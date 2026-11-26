import exec from 'k6/execution';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Gauge, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:7878';
const allowedBaseUrls = new Set([
  'http://localhost:7878',
  'http://127.0.0.1:7878',
  'http://host.docker.internal:7878',
  'http://server:7878',
]);
const MAX_DEVICES = Number(__ENV.MAX_DEVICES || 25);
const RUN_ID = (__ENV.HOURLY_RUN_ID || 'local')
  .replace(/[^a-zA-Z0-9-]/g, '-')
  .slice(0, 32);
const READINGS_PER_DEVICE = 60;
const HOUR_MS = 60 * 60 * 1000;
const WAVE_LIMIT_MS = 5000;

if (!allowedBaseUrls.has(BASE_URL)) {
  throw new Error('O teste está restrito ao servidor local na porta 7878');
}

if (!Number.isSafeInteger(MAX_DEVICES) || MAX_DEVICES < 1) {
  throw new Error('MAX_DEVICES deve ser um inteiro maior que zero');
}

const waveDurationMetric = new Trend('wave_duration_ms', true);
const requestDurationMetric = new Trend('device_request_duration_ms', true);
const waveDeviceMetric = new Gauge('wave_device_count');
const waveReadingMetric = new Counter('wave_reading_count');

export const options = {
  scenarios: {
    hourlyWaves: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '30m',
    },
  },
  batch: MAX_DEVICES,
  batchPerHost: MAX_DEVICES,
};

function getWaveTargets(maxDevices) {
  return [
    ...new Set([
      1,
      Math.ceil(maxDevices * 0.25),
      Math.ceil(maxDevices * 0.5),
      Math.ceil(maxDevices * 0.75),
      maxDevices,
    ]),
  ];
}

export default function () {
  const targets = getWaveTargets(MAX_DEVICES);

  for (let waveIndex = 0; waveIndex < targets.length; waveIndex += 1) {
    const deviceCount = targets[waveIndex];
    const payloadBuildStarted = Date.now();
    const hourStart = Date.now() + waveIndex * HOUR_MS;
    const readings = Array.from({ length: READINGS_PER_DEVICE }, (_, index) => {
      const sample = index % 100;
      return {
        timestamp: new Date(
          hourStart + Math.floor((index * HOUR_MS) / READINGS_PER_DEVICE),
        ).toISOString(),
        humidity_percent: 30 + (sample % 51),
        soil_ph: Number((5 + (sample % 80) / 10).toFixed(1)),
        temperature_c: Number((12 + (sample % 180) / 10).toFixed(1)),
      };
    });
    const readingsJson = JSON.stringify(readings);
    const requests = Array.from({ length: deviceCount }, (_, deviceIndex) => {
      const deviceId =
        `hourly-${RUN_ID}-${String(deviceIndex + 1).padStart(4, '0')}`;
      const body =
        `{"device_id":${JSON.stringify(deviceId)},"readings":${readingsJson}}`;
      return [
        'POST',
        `${BASE_URL}/readings/batch`,
        body,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: '5s',
        },
      ];
    });
    const payloadBuildMs = Date.now() - payloadBuildStarted;

    const waveStarted = Date.now();
    const responses = http.batch(requests);
    const waveDurationMs = Date.now() - waveStarted;
    const requestDurations = responses.map((response) => response.timings.duration);
    const requestDurationTotal = requestDurations.reduce(
      (total, duration) => total + duration,
      0,
    );
    const requestDurationMax = requestDurations.reduce(
      (maximum, duration) => Math.max(maximum, duration),
      0,
    );
    let failedRequests = 0;

    for (const response of responses) {
      requestDurationMetric.add(response.timings.duration);
      const stored = check(response, {
        'lote de 60 leituras gravado': (result) =>
          result.status === 201 &&
          result.json('inserted_count') === READINGS_PER_DEVICE,
      });
      if (!stored) {
        failedRequests += 1;
      }
    }
    waveDurationMetric.add(waveDurationMs);
    waveDeviceMetric.add(deviceCount);
    waveReadingMetric.add(deviceCount * READINGS_PER_DEVICE);
    console.log(
      `[hourly-wave] ${JSON.stringify({
        wave: waveIndex + 1,
        devices: deviceCount,
        readings_per_device: READINGS_PER_DEVICE,
        total_readings: deviceCount * READINGS_PER_DEVICE,
        payload_build_ms: payloadBuildMs,
        wave_duration_ms: waveDurationMs,
        request_avg_ms: Number(
          (requestDurationTotal / requestDurations.length).toFixed(2),
        ),
        request_max_ms: Number(requestDurationMax.toFixed(2)),
        failed_requests: failedRequests,
      })}`,
    );

    if (failedRequests > 0) {
      exec.test.abort(`A onda ${waveIndex + 1} teve ${failedRequests} requests inválidas`);
    }
    if (waveDurationMs >= WAVE_LIMIT_MS) {
      exec.test.abort(
        `A onda com ${deviceCount} dispositivos demorou ${waveDurationMs}ms (limite: ${WAVE_LIMIT_MS}ms)`,
      );
    }
    if (waveIndex < targets.length - 1) {
      // sleep(1);
    }
  }

  console.log(`[hourly-wave] MAX_DEVICES=${MAX_DEVICES} concluído abaixo de 1 segundo`);
}
