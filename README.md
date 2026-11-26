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

Abra o painel React em <http://localhost:8080>. O frontend encaminha as chamadas da API ao servidor. A API também fica disponível em <http://localhost:7878>, e seu endpoint de saúde em <http://localhost:7878/health>.

Para executar o teste de carga k6 contra a API local do Compose:

```sh
docker compose --profile loadtest run --rm k6
```

O teste envia lotes ao servidor e pode inserir muitas leituras; execute-o apenas no ambiente local de desenvolvimento. O banco persiste no volume `mongo_data`, inclusive ao parar e recriar os containers.

### Teste gradual de capacidade

O script [capacity-test.js](./scripts/capacity-test.js) começa com um dispositivo e aumenta gradualmente até o número configurado. Cada dispositivo envia continuamente lotes de 60 leituras com humidade, pH e temperatura, iniciando um novo lote assim que o anterior termina. Ao chegar ao alvo, mantém todos os dispositivos enviando por mais 10 segundos e então termina, se não houver erros. O teste exibe uma vez por segundo o número de dispositivos ativos e a latência observada; interrompe imediatamente se uma resposta ultrapassar 1 segundo ou se um lote falhar.

O teste é restrito ao servidor local e não tem um teto fixo de dispositivos nem contabiliza o total de registros do banco. `MAX_DEVICES` define o alvo do ramp-up; ajuste esse valor conforme os recursos disponíveis:

```sh
MAX_DEVICES=1000 CAPACITY_RUN_ID=local-01 \
  docker compose --profile capacity run --rm capacity-test
```

O banco pode acumular muitas leituras durante o teste; use um ambiente local de teste e monitore os recursos.

### Teste de ondas horárias

O script [hourly-wave-test.js](./scripts/hourly-wave-test.js) simula uma onda de envio: cada dispositivo faz uma única requisição com 6.000 leituras distribuídas por uma hora. Começa com 1 dispositivo, aumenta para 25%, 50%, 75% e 100% de `MAX_DEVICES`, removendo etapas repetidas. As requisições da onda são disparadas em paralelo; a onda seguinte só começa quando todas as respostas da anterior chegaram. Se a duração total da onda alcançar 1 segundo, ou alguma resposta não confirmar as 6.000 leituras, o teste aborta. Ao completar a onda máxima abaixo de 1 segundo, termina com sucesso.

Cada linha `[hourly-wave]` registra dispositivos, leituras, tempo de preparação do payload, duração da onda e latências média/máxima das requisições. O resumo k6 também inclui as métricas `wave_duration_ms` e `device_request_duration_ms`. O teste grava muitos dados e as respostas incluem os IDs das 6.000 leituras; monitore RAM, CPU e espaço em disco do k6, servidor e MongoDB.

Use um banco de teste separado. O exemplo abaixo cria/usa `soil_monitoring_hourly_test` e salva a saída do teste em `hourly-wave-results.log`:

```sh
MONGODB_DATABASE=soil_monitoring_hourly_test docker compose up --build -d server
set -o pipefail
MAX_DEVICES=100 HOURLY_RUN_ID=local-01 MONGODB_DATABASE=soil_monitoring_hourly_test \
  docker compose --profile hourly-wave run --rm hourly-wave-test \
  | tee hourly-wave-results.log
```

O teste aceita somente URLs locais da API na porta 7878. `MAX_DEVICES` limita a última onda e o padrão é 25; comece com um valor baixo, pois a quantidade total gravada cresce com cada onda concluída.

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

O banco padrão é `soil_monitoring`. A API cria a coleção Time Series `readings_ts` na inicialização; ela usa `timestamp` como campo de tempo, `device_id` como metadado e granularidade de minutos. A coleção regular `readings`, se já existir, não é alterada nem migrada; a API e o painel passam a usar somente `readings_ts`, então os dados antigos não aparecerão até serem migrados. Para criar a coleção manualmente no `mongosh`:

```javascript
use soil_monitoring
db.createCollection("readings_ts", {
  timeseries: {
    timeField: "timestamp",
    metaField: "device_id",
    granularity: "minutes"
  }
})
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

Na inicialização, o servidor valida a configuração da coleção Time Series existente ou a cria se estiver ausente. O MongoDB 8.0 cria o índice composto de metadados e tempo; a consulta do painel filtra por dispositivo e intervalo de timestamps. `GET /api/devices` usa agregação para listar dispositivos, pois o comando `distinct` não é suportado em coleções Time Series. O endpoint `GET /health` verifica a conexão com o MongoDB.

## Frontend React

O painel é uma aplicação React + TypeScript estilizada com Tailwind CSS. Para executá-la em modo de desenvolvimento, inicie primeiro o servidor e rode:

```sh
cd frontend
pnpm install
pnpm start
```

O servidor de desenvolvimento React abre em <http://localhost:3000> e encaminha as chamadas para a API em `http://localhost:7878`. O Docker Compose serve a versão de produção pelo Nginx.

## Séries temporais

Com os serviços em execução, abra `http://localhost:8080` para visualizar humidade, pH e temperatura nas últimas 24 horas, 7 dias ou 30 dias.

As rotas `GET /api/devices` e `GET /api/readings` não exigem chave de API. A consulta de séries aceita `device_id`, `from` e `to` como parâmetros RFC 3339 e retorna até 43.200 pontos mais recentes no intervalo — um ponto por minuto durante 30 dias.

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

Uma leitura pode incluir `humidity_percent` (0 a 100), `soil_ph` (0 a 14) e `temperature_c` (graus Celsius). Cada item precisa incluir ao menos um desses campos e um timestamp RFC 3339 com fuso horário. Campos não enviados não são armazenados. A API grava um `_id` ObjectId gerado pelo MongoDB para cada documento e responde `201 Created` com a quantidade e os IDs inseridos na mesma ordem dos itens enviados. Cada request para `/readings/batch` aceita até 6.000 leituras.

O envio unitário responde `201 Created` com o ID da leitura. Timestamps são armazenados como BSON Date UTC. Dados inválidos recebem `400 Bad Request`. Como os IDs são gerados no servidor, reenviar um lote após perder a resposta pode criar duplicatas.

As gravações concorrentes de `POST /readings` e `POST /readings/batch` são reunidas por até 10 ms, com alvo máximo de 500 documentos agrupados por comando MongoDB. Um request individual pode conter até 6.000 documentos e é gravado como uma operação própria. Cada request aguarda a confirmação da gravação e recebe somente os IDs dos seus próprios documentos.

Durante a carga, o servidor emite linhas `[mongo-write]` com métricas agregadas em janelas de aproximadamente 1 segundo: `queue_wait_avg_ms`/`queue_wait_max_ms` medem o tempo do início do enfileiramento até o worker retirar cada request; `collect_avg_ms` mede o tempo de formação do lote; e `insert_many_avg_ms`/`insert_many_max_ms` medem a duração da chamada do driver MongoDB, incluindo a comunicação com o banco, não apenas o tempo registrado pelo profiler do MongoDB.

## Gerar dados de teste

O script [seed.js](./scripts/seed.js) gera leituras por minuto para cada um dos 100 dispositivos e cria `readings_ts` como Time Series se ainda não existir. Cada dispositivo recebe uma das sete combinações de sensores disponíveis, indicada no nome pelos sufixos `H` (humidade), `P` (pH) e `T` (temperatura), por exemplo `seed-device-001 (H-T)` ou `seed-device-002 (P-T)`. Humidade, pH e temperatura variam como senóides com período de 24 horas; a fase, a amplitude e o valor médio mudam entre dispositivos. Reserve tempo e espaço em disco e execute em um banco de teste dedicado.

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

O [loadtest.js](./scripts/loadtest.js) envia 60 leituras por requisição, cobrindo uma hora por lote. Cada worker usa seu próprio `device_id` (`loadtest-1`, `loadtest-2`, etc.) e uma combinação de sensores que se repete a cada sete workers. Para os dados simulados do mês, use `seed.js`, que cria os 100 dispositivos `seed-device-*` com sufixos de sensor.

Na raiz do repositório, com o servidor rodando:

```sh
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -v "$PWD/scripts/loadtest.js:/scripts/loadtest.js:ro" \
  grafana/k6:master-with-browser run /scripts/loadtest.js
```

No macOS/Windows, normalmente pode remover `--add-host`.
