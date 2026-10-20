import { describe, expect, it, vi } from 'vitest';
import { LEDGER_ACK_INVALID_MESSAGE, createHttpLedgerClient, createLedgerTransport } from './http-client.js';
import { parseAmount as amt } from './money.js';
import { recipes } from './recipes/index.js';
import { InsufficientFundsError, LedgerError } from './types.js';
import { classifyPostOutcome, provesPostNotCommitted } from './post-outcome.js';

const USER = '11111111-1111-4111-8111-111111111111';
const request = recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('50'), rail: 'test', railRef: 'http-client-1' });
const AT = '2026-10-13T12:00:00.000Z';
const ack = (extra: Record<string, unknown> = {}) => ({ txId: 'tx-1', hash: 'h-1', postedAt: AT, ...extra });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function harness(responses: Array<Response | Error>, over: Partial<Parameters<typeof createHttpLedgerClient>[0]> = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string; signal: AbortSignal | null | undefined }> = [];
  const queue = [...responses];
  const sleeps: number[] = [];
  let signed = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body), signal: init.signal });
    const next = queue.shift();
    if (!next) throw new Error('no more responses queued');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof globalThis.fetch;
  const options = {
    baseUrl: 'http://ledger.internal:4001/',
    sign: (payload: string) => ({ 'x-sig': `sig-${(signed += 1)}:${payload.length}` }),
    fetch,
    sleep: async (ms: number) => void sleeps.push(ms),
    ...over,
  };
  return { client: createHttpLedgerClient(options), transport: createLedgerTransport(options), calls, sleeps, queue };
}

describe('the signer is told what is being sent', () => {
  it('passes the method, the full URL and the content type, so a key-signed call covers them', async () => {
    const seen: Array<{ payload: string; method: string; url: string; contentType: string }> = [];
    const h = harness([json(ack())], {
      sign: (payload: string, req?: { method: string; url: URL; contentType: string }) => {
        seen.push({ payload, method: req!.method, url: req!.url.href, contentType: req!.contentType });
        return { 'x-sig': 'k' };
      },
    });
    await h.client.post(request);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: 'http://ledger.internal:4001/trpc/post', contentType: 'application/json' });
    expect(seen[0]!.url).toBe(h.calls[0]!.url);
    expect(seen[0]!.payload).toBe(h.calls[0]!.body);
  });

  it('signs each retry with its own request info', async () => {
    const urls: string[] = [];
    const h = harness([new Error('connection reset'), json(ack())], {
      sign: (_payload: string, req?: { method: string; url: URL; contentType: string }) => {
        urls.push(req!.url.pathname);
        return { 'x-sig': 'k' };
      },
    });
    await h.client.post(request);
    expect(urls).toEqual(['/trpc/post', '/trpc/post']);
  });
});

describe('createHttpLedgerClient.post', () => {
  it('signs the exact bytes it sends, with a timeout armed', async () => {
    const h = harness([json(ack())]);
    await h.client.post(request);
    const call = h.calls[0]!;
    expect(call.url).toBe('http://ledger.internal:4001/trpc/post');
    expect(call.headers['x-sig']).toBe(`sig-1:${call.body.length}`);
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(call.body)).toMatchObject({ idempotencyKey: request.idempotencyKey, entries: [{ amount: '50' }, { amount: '50' }] });
  });

  it('returns the booked entries on the receipt so receipt checks compare real accounts and amounts', async () => {
    const entries = [
      { id: '7', txId: 'tx-1', accountId: 'a-1', assetId: 'USDT', direction: 'debit', amount: '50', balanceAfter: '50' },
      { id: '8', txId: 'tx-1', accountId: 'a-2', assetId: 'USDT', direction: 'credit', amount: '50', balanceAfter: '-50' },
    ];
    const tx = await harness([json(ack({ entries }))]).client.post(request);
    expect(tx.entries).toEqual([
      { id: '7', txId: 'tx-1', accountId: 'a-1', assetId: 'USDT', direction: 'debit', amount: amt('50'), balanceAfter: amt('50') },
      { id: '8', txId: 'tx-1', accountId: 'a-2', assetId: 'USDT', direction: 'credit', amount: amt('50'), balanceAfter: -amt('50') },
    ]);
    expect(tx.postedAt.toISOString()).toBe(AT);
  });

  it('keeps working against an older ledger that returns no entries', async () => {
    expect((await harness([json(ack())]).client.post(request)).entries).toEqual([]);
  });

  it.each([
    ['not an object', 'ok'],
    ['no txId', { hash: 'h', postedAt: AT }],
    ['blank txId', ack({ txId: '  ' })],
    ['blank hash', ack({ hash: '' })],
    ['impossible date', ack({ postedAt: '2026-02-31T00:00:00.000Z' })],
    ['non-ISO date', ack({ postedAt: 'Tue Oct 13 2026' })],
    [
      'bad entry amount',
      ack({ entries: [{ id: '1', txId: 'tx-1', accountId: 'a', assetId: 'USDT', direction: 'debit', amount: 'abc', balanceAfter: '1' }] }),
    ],
  ])('treats a malformed acknowledgement (%s) as an unknown outcome, never a success', async (_label, body) => {
    await expect(harness([json(body)]).client.post(request)).rejects.toThrow(LEDGER_ACK_INVALID_MESSAGE);
  });
});

describe('retries', () => {
  it('retries a network error and a 503, re-signing each attempt, then succeeds', async () => {
    const h = harness([new TypeError('fetch failed'), json({ error: 'busy' }, 503), json(ack())]);
    const tx = await h.client.post(request);
    expect(tx.id).toBe('tx-1');
    expect(h.calls).toHaveLength(3);
    expect(new Set(h.calls.map((c) => c.headers['x-sig'])).size).toBe(3);
    expect(new Set(h.calls.map((c) => c.body)).size).toBe(1);
    expect(h.sleeps).toEqual([150, 300]);
  });

  it('gives up after the budget and surfaces the last error', async () => {
    const h = harness([new TypeError('a'), new TypeError('b'), new TypeError('c')]);
    await expect(h.client.post(request)).rejects.toThrow('c');
    expect(h.calls).toHaveLength(3);
    const none = harness([new TypeError('x')], { retries: 0 });
    await expect(none.client.post(request)).rejects.toThrow('x');
    expect(none.calls).toHaveLength(1);
  });

  it('stamps how many attempts a failed post took, so a refusal after a retry is not taken for proof', async () => {
    // One attempt, refused: proof nothing committed.
    const refusal = { code: 'ledger.frozen', message: 'frozen' };
    const first = harness([json(refusal, 412)]);
    const once = await first.client.post(request).catch((e: unknown) => e);
    expect(classifyPostOutcome(once)).toBe('refused');
    expect(provesPostNotCommitted(once)).toBe(true);
    // The first attempt was lost, the second was refused: the first may still land.
    const retried = harness([new TypeError('fetch failed'), json(refusal, 412)]);
    const second = await retried.client.post(request).catch((e: unknown) => e);
    expect(classifyPostOutcome(second)).toBe('refused');
    expect(provesPostNotCommitted(second)).toBe(false);
    // Connect failures on every attempt: nothing is proven, because the first may have connected before a restart.
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const none = harness([refused, refused, refused]);
    const gaveUp = await none.client.post(request).catch((e: unknown) => e);
    expect(classifyPostOutcome(gaveUp)).toBe('unknown');
    // With a single attempt and a connect failure, nothing was sent.
    const single = harness([refused], { retries: 0 });
    const unsent = await single.client.post(request).catch((e: unknown) => e);
    expect(classifyPostOutcome(unsent)).toBe('unsent');
    expect(provesPostNotCommitted(unsent)).toBe(true);
  });

  it('never retries a ledger refusal or any 4xx', async () => {
    for (const [status, body] of [
      [409, { code: 'ledger.idempotency_conflict', message: 'taken' }],
      [412, { code: 'ledger.frozen', message: 'frozen' }],
      [
        400,
        {
          code: 'ledger.insufficient_funds',
          message: 'Insufficient USDT: requested 5, available 1',
          accountId: 'a',
          assetId: 'USDT',
          requested: '5',
          availableBalance: '1',
        },
      ],
      [401, { code: 'ledger.unauthenticated', message: 'no' }],
      [500, { code: 'ledger.something', message: 'bug' }],
    ] as const) {
      const h = harness([json(body, status), json(ack())]);
      await expect(h.client.post(request)).rejects.toBeInstanceOf(LedgerError);
      expect(h.calls).toHaveLength(1);
    }
  });

  it('rehydrates a funds refusal and a conflict with their codes', async () => {
    const funds = harness([
      json(
        {
          code: 'ledger.insufficient_funds',
          message: 'Insufficient USDT: requested 5, available 1',
          accountId: 'a',
          assetId: 'USDT',
          requested: '5',
          availableBalance: '1',
        },
        400,
      ),
    ]);
    await expect(funds.client.post(request)).rejects.toBeInstanceOf(InsufficientFundsError);
    const conflict = harness([json({ code: 'ledger.idempotency_conflict', message: 'taken' }, 409)]);
    await expect(conflict.client.post(request)).rejects.toMatchObject({ code: 'ledger.idempotency_conflict' });
  });

  it('lets the caller map a refusal (typed funds failure) without a second copy of the client', async () => {
    const mapError = vi.fn(
      async (error: Error, f: { status: number; path: string }) => new Error(`mapped ${f.status} ${f.path} ${error.message}`),
    );
    const h = harness([json({ code: 'ledger.frozen', message: 'frozen' }, 412)], { mapError });
    await expect(h.client.post(request)).rejects.toThrow('mapped 412 /trpc/post frozen');
  });
});

describe('options and the other calls', () => {
  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 2_147_483_648 },
    { timeoutMs: 1.5 },
    { retries: -1 },
    { retries: 6 },
    { retryBaseDelayMs: -1 },
    { deadlineMs: 0 },
    { deadlineMs: -5 },
    { deadlineMs: 1.5 },
    { deadlineMs: 2_147_483_648 },
  ])('refuses a bad budget %o at construction', (over) => {
    expect(() => harness([], over)).toThrow(RangeError);
  });

  it('reads balances through the same signed transport and parses them', async () => {
    const ref = { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'available' } as const;
    const h = harness([
      json({ accountId: 'acc-1', amount: '12.5' }),
      json([{ accountId: 'acc-1', assetId: 'USDT', kind: 'available', amount: '12.5' }]),
      json({ nope: true }),
    ]);
    expect(await h.client.balance(ref)).toEqual({ account: ref, accountId: 'acc-1', amount: amt('12.5') });
    const listed = (await h.client.balances('user', USER))[0]!;
    expect(listed).toMatchObject({ accountId: 'acc-1', amount: amt('12.5') });
    expect(listed.account).not.toHaveProperty('purpose');
    await expect(h.client.balance(ref)).rejects.toThrow();
  });

  it('keeps the account purpose on balances, so two holds stay two accounts', async () => {
    const h = harness([
      json([
        { accountId: 'h-1', assetId: 'USDT', kind: 'hold', purpose: 'order:abc', amount: '5' },
        { accountId: 'h-2', assetId: 'USDT', kind: 'hold', purpose: 'withdrawal:xyz', amount: '7' },
        { accountId: 'a-1', assetId: 'USDT', kind: 'available', purpose: '', amount: '1' },
      ]),
    ]);
    const [a, b, c] = await h.client.balances('user', USER);
    expect(a!.account.purpose).toBe('order:abc');
    expect(b!.account.purpose).toBe('withdrawal:xyz');
    expect(c!.account).not.toHaveProperty('purpose');
  });

  it('exposes the raw transport for service-specific endpoints (history, funds checks)', async () => {
    const h = harness([json([1, 2])]);
    expect(await h.transport<number[]>('/trpc/history', { a: 1 })).toEqual([1, 2]);
    expect(h.calls[0]!.url).toBe('http://ledger.internal:4001/trpc/history');
  });
});

const TX_ID = 'tx-9';
const KEY = 'idem-key-9';
const foundById = (extra: Record<string, unknown> = {}) => ({
  found: true,
  txId: TX_ID,
  idempotencyKey: KEY,
  hash: 'h-9',
  postedAt: AT,
  module: 'deposit',
  reason: 'test deposit',
  entries: [
    { accountId: 'a-1', assetId: 'USDT', direction: 'debit', amount: '50' },
    { accountId: 'a-2', assetId: 'USDT', direction: 'credit', amount: '50.25' },
  ],
  ...extra,
});
const foundByKey = (extra: Record<string, unknown> = {}) => ({
  found: true,
  txId: TX_ID,
  hash: 'h-9',
  postedAt: AT,
  module: 'deposit',
  reason: 'test deposit',
  ...extra,
});

describe('getTx', () => {
  it('reads a transaction through txById, with its real entries', async () => {
    const h = harness([json(foundById())]);
    const tx = await h.client.getTx(TX_ID);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe('http://ledger.internal:4001/trpc/txById');
    expect(JSON.parse(h.calls[0]!.body)).toEqual({ txId: TX_ID });
    expect(h.calls[0]!.headers['x-sig']).toBe(`sig-1:${h.calls[0]!.body.length}`);
    expect(tx).toEqual({
      id: TX_ID,
      idempotencyKey: KEY,
      module: 'deposit',
      reason: 'test deposit',
      meta: {},
      postedAt: new Date(AT),
      hash: 'h-9',
      previousHash: null,
      entries: [
        { id: '', txId: TX_ID, accountId: 'a-1', assetId: 'USDT', direction: 'debit', amount: amt('50'), balanceAfter: 0n },
        { id: '', txId: TX_ID, accountId: 'a-2', assetId: 'USDT', direction: 'credit', amount: amt('50.25'), balanceAfter: 0n },
      ],
    });
  });

  it('returns null only for an explicit found:false', async () => {
    expect(await harness([json({ found: false })]).client.getTx(TX_ID)).toBeNull();
  });

  it.each([
    ['no found verdict', { txId: TX_ID, hash: 'h' }],
    ['found is not a boolean', { found: 'yes' }],
    ['found is null', { found: null }],
    ['not an object', 'ok'],
    ['float amount', foundById({ entries: [{ accountId: 'a', assetId: 'USDT', direction: 'debit', amount: 50.5 }] })],
    ['exponent amount', foundById({ entries: [{ accountId: 'a', assetId: 'USDT', direction: 'debit', amount: '1e3' }] })],
    ['garbage amount', foundById({ entries: [{ accountId: 'a', assetId: 'USDT', direction: 'debit', amount: 'abc' }] })],
    ['bad direction', foundById({ entries: [{ accountId: 'a', assetId: 'USDT', direction: 'sideways', amount: '1' }] })],
    ['entries missing', foundById({ entries: undefined })],
    ['impossible postedAt', foundById({ postedAt: '2026-02-31T00:00:00.000Z' })],
    ['non-ISO postedAt', foundById({ postedAt: 'Tue Oct 13 2026' })],
    ['blank txId', foundById({ txId: ' ' })],
    ['blank hash', foundById({ hash: '' })],
    ['no entries (a booked tx always has at least two legs)', foundById({ entries: [] })],
    ['a single leg', foundById({ entries: [{ accountId: 'a', assetId: 'USDT', direction: 'debit', amount: '1' }] })],
  ])('throws, never null or a success, on a malformed answer (%s)', async (_label, body) => {
    await expect(harness([json(body)]).client.getTx(TX_ID)).rejects.toThrow();
  });

  it('refuses an answer for a different transaction than the one asked for', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    await expect(harness([json(foundById({ txId: other }))]).client.getTx(TX_ID)).rejects.toThrow(/different txId/);
  });
});

describe('getTxByKey', () => {
  it('chains txByKey to txById so the result carries the real entries', async () => {
    const h = harness([json(foundByKey()), json(foundById())]);
    const tx = await h.client.getTxByKey(KEY);
    expect(h.calls.map((c) => c.url)).toEqual(['http://ledger.internal:4001/trpc/txByKey', 'http://ledger.internal:4001/trpc/txById']);
    expect(JSON.parse(h.calls[0]!.body)).toEqual({ idempotencyKey: KEY });
    expect(JSON.parse(h.calls[1]!.body)).toEqual({ txId: TX_ID });
    expect(tx).toMatchObject({ id: TX_ID, idempotencyKey: KEY, hash: 'h-9', module: 'deposit', postedAt: new Date(AT) });
    expect(tx!.entries).toEqual([
      { id: '', txId: TX_ID, accountId: 'a-1', assetId: 'USDT', direction: 'debit', amount: amt('50'), balanceAfter: 0n },
      { id: '', txId: TX_ID, accountId: 'a-2', assetId: 'USDT', direction: 'credit', amount: amt('50.25'), balanceAfter: 0n },
    ]);
  });

  it('returns null after ONE request when the key was never booked', async () => {
    const h = harness([json({ found: false })]);
    expect(await h.client.getTxByKey(KEY)).toBeNull();
    expect(h.calls).toHaveLength(1);
  });

  it('throws when txByKey finds the key but txById cannot find the transaction', async () => {
    const h = harness([json(foundByKey()), json({ found: false })]);
    await expect(h.client.getTxByKey(KEY)).rejects.toThrow(/inconsistent/);
    expect(h.calls).toHaveLength(2);
  });

  it('throws when txById says the transaction was booked under another key', async () => {
    const h = harness([json(foundByKey()), json(foundById({ idempotencyKey: 'someone-else' }))]);
    await expect(h.client.getTxByKey(KEY)).rejects.toThrow(/another key/);
  });

  it.each([
    ['no found verdict', { txId: TX_ID, hash: 'h' }],
    ['found is not a boolean', { found: 1 }],
    ['blank txId', foundByKey({ txId: '' })],
    ['bad postedAt on the chained read', null],
  ])('throws, never null, on a malformed answer (%s)', async (_label, body) => {
    const responses = body === null ? [json(foundByKey()), json(foundById({ postedAt: 'yesterday' }))] : [json(body)];
    await expect(harness(responses).client.getTxByKey(KEY)).rejects.toThrow();
  });
});

describe('deadlineMs', () => {
  const unavailable = () => Array.from({ length: 10 }, () => json({ error: 'busy' }, 503));

  it('stops retrying once the budget cannot cover the next backoff, and surfaces the last error', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const sleeps: number[] = [];
      const h = harness(unavailable(), {
        retries: 5,
        retryBaseDelayMs: 100,
        deadlineMs: 250,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          vi.setSystemTime(Date.now() + ms);
        },
      });
      await expect(h.client.post(request)).rejects.toThrow(/503/);
      // attempt 1 at t=0, back off 100, attempt 2 at t=100, the 200ms backoff no longer fits in the 150ms left.
      expect(h.calls).toHaveLength(2);
      expect(sleeps).toEqual([100]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never starts an attempt once the deadline has passed, and caps each attempt timeout at what is left', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const h = harness([json({ error: 'busy' }, 503), json(ack())], {
        retries: 5,
        retryBaseDelayMs: 0,
        deadlineMs: 500,
        timeoutMs: 15_000,
      });
      await h.client.post(request);
      expect(timeoutSpy).toHaveBeenCalledTimes(2);
      expect(timeoutSpy.mock.calls[0]![0]).toBe(500);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('throws when a slow failure has already spent the whole budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let n = 0;
      const options = {
        baseUrl: 'http://ledger.internal:4001',
        sign: () => ({}),
        retries: 5,
        retryBaseDelayMs: 0,
        deadlineMs: 1_000,
        sleep: async () => {},
        fetch: (async () => {
          n += 1;
          vi.setSystemTime(Date.now() + 1_000);
          throw new TypeError(`slow failure ${n}`);
        }) as unknown as typeof globalThis.fetch,
      };
      await expect(createLedgerTransport(options)('/trpc/post', {})).rejects.toThrow('slow failure 1');
      expect(n).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds real elapsed time with a tiny deadline against an always-503 ledger', async () => {
    const h = harness(unavailable(), { retries: 5, retryBaseDelayMs: 20, deadlineMs: 50, sleep: undefined });
    const started = Date.now();
    await expect(h.client.post(request)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(500);
    expect(h.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.calls.length).toBeLessThan(6);
  });

  it('changes nothing when unset: the full retry budget still runs', async () => {
    const h = harness(unavailable(), { retries: 3 });
    await expect(h.client.post(request)).rejects.toThrow();
    expect(h.calls).toHaveLength(4);
  });
});

describe('statuses that are still not retried', () => {
  it.each([429, 500, 401, 409])('does not retry a %i', async (status) => {
    const h = harness([json({ code: 'ledger.something', message: 'no' }, status), json(ack())], { deadlineMs: 10_000 });
    await expect(h.client.post(request)).rejects.toBeInstanceOf(LedgerError);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });
});
