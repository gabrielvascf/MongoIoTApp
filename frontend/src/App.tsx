import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import './App.css';

type Reading = {
  timestamp_ms: number;
  humidity_percent?: number;
  soil_ph?: number;
  temperature_c?: number;
};

type Period = 24 | 168 | 720;
type MetricKey = 'humidity_percent' | 'soil_ph' | 'temperature_c';

type Metric = {
  key: MetricKey;
  label: string;
  shortLabel: string;
  unit: string;
  color: string;
  range?: [number, number];
};

const metrics: Metric[] = [
  {
    key: 'humidity_percent',
    label: 'Humidade do solo',
    shortLabel: 'Humidade',
    unit: '%',
    color: '#13866b',
    range: [0, 100],
  },
  {
    key: 'soil_ph',
    label: 'pH do solo',
    shortLabel: 'pH',
    unit: '',
    color: '#8064d8',
    range: [0, 14],
  },
  {
    key: 'temperature_c',
    label: 'Temperatura',
    shortLabel: 'Temperatura',
    unit: '°C',
    color: '#e18a47',
  },
];

const periods: { value: Period; label: string }[] = [
  { value: 24, label: '24 horas' },
  { value: 168, label: '7 dias' },
  { value: 720, label: '30 dias' },
];

const MAX_READINGS_PER_DEVICE = 30 * 24 * 60;

async function getJson<T>(
  url: string,
  signal: AbortSignal,
  isExpected: (value: unknown) => value is T,
): Promise<T> {
  const response = await fetch(url, { signal });
  const body: unknown = await response.json();

  if (!response.ok) {
    throw new Error(
      isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `Erro HTTP ${response.status}`,
    );
  }

  if (!isExpected(body)) {
    throw new Error('O servidor retornou uma resposta em formato inválido.');
  }

  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDeviceList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((device) => typeof device === 'string');
}

function isReadingsResponse(value: unknown): value is { readings: Reading[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.readings) &&
    value.readings.every(
      (reading) =>
        isRecord(reading) &&
        typeof reading.timestamp_ms === 'number' &&
        Number.isFinite(reading.timestamp_ms) &&
        metrics.every(
          (metric) =>
            reading[metric.key] === undefined ||
            (typeof reading[metric.key] === 'number' &&
              Number.isFinite(reading[metric.key])),
        ),
    )
  );
}

function formatValue(value: number | undefined, unit: string): string {
  if (value === undefined) {
    return '—';
  }

  return `${value.toLocaleString('pt-BR', {
    maximumFractionDigits: 1,
  })}${unit ? ` ${unit}` : ''}`;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('pt-BR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Icon({
  name,
  className = 'h-5 w-5',
}: {
  name: 'leaf' | 'refresh' | 'chevron' | 'drop' | 'thermometer' | 'flask' | 'pulse';
  className?: string;
}) {
  const paths: Record<typeof name, ReactNode> = {
    leaf: (
      <>
        <path d="M20.7 3.3C12.2 2.8 5.4 5.2 4.1 10.1c-.8 3.1 1.3 5.7 4.2 5.9 5.3.4 10.9-4.9 12.4-12.7Z" />
        <path d="M3 21c2.4-5.3 6.7-8.8 12.7-11.2" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5" />
        <path d="M4.7 9A7 7 0 0 1 17 6.2L20 12M4 17v-5h5" />
        <path d="M19.3 15A7 7 0 0 1 7 17.8L4 12" />
      </>
    ),
    chevron: <path d="m7 10 5 5 5-5" />,
    drop: (
      <>
        <path d="M12 22a8 8 0 0 0 8-8c0-4-8-12-8-12S4 10 4 14a8 8 0 0 0 8 8Z" />
        <path d="M8 14a4 4 0 0 0 4 4" />
      </>
    ),
    thermometer: (
      <>
        <path d="M14 14.8V5a3 3 0 0 0-6 0v9.8a5 5 0 1 0 6 0Z" />
        <path d="M11 12v6" />
      </>
    ),
    flask: (
      <>
        <path d="M9 3h6M10 3v7l-5.4 8.3A2.5 2.5 0 0 0 6.7 22h10.6a2.5 2.5 0 0 0 2.1-3.7L14 10V3" />
        <path d="M8 16h8" />
      </>
    ),
    pulse: (
      <>
        <path d="M3 12h4l3-8 4 16 3-8h4" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      {paths[name]}
    </svg>
  );
}

function SensorChart({
  metric,
  readings,
}: {
  metric: Metric;
  readings: Reading[];
}) {
  const samples = readings.flatMap((reading) => {
    const value = reading[metric.key];
    return typeof value === 'number' && Number.isFinite(value)
      ? [{ timestamp_ms: reading.timestamp_ms, value }]
      : [];
  });

  if (samples.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-xl bg-slate-50 text-sm text-slate-400">
        Sem leituras desta variável neste período
      </div>
    );
  }

  const plot = { left: 52, right: 760, top: 16, bottom: 174 };
  const times = samples.map((sample) => sample.timestamp_ms);
  const firstTime = Math.min(...times);
  const lastTime = Math.max(...times);
  let minValue =
    metric.range?.[0] ??
    Math.min(...samples.map((sample) => sample.value));
  let maxValue =
    metric.range?.[1] ??
    Math.max(...samples.map((sample) => sample.value));

  if (!metric.range) {
    const padding =
      minValue === maxValue
        ? Math.max(Math.abs(minValue) * 0.1, 1)
        : (maxValue - minValue) * 0.1;
    minValue -= padding;
    maxValue += padding;
  }

  const x = (time: number) =>
    plot.left +
    ((time - firstTime) / Math.max(lastTime - firstTime, 1)) *
      (plot.right - plot.left);
  const y = (value: number) =>
    plot.bottom -
    ((value - minValue) / (maxValue - minValue)) *
      (plot.bottom - plot.top);
  const points = samples
    .map(
      (sample) =>
        `${x(sample.timestamp_ms)},${y(sample.value)}`,
    )
    .join(' ');

  return (
    <svg
      aria-label={`Gráfico de ${metric.label.toLocaleLowerCase('pt-BR')}`}
      className="h-auto w-full overflow-visible"
      role="img"
      viewBox="0 0 780 218"
    >
      {[0, 1, 2, 3, 4].map((tick) => {
        const value = minValue + ((maxValue - minValue) * tick) / 4;
        const yPosition = y(value);

        return (
          <g key={tick}>
            <line
              stroke="#e9eef2"
              strokeDasharray={tick === 0 ? undefined : '3 5'}
              x1={plot.left}
              x2={plot.right}
              y1={yPosition}
              y2={yPosition}
            />
            <text
              fill="#8a98a6"
              fontSize="11"
              textAnchor="end"
              x={plot.left - 10}
              y={yPosition + 4}
            >
              {value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}
            </text>
          </g>
        );
      })}
      <polyline
        fill="none"
        points={points}
        stroke={metric.color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.75"
        vectorEffect="non-scaling-stroke"
      />
      {samples.length === 1 && (
        <circle
          cx={x(samples[0].timestamp_ms)}
          cy={y(samples[0].value)}
          fill={metric.color}
          r="4"
        />
      )}
      <line
        stroke="#dbe3e9"
        x1={plot.left}
        x2={plot.right}
        y1={plot.bottom}
        y2={plot.bottom}
      />
      <text fill="#8a98a6" fontSize="11" x={plot.left} y="203">
        {formatTimestamp(firstTime)}
      </text>
      <text
        fill="#8a98a6"
        fontSize="11"
        textAnchor="end"
        x={plot.right}
        y="203"
      >
        {formatTimestamp(lastTime)}
      </text>
    </svg>
  );
}

function App() {
  const [devices, setDevices] = useState<string[]>([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [period, setPeriod] = useState<Period>(24);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [readingsLoading, setReadingsLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [devicesRefreshKey, setDevicesRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setDevicesLoading(true);
    setError('');

    getJson('/api/devices', controller.signal, isDeviceList)
      .then((result) => {
        setDevices(result);
        setSelectedDevice((current) =>
          current && result.includes(current) ? current : (result[0] ?? ''),
        );
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Não foi possível carregar os dispositivos.',
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setDevicesLoading(false);
        }
      });

    return () => controller.abort();
  }, [devicesRefreshKey]);

  useEffect(() => {
    if (!selectedDevice) {
      setReadings([]);
      setReadingsLoading(false);
      return;
    }

    const controller = new AbortController();
    const to = new Date();
    const from = new Date(to.getTime() - period * 60 * 60 * 1000);
    const query = new URLSearchParams({
      device_id: selectedDevice,
      from: from.toISOString(),
      to: to.toISOString(),
    });

    setReadingsLoading(true);
    setReadings([]);
    setError('');

    getJson(
      `/api/readings?${query}`,
      controller.signal,
      isReadingsResponse,
    )
      .then((result) => setReadings(result.readings))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Não foi possível carregar as leituras.',
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setReadingsLoading(false);
        }
      });

    return () => controller.abort();
  }, [selectedDevice, period, refreshKey]);

  const latestValues = useMemo(() => {
    return metrics.map((metric) => {
      const latest = [...readings]
        .reverse()
        .find((reading) => Number.isFinite(reading[metric.key]));
      return { ...metric, value: latest?.[metric.key] };
    });
  }, [readings]);

  const hasDevice = devices.length > 0;
  const statusText = devicesLoading
    ? 'Conectando ao servidor…'
    : readingsLoading
      ? 'Atualizando leituras…'
      : error
        ? 'Falha ao atualizar'
        : hasDevice
          ? 'Sistema atualizado'
          : 'Aguardando dispositivos';

  return (
    <div className="min-h-screen bg-[#f7f9f8] text-slate-900">
      <header className="border-b border-slate-200/80 bg-white">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-5 py-4 sm:px-8">
          <a className="flex items-center gap-3" href="/" aria-label="Solo vivo">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-700 text-white shadow-sm shadow-emerald-900/15">
              <Icon name="leaf" className="h-6 w-6" />
            </span>
            <span>
              <span className="block text-[15px] font-bold tracking-tight text-slate-900">
                solo<span className="text-emerald-700">vivo</span>
              </span>
              <span className="block text-[11px] font-medium tracking-wide text-slate-400">
                MONITORAMENTO INTELIGENTE
              </span>
            </span>
          </a>

          <div
            className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600"
            role="status"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                error
                  ? 'bg-rose-500'
                  : devicesLoading || readingsLoading
                    ? 'animate-pulse bg-amber-400'
                    : 'bg-emerald-500'
              }`}
            />
            <span className="hidden sm:inline">{statusText}</span>
            <span className="sm:hidden">
              {error
                ? 'Offline'
                : devicesLoading || readingsLoading
                  ? 'Carregando'
                  : 'Online'}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-5 pb-12 pt-8 sm:px-8 sm:pt-10">
        <section className="mb-8 flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div>
            <p className="mb-2 text-sm font-semibold text-emerald-700">
              PAINEL DE CONTROLE
            </p>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-[2.1rem]">
              Saúde do seu solo
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500 sm:text-base">
              Acompanhe as condições do solo e o histórico dos seus sensores em
              um só lugar.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex min-w-56 flex-col gap-1.5 text-xs font-semibold text-slate-500">
              DISPOSITIVO
              <span className="relative">
                <select
                  aria-label="Dispositivo"
                  className="h-11 w-full appearance-none rounded-xl border border-slate-200 bg-white pl-3.5 pr-10 text-sm font-medium text-slate-800 shadow-sm outline-none transition focus:border-emerald-600 focus:ring-4 focus:ring-emerald-600/10 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  disabled={!hasDevice || devicesLoading}
                  onChange={(event) => setSelectedDevice(event.target.value)}
                  value={selectedDevice}
                >
                  {devices.length === 0 ? (
                    <option value="">
                      {devicesLoading ? 'Carregando…' : 'Sem dispositivos'}
                    </option>
                  ) : (
                    devices.map((device) => (
                      <option key={device} value={device}>
                        {device}
                      </option>
                    ))
                  )}
                </select>
                <Icon
                  name="chevron"
                  className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                />
              </span>
            </label>

            <div className="flex h-11 items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
              {periods.map((option) => (
                <button
                  aria-pressed={period === option.value}
                  className={`h-full rounded-lg px-3 text-xs font-semibold transition sm:px-3.5 ${
                    period === option.value
                      ? 'bg-emerald-700 text-white shadow-sm'
                      : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
                  }`}
                  key={option.value}
                  onClick={() => setPeriod(option.value)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>

            <button
              aria-label="Atualizar dados"
              className="flex h-11 w-11 items-center justify-center self-end rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!hasDevice || readingsLoading}
              onClick={() => setRefreshKey((key) => key + 1)}
              title="Atualizar dados"
              type="button"
            >
              <Icon
                name="refresh"
                className={`h-[18px] w-[18px] ${readingsLoading ? 'animate-spin' : ''}`}
              />
            </button>
          </div>
        </section>

        {error && (
          <div
            className="mb-6 flex flex-col gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 sm:flex-row sm:items-center sm:justify-between"
            role="alert"
          >
            <span>
              <strong className="font-semibold">Não foi possível atualizar:</strong>{' '}
              {error}
            </span>
            <button
              className="shrink-0 font-semibold underline underline-offset-2"
              onClick={() => {
                if (hasDevice) {
                  setRefreshKey((key) => key + 1);
                } else {
                  setDevicesRefreshKey((key) => key + 1);
                }
              }}
              type="button"
            >
              Tentar novamente
            </button>
          </div>
        )}

        {!devicesLoading && !hasDevice ? (
          <section className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center shadow-sm">
            <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700">
              <Icon name="pulse" className="h-7 w-7" />
            </span>
            <h2 className="text-lg font-semibold text-slate-900">
              {error
                ? 'Não foi possível conectar ao painel'
                : 'Ainda não há dispositivos'}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
              {error
                ? 'Verifique se o servidor está em execução e tente novamente.'
                : 'Quando um sensor enviar leituras, ele aparecerá aqui e você poderá acompanhar os dados do solo.'}
            </p>
            {error && (
              <button
                className="mt-5 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-800"
                onClick={() =>
                  setDevicesRefreshKey((key) => key + 1)
                }
                type="button"
              >
                Tentar novamente
              </button>
            )}
          </section>
        ) : (
          <>
            <section
              aria-label="Resumo das leituras"
              className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
            >
              <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.025)]">
                <div className="mb-5 flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-500">
                    Leituras no período
                  </span>
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-50 text-sky-700">
                    <Icon name="pulse" className="h-[18px] w-[18px]" />
                  </span>
                </div>
                <p className="text-3xl font-bold tracking-tight text-slate-900">
                  {readingsLoading && readings.length === 0
                    ? '—'
                    : readings.length.toLocaleString('pt-BR')}
                </p>
                <p className="mt-1.5 text-xs text-slate-400">
                  {selectedDevice || 'Selecione um dispositivo'}
                </p>
              </article>

              {latestValues.map((metric) => {
                const icon =
                  metric.key === 'humidity_percent'
                    ? 'drop'
                    : metric.key === 'soil_ph'
                      ? 'flask'
                      : 'thermometer';

                return (
                  <article
                    className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.025)]"
                    key={metric.key}
                  >
                    <div className="mb-5 flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-500">
                        {metric.shortLabel}
                      </span>
                      <span
                        className="flex h-9 w-9 items-center justify-center rounded-xl"
                        style={{
                          color: metric.color,
                          backgroundColor: `${metric.color}12`,
                        }}
                      >
                        <Icon
                          name={icon}
                          className="h-[18px] w-[18px]"
                        />
                      </span>
                    </div>
                    <p className="text-3xl font-bold tracking-tight text-slate-900">
                      {formatValue(metric.value, metric.unit)}
                    </p>
                    <p className="mt-1.5 text-xs text-slate-400">
                      Último valor registado
                    </p>
                  </article>
                );
              })}
            </section>

            <section aria-label="Séries temporais" className="space-y-4">
              {metrics.map((metric) => {
                const lastSample = [...readings]
                  .reverse()
                  .find((reading) => Number.isFinite(reading[metric.key]));

                return (
                  <article
                    aria-busy={readingsLoading}
                    className={`rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.025)] transition-opacity sm:p-6 ${
                      readingsLoading ? 'opacity-65' : ''
                    }`}
                    key={metric.key}
                  >
                    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2.5">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: metric.color }}
                          />
                          <h2 className="font-semibold text-slate-900">
                            {metric.label}
                          </h2>
                        </div>
                        <p className="ml-5 mt-1 text-xs text-slate-400">
                          Histórico das leituras do dispositivo
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold text-slate-800">
                          {formatValue(lastSample?.[metric.key], metric.unit)}
                        </p>
                        {lastSample && (
                          <p className="text-[11px] text-slate-400">
                            {formatTimestamp(lastSample.timestamp_ms)}
                          </p>
                        )}
                      </div>
                    </div>
                    <SensorChart metric={metric} readings={readings} />
                  </article>
                );
              })}
            </section>

            <footer className="mt-5 flex flex-col gap-1 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
              <span>
                Exibindo até{' '}
                {MAX_READINGS_PER_DEVICE.toLocaleString('pt-BR')} leituras para{' '}
                {selectedDevice || '—'}
              </span>
              <span>
                {readings.length === MAX_READINGS_PER_DEVICE
                  ? 'Limite mensal de resultados atingido.'
                  : readings.length === 1
                    ? '1 leitura encontrada'
                    : `${readings.length.toLocaleString('pt-BR')} leituras encontradas`}
              </span>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
