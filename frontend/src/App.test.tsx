import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

const readings = [
  {
    timestamp_ms: 1795636800000,
    humidity_percent: 54.2,
    soil_ph: 6.4,
    temperature_c: 22.8,
  },
];
let requestedUrls: string[] = [];

beforeEach(() => {
  requestedUrls = [];
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    const body = url === '/api/devices'
      ? ['sensor-estufa']
      : { readings };

    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    } as Response);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('loads device readings and displays the sensor dashboard', async () => {
  render(<App />);

  expect(
    await screen.findByRole('option', { name: 'sensor-estufa' }),
  ).toBeInTheDocument();
  await screen.findByRole('img', { name: 'Gráfico de humidade do solo' });
  expect(screen.getAllByText('54,2 %')).toHaveLength(2);
  expect(screen.getByRole('heading', { name: 'Humidade do solo' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Gráfico de humidade do solo' })).toBeInTheDocument();
  expect(screen.getByText('1 leitura encontrada')).toBeInTheDocument();
});

test('reloads readings when the selected period changes', async () => {
  render(<App />);
  await screen.findByRole('option', { name: 'sensor-estufa' });
  const initialReadingsRequests = requestedUrls.filter((url) =>
    url.startsWith('/api/readings?'),
  ).length;

  fireEvent.click(screen.getByRole('button', { name: '7 dias' }));

  await waitFor(() => {
    expect(
      requestedUrls.filter((url) => url.startsWith('/api/readings?')),
    ).toHaveLength(initialReadingsRequests + 1);
  });
  const latestRequest = requestedUrls
    .filter((url) => url.startsWith('/api/readings?'))
    .pop();
  const query = new URLSearchParams(latestRequest?.split('?')[1]);
  expect(query.get('device_id')).toBe('sensor-estufa');
  expect(
    Date.parse(query.get('to') ?? '') - Date.parse(query.get('from') ?? ''),
  ).toBe(168 * 60 * 60 * 1000);
  expect(screen.getByRole('button', { name: '7 dias' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('shows an empty state when no devices have reported readings', async () => {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve([]),
    } as Response),
  );

  render(<App />);

  expect(
    await screen.findByRole('heading', { name: 'Ainda não há dispositivos' }),
  ).toBeInTheDocument();
});
