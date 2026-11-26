const DEVICE_COUNT = 100;
const DAYS = 30*6;
const MINUTES_PER_DAY = 24 * 60;
const MINUTE_MS = 60 * 1000;
const READINGS_PER_DEVICE = DAYS * MINUTES_PER_DAY;
const EXPECTED_READINGS = DEVICE_COUNT * READINGS_PER_DEVICE;
const BATCH_SIZE = 1000;

const sensorProfiles = [
  { suffix: 'H', sensors: ['humidity_percent'] },
  { suffix: 'P', sensors: ['soil_ph'] },
  { suffix: 'T', sensors: ['temperature_c'] },
  { suffix: 'H-P', sensors: ['humidity_percent', 'soil_ph'] },
  { suffix: 'H-T', sensors: ['humidity_percent', 'temperature_c'] },
  { suffix: 'P-T', sensors: ['soil_ph', 'temperature_c'] },
  {
    suffix: 'H-P-T',
    sensors: ['humidity_percent', 'soil_ph', 'temperature_c'],
  },
];

const READINGS_COLLECTION = 'readings_ts';
const collectionInfo = db.getCollectionInfos({ name: READINGS_COLLECTION })[0];
if (!collectionInfo) {
  db.createCollection(READINGS_COLLECTION, {
    timeseries: {
      timeField: 'timestamp',
      metaField: 'device_id',
      granularity: 'minutes',
    },
  });
} else {
  const timeseries = collectionInfo.options.timeseries;
  if (
    !timeseries ||
    timeseries.timeField !== 'timestamp' ||
    timeseries.metaField !== 'device_id' ||
    timeseries.granularity !== 'minutes'
  ) {
    throw new Error(
      `${READINGS_COLLECTION} exists but is not the expected time-series collection`,
    );
  }
}
const readings = db.getCollection(READINGS_COLLECTION);

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
  const profile = sensorProfiles[deviceIndex % sensorProfiles.length];
  const deviceId = `seed-device-${String(deviceIndex + 1).padStart(3, '0')} (${profile.suffix})`;
  const devicePhase = deviceIndex * 0.13;
  const humidityAmplitude = 7 + (deviceIndex % 5);
  const soilPhAmplitude = 0.2 + (deviceIndex % 4) * 0.05;
  const temperatureAmplitude = 5 + (deviceIndex % 5) * 0.8;

  for (let minuteIndex = 0; minuteIndex < READINGS_PER_DEVICE; minuteIndex += 1) {
    const minuteOfDay = minuteIndex % MINUTES_PER_DAY;
    const dailyPhase = (minuteOfDay / MINUTES_PER_DAY) * Math.PI * 2 - Math.PI / 2;
    const timestamp = new Date(startTime + minuteIndex * MINUTE_MS);
    const reading = {
      device_id: deviceId,
      timestamp,
    };

    if (profile.sensors.includes('humidity_percent')) {
      reading.humidity_percent = clamp(
        43 +
          (deviceIndex % 8) * 3 +
          humidityAmplitude * Math.sin(dailyPhase + devicePhase),
        0,
        100,
      );
    }

    if (profile.sensors.includes('soil_ph')) {
      reading.soil_ph =
        4.8 +
        (deviceIndex % 14) * 0.25 +
        soilPhAmplitude * Math.sin(dailyPhase + devicePhase + Math.PI / 3);
    }

    if (profile.sensors.includes('temperature_c')) {
      reading.temperature_c =
        13 +
        (deviceIndex % 18) * 0.8 +
        temperatureAmplitude * Math.sin(dailyPhase + devicePhase + Math.PI / 2);
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
