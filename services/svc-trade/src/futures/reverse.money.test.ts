/**
 * One-tap reverse of a futures position (J-derivatives-03 #9, D-account-03), against real trade schema, MemoryLedger
 * and a scripted engine.
 *
 * One request closes the position through the book and opens the other side at the same size and leverage, each leg
 * an ordinary book order under the request's own key. These tests pin: the open goes only after the close settled; a
 * refused open leaves the close standing and says `closed_only` with the refusal; a close that took nothing or less
 * than the size opens nothing and leaves the rest free to reverse again; a position another order closed first opens
 * nothing; the same request sent again places nothing twice; a crash between the legs is carried on by the same
 * request or reported by the reconciler, which never places and never reports a leg while a send may be on its way.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLedger, formatAmount, parseAmount, positionCollateralAccount, recipes } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type { EngineSubmitRequest, EngineSubmitResult, MatchingClient } from '../spot/matching-client.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { MatchedFuturesOrders, type PlaceMatchedOrderInput } from './matched-orders.js';
import { matchedOrderIdFor } from './ids.js';
import {
  createReverseService,
  REVERSE_ALREADY_REQUESTED,
  REVERSE_CLOSE_NOT_SENT,
  REVERSE_CLOSED_ELSEWHERE,
  REVERSE_OPEN_NOT_SENT,
  type ReverseDeps,
} from './reverse.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_reverse_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`the reverse tests need Postgres: TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
  }
}

const A = (s: string) => parseAmount(s);
const USDT = 'USDT';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SYMBOL = 'BTC/USDT:USDT';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const PROOF = { stub: true } as unknown as LifecycleAdmissionProof;

/** Scripted engine: each submit takes the next scripted answer, or rests the order untouched. */
class FakeEngine {
  readonly submits: EngineSubmitRequest[] = [];
  readonly script: Array<EngineSubmitResult | Error> = [];
  private seq = 1000;

  async submit(_marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    this.submits.push(request);
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    this.seq += 1;
    return {
      accepted: true,
      sequence: this.seq,
      fills: [],
      resting: {
        kind: 'book',
        orderId: request.orderId,
        accountId: request.accountId,
        side: request.side,
        price: request.price ?? '0',
        remaining: request.qty,
        sequence: this.seq,
      },
      rejected: null,
      cancellations: [],
      triggered: [],
    };
  }

  async cancel(_marketId: string, orderId: string) {
    this.seq += 1;
    return { cancelled: true, orderId, sequence: this.seq, cancellation: null };
  }
}

const principal = (userId: string) => ({ userId, scopes: [] }) as unknown as Principal;

describe('one-tap reverse through the book', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  let ledger: MemoryLedger;
  let engine: FakeEngine;
  let book: MatchedFuturesOrders;
  let seq: number;

  beforeEach(async () => {
    await sql`
      TRUNCATE trade.futures_reverse_requests, trade.futures_order_fills, trade.futures_orders, trade.positions, trade.markets,
        trade.futures_payouts, trade.futures_fill_waits, trade.account_position_modes
      RESTART IDENTITY CASCADE
    `;
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET}, ${SYMBOL}, 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now()
      )
    `;
    ledger = new MemoryLedger();
    engine = new FakeEngine();
    seq = 5000;
    book = new MatchedFuturesOrders({
      sql,
      ledger,
      matching: engine as unknown as MatchingClient,
      enabled: true,
      priceBand: A('0.05'),
      maxLeverage: A('10'),
      now: () => NOW,
      markFor: async () => A('100'),
      assertPositionIdle: async () => undefined,
      lifecycleProof: async () => PROOF,
      admission: { admit: vi.fn(async () => ({})), admitStanding: vi.fn(async () => ({})) } as unknown as TradingAdmissionPort,
      emailProof: { get: async () => 'accepted' },
      feeRates: async () => ({ makerBps: 0, takerBps: 0 }),
    });
    for (const userId of [ALICE, BOB, CAROL]) {
      await ledger.post(
        recipes.deposit({ userId, assetId: USDT, amount: A('1000'), rail: 'test', railRef: `fund-${userId}-${randomUUID()}` }),
      );
    }
  });

  function reverses(extra: Partial<ReverseDeps> = {}) {
    return createReverseService({
      sql,
      place: (who, input) => book.place(who, input),
      settleWaitMs: 0,
      sleep: async () => undefined,
      ...extra,
    });
  }

  function limit(userId: string, side: 'buy' | 'sell', qty: string, price: string, clientOrderId: string): PlaceMatchedOrderInput {
    return { userId, symbol: SYMBOL, side, type: 'limit', qty: A(qty), limitPrice: A(price), leverage: A('10'), clientOrderId };
  }

  /** Alice long `qty` at 100 against Bob's short, both at 10x. */
  async function aliceLong(qty = '1'): Promise<string> {
    const a = await book.place(principal(ALICE), limit(ALICE, 'buy', qty, '100', `a-open-${seq}`));
    const b = await book.place(principal(BOB), limit(BOB, 'sell', qty, '100', `b-open-${seq}`));
    seq += 1;
    await book.settleFill({ marketId: MARKET, makerOrderId: a.orderId, takerOrderId: b.orderId, price: '100', qty, sequence: seq });
    const [pos] = await sql<{ id: string }[]>`SELECT id FROM trade.positions WHERE user_id = ${ALICE} AND status = 'open'`;
    return pos!.id;
  }

  /** Carol's resting buy at 100: the liquidity Alice's sells meet. */
  async function carolBid(qty: string): Promise<string> {
    const c = await book.place(principal(CAROL), limit(CAROL, 'buy', qty, '100', `c-bid-${seq}`));
    seq += 1;
    return c.orderId;
  }

  /** The engine fills Alice's sell under `clientOrderId` against `makerOrderId`: `qty` at 100, `left` cancelled. */
  function scriptSell(clientOrderId: string, makerOrderId: string, qty: string, left?: string) {
    seq += 1;
    const takerOrderId = matchedOrderIdFor(ALICE, MARKET, clientOrderId);
    engine.script.push({
      accepted: true,
      sequence: seq,
      fills:
        qty === '0'
          ? []
          : [
              {
                sequence: seq,
                makerOrderId,
                makerAccountId: CAROL,
                takerOrderId,
                takerAccountId: ALICE,
                takerSide: 'sell',
                price: '100',
                qty,
              },
            ],
      resting: null,
      rejected: null,
      cancellations: left ? [{ orderId: takerOrderId, accountId: ALICE, remainingQty: left, sequence: seq, reason: 'ioc' }] : [],
      triggered: [],
    } as EngineSubmitResult);
    return takerOrderId;
  }

  async function alicePositions() {
    const rows = await sql<{ id: string; side: string; status: string; size: string; leverage: string }[]>`
      SELECT id, side, status, size, leverage FROM trade.positions WHERE user_id = ${ALICE} ORDER BY opened_at
    `;
    return rows.map((r) => ({ ...r, size: formatAmount(A(r.size)), leverage: formatAmount(A(r.leverage)) }));
  }

  async function aliceOrders() {
    const rows = await sql<{ client_order_id: string; side: string; reduce_only: boolean; status: string; filled_qty: string }[]>`
      SELECT client_order_id, side, reduce_only, status, filled_qty FROM trade.futures_orders
      WHERE user_id = ${ALICE} AND client_order_id LIKE 'rv:%' ORDER BY created_at, client_order_id
    `;
    return rows.map((r) => [r.client_order_id, r.side, r.reduce_only, r.status, formatAmount(A(r.filled_qty))]);
  }

  it('closes the long through the book, then opens a short of the same size and leverage, under one request', async () => {
    const positionId = await aliceLong();
    const bid = await carolBid('2');
    const closeId = scriptSell('rv:c:rev-1', bid, '1');
    const openId = scriptSell('rv:o:rev-1', bid, '1');
    const view = await reverses().reverse(principal(ALICE), { positionId, clientRequestId: 'rev-1' });

    expect(view).toMatchObject({
      status: 'done',
      from: 'long',
      to: 'short',
      size: '1',
      leverage: '10',
      closeOrderId: closeId,
      openOrderId: openId,
      closedQuantity: '1',
      openedQuantity: '1',
      refusalCode: null,
    });
    // The close was reduce-only on the long; the open a plain sell that opened the short.
    expect(await aliceOrders()).toEqual([
      ['rv:c:rev-1', 'sell', true, 'filled', '1'],
      ['rv:o:rev-1', 'sell', false, 'filled', '1'],
    ]);
    const positions = await alicePositions();
    expect(positions.map((p) => [p.side, p.status, p.size, p.leverage])).toEqual([
      ['long', 'closed', '1', '10'],
      ['short', 'open', '1', '10'],
    ]);
    expect(view.newPositionId).toBe(positions[1]!.id);
    expect(await ledger.balance(positionCollateralAccount(ALICE, USDT, positionId))).toMatchObject({ amount: 0n });
    expect((await ledger.balance(positionCollateralAccount(ALICE, USDT, positions[1]!.id))).amount).toBe(A('10'));

    // The same request again answers the same reverse and places nothing.
    const submitted = engine.submits.length;
    expect(await reverses().reverse(principal(ALICE), { positionId, clientRequestId: 'rev-1' })).toEqual(view);
    expect(engine.submits).toHaveLength(submitted);
  });

  it('an open the book refuses leaves the close standing: closed_only with the refusal, and nothing more is placed', async () => {
    const positionId = await aliceLong();
    // A live opening buy on the contract: in one-way mode the book refuses opening the short beside it.
    await book.place(principal(ALICE), limit(ALICE, 'buy', '0.5', '95', 'a-add'));
    const bid = await carolBid('1');
    scriptSell('rv:c:rev-2', bid, '1');
    const view = await reverses().reverse(principal(ALICE), { positionId, clientRequestId: 'rev-2' });

    expect(view).toMatchObject({ status: 'closed_only', closedQuantity: '1', openedQuantity: null, openOrderId: null });
    expect(view.refusalCode).toBe('trade.futures_one_way_flip_refused');
    expect((await alicePositions()).map((p) => [p.side, p.status])).toEqual([['long', 'closed']]);
    expect(await aliceOrders()).toEqual([['rv:c:rev-2', 'sell', true, 'filled', '1']]);
    const submitted = engine.submits.length;
    expect(await reverses().reverse(principal(ALICE), { positionId, clientRequestId: 'rev-2' })).toMatchObject({ status: 'closed_only' });
    expect(engine.submits).toHaveLength(submitted);
  });

  it('a close that takes nothing opens nothing: refused, the long untouched, and another request may try again', async () => {
    const positionId = await aliceLong();
    scriptSell('rv:c:rev-3', 'none', '0', '1');
    const view = await reverses().reverse(principal(ALICE), { positionId, clientRequestId: 'rev-3' });
    expect(view).toMatchObject({ status: 'refused', closedQuantity: null, openOrderId: null });
    expect(view.refusalCode).not.toBeNull();
    expect((await alicePositions()).map((p) => [p.side, p.status, p.size])).toEqual([['long', 'open', '1']]);

    // Nothing changed, so the position may be reversed under a new request.
    const bid = await carolBid('2');
    scriptSell('rv:c:rev-3b', bid, '1');
    scriptSell('rv:o:rev-3b', bid, '1');
    expect(await reverses().reverse(principal(ALICE), { positionId, clientRequestId: 'rev-3b' })).toMatchObject({ status: 'done' });
  });

  it('a close that takes less than the size opens nothing: close_incomplete with what it closed', async () => {
    const positionId = await aliceLong();
    const bid = await carolBid('0.4');
    scriptSell('rv:c:rev-4', bid, '0.4', '0.6');
    const view = await reverses().reverse(principal(ALICE), { positionId, clientRequestId: 'rev-4' });
    expect(view).toMatchObject({ status: 'close_incomplete', closedQuantity: '0.4', openOrderId: null });
    expect((await alicePositions()).map((p) => [p.side, p.status, p.size])).toEqual([['long', 'open', '0.6']]);
    expect(await aliceOrders()).toEqual([['rv:c:rev-4', 'sell', true, 'cancelled', '0.4']]);

    // The reverse ended, so the 0.6 still open may be reversed under a new request.
    const more = await carolBid('1.2');
    scriptSell('rv:c:rev-4b', more, '0.6');
    scriptSell('rv:o:rev-4b', more, '0.6');
    expect(await reverses().reverse(principal(ALICE), { positionId, clientRequestId: 'rev-4b' })).toMatchObject({
      status: 'done',
      size: '0.6',
      openedQuantity: '0.6',
    });
  });

  it('an open refused on its own row (too little margin) is final: closed_only with the refusal, not working', async () => {
    const positionId = await aliceLong();
    const bid = await carolBid('2');
    scriptSell('rv:c:rev-8', bid, '1');
    const service = reverses({
      place: async (who, input) => {
        // Between the legs the balance is taken by another hold, so the open cannot be margined.
        if (input.clientOrderId.startsWith('rv:o:')) {
          await ledger.post(recipes.futuresOrderMarginHold({ orderId: randomUUID(), userId: ALICE, assetId: USDT, amount: A('995') }));
        }
        return book.place(who, input);
      },
    });
    const view = await service.reverse(principal(ALICE), { positionId, clientRequestId: 'rev-8' });
    expect(view).toMatchObject({ status: 'closed_only', closedQuantity: '1', openedQuantity: null });
    expect(view.refusalCode).toBe('trade.futures_margin_insufficient');
    expect(await aliceOrders()).toEqual([
      ['rv:c:rev-8', 'sell', true, 'filled', '1'],
      ['rv:o:rev-8', 'sell', false, 'refused', '0'],
    ]);
  });

  it('a position another order closed first opens nothing: the reverse says so and places no open', async () => {
    const positionId = await aliceLong();
    // The close rests (nothing in the script fills it), then the position is liquidated and the close comes off empty.
    expect(await reverses().reverse(principal(ALICE), { positionId, clientRequestId: 'rev-9' })).toMatchObject({ status: 'closing' });
    await sql`UPDATE trade.positions SET status = 'liquidated' WHERE id = ${positionId}`;
    await sql`UPDATE trade.futures_orders SET status = 'cancelled', engine_filled_qty = 0 WHERE client_order_id = 'rv:c:rev-9'`;
    await sql`UPDATE trade.futures_reverse_requests SET updated_at = now() - interval '1 minute'`;
    const submitted = engine.submits.length;
    expect(await reverses().reconcile()).toBe(1);
    const view = await reverses().reverse(principal(ALICE), { positionId, clientRequestId: 'rev-9' });
    expect(view).toMatchObject({ status: 'refused', refusalCode: REVERSE_CLOSED_ELSEWHERE, closedQuantity: '0', openOrderId: null });
    expect(engine.submits).toHaveLength(submitted);
    expect((await alicePositions()).map((p) => [p.side, p.status])).toEqual([['long', 'liquidated']]);
  });

  it('the reconciler reports a close never sent, but not while a send of it may be on its way', async () => {
    const positionId = await aliceLong();
    const stopped = reverses({
      place: async () => {
        throw new Error('process stopped');
      },
    });
    expect(await stopped.reverse(principal(ALICE), { positionId, clientRequestId: 'rev-10' })).toMatchObject({ status: 'closing' });
    // Sent again 10 s ago: within staleMs, nothing is reported.
    await sql`UPDATE trade.futures_reverse_requests SET updated_at = now() - interval '10 seconds'`;
    expect(await reverses({ staleMs: 60_000 }).reconcile()).toBe(0);
    await sql`UPDATE trade.futures_reverse_requests SET updated_at = now() - interval '1 hour'`;
    expect(await reverses({ staleMs: 60_000 }).reconcile()).toBe(1);
    const [row] = await sql<{ status: string; refusal_code: string }[]>`SELECT status, refusal_code FROM trade.futures_reverse_requests`;
    expect(row).toEqual({ status: 'refused', refusal_code: REVERSE_CLOSE_NOT_SENT });
    expect(await aliceOrders()).toEqual([]);
  });

  it('a crash after the close settled: the same request carries on to the open, once', async () => {
    const positionId = await aliceLong();
    const bid = await carolBid('2');
    scriptSell('rv:c:rev-5', bid, '1');
    let calls = 0;
    const crashing = reverses({
      place: async (who, input) => {
        calls += 1;
        if (calls === 2) throw new Error('connection reset');
        return book.place(who, input);
      },
    });
    expect(await crashing.reverse(principal(ALICE), { positionId, clientRequestId: 'rev-5' })).toMatchObject({ status: 'opening' });
    expect((await alicePositions()).map((p) => [p.side, p.status])).toEqual([['long', 'closed']]);

    scriptSell('rv:o:rev-5', bid, '1');
    const done = await reverses().reverse(principal(ALICE), { positionId, clientRequestId: 'rev-5' });
    expect(done).toMatchObject({ status: 'done', openedQuantity: '1' });
    expect(await aliceOrders()).toEqual([
      ['rv:c:rev-5', 'sell', true, 'filled', '1'],
      ['rv:o:rev-5', 'sell', false, 'filled', '1'],
    ]);
  });

  it('the reconciler reports an open never sent once its last send is stale, and places nothing', async () => {
    // The open's send fails before any order exists.
    const positionId = await aliceLong();
    const bid = await carolBid('2');
    scriptSell('rv:c:rev-6', bid, '1');
    const stopped = reverses({
      place: async (who, input) => {
        if (input.clientOrderId.startsWith('rv:o:')) throw new Error('process stopped');
        return book.place(who, input);
      },
    });
    await stopped.reverse(principal(ALICE), { positionId, clientRequestId: 'rev-6' });
    // Its last send was just now: within staleMs nothing is reported, since the open may still be on its way.
    await sql`UPDATE trade.futures_reverse_requests SET open_sent_at = now(), updated_at = now() - interval '1 hour'`;
    const submitted = engine.submits.length;
    expect(await reverses({ staleMs: 60_000 }).reconcile()).toBe(0);
    await sql`UPDATE trade.futures_reverse_requests SET open_sent_at = now() - interval '1 hour'`;
    expect(await reverses({ staleMs: 60_000 }).reconcile()).toBe(1);
    const [row] = await sql<{ status: string; refusal_code: string }[]>`SELECT status, refusal_code FROM trade.futures_reverse_requests`;
    expect(row).toEqual({ status: 'closed_only', refusal_code: REVERSE_OPEN_NOT_SENT });
    expect(engine.submits).toHaveLength(submitted);
    expect(await reverses().reverse(principal(ALICE), { positionId, clientRequestId: 'rev-6' })).toMatchObject({
      status: 'closed_only',
      refusalCode: REVERSE_OPEN_NOT_SENT,
    });
    expect(engine.submits).toHaveLength(submitted);
  });

  it('the reconciler reads an open placed before a crash', async () => {
    const positionId = await aliceLong();
    const bid = await carolBid('2');
    scriptSell('rv:c:rev-7', bid, '1');
    scriptSell('rv:o:rev-7', bid, '1');
    const lost = reverses({
      place: async (who, input) => {
        const order = await book.place(who, input);
        if (input.clientOrderId.startsWith('rv:o:')) throw new Error('answer lost');
        return order;
      },
    });
    expect(await lost.reverse(principal(ALICE), { positionId, clientRequestId: 'rev-7' })).toMatchObject({ status: 'opening' });
    await sql`UPDATE trade.futures_reverse_requests SET updated_at = now() - interval '1 hour'`;
    expect(await reverses().reconcile()).toBe(1);
    const [row] = await sql<
      { status: string; opened_quantity: string }[]
    >`SELECT status, opened_quantity FROM trade.futures_reverse_requests`;
    expect({ status: row!.status, opened: formatAmount(A(row!.opened_quantity)) }).toEqual({ status: 'done', opened: '1' });
  });

  it('refuses a position that is not the caller’s or not open, a second request for one being reversed, and a request id reused', async () => {
    const positionId = await aliceLong();
    const service = reverses();
    await expect(service.reverse(principal(BOB), { positionId, clientRequestId: 'bob' })).rejects.toMatchObject({
      code: 'trade.position_not_found',
    });
    await expect(service.reverse(principal(ALICE), { positionId: 'not-a-uuid', clientRequestId: 'x' })).rejects.toMatchObject({
      code: 'trade.position_not_found',
    });
    await expect(service.reverse(principal(ALICE), { positionId, clientRequestId: '' })).rejects.toMatchObject({
      code: 'trade.client_request_id_required',
    });
    // The first request's close rests (nothing in the script fills it), so it is still working.
    await service.reverse(principal(ALICE), { positionId, clientRequestId: 'first' });
    await expect(service.reverse(principal(ALICE), { positionId, clientRequestId: 'second' })).rejects.toMatchObject({
      code: REVERSE_ALREADY_REQUESTED,
    });
    const [bobPosition] = await sql<{ id: string }[]>`SELECT id FROM trade.positions WHERE user_id = ${BOB}`;
    await expect(service.reverse(principal(BOB), { positionId: bobPosition!.id, clientRequestId: 'first' })).resolves.toBeDefined();
    await expect(service.reverse(principal(ALICE), { positionId: bobPosition!.id, clientRequestId: 'first' })).rejects.toMatchObject({
      code: 'trade.client_order_id_conflict',
    });
    await sql`UPDATE trade.positions SET status = 'closed' WHERE user_id = ${BOB}`;
    await expect(service.reverse(principal(BOB), { positionId: bobPosition!.id, clientRequestId: 'late' })).rejects.toMatchObject({
      code: 'trade.position_not_open',
    });
  });
});
