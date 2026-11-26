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
use std::{env, net::SocketAddr};
use tokio::net::TcpSocket;

const LISTEN_BACKLOG: u32 = 4096;

#[derive(Clone)]
struct AppState {
    // Axum compartilha este estado entre as requisições concorrentes.
    readings: Collection<Document>,
    database: mongodb::Database,
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

    let state = AppState { readings, database };
    // Cada rota recebe uma cópia leve do estado compartilhado.
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/devices", get(list_devices))
        .route("/api/readings", get(list_readings))
        .route("/readings", post(create_reading))
        .route("/readings/batch", post(create_reading_batch))
        .with_state(state);

    let socket = if address.is_ipv4() {
        TcpSocket::new_v4()?
    } else {
        TcpSocket::new_v6()?
    };
    #[cfg(not(windows))]
    socket.set_reuseaddr(true)?;
    socket.bind(address)?;
    let listener = socket.listen(LISTEN_BACKLOG)?;
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
        .limit(5000)
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
    let result = state
        .readings
        .insert_one(document)
        .await
        .map_err(ApiError::Database)?;
    let id = result
        .inserted_id
        .as_object_id()
        .expect("MongoDB generates an ObjectId for inserted readings")
        .to_hex();

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

    // Valida todo o lote antes de enviar os documentos ao MongoDB.
    let documents = batch
        .readings
        .into_iter()
        .map(|reading| reading_document(device_id, reading))
        .collect::<Result<Vec<_>, _>>()?;
    let result = state
        .readings
        .insert_many(documents)
        .await
        .map_err(ApiError::Database)?;
    // MongoDB devolve IDs associados aos índices de entrada; ordená-los preserva a ordem do lote.
    let mut inserted_ids = result.inserted_ids.into_iter().collect::<Vec<_>>();
    inserted_ids.sort_by_key(|(index, _)| *index);
    let ids = inserted_ids
        .into_iter()
        .map(|(_, id)| id)
        .map(|id| {
            id.as_object_id()
                .expect("MongoDB generates an ObjectId for inserted readings")
                .to_hex()
        })
        .collect::<Vec<_>>();

    Ok((
        StatusCode::CREATED,
        Json(StoredBatch {
            status: "stored",
            inserted_count: ids.len(),
            ids,
        }),
    ))
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
}
