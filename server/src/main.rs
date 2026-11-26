//! Servidor HTTP assíncrono que valida leituras de sensores e as persiste no MongoDB.
//! Cada leitura vira um documento; lotes permitem que um dispositivo envie os dados
//! acumulados ao longo de uma hora em uma única requisição.

use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::TryStreamExt;
use mongodb::{
    Client, Collection, IndexModel,
    bson::{Bson, DateTime, Document, doc},
};
use serde::{Deserialize, Serialize};
use std::{env, net::SocketAddr, time::Duration};
use tokio::{
    sync::{mpsc, oneshot},
    time::{Instant, sleep_until},
};

const MAX_READINGS_PER_DEVICE: i64 = 30 * 24 * 60;
const WRITE_BATCH_WINDOW: Duration = Duration::from_millis(10);
const MAX_DOCUMENTS_PER_WRITE: usize = 500;
const WRITE_QUEUE_CAPACITY: usize = 128;

type WriteResult = Result<Vec<String>, ()>;

struct PendingWrite {
    documents: Vec<Document>,
    response: oneshot::Sender<WriteResult>,
    enqueued_at: Instant,
}

#[derive(Clone)]
struct AppState {
    // Axum compartilha este estado entre as requisições concorrentes.
    readings: Collection<Document>,
    database: mongodb::Database,
    write_queue: mpsc::Sender<PendingWrite>,
}

#[derive(Deserialize)]
struct NewReading {
    device_id: String,
    // Mantém os campos da leitura no mesmo nível do JSON de POST /readings.
    #[serde(flatten)]
    measurement: NewMeasurement,
}

#[derive(Deserialize)]
struct NewMeasurement {
    timestamp: String,
    // Campos opcionais permitem que cada dispositivo envie apenas o que mede.
    #[serde(default)]
    humidity_percent: Option<f64>,
    #[serde(default)]
    soil_ph: Option<f64>,
    #[serde(default)]
    temperature_c: Option<f64>,
}

#[derive(Deserialize)]
struct NewReadingBatch {
    device_id: String,
    // Todas as leituras deste lote pertencem ao mesmo dispositivo.
    readings: Vec<NewMeasurement>,
}

#[derive(Serialize)]
struct StoredReading {
    status: &'static str,
    id: String,
}

#[derive(Serialize)]
struct StoredBatch {
    status: &'static str,
    inserted_count: usize,
    ids: Vec<String>,
}

#[derive(Deserialize)]
struct ReadingsQuery {
    device_id: String,
    from: String,
    to: String,
}

#[derive(Serialize)]
struct ReadingPoint {
    timestamp_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    humidity_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    soil_ph: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature_c: Option<f64>,
}

#[derive(Serialize)]
struct ReadingsResponse {
    readings: Vec<ReadingPoint>,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mongo_uri =
        env::var("MONGODB_URI").unwrap_or_else(|_| "mongodb://localhost:27017".to_owned());
    let database_name =
        env::var("MONGODB_DATABASE").unwrap_or_else(|_| "soil_monitoring".to_owned());
    let address: SocketAddr = env::var("SERVER_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:7878".to_owned())
        .parse()?;

    let client = Client::with_uri_str(&mongo_uri).await?;
    let database = client.database(&database_name);
    let readings = database.collection::<Document>("readings");
    // Este índice acelera consultas das leituras de um dispositivo por horário.
    readings
        .create_index(
            IndexModel::builder()
                .keys(doc! { "device_id": 1, "timestamp": -1 })
                .build(),
        )
        .await?;

    let (write_queue, write_receiver) = mpsc::channel(WRITE_QUEUE_CAPACITY);
    tokio::spawn(run_write_worker(readings.clone(), write_receiver));

    let state = AppState {
        readings,
        database,
        write_queue,
    };
    // Cada rota recebe uma cópia leve do estado compartilhado.
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/devices", get(list_devices))
        .route("/api/readings", get(list_readings))
        .route("/readings", post(create_reading))
        .route("/readings/batch", post(create_reading_batch))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("Server listening on {address}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> Response {
    // Confirma que o processo consegue alcançar o MongoDB, não apenas que a porta HTTP está aberta.
    match state.database.run_command(doc! { "ping": 1 }).await {
        Ok(_) => (StatusCode::OK, Json(doc! { "status": "ok" })).into_response(),
        Err(error) => {
            eprintln!("MongoDB health check failed: {error}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(doc! { "status": "unavailable" }),
            )
                .into_response()
        }
    }
}

async fn list_devices(State(state): State<AppState>) -> Result<Json<Vec<String>>, ApiError> {
    let mut devices = state
        .readings
        .distinct("device_id", doc! {})
        .await
        .map_err(ApiError::Database)?
        .into_iter()
        .map(|value| match value {
            Bson::String(device_id) => Ok(device_id),
            _ => Err(ApiError::InvalidStoredData),
        })
        .collect::<Result<Vec<_>, _>>()?;
    devices.sort();
    Ok(Json(devices))
}

async fn list_readings(
    State(state): State<AppState>,
    Query(query): Query<ReadingsQuery>,
) -> Result<Json<ReadingsResponse>, ApiError> {
    let device_id = validate_device_id(&query.device_id)?;
    let from = parse_timestamp(&query.from)?;
    let to = parse_timestamp(&query.to)?;
    if from.timestamp_millis() > to.timestamp_millis() {
        return Err(ApiError::BadRequest(
            "'from' must be earlier than or equal to 'to'",
        ));
    }

    let mut time_range = Document::new();
    time_range.insert("$gte", from);
    time_range.insert("$lte", to);
    let filter = doc! {
        "device_id": device_id,
        "timestamp": time_range,
    };
    let mut cursor = state
        .readings
        .find(filter)
        .sort(doc! { "timestamp": -1 })
        .limit(MAX_READINGS_PER_DEVICE)
        .await
        .map_err(ApiError::Database)?;
    let mut readings = Vec::new();
    while let Some(document) = cursor.try_next().await.map_err(ApiError::Database)? {
        readings.push(reading_point(&document)?);
    }
    // A consulta busca os registros mais recentes primeiro e a interface plota em ordem temporal.
    readings.reverse();
    Ok(Json(ReadingsResponse { readings }))
}

async fn create_reading(
    State(state): State<AppState>,
    Json(reading): Json<NewReading>,
) -> Result<(StatusCode, Json<StoredReading>), ApiError> {
    // O endpoint unitário é mantido para clientes que enviam uma leitura por chamada.
    let device_id = validate_device_id(&reading.device_id)?;
    let document = reading_document(device_id, reading.measurement)?;
    let mut ids = enqueue_write(&state, vec![document]).await?;
    let id = ids.pop().ok_or(ApiError::InvalidStoredData)?;

    Ok((
        StatusCode::CREATED,
        Json(StoredReading {
            status: "stored",
            id,
        }),
    ))
}

async fn create_reading_batch(
    State(state): State<AppState>,
    Json(batch): Json<NewReadingBatch>,
) -> Result<(StatusCode, Json<StoredBatch>), ApiError> {
    let device_id = validate_device_id(&batch.device_id)?;
    if batch.readings.is_empty() {
        return Err(ApiError::BadRequest(
            "readings must contain at least one item",
        ));
    }
    if batch.readings.len() > MAX_DOCUMENTS_PER_WRITE {
        return Err(ApiError::BadRequest(
            "readings cannot contain more than 1000 items",
        ));
    }

    // Valida todo o lote antes de enviar os documentos ao MongoDB.
    let documents = batch
        .readings
        .into_iter()
        .map(|reading| reading_document(device_id, reading))
        .collect::<Result<Vec<_>, _>>()?;
    let ids = enqueue_write(&state, documents).await?;

    Ok((
        StatusCode::CREATED,
        Json(StoredBatch {
            status: "stored",
            inserted_count: ids.len(),
            ids,
        }),
    ))
}

async fn enqueue_write(
    state: &AppState,
    documents: Vec<Document>,
) -> Result<Vec<String>, ApiError> {
    let (response, result) = oneshot::channel();
    let enqueued_at = Instant::now();
    state
        .write_queue
        .send(PendingWrite {
            documents,
            response,
            enqueued_at,
        })
        .await
        .map_err(|_| ApiError::WriteQueueUnavailable)?;

    result
        .await
        .map_err(|_| ApiError::WriteQueueUnavailable)?
        .map_err(|()| ApiError::BatchWriteFailed)
}

async fn run_write_worker(
    readings: Collection<Document>,
    mut receiver: mpsc::Receiver<PendingWrite>,
) {
    let mut overflow = None;
    let mut metrics_window_started = Instant::now();
    let mut metric_batches = 0;
    let mut metric_requests = 0;
    let mut metric_documents = 0;
    let mut total_queue_wait = Duration::ZERO;
    let mut max_queue_wait = Duration::ZERO;
    let mut total_collect_time = Duration::ZERO;
    let mut total_insert_many_time = Duration::ZERO;
    let mut max_insert_many_time = Duration::ZERO;

    loop {
        let first = match overflow.take() {
            Some(request) => request,
            None => match receiver.recv().await {
                Some(request) => request,
                None => return,
            },
        };
        let batch = collect_write_batch(&mut receiver, first).await;
        overflow = batch.overflow;
        let queue_wait_total = batch.queue_wait_total;
        let queue_wait_max = batch.queue_wait_max;
        let collect_time = batch.collect_time;
        let documents = batch.documents;
        let responses = batch.responses;
        let request_count = responses.len();
        let document_count = documents.len();

        let insert_started = Instant::now();
        let result = readings.insert_many(documents).await;
        let insert_many_time = insert_started.elapsed();

        metric_batches += 1;
        metric_requests += request_count;
        metric_documents += document_count;
        total_queue_wait += queue_wait_total;
        max_queue_wait = max_queue_wait.max(queue_wait_max);
        total_collect_time += collect_time;
        total_insert_many_time += insert_many_time;
        max_insert_many_time = max_insert_many_time.max(insert_many_time);

        let metrics_window = metrics_window_started.elapsed();
        if metrics_window >= Duration::from_secs(1) {
            eprintln!(
                "[mongo-write] window_ms={} batches={} requests={} documents={} \
                 queue_wait_avg_ms={:.2} queue_wait_max_ms={:.2} \
                 collect_avg_ms={:.2} insert_many_avg_ms={:.2} insert_many_max_ms={:.2}",
                metrics_window.as_millis(),
                metric_batches,
                metric_requests,
                metric_documents,
                total_queue_wait.as_secs_f64() * 1000.0 / metric_requests as f64,
                max_queue_wait.as_secs_f64() * 1000.0,
                total_collect_time.as_secs_f64() * 1000.0 / metric_batches as f64,
                total_insert_many_time.as_secs_f64() * 1000.0 / metric_batches as f64,
                max_insert_many_time.as_secs_f64() * 1000.0,
            );
            metrics_window_started = Instant::now();
            metric_batches = 0;
            metric_requests = 0;
            metric_documents = 0;
            total_queue_wait = Duration::ZERO;
            max_queue_wait = Duration::ZERO;
            total_collect_time = Duration::ZERO;
            total_insert_many_time = Duration::ZERO;
            max_insert_many_time = Duration::ZERO;
        }

        match result {
            Ok(result) => {
                // MongoDB indexes IDs by input position; keep each request's response ordered.
                let mut inserted_ids = result.inserted_ids.into_iter().collect::<Vec<_>>();
                inserted_ids.sort_by_key(|(index, _)| *index);
                let ids = inserted_ids
                    .into_iter()
                    .map(|(_, id)| {
                        id.as_object_id()
                            .expect("MongoDB generates an ObjectId for inserted readings")
                            .to_hex()
                    })
                    .collect::<Vec<_>>();
                let counts = responses
                    .iter()
                    .map(|(_, count)| *count)
                    .collect::<Vec<_>>();
                let Some(request_ids) = split_inserted_ids(ids, &counts) else {
                    eprintln!("MongoDB returned an unexpected number of inserted IDs");
                    for (response, _) in responses {
                        let _ = response.send(Err(()));
                    }
                    continue;
                };

                for ((response, _), ids) in responses.into_iter().zip(request_ids) {
                    let _ = response.send(Ok(ids));
                }
            }
            Err(error) => {
                eprintln!("MongoDB grouped write failed: {error}");
                for (response, _) in responses {
                    let _ = response.send(Err(()));
                }
            }
        }
    }
}

struct CollectedWriteBatch {
    documents: Vec<Document>,
    responses: Vec<(oneshot::Sender<WriteResult>, usize)>,
    overflow: Option<PendingWrite>,
    queue_wait_total: Duration,
    queue_wait_max: Duration,
    collect_time: Duration,
}

async fn collect_write_batch(
    receiver: &mut mpsc::Receiver<PendingWrite>,
    first: PendingWrite,
) -> CollectedWriteBatch {
    let collect_started = Instant::now();
    let first_queue_wait = collect_started.duration_since(first.enqueued_at);
    let first_count = first.documents.len();
    let mut documents = first.documents;
    let mut responses = vec![(first.response, first_count)];
    let mut overflow = None;
    let mut queue_wait_total = first_queue_wait;
    let mut queue_wait_max = first_queue_wait;
    let deadline = Instant::now() + WRITE_BATCH_WINDOW;

    while documents.len() < MAX_DOCUMENTS_PER_WRITE {
        let next = tokio::select! {
            request = receiver.recv() => request,
            _ = sleep_until(deadline) => break,
        };
        let Some(next) = next else {
            break;
        };
        let next_queue_wait = Instant::now().duration_since(next.enqueued_at);
        let next_count = next.documents.len();
        if documents.len() + next_count > MAX_DOCUMENTS_PER_WRITE {
            overflow = Some(next);
            break;
        }

        queue_wait_total += next_queue_wait;
        queue_wait_max = queue_wait_max.max(next_queue_wait);
        documents.extend(next.documents);
        responses.push((next.response, next_count));
    }

    CollectedWriteBatch {
        documents,
        responses,
        overflow,
        queue_wait_total,
        queue_wait_max,
        collect_time: collect_started.elapsed(),
    }
}

fn split_inserted_ids(ids: Vec<String>, counts: &[usize]) -> Option<Vec<Vec<String>>> {
    if counts.iter().sum::<usize>() != ids.len() {
        return None;
    }

    let mut offset = 0;
    Some(
        counts
            .iter()
            .map(|count| {
                let end = offset + count;
                let request_ids = ids[offset..end].to_vec();
                offset = end;
                request_ids
            })
            .collect(),
    )
}

fn validate_device_id(device_id: &str) -> Result<&str, ApiError> {
    let device_id = device_id.trim();
    if device_id.is_empty() || device_id.len() > 128 {
        return Err(ApiError::BadRequest(
            "device_id must contain between 1 and 128 characters",
        ));
    }
    Ok(device_id)
}

fn parse_timestamp(value: &str) -> Result<DateTime, ApiError> {
    DateTime::parse_rfc3339_str(value)
        .map_err(|_| ApiError::BadRequest("timestamp must be a valid RFC 3339 date and time"))
}

fn reading_document(device_id: &str, reading: NewMeasurement) -> Result<Document, ApiError> {
    // Rejeita leituras vazias e valores fora das faixas definidas para humidade e pH.
    if reading.humidity_percent.is_none()
        && reading.soil_ph.is_none()
        && reading.temperature_c.is_none()
    {
        return Err(ApiError::BadRequest(
            "each reading must contain at least one measurement",
        ));
    }
    if reading
        .humidity_percent
        .is_some_and(|value| !value.is_finite() || !(0.0..=100.0).contains(&value))
    {
        return Err(ApiError::BadRequest(
            "humidity_percent must be between 0 and 100",
        ));
    }
    if reading
        .soil_ph
        .is_some_and(|value| !value.is_finite() || !(0.0..=14.0).contains(&value))
    {
        return Err(ApiError::BadRequest("soil_ph must be between 0 and 14"));
    }
    if reading
        .temperature_c
        .is_some_and(|value| !value.is_finite())
    {
        return Err(ApiError::BadRequest(
            "temperature_c must be a finite number",
        ));
    }

    let timestamp = parse_timestamp(&reading.timestamp)?;
    let mut document = doc! {
        "device_id": device_id,
        "timestamp": timestamp,
    };
    // Campos ausentes são omitidos, não armazenados como null. O MongoDB gera _id ao inserir.
    if let Some(value) = reading.humidity_percent {
        document.insert("humidity_percent", value);
    }
    if let Some(value) = reading.soil_ph {
        document.insert("soil_ph", value);
    }
    if let Some(value) = reading.temperature_c {
        document.insert("temperature_c", value);
    }
    Ok(document)
}

fn reading_point(document: &Document) -> Result<ReadingPoint, ApiError> {
    let timestamp_ms = document
        .get_datetime("timestamp")
        .map_err(|_| ApiError::InvalidStoredData)?
        .timestamp_millis();
    Ok(ReadingPoint {
        timestamp_ms,
        humidity_percent: optional_number(document, "humidity_percent")?,
        soil_ph: optional_number(document, "soil_ph")?,
        temperature_c: optional_number(document, "temperature_c")?,
    })
}

fn optional_number(document: &Document, field: &str) -> Result<Option<f64>, ApiError> {
    match document.get(field) {
        None => Ok(None),
        Some(Bson::Double(value)) => Ok(Some(*value)),
        Some(Bson::Int32(value)) => Ok(Some(f64::from(*value))),
        Some(Bson::Int64(value)) => Ok(Some(*value as f64)),
        Some(_) => Err(ApiError::InvalidStoredData),
    }
}

#[derive(Debug)]
enum ApiError {
    BadRequest(&'static str),
    Database(mongodb::error::Error),
    BatchWriteFailed,
    WriteQueueUnavailable,
    InvalidStoredData,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        // Converte erros internos em respostas HTTP sem expor detalhes do MongoDB ao cliente.
        let (status, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            Self::Database(error) => {
                eprintln!("MongoDB operation failed: {error}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "database operation failed",
                )
            }
            Self::BatchWriteFailed => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "database operation failed",
            ),
            Self::WriteQueueUnavailable => {
                eprintln!("MongoDB write queue is unavailable");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "database write queue is unavailable",
                )
            }
            Self::InvalidStoredData => {
                eprintln!("MongoDB returned a reading with an invalid stored field");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "stored reading has an invalid format",
                )
            }
        };
        (status, Json(ErrorResponse { error: message })).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn measurement(
        timestamp: &str,
        humidity_percent: Option<f64>,
        soil_ph: Option<f64>,
        temperature_c: Option<f64>,
    ) -> NewMeasurement {
        NewMeasurement {
            timestamp: timestamp.to_owned(),
            humidity_percent,
            soil_ph,
            temperature_c,
        }
    }

    #[test]
    fn document_contains_only_measurements_that_were_provided() {
        let document = reading_document(
            "esp32-sala",
            measurement("2026-11-24T19:30:00Z", None, Some(6.5), None),
        )
        .unwrap();

        assert_eq!(document.get_str("device_id").unwrap(), "esp32-sala");
        assert!(document.contains_key("soil_ph"));
        assert!(!document.contains_key("humidity_percent"));
        assert!(!document.contains_key("temperature_c"));
    }

    #[test]
    fn rejects_readings_without_measurements() {
        let result = reading_document(
            "esp32-sala",
            measurement("2026-11-24T19:30:00Z", None, None, None),
        );

        assert!(matches!(result, Err(ApiError::BadRequest(_))));
    }

    #[test]
    fn rejects_out_of_range_ph() {
        let result = reading_document(
            "esp32-sala",
            measurement("2026-11-24T19:30:00Z", None, Some(14.1), None),
        );

        assert!(matches!(result, Err(ApiError::BadRequest(_))));
    }

    #[test]
    fn response_uses_epoch_milliseconds_and_omits_missing_values() {
        let document = doc! {
            "timestamp": DateTime::parse_rfc3339_str("2026-11-24T19:30:00Z").unwrap(),
            "soil_ph": 6.5,
        };
        let point = reading_point(&document).unwrap();

        assert_eq!(point.timestamp_ms, 1_795_548_600_000);
        assert_eq!(point.soil_ph, Some(6.5));
        assert_eq!(point.humidity_percent, None);
    }

    #[tokio::test]
    async fn collects_separate_requests_into_one_write_batch() {
        let (sender, mut receiver) = mpsc::channel(2);
        let (first_response, _first_receiver) = oneshot::channel();
        let (second_response, _second_receiver) = oneshot::channel();
        assert!(
            sender
                .send(PendingWrite {
                    documents: vec![doc! { "sequence": 1 }],
                    response: first_response,
                    enqueued_at: Instant::now(),
                })
                .await
                .is_ok()
        );
        assert!(
            sender
                .send(PendingWrite {
                    documents: vec![doc! { "sequence": 2 }],
                    response: second_response,
                    enqueued_at: Instant::now(),
                })
                .await
                .is_ok()
        );

        let first = receiver.recv().await.unwrap();
        let batch = collect_write_batch(&mut receiver, first).await;

        assert_eq!(
            batch.documents,
            vec![doc! { "sequence": 1 }, doc! { "sequence": 2 }]
        );
        assert_eq!(
            batch
                .responses
                .iter()
                .map(|(_, count)| *count)
                .collect::<Vec<_>>(),
            vec![1, 1]
        );
        assert!(batch.overflow.is_none());
    }

    #[tokio::test]
    async fn carries_a_request_forward_when_it_would_exceed_write_limit() {
        let (sender, mut receiver) = mpsc::channel(2);
        let (first_response, _first_receiver) = oneshot::channel();
        let (second_response, _second_receiver) = oneshot::channel();
        assert!(
            sender
                .send(PendingWrite {
                    documents: vec![doc! { "sequence": 1 }; MAX_DOCUMENTS_PER_WRITE - 1],
                    response: first_response,
                    enqueued_at: Instant::now(),
                })
                .await
                .is_ok()
        );
        assert!(
            sender
                .send(PendingWrite {
                    documents: vec![doc! { "sequence": 2 }; 2],
                    response: second_response,
                    enqueued_at: Instant::now(),
                })
                .await
                .is_ok()
        );

        let first = receiver.recv().await.unwrap();
        let batch = collect_write_batch(&mut receiver, first).await;

        assert_eq!(batch.documents.len(), MAX_DOCUMENTS_PER_WRITE - 1);
        assert_eq!(batch.responses.len(), 1);
        assert_eq!(
            batch.overflow.map(|request| request.documents.len()),
            Some(2)
        );
    }

    #[test]
    fn split_inserted_ids_preserves_each_request_boundary() {
        let ids = vec!["id-1".to_owned(), "id-2".to_owned(), "id-3".to_owned()];

        assert_eq!(
            split_inserted_ids(ids, &[2, 1]),
            Some(vec![
                vec!["id-1".to_owned(), "id-2".to_owned()],
                vec!["id-3".to_owned()],
            ])
        );
    }

    #[test]
    fn split_inserted_ids_rejects_mismatched_counts() {
        assert_eq!(split_inserted_ids(vec!["id-1".to_owned()], &[2]), None);
    }
}
