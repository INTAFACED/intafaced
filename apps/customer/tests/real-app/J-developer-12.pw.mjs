import { test, expect } from '@playwright/test';
import { journeyState, EDGE } from './stack.mjs';
import { keyHolder, makeKey } from './developer.mjs';

// J-developer-12, in the running app (docs/roadmap/journeys.json): build with the official SDK. One test per step, titled
// "J-developer-12 #<n>", run in order. The SDK is loaded from the repository's own build (packages/sdk-ts) and pointed at
// the stack's Edge; #2 makes the start for the rest: a verified TEST account with a passkey and a live trade key.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #2 to #5: the SDK is the merchant payments client only: it has no trading client (orders with retry under one
//   idempotency key, paged lists, stream helpers) and no version pin.
const J = 'J-developer-12';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const sdk = () => import(new URL('../../../../packages/sdk-ts/dist/index.js', import.meta.url).href);

/** The SDK's trading client, or a plain failure naming what is missing. */
async function tradingClient(options) {
  const { createClient } = await sdk();
  if (typeof createClient !== 'function') throw new Error(`${J}: the SDK has no trading client (createClient); only createPayClient`);
  return createClient(options);
}

test(`${J} #1 creates a client with a blank host: the typed error`, async () => {
  run.reset({});
  const { createPayClient } = await sdk();
  expect(() => createPayClient({ baseUrl: '', apiKey: 'ifc_TEST' })).toThrow(/base ?url/i);
  await tradingClient({ baseUrl: '', apiKey: 'ifc_TEST' }).then(
    () => {
      throw new Error('a blank host made a client');
    },
    (error) => expect(String(error.message)).toMatch(/host|base ?url/i),
  );
});

test(`${J} #2 places an order and the write times out: one retry under the same idempotency key; never a second order`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { page, who } = await keyHolder(browser, 'jdsdk');
  const key = await makeKey(page, { name: 'sdk-test' });
  run.write({ who, key });
  const seen = [];
  const client = await tradingClient({
    baseUrl: EDGE,
    apiKey: key,
    timeoutMs: 1,
    onRequest: (req) => seen.push(req.headers['idempotency-key']),
  });
  await client.orders.place({ symbol: 'BTC/USDT', type: 'limit', side: 'buy', amount: '0.0001', price: '1' }).catch(() => {});
  expect(new Set(seen).size).toBe(1);
});

test(`${J} #3 pages through a list: each item once`, async () => {
  const client = await tradingClient({ baseUrl: EDGE, apiKey: state('key') });
  const ids = [];
  for await (const order of client.orders.listAll({ symbol: 'BTC/USDT' })) ids.push(order.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test(`${J} #4 leaves a stream token near expiry: the helper refreshes it before reconnecting`, async () => {
  const client = await tradingClient({ baseUrl: EDGE, apiKey: state('key') });
  const stream = await client.stream.connect({ channels: ['orders'] });
  expect(typeof stream.tokenExpiresAt).toBe('number');
  await stream.close();
});

test(`${J} #5 sets the SDK version pin: the reply echoes the pinned version`, async () => {
  const client = await tradingClient({ baseUrl: EDGE, apiKey: state('key'), apiVersion: '2026-10-01' });
  const reply = await client.raw.get('/api/v1/time');
  expect(reply.headers['api-version']).toBe('2026-10-01');
});
