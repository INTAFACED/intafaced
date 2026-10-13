import { describe, expect, it, vi } from 'vitest';
import { LEDGER_ACK_INVALID_MESSAGE, createHttpLedgerClient, createLedgerTransport } from './http-client.js';
import { parseAmount as amt } from './money.js';
import { recipes } from './recipes/index.js';
import { InsufficientFundsError, LedgerError } from './types.js';

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
  it.each([{ timeoutMs: 0 }, { timeoutMs: 2_147_483_648 }, { timeoutMs: 1.5 }, { retries: -1 }, { retries: 6 }, { retryBaseDelayMs: -1 }])(
    'refuses a bad budget %o at construction',
    (over) => {
      expect(() => harness([], over)).toThrow(RangeError);
    },
  );

  it('reads balances through the same signed transport and parses them', async () => {
    const ref = { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'available' } as const;
    const h = harness([
      json({ accountId: 'acc-1', amount: '12.5' }),
      json([{ accountId: 'acc-1', assetId: 'USDT', kind: 'available', amount: '12.5' }]),
      json({ nope: true }),
    ]);
    expect(await h.client.balance(ref)).toEqual({ account: ref, accountId: 'acc-1', amount: amt('12.5') });
    expect((await h.client.balances('user', USER))[0]).toMatchObject({ accountId: 'acc-1', amount: amt('12.5') });
    await expect(h.client.balance(ref)).rejects.toThrow();
  });

  it('exposes the raw transport for service-specific endpoints (history, funds checks)', async () => {
    const h = harness([json([1, 2])]);
    expect(await h.transport<number[]>('/trpc/history', { a: 1 })).toEqual([1, 2]);
    expect(h.calls[0]!.url).toBe('http://ledger.internal:4001/trpc/history');
  });
});
