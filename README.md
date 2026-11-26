# Soil monitoring app

Servidor HTTP em Rust para receber leituras de humidade de solo e armazená-las no MongoDB.

## Executar com Docker Compose

Requisitos: Docker Engine e Docker Compose v2 (`docker compose`).

Na raiz do repositório, construa e inicie o MongoDB, a API Rust e o frontend:

```sh
docker compose up --build -d
```

O Compose aguarda o MongoDB ficar saudável antes de iniciar o servidor, e o frontend aguarda a API. Acompanhe a inicialização com:

```sh
docker compose ps
docker compose logs -f
```

Abra o painel em <http://localhost:8080>. O frontend encaminha as chamadas da API ao servidor. A API também fica disponível em <http://localhost:7878>, e seu endpoint de saúde em <http://localhost:7878/health>.

Para executar o teste de carga k6 contra a API local do Compose:

```sh
docker compose --profile loadtest run --rm k6
```

O teste envia lotes ao servidor e pode inserir muitas leituras; execute-o apenas no ambiente local de desenvolvimento. O banco persiste no volume `mongo_data`, inclusive ao parar e recriar os containers.

Para parar os serviços sem apagar os dados:

```sh
docker compose down
```

Para apagar também o banco e todas as leituras persistidas:

```sh
docker compose down --volumes
```

As portas do MongoDB, da API e do frontend estão vinculadas a `127.0.0.1` para não ficarem expostas a outras máquinas da rede.

## Requisitos

- Rust (com Cargo)
- MongoDB em execução

O nome do banco e da coleção são `soil_monitoring` e `readings`. O MongoDB cria o banco e a coleção automaticamente na primeira gravação. Para criá-los manualmente no `mongosh`:

```javascript
use soil_monitoring
db.createCollection("readings")
```

## Configuração e execução

Na pasta `server`, configure a conexão se necessário e inicie o servidor:

```sh
export MONGODB_URI='mongodb://localhost:27017'
export MONGODB_DATABASE='soil_monitoring'
export SERVER_ADDR='0.0.0.0:7878'
cargo run
```

Por padrão, o servidor escuta em `0.0.0.0:7878` para aceitar conexões de dispositivos na rede local. **A API não tem autenticação**: qualquer pessoa que consiga alcançar essa porta pode ler e inserir dados. Restrinja o acesso pelo firewall à sua rede confiável; para uso somente local, configure `SERVER_ADDR='127.0.0.1:7878'`. Não exponha o servidor diretamente à internet.

Na inicialização, o servidor cria um índice por dispositivo e timestamp. O endpoint `GET /health` verifica a conexão com o MongoDB.

## Painel de séries temporais

Com o servidor em execução, abra `http://localhost:7878/` e clique em **Carregar dispositivos** para visualizar humidade, pH e temperatura nas últimas 24 horas, 7 dias ou 30 dias.

As rotas `GET /api/devices` e `GET /api/readings` não exigem chave de API. A consulta de séries aceita `device_id`, `from` e `to` como parâmetros RFC 3339 e retorna até 5.000 pontos mais recentes no intervalo.

## Enviar uma leitura

`POST /readings` recebe uma leitura, mantendo o formato unitário:

```sh
curl -i http://localhost:7878/readings \
  -H 'content-type: application/json' \
  -d '{"device_id":"esp32-sala","humidity_percent":42.7,"timestamp":"2026-11-24T19:30:00Z"}'
```

## Enviar um lote de leituras

Cada dispositivo pode enviar várias leituras acumuladas em uma única chamada para `POST /readings/batch`. O `device_id` fica no topo do pedido; cada item tem seu próprio timestamp e pode incluir um ou mais campos de medição:

```sh
curl -i http://localhost:7878/readings/batch \
  -H 'content-type: application/json' \
  -d '{
    "device_id": "esp32-sala",
    "readings": [
      {"timestamp":"2026-11-24T19:30:00Z","humidity_percent":42.7},
      {"timestamp":"2026-11-24T19:31:00Z","soil_ph":6.5},
      {"timestamp":"2026-11-24T19:32:00Z","temperature_c":23.1},
      {"timestamp":"2026-11-24T19:33:00Z","humidity_percent":43.0,"soil_ph":6.4,"temperature_c":23.2}
    ]
  }'
```

Uma leitura pode incluir `humidity_percent` (0 a 100), `soil_ph` (0 a 14) e `temperature_c` (graus Celsius). Cada item precisa incluir ao menos um desses campos e um timestamp RFC 3339 com fuso horário. Campos não enviados não são armazenados. A API grava um `_id` ObjectId gerado pelo MongoDB para cada documento e responde `201 Created` com a quantidade e os IDs inseridos na mesma ordem dos itens enviados. O limite padrão de corpo HTTP do Axum também limita o tamanho máximo de cada lote.

O envio unitário responde `201 Created` com o ID da leitura. Timestamps são armazenados como BSON Date UTC. Dados inválidos recebem `400 Bad Request`. Como os IDs são gerados no servidor, reenviar um lote após perder a resposta pode criar duplicatas.

## Gerar dados de teste

O script [seed.js](./scripts/seed.js) gera um mês de leituras por minuto para 100 dispositivos. Cada dispositivo recebe uma das sete combinações de sensores disponíveis, e os valores variam ao longo do dia e entre dispositivos. Isso cria **4.320.000 documentos**; reserve tempo e espaço em disco e execute em um banco de teste dedicado.

Na raiz do repositório, rode:

```sh
mongosh "mongodb://localhost:27017/soil_monitoring_seed" --file scripts/seed.js
```

Para visualizar esses dados no painel, inicie o servidor apontando para o mesmo banco:

```sh
cd server
MONGODB_DATABASE=soil_monitoring_seed cargo run
```

O script não apaga dados anteriores; executá-lo novamente acrescenta outro conjunto de leituras.

## Teste de carga com k6

O [loadtest.js](./scripts/loadtest.js) envia 60 leituras por requisição. Cada worker usa seu próprio `device_id` (`loadtest-1`, `loadtest-2`, etc.) e uma combinação de sensores que se repete a cada sete workers.

Na raiz do repositório, com o servidor rodando:

```sh
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -v "$PWD/scripts/loadtest.js:/scripts/loadtest.js:ro" \
  grafana/k6:master-with-browser run /scripts/loadtest.js
```

No macOS/Windows, normalmente pode remover `--add-host`.
