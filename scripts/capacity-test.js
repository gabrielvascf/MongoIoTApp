import exec from 'k6/execution';
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:7878';
const allowedBaseUrls = new Set([
  'http://localhost:7878',
  'http://127.0.0.1:7878',
  'http://host.docker.internal:7878',
  'http://server:7878',
]);
const MAX_DEVICES = Number(__ENV.MAX_DEVICES || 25);
const RUN_ID = (__ENV.CAPACITY_RUN_ID || 'local')
  .replace(/[^a-zA-Z0-9-]/g, '-')
  .slice(0, 32);
const READINGS_PER_DEVICE = 60;
let lastStatusLogAt = 0;

if (!allowedBaseUrls.has(BASE_URL)) {
  throw new Error('O teste de capacidade está restrito ao servidor local na porta 7878');
}

if (!Number.isSafeInteger(MAX_DEVICES) || MAX_DEVICES < 1) {
  throw new Error('MAX_DEVICES deve ser um inteiro maior que zero');
}

export const options = {
  scenarios: {
    devices: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { target: Math.ceil(MAX_DEVICES * 0.25), duration: '5s' },
        { target: Math.ceil(MAX_DEVICES * 0.5), duration: '5s' },
        { target: Math.ceil(MAX_DEVICES * 0.75), duration: '5s' },
        { target: MAX_DEVICES, duration: '5s' },
        { target: MAX_DEVICES, duration: '10s' },
      ],
      gracefulRampDown: '1s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const batchEnd = Date.now();
  const readings = Array.from({ length: READINGS_PER_DEVICE }, (_, minute) => {
    const sample = (__VU + minute) % 60;
    return {
      timestamp: new Date(batchEnd - (READINGS_PER_DEVICE - minute) * 60_000).toISOString(),
      humidity_percent: 30 + (sample % 51),
      soil_ph: Number((5 + (sample % 80) / 10).toFixed(1)),
      temperature_c: Number((12 + (sample % 180) / 10).toFixed(1)),
    };
  });
  const deviceId = `capacity-${RUN_ID}-${String(__VU).padStart(3, '0')} (H-P-T)`;
  const response = http.post(
    `${BASE_URL}/readings/batch`,
    JSON.stringify({ device_id: deviceId, readings }),
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: '5s',
    },
  );
  const responseTime = response.timings.duration;
  const stored = check(response, {
    'lote de 60 leituras gravado': (r) =>
      r.status === 201 && r.json('inserted_count') === READINGS_PER_DEVICE,
  });

  const now = Date.now();
  if (__VU === 1 && now - lastStatusLogAt >= 1000) {
    console.log(
      `[capacity] dispositivos_ativos=${exec.instance.vusActive}/${MAX_DEVICES} ` +
        `device=${deviceId} resposta=${responseTime.toFixed(1)}ms`,
    );
    lastStatusLogAt = now;
  }

  if (responseTime > 1000) {
    exec.test.abort(`Resposta acima de 1 segundo: ${responseTime.toFixed(1)}ms`);
  }
  if (!stored) {
    exec.test.abort(`O servidor não gravou o lote do dispositivo ${deviceId}`);
  }
}
