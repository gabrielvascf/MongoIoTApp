import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://host.docker.internal:7878';
const allowedBaseUrls = new Set([
  'http://localhost:7878',
  'http://127.0.0.1:7878',
  'http://host.docker.internal:7878',
  'http://server:7878',
]);

if (!allowedBaseUrls.has(BASE_URL)) {
  throw new Error('O teste de carga está restrito ao servidor local na porta 7878');
}

const measurementShapes = [
  ['humidity_percent'],
  ['soil_ph'],
  ['temperature_c'],
  ['humidity_percent', 'soil_ph'],
  ['humidity_percent', 'temperature_c'],
  ['soil_ph', 'temperature_c'],
  ['humidity_percent', 'soil_ph', 'temperature_c'],
];

export const options = {
  scenarios: {
    readings: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 200,
      stages: [
        { target: 10, duration: '30s' },
        { target: 20, duration: '30s' },
        { target: 50, duration: '30s' },
        { target: 0, duration: '10s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const workerId = __VU;
  const supportedMeasurements =
    measurementShapes[(workerId - 1) % measurementShapes.length];
  const batchEnd = Date.now();
  const readings = Array.from({ length: 60 }, (_, minute) => {
    const sample = {
      timestamp: new Date(batchEnd - (60 - minute) * 60_000).toISOString(),
    };

    if (supportedMeasurements.includes('humidity_percent')) {
      sample.humidity_percent = 20 + ((workerId + minute) % 61);
    }
    if (supportedMeasurements.includes('soil_ph')) {
      sample.soil_ph = Number((5 + ((workerId + minute) % 90) / 10).toFixed(1));
    }
    if (supportedMeasurements.includes('temperature_c')) {
      sample.temperature_c = Number((10 + ((workerId + minute) % 300) / 10).toFixed(1));
    }

    return sample;
  });
  const payload = JSON.stringify({
    device_id: `loadtest-${workerId}`,
    readings,
  });

  const response = http.post(`${BASE_URL}/readings/batch`, payload, {
    headers: {
      'Content-Type': 'application/json',
    },
  });

  check(response, {
    'lote de 60 leituras gravado': (r) =>
      r.status === 201 && r.json('inserted_count') === 60,
  });
}
