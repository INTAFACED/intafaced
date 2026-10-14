/**
 * The HTTP ledger client must implement every LedgerClient read that money paths
 * call. Convert settle calls `getTxByKey` before each post (#4678); the HTTP
 * client threw "not exposed over the internal ledger API", the router turned
 * that into INTERNAL_SERVER_ERROR, and every `convert.accept` returned 500 on a
 * running stack while the MemoryLedger tests stayed green.
 *
 * Here the client talks to the fake svc-ledger door (`ledger-door-fake.ts`): it
 * verifies the body-bound service signature and answers as svc-ledger's S2S
 * door does, backed by the in-memory reference ledger.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLedger, parseAmount, recipes, userAvailable, formatAmount } from '@intafaced/ledger-client';
import { acceptConvertQuote, buildFirmConvertQuote, estimateConvert } from './convert/quote.js';
import { planConvertSettle, postConvertSettle } from './convert/settle.js';
import { convertSettleIdsFor } from './convert/ids.js';
import { createLedgerClient } from './ledger-client.js';
import { fakeLedgerDoor } from './ledger-door-fake.js';

const USER = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-08-26T12:00:00.000Z');
const ACCEPT_AT = new Date('2026-08-26T12:00:01.000Z');
const SECRET = 'test-only-internal-service-secret-0123456789';

/** The door as a stubbed global fetch; `calls` collects the paths it was asked for. */
function ledgerDoorOver(ledger: MemoryLedger, calls: string[]) {
  const door = fakeLedgerDoor(ledger, SECRET, []);
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(new URL(String(input)).pathname);
    return door(input, init);
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
    const calls: string[] = [];
    vi.stubGlobal('fetch', ledgerDoorOver(ledger, calls));
    const client = createLedgerClient('http://ledger.test', SECRET);
    const tx = await client.getTxByKey(deposit.idempotencyKey);
    expect(tx?.id).toBe(posted.id);
    expect(tx?.idempotencyKey).toBe(deposit.idempotencyKey);
    expect(tx?.hash).toBe(posted.hash);
    expect(tx?.module).toBe(deposit.module);
    expect(tx?.reason).toBe(deposit.reason);
    // chained to txById, so the found transaction carries the legs the ledger booked
    expect(calls).toEqual(['/trpc/txByKey', '/trpc/txById']);
    expect(tx?.entries).toHaveLength(deposit.entries.length);
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
