/**
 * The HTTP ledger client must implement every LedgerClient read that money paths
 * call. Convert settle calls `getTxByKey` before each post (#4678); the HTTP
 * client threw "not exposed over the internal ledger API", the router turned
 * that into INTERNAL_SERVER_ERROR, and every `convert.accept` returned 500 on a
 * running stack while the MemoryLedger tests stayed green.
 *
 * Here the client talks to a fetch stub that answers like svc-ledger's S2S door,
 * backed by the in-memory reference ledger.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLedger, parseAmount, recipes, userAvailable, formatAmount, type PostRequest } from '@intafaced/ledger-client';
import { classifyHoldPostError } from './spot/hold-outcome.js';
import { acceptConvertQuote, buildFirmConvertQuote, estimateConvert } from './convert/quote.js';
import { planConvertSettle, postConvertSettle } from './convert/settle.js';
import { convertSettleIdsFor } from './convert/ids.js';
import { createLedgerClient } from './ledger-client.js';

const USER = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-08-26T12:00:00.000Z');
const ACCEPT_AT = new Date('2026-08-26T12:00:01.000Z');
const SECRET = 'test-only-internal-service-secret-0123456789';

function ledgerDoorOver(ledger: MemoryLedger, calls: string[]) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/trpc/txByKey') {
      const tx = await ledger.getTxByKey(String(body.idempotencyKey));
      return json(
        tx
          ? { found: true, txId: tx.id, hash: tx.hash, postedAt: tx.postedAt.toISOString(), module: tx.module, reason: tx.reason }
          : { found: false },
      );
    }
    if (path === '/trpc/post') {
      const request = body as unknown as Omit<PostRequest, 'entries'> & {
        entries: Array<{ account: never; direction: 'debit' | 'credit'; amount: string }>;
      };
      try {
        const tx = await ledger.post({
          ...request,
          entries: request.entries.map((e) => ({ account: e.account, direction: e.direction, amount: parseAmount(e.amount) })),
        });
        return json({ txId: tx.id, hash: tx.hash, postedAt: tx.postedAt.toISOString() });
      } catch (err) {
        return json({ message: (err as Error).message, code: (err as { code?: string }).code }, 400);
      }
    }
    return json({ message: `no route ${path}` }, 404);
  });
}

function boundBuy() {
  const estimate = estimateConvert({
    side: 'buy',
    qty: parseAmount('1'),
    levels: [['100', '5']],
    convertSpreadBps: 100,
    tickSize: parseAmount('0.01'),
  });
  const quote = buildFirmConvertQuote({
    quoteId: 'q-http-ledger',
    userId: USER,
    symbol: 'BTC/USDT',
    marketId: 'm1',
    side: 'buy',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    requestedQty: parseAmount('1'),
    estimate,
    convertSpreadBps: 100,
    source: { kind: 'book', symbol: 'BTC/USDT', asOf: NOW.toISOString() },
    now: NOW,
    quoteTtlMs: 15_000,
  });
  return acceptConvertQuote({ quote, now: ACCEPT_AT });
}

afterEach(() => vi.unstubAllGlobals());

describe('createLedgerClient.getTxByKey', () => {
  it('answers null for a key the ledger has not booked', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', ledgerDoorOver(new MemoryLedger(), calls));
    const client = createLedgerClient('http://ledger.test', SECRET);
    await expect(client.getTxByKey('order.release:never-booked:0')).resolves.toBeNull();
    expect(calls).toEqual(['/trpc/txByKey']);
  });

  it('answers the booked transaction for a key it has', async () => {
    const ledger = new MemoryLedger();
    const deposit = recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('10'), rail: 'test', railRef: 'k1' });
    const posted = await ledger.post(deposit);
    vi.stubGlobal('fetch', ledgerDoorOver(ledger, []));
    const client = createLedgerClient('http://ledger.test', SECRET);
    const tx = await client.getTxByKey(deposit.idempotencyKey);
    expect(tx?.id).toBe(posted.id);
    expect(tx?.idempotencyKey).toBe(deposit.idempotencyKey);
    expect(tx?.hash).toBe(posted.hash);
    expect(tx?.module).toBe(deposit.module);
    expect(tx?.reason).toBe(deposit.reason);
  });

  it('throws when txByKey returns an empty object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    const client = createLedgerClient('http://ledger.test', SECRET);
    await expect(client.getTxByKey('order.hold:missing-shape')).rejects.toThrow(/unreadable body/);
  });
});

describe('createLedgerClient timeout', () => {
  it('aborts every ledger call and a timeout is unknown, never a refusal', async () => {
    const src = readFileSync(new URL('./ledger-client.ts', import.meta.url), 'utf8');
    expect(src).toContain('signal: AbortSignal.timeout(25_000)');

    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (!(init?.signal instanceof AbortSignal)) throw new Error('ledger call has no timeout signal');
        signals.push(init.signal);
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    );
    const client = createLedgerClient('http://ledger.test', SECRET);
    const postErr = await client
      .post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('1'), rail: 'test', railRef: 'timeout' }))
      .then(() => {
        throw new Error('post resolved');
      })
      .catch((err: unknown) => err);
    expect(postErr).toBeInstanceOf(DOMException);
    expect((postErr as DOMException).name).toBe('TimeoutError');
    expect(classifyHoldPostError(postErr)).toBe('unknown');

    await expect(client.balance(userAvailable(USER, 'USDT'))).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(client.getTxByKey('order.hold:timeout')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted === false)).toBe(true);
  });
});

describe('Convert settle over the HTTP ledger client', () => {
  it('settles instead of throwing "getTxByKey is not exposed" (the convert.accept 500)', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: parseAmount('10'), seedId: 'cvt-btc' }));
    await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: parseAmount('1000'), rail: 'test', railRef: 'cvt-u' }));
    vi.stubGlobal('fetch', ledgerDoorOver(ledger, []));
    const client = createLedgerClient('http://ledger.test', SECRET);

    const bound = boundBuy();
    const plan = planConvertSettle({ bound, ...convertSettleIdsFor(bound.quote.quoteId), now: ACCEPT_AT });
    await postConvertSettle(client, plan);

    expect(formatAmount((await ledger.balance(userAvailable(USER, 'BTC'))).amount)).toBe('1');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});
