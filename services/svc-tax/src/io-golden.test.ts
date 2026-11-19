/**
 * The golden the Rust clients replay (crates/svc-tax/tests/io_golden.rs): every request the TypeScript clients send
 * (method, URL, the headers they set, body) for scripted upstream answers, and what each client made of the answers.
 * Recorded with a fixed clock, a fixed S2S key and a fixed nonce, so every signature is reproducible.
 *
 * `RECORD_IO_GOLDEN=1` rewrites the file; otherwise this test fails when the TypeScript clients no longer produce it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBankOwnSpacesClient,
  createServiceSigner,
  createTradeVenueActivityClient,
  parseKeyring,
  serviceAuthHeadersForBody,
  serviceCallSigner,
} from '@intafaced/contracts';
import { TaxError } from './codes.js';
import { createTaxLedgerReads } from './ledger-reads.js';
import { createTradePrices } from './prices.js';

vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  // The S2S nonce, fixed: 16 bytes of 0xab.
  return { ...real, randomBytes: (n: number) => Buffer.alloc(n, 0xab) };
});

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'crates', 'svc-tax', 'tests', 'fixtures', 'io-golden.json');
const NOW = new Date('2026-11-19T00:00:00.000Z');
const SECRET = 'placeholder-internal-service-secret-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';
const SPACE = '33333333-3333-4333-8333-333333333333';
const SPACE2 = '44444444-4444-4444-8444-444444444444';
/** PKCS8 of the Ed25519 seed 0x00..0x1f, and its public key. */
const SEED = Buffer.from([...Array(32).keys()]);
const PKCS8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEED]).toString('base64url');
const PUBLIC = 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg';

type Answer = { status?: number; body: unknown; raw?: string } | 'throw';
type Exchange = {
  request: { method: string; url: string; headers: [string, string][]; body: string | null };
  response: { status: number; body: string } | { throws: string };
};

/** A fake upstream: `answer` decides each reply; every exchange is kept in the order it happened. */
function upstream(answer: (url: URL, body: Record<string, unknown> | null) => Answer) {
  const exchanges: Exchange[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body === undefined ? null : String(init.body);
    const headers = Object.entries((init?.headers ?? {}) as Record<string, string>);
    const a = answer(new URL(url), raw === null ? null : (JSON.parse(raw) as Record<string, unknown>));
    const request = { method: init?.method ?? 'GET', url, headers, body: raw };
    if (a === 'throw') {
      exchanges.push({ request, response: { throws: 'fetch failed' } });
      throw new TypeError('fetch failed');
    }
    const body = a.raw ?? JSON.stringify(a.body);
    exchanges.push({ request, response: { status: a.status ?? 200, body } });
    return new Response(body, { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, exchanges };
}

/** Bigints as their scaled integer, dates as ISO, sets sorted; a history entry's `module` is left out (no port carries it). */
function canon(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Set) return [...v].map(canon).sort();
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined && k !== 'module') out[k] = canon(x);
    return out;
  }
  return v;
}

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: canon(await run()) };
  } catch (err) {
    const e = err as Error;
    return { error: err instanceof TaxError ? { code: err.code, message: e.message } : { message: e.message } };
  }
}

const entry = (e: Record<string, unknown>) => ({
  txId: 'tx',
  module: 'trade',
  reason: 'trade.fill',
  direction: 'debit',
  amount: '1',
  postedAt: '2026-10-01T00:00:00.000Z',
  assetId: 'BTC',
  entryId: '1',
  rail: null,
  product: null,
  orderId: null,
  fee: null,
  withdrawalId: null,
  ...e,
});
const page = (entries: unknown[], nextCursor: string | null = null) => ({ entries, nextCursor });

const keyring = parseKeyring(JSON.stringify({ keys: [{ kid: 'svc-tax.a', svc: 'svc-tax', use: 's2s', x: PUBLIC }] }));
const signer = () => createServiceSigner({ service: 'svc-tax', kid: 'svc-tax.a', privateKey: PKCS8, keyring, now: () => NOW });

type Scenario = {
  name: string;
  client: string;
  call: string;
  args: unknown[];
  s2s?: 'dual' | 'keypair';
  messageDiffers?: boolean;
  answer: (url: URL, body: Record<string, unknown> | null) => Answer;
};

const pricesAt = Date.UTC(2026, 9, 20, 10, 30, 15);
const MIN = Math.floor(pricesAt / 60_000) * 60_000;
const HOUR = Math.floor(pricesAt / 3_600_000) * 3_600_000;
const c = (openAt: number, close: string) => [openAt, '1', '1', '1', close, '1'];
const ohlcv = (table: Record<string, Answer>) => (url: URL) =>
  table[`${decodeURIComponent(url.pathname.replace('/api/v1/ohlcv/', ''))} ${url.searchParams.get('timeframe')}`] ?? {
    status: 404,
    body: { code: 'BadSymbol' },
  };

const fillsLedger = (url: URL, body: Record<string, unknown> | null): Answer => {
  if (url.pathname === '/trpc/balances')
    return { body: [{ accountId: 'a1', assetId: 'USDT', kind: 'available', purpose: '', amount: '300' }] };
  if (body?.kind === 'available')
    return body.cursor === undefined
      ? {
          body: page(
            [
              entry({ txId: 'sell', amount: '300', assetId: 'USDT', orderId: 'o2', postedAt: '2026-10-03T00:00:00.000Z', fee: '1.5' }),
              entry({ txId: 'noise', reason: 'deposit', amount: '500', assetId: 'USDT' }),
              entry({ txId: 'released', reason: 'order.hold.released', amount: '2', assetId: 'SOL' }),
              entry({ txId: 'dep', reason: 'deposit.credited', amount: '2', assetId: 'BTC' }),
              entry({ txId: 'out', reason: 'bank.transfer.manual', direction: 'credit', amount: '0.25', assetId: 'ETH' }),
            ],
            'page2',
          ),
        }
      : { body: page([entry({ txId: 'buy', amount: '1', assetId: 'BTC', orderId: 'o1' })]) };
  if (body?.purpose === 'order:o1') return { body: page([entry({ txId: 'buy', direction: 'credit', amount: '100', assetId: 'USDT' })]) };
  if (body?.purpose === 'order:o2') return { body: page([entry({ txId: 'sell', direction: 'credit', amount: '1', assetId: 'BTC' })]) };
  return { body: page([]) };
};

const SCENARIOS: Scenario[] = [
  {
    name: 'ledger balances',
    client: 'ledger',
    call: 'balances',
    args: ['user', USER],
    answer: () => ({
      body: [
        { accountId: 'a1', assetId: 'USDT', kind: 'available', purpose: '', amount: '300.50' },
        { accountId: 'a2', assetId: 'BTC', kind: 'hold', purpose: 'withdraw:w1', amount: '0' },
      ],
    }),
  },
  {
    name: 'ledger balances refused with a code',
    client: 'ledger',
    call: 'balances',
    args: ['user', USER],
    answer: () => ({ status: 412, body: { code: 'ledger.frozen', message: 'Ledger postings are frozen' } }),
  },
  {
    name: 'ledger balances failed with no body',
    client: 'ledger',
    call: 'balances',
    args: ['user', USER],
    answer: () => ({ status: 502, body: null, raw: 'Bad gateway' }),
  },
  {
    name: 'ledger balances insufficient funds',
    client: 'ledger',
    call: 'balances',
    args: ['user', USER],
    answer: () => ({ status: 400, body: { message: 'Insufficient BTC: requested 2, available 1' } }),
  },
  { name: 'ledger balances unreachable', client: 'ledger', call: 'balances', args: ['user', USER], answer: () => 'throw' },
  {
    name: 'ledger history',
    client: 'ledger',
    call: 'history',
    args: [
      { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'available' },
      { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
    ],
    answer: () => ({
      body: [{ txId: 't1', module: 'bank', reason: 'deposit', direction: 'debit', amount: '10', postedAt: '2026-01-05T10:00:00.000Z' }],
    }),
  },
  {
    name: 'ledger history failed',
    client: 'ledger',
    call: 'history',
    args: [
      { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'available' },
      { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
    ],
    answer: () => ({ status: 500, body: { code: 'ledger.internal', message: 'boom' } }),
  },
  { name: 'trade fills across pages, holds and inflows', client: 'ledger', call: 'tradeFills', args: [USER], answer: fillsLedger },
  { name: 'trade fills signed dual', client: 'ledger', call: 'tradeFills', args: [USER], s2s: 'dual', answer: fillsLedger },
  { name: 'trade fills signed keypair', client: 'ledger', call: 'tradeFills', args: [USER], s2s: 'keypair', answer: fillsLedger },
  {
    name: 'trade fills: a self-trade joins each leg to its own order',
    client: 'ledger',
    call: 'tradeFills',
    args: [USER],
    answer: (url, body) => {
      if (url.pathname === '/trpc/balances') return { body: [] };
      if (body?.kind === 'available')
        return {
          body: page([
            entry({ txId: 'self', amount: '1', assetId: 'BTC', orderId: 'o1' }),
            entry({ txId: 'self', amount: '100', assetId: 'USDT', orderId: 'o2' }),
          ]),
        };
      if (body?.purpose === 'order:o1')
        return { body: page([entry({ txId: 'self', direction: 'credit', amount: '100', assetId: 'USDT' })]) };
      if (body?.purpose === 'order:o2') return { body: page([entry({ txId: 'self', direction: 'credit', amount: '1', assetId: 'BTC' })]) };
      return { body: page([]) };
    },
  },
  {
    name: 'trade fills: each withdrawal read from its own hold account',
    client: 'ledger',
    call: 'tradeFills',
    args: [USER],
    answer: (url, body) => {
      if (url.pathname === '/trpc/balances')
        return {
          body: [
            { accountId: 'a4', assetId: 'BTC', kind: 'available', purpose: '', amount: '0' },
            { accountId: 'a5', assetId: 'BTC', kind: 'hold', purpose: 'withdraw:w-ok', amount: '0' },
            { accountId: 'a6', assetId: 'BTC', kind: 'hold', purpose: 'withdraw:w-failed', amount: '0' },
            { accountId: 'a8', assetId: 'ETH', kind: 'hold', purpose: 'withdraw:w-ok', amount: '0' },
            { accountId: 'a7', assetId: 'BTC', kind: 'hold', purpose: 'order:o7', amount: '0' },
          ],
        };
      if (body?.purpose === 'withdraw:w-ok')
        return {
          body: page([
            entry({ txId: 'ok-s', reason: 'withdraw.settled', direction: 'credit' }),
            entry({ txId: 'ok', reason: 'withdraw.held', postedAt: '2026-10-05T00:00:00.000Z' }),
          ]),
        };
      if (body?.purpose === 'withdraw:w-failed')
        return {
          body: page([
            entry({ txId: 'bad-r', reason: 'withdraw.reversed', direction: 'credit' }),
            entry({ txId: 'bad', reason: 'withdraw.held', postedAt: '2026-10-04T00:00:00.000Z' }),
          ]),
        };
      return { body: page([]) };
    },
  },
  {
    name: 'trade fills: the page ceiling is reported, never a silent short book',
    client: 'ledger',
    call: 'tradeFills',
    args: [USER],
    answer: (url) => (url.pathname === '/trpc/balances' ? { body: [] } : { body: page([], 'next') }),
  },
  {
    name: 'trade fills: a reply the record refuses',
    client: 'ledger',
    call: 'tradeFills',
    args: [USER],
    messageDiffers: true,
    answer: () => ({ body: { entries: [{ txId: 'x' }], nextCursor: null } }),
  },
  { name: 'trade fills: the ledger unreachable', client: 'ledger', call: 'tradeFills', args: [USER], answer: () => 'throw' },
  {
    name: 'trade fills: refused by the ledger',
    client: 'ledger',
    call: 'tradeFills',
    args: [USER],
    answer: () => ({ status: 401, body: { code: 'ledger.unauthenticated', message: 'no caller' } }),
  },
  {
    name: 'trade fills: an upper-case owner id',
    client: 'ledger',
    call: 'tradeFills',
    args: [USER.toUpperCase()],
    answer: (url) => (url.pathname === '/trpc/balances' ? { body: [] } : { body: page([]) }),
  },
  {
    name: 'space history',
    client: 'ledger',
    call: 'spaceHistory',
    args: [[SPACE, SPACE2]],
    answer: (_url, body) =>
      body?.ownerId === SPACE && body.cursor === 'c2'
        ? { body: page([]) }
        : body?.ownerId === SPACE
          ? { body: page([entry({ txId: 'mv', reason: 'bank.transfer.manual', postedAt: '2026-10-05T00:00:00.000Z' })], 'c2') }
          : { body: page([entry({ txId: 'gift', reason: 'bank.transfer.manual', direction: 'credit', amount: '0.5' })]) },
  },
  // prices.test.ts, door by door.
  {
    name: 'price at: the minute it arrived in',
    client: 'prices',
    call: 'priceAt',
    args: ['BTC', pricesAt],
    answer: ohlcv({ 'BTC/USDT 1m': { body: [c(MIN - 120_000, '64000'), c(MIN, '64500.5'), c(MIN + 60_000, '70000')] } }),
  },
  {
    name: 'price at: the last minute before that traded',
    client: 'prices',
    call: 'priceAt',
    args: ['BTC', pricesAt],
    answer: ohlcv({ 'BTC/USDT 1m': { body: [c(MIN - 300_000, '64100'), c(MIN + 120_000, '70000')] } }),
  },
  {
    name: 'price at: an hourly candle that had ended',
    client: 'prices',
    call: 'priceAt',
    args: ['BTC', pricesAt],
    answer: ohlcv({
      'BTC/USDT 1m': { status: 400, body: { code: 'BadRequest', intafacedCode: 'trade.candles_range_point_cap' } },
      'BTC/USDT 1h': { body: [c(HOUR - 3_600_000, '64300'), c(HOUR, '69000')] },
    }),
  },
  {
    name: 'price at: the USDC market',
    client: 'prices',
    call: 'priceAt',
    args: ['eth', pricesAt],
    answer: ohlcv({ 'ETH/USDC 1m': { body: [c(MIN, '2600')] } }),
  },
  {
    name: 'price at: no candle anywhere',
    client: 'prices',
    call: 'priceAt',
    args: ['BTC', pricesAt],
    answer: ohlcv({ 'BTC/USDT 1m': { body: [] }, 'BTC/USDT 1h': { body: [] }, 'BTC/USDT 1d': { body: [] } }),
  },
  {
    name: 'price at: one failed read moves on',
    client: 'prices',
    call: 'priceAt',
    args: ['BTC', pricesAt],
    answer: ohlcv({ 'BTC/USDT 1m': 'throw', 'BTC/USDT 1h': { body: [c(HOUR - 3_600_000, '64200')] } }),
  },
  {
    name: 'price at: nothing answers',
    client: 'prices',
    call: 'priceAt',
    args: ['BTC', pricesAt],
    answer: () => 'throw',
  },
  {
    name: 'price at: a refusal that is not a missing market',
    client: 'prices',
    call: 'priceAt',
    args: ['BTC', pricesAt],
    answer: ohlcv({
      'BTC/USDT 1m': { status: 400, body: { intafacedCode: 'trade.other' } },
      'BTC/USDT 1h': { status: 503, body: {} },
      'BTC/USDT 1d': { body: { not: 'rows' } },
    }),
  },
  {
    name: 'closes: one whole window',
    client: 'prices',
    call: 'closes',
    args: ['ETH', '1h', HOUR - 3 * 3_600_000, HOUR],
    answer: ohlcv({ 'ETH/USDT 1h': { body: [c(HOUR - 4 * 3_600_000, '2000'), c(HOUR - 3_600_000, '2100'), c(HOUR + 3_600_000, '2500')] } }),
  },
  {
    name: 'closes: the USDC market',
    client: 'prices',
    call: 'closes',
    args: ['SOL', '1h', HOUR - 3 * 3_600_000, HOUR],
    answer: ohlcv({ 'SOL/USDC 1h': { body: [c(HOUR - 3_600_000, '150')] } }),
  },
  { name: 'closes: no market', client: 'prices', call: 'closes', args: ['XYZ', '1h', HOUR - 3 * 3_600_000, HOUR], answer: ohlcv({}) },
  {
    name: 'closes: a coin that last traded before the window',
    client: 'prices',
    call: 'closes',
    args: ['ETH', '1h', HOUR - 3 * 3_600_000, HOUR],
    answer: ohlcv({
      'ETH/USDT 1h': { body: [c(HOUR - 2 * 3_600_000, '2100')] },
      'ETH/USDT 1m': { body: [] },
      'ETH/USDT 1d': { body: [c(Math.floor((HOUR - 3 * 3_600_000) / 86_400_000) * 86_400_000 - 86_400_000, '1800')] },
    }),
  },
  {
    name: 'closes: too far to read whole',
    client: 'prices',
    call: 'closes',
    args: ['ETH', '1h', HOUR - 3 * 3_600_000, HOUR],
    answer: ohlcv({ 'ETH/USDT 1h': { status: 400, body: { intafacedCode: 'trade.candles_range_point_cap' } } }),
  },
  { name: 'closes: down', client: 'prices', call: 'closes', args: ['ETH', '5m', HOUR - 3 * 3_600_000, HOUR], answer: () => 'throw' },
  // The bank's own spaces.
  {
    name: 'bank spaces read',
    client: 'bank',
    call: 'list',
    args: [USER],
    answer: () => ({ body: { result: { data: { spaces: [{ spaceId: SPACE, assetId: 'BTC', name: 'TEST cold', archived: false }] } } } }),
  },
  { name: 'bank spaces non-2xx', client: 'bank', call: 'list', args: [USER], answer: () => ({ status: 500, body: {} }) },
  {
    name: 'bank spaces a reply the schema refuses',
    client: 'bank',
    call: 'list',
    args: [USER],
    answer: () => ({ body: { result: { data: { spaces: [{ spaceId: 'not-a-guid', assetId: 'BTC', name: 'x', archived: false }] } } } }),
  },
  { name: 'bank spaces no result', client: 'bank', call: 'list', args: [USER], answer: () => ({ body: { error: {} } }) },
  { name: 'bank spaces unreachable', client: 'bank', call: 'list', args: [USER], answer: () => 'throw' },
  {
    name: 'bank spaces a URL with a query is no transport',
    client: 'bank-query-url',
    call: 'list',
    args: [USER],
    answer: () => ({ body: {} }),
  },
  {
    name: 'bank spaces a short secret is no transport',
    client: 'bank-short-secret',
    call: 'list',
    args: [USER],
    answer: () => ({ body: {} }),
  },
  // The venue.
  {
    name: 'venue activity read',
    client: 'venue',
    call: 'read',
    args: [USER],
    answer: () => ({
      body: {
        result: {
          data: {
            state: 'read',
            test: true,
            accounts: [
              {
                venueId: 'hl-test',
                owner: '0x' + 'ab'.repeat(20),
                subAccount: null,
                balances: [{ asset: 'BTC', total: '0.5' }],
                fills: [
                  {
                    fillId: 'f1',
                    symbol: 'BTC/USDC',
                    base: 'BTC',
                    quote: 'USDC',
                    side: 'buy',
                    price: '60000',
                    amount: '0.5',
                    fee: '0.0001',
                    feeAsset: 'BTC',
                    filledAt: '2026-10-01T00:00:00.123456Z',
                  },
                ],
                transfers: [
                  {
                    moveId: 'm1',
                    subAccount: 's1',
                    direction: 'out_of_sub_account',
                    asset: 'USDC',
                    amount: '1',
                    settledAt: '2026-10-02T00:00:00Z',
                  },
                ],
                asOf: '2026-11-01T00:00:00.000Z',
              },
            ],
          },
        },
      },
    }),
  },
  {
    name: 'venue activity off',
    client: 'venue',
    call: 'read',
    args: [USER],
    answer: () => ({ body: { result: { data: { state: 'off' } } } }),
  },
  { name: 'venue activity down', client: 'venue', call: 'read', args: [USER], answer: () => ({ status: 503, body: {} }) },
  {
    name: 'venue activity a reply the schema refuses',
    client: 'venue',
    call: 'read',
    args: [USER],
    answer: () => ({
      body: {
        result: {
          data: {
            state: 'read',
            test: false,
            accounts: [{ venueId: 'v', owner: '0xAB', subAccount: null, balances: [], fills: [], asOf: '2026-11-01T00:00:00Z' }],
          },
        },
      },
    }),
  },
  {
    name: 'venue activity an unknown key',
    client: 'venue',
    call: 'read',
    args: [USER],
    answer: () => ({ body: { result: { data: { state: 'off', extra: 1 } } } }),
  },
];

async function play(s: Scenario) {
  const { fetchImpl, exchanges } = upstream(s.answer);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    let result: unknown;
    if (s.client === 'ledger') {
      const reads = createTaxLedgerReads('http://ledger.test/', SECRET, s.s2s ? { signer: signer(), mode: s.s2s } : undefined);
      if (s.call === 'history') {
        const [account, range] = s.args as [never, { from: string; to: string }];
        result = await outcome(() => reads.history(account, { from: new Date(range.from), to: new Date(range.to) }));
      } else if (s.call === 'balances') {
        result = await outcome(() => reads.balances(s.args[0] as 'user', s.args[1] as string));
      } else if (s.call === 'tradeFills') {
        result = await outcome(() => reads.tradeFills!(s.args[0] as string));
      } else {
        result = await outcome(() => reads.spaceHistory!(s.args[0] as string[]));
      }
    } else if (s.client === 'prices') {
      const prices = createTradePrices('http://trade.test/', fetchImpl);
      result =
        s.call === 'priceAt'
          ? await outcome(() => prices.priceAt(s.args[0] as string, new Date(s.args[1] as number)))
          : await outcome(() =>
              prices.closes(s.args[0] as string, s.args[1] as '1h', new Date(s.args[2] as number), new Date(s.args[3] as number)),
            );
    } else if (s.client.startsWith('bank')) {
      const bankUrl = s.client === 'bank-query-url' ? 'http://bank.test:4009/?x=1' : 'http://BANK.test:4009';
      const secret = s.client === 'bank-short-secret' ? 'short' : SECRET;
      result = await outcome(() =>
        createBankOwnSpacesClient({ bankUrl, secret, fetcher: fetchImpl }).list({ userId: s.args[0] as string }),
      );
    } else {
      result = await outcome(() =>
        createTradeVenueActivityClient({ tradeUrl: 'http://trade.test/base/', secret: SECRET, fetcher: fetchImpl }).read({
          userId: s.args[0] as string,
        }),
      );
    }
    return {
      name: s.name,
      client: s.client,
      call: s.call,
      args: s.args,
      s2s: s.s2s ?? null,
      messageDiffers: s.messageDiffers ?? false,
      exchanges,
      result,
    };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('the I/O golden the Rust clients replay', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the TypeScript clients still produce it', async () => {
    const s = signer();
    const vectors = {
      now: NOW.toISOString(),
      secret: SECRET,
      pkcs8: PKCS8,
      publicKey: PUBLIC,
      nonceByte: 0xab,
      legacy: serviceAuthHeadersForBody('svc-tax', SECRET, '{"userId":"u"}'),
      v3: s.headers({
        audience: 'svc-ledger',
        method: 'post',
        url: new URL('http://ledger.test/trpc/historyPage?x=1'),
        body: '{"a":1}',
        context: { principal: 'p', principalSignature: 'sig', region: 'DE', contentType: 'application/json' },
      }),
      dual: serviceCallSigner({ service: 'svc-tax', audience: 'svc-ledger', legacySecret: SECRET, s2s: { signer: s, mode: 'dual' } })(
        '{}',
        {
          method: 'POST',
          url: new URL('http://ledger.test/trpc/balances'),
          contentType: 'application/json',
        },
      ),
    };
    const scenarios = [];
    for (const scenario of SCENARIOS) scenarios.push(await play(scenario));
    // Compared as data: the file is kept in the repository's format (prettier), which JSON.stringify does not write.
    const golden = JSON.parse(JSON.stringify({ vectors, scenarios })) as unknown;
    if (process.env.RECORD_IO_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`);
    expect(golden).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});
