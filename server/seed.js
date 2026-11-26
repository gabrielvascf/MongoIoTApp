const DEVICE_COUNT = 100;
const DAYS = 30;
const MINUTES_PER_DAY = 24 * 60;
const MINUTE_MS = 60 * 1000;
const READINGS_PER_DEVICE = DAYS * MINUTES_PER_DAY;
const EXPECTED_READINGS = DEVICE_COUNT * READINGS_PER_DEVICE;
const BATCH_SIZE = 1000;

const sensorProfiles = [
  ['humidity_percent'],
  ['soil_ph'],
  ['temperature_c'],
  ['humidity_percent', 'soil_ph'],
  ['humidity_percent', 'temperature_c'],
  ['soil_ph', 'temperature_c'],
  ['humidity_percent', 'soil_ph', 'temperature_c'],
];

const readings = db.getCollection('readings');
readings.createIndex({ device_id: 1, timestamp: -1 });

const endTime = Date.now();
const startTime = endTime - DAYS * 24 * 60 * MINUTE_MS;
let operations = [];
let insertedCount = 0;

function flushBatch() {
  if (operations.length === 0) {
    return;
  }

  const result = readings.bulkWrite(operations, { ordered: false });
  insertedCount += result.insertedCount;
  operations = [];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

print(`Banco: ${db.getName()}`);
print(
  `Gerando ${EXPECTED_READINGS.toLocaleString()} leituras (${DEVICE_COUNT} dispositivos, ${DAYS} dias).`,
);

for (let deviceIndex = 0; deviceIndex < DEVICE_COUNT; deviceIndex += 1) {
  const deviceId = `seed-device-${String(deviceIndex + 1).padStart(3, '0')}`;
  const profile = sensorProfiles[deviceIndex % sensorProfiles.length];

  for (let minuteIndex = 0; minuteIndex < READINGS_PER_DEVICE; minuteIndex += 1) {
    const minuteOfDay = minuteIndex % MINUTES_PER_DAY;
    const dailyPhase = (minuteOfDay / MINUTES_PER_DAY) * Math.PI * 2 - Math.PI / 2;
    const timestamp = new Date(startTime + minuteIndex * MINUTE_MS);
    const reading = {
      device_id: deviceId,
      timestamp,
    };

    if (profile.includes('humidity_percent')) {
      reading.humidity_percent = clamp(
        43 +
          (deviceIndex % 8) * 3 +
          9 * Math.sin(dailyPhase + deviceIndex * 0.13) +
          2.5 * Math.sin((minuteIndex + deviceIndex * 7) * 0.07),
        0,
        100,
      );
    }

    if (profile.includes('soil_ph')) {
      reading.soil_ph =
        4.8 + (deviceIndex % 14) * 0.25 + 0.18 * Math.sin(minuteIndex * 0.008 + deviceIndex);
    }

    if (profile.includes('temperature_c')) {
      reading.temperature_c =
        13 +
        (deviceIndex % 18) * 0.8 +
        7 * Math.sin(dailyPhase) +
        1.2 * Math.sin((minuteIndex + deviceIndex * 3) * 0.05);
    }

    operations.push({ insertOne: { document: reading } });
    if (operations.length >= BATCH_SIZE) {
      flushBatch();
    }
  }

  flushBatch();
  print(
    `Dispositivos ${deviceIndex + 1}/${DEVICE_COUNT}; ${insertedCount.toLocaleString()} leituras inseridas.`,
  );
}

print(`Concluído: ${insertedCount.toLocaleString()} leituras inseridas.`);
