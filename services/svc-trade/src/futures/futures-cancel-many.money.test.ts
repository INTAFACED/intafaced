/**
 * Batch cancel (J-derivatives-04 step 4, D-orders-02), against the real trade schema and MemoryLedger: by id, by
 * contract and by label, singly and in a batch. Each id is answered on its own line, an unknown id is reported while
 * the rest cancel, and every cancelled order releases its own unused hold exactly once: a second request for the same
 * orders moves nothing. A liquidation's order is never taken by a filter and refused when named.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLedger, formatAmount, futuresOrderMarginAccount, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type { EngineCancelResult, EngineSubmitRequest, EngineSubmitResult, MatchingClient } from '../spot/matching-client.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { FUTURES_CANCEL_BATCH_MAX, MatchedFuturesOrders, type MatchedOrdersDeps, type PlaceMatchedOrderInput } from './matched-orders.js';
import type { FeeRates } from './matched-order-plan.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const files = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const migrations = files.map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_cancel_many_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`batch cancel needs Postgres: TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
  }
}

const A = (s: string) => parseAmount(s);
const USDT = 'USDT';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const MARKET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SYMBOL = 'SOL/USDT-PERP';
const OTHER_MARKET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER = 'ETH/USDT-PERP';
const NOW = new Date('2026-10-24T06:00:00.000Z');
const PROOF = { stub: true } as unknown as LifecycleAdmissionProof;

/** Engine that rests every order untouched; fills are delivered by the test with `settleFill`, as the event path does. */
class RestingEngine {
  readonly submits: EngineSubmitRequest[] = [];
  readonly cancels: string[] = [];
  private seq = 7000;

  async submit(_marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    this.submits.push(request);
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

  async cancel(_marketId: string, orderId: string): Promise<EngineCancelResult> {
    this.cancels.push(orderId);
    this.seq += 1;
    const sent = this.submits.find((s) => s.orderId === orderId);
    const cancellation = { orderId, accountId: 'fake', remainingQty: sent?.qty ?? '0', sequence: this.seq, reason: 'cancel' };
    return { cancelled: true, orderId, sequence: this.seq, cancellation };
  }
}

const principal = (userId: string) => ({ userId, scopes: [] }) as unknown as Principal;

describe('svc-trade futures batch cancel (PG-backed)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  let ledger: MemoryLedger;
  let engine: RestingEngine;
  let admission: TradingAdmissionPort;

  beforeEach(async () => {
    await sql`
      TRUNCATE trade.futures_order_fills, trade.futures_orders, trade.positions, trade.markets, trade.futures_payouts,
               trade.futures_fill_waits, trade.account_position_modes, trade.liquidation_rungs, trade.futures_adl_pairs,
               trade.futures_conditional_orders, trade.futures_reverse_requests
      RESTART IDENTITY CASCADE
    `;
    for (const [id, symbol, base] of [
      [MARKET, SYMBOL, 'SOL'],
      [OTHER_MARKET, OTHER, 'ETH'],
    ] as const) {
      await sql`
        INSERT INTO trade.markets (
          id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
          maker_bps, taker_bps, status, display_name, listed_at
        ) VALUES (
          ${id}, ${symbol}, ${base}, 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', ${symbol}, now()
        )
      `;
    }
    ledger = new MemoryLedger();
    engine = new RestingEngine();
    admission = { admit: vi.fn(async () => ({})), admitStanding: vi.fn(async () => ({})) } as unknown as TradingAdmissionPort;
    for (const userId of [ALICE, BOB]) {
      await ledger.post(
        recipes.deposit({ userId, assetId: USDT, amount: A('1000'), rail: 'test', railRef: `fund-${userId}-${randomUUID()}` }),
      );
    }
  });

  function build(overrides: Partial<MatchedOrdersDeps> = {}): MatchedFuturesOrders {
    return new MatchedFuturesOrders({
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
      admission,
      emailProof: { get: async () => 'accepted' },
      feeRates: async () => ({ makerBps: 2, takerBps: 5 }),
      ...overrides,
    });
  }

  function order(
    overrides: Partial<PlaceMatchedOrderInput> & Pick<PlaceMatchedOrderInput, 'userId' | 'side' | 'qty'>,
  ): PlaceMatchedOrderInput {
    return { symbol: SYMBOL, type: 'limit', limitPrice: A('100'), leverage: A('10'), clientOrderId: `c-${randomUUID()}`, ...overrides };
  }

  const free = async (userId: string) => (await ledger.balance(userAvailable(userId, USDT))).amount;
  const held = async (userId: string, orderId: string) => (await ledger.balance(futuresOrderMarginAccount(userId, USDT, orderId))).amount;
  const statusOf = async (orderId: string) =>
    (await sql<{ status: string }[]>`SELECT status FROM trade.futures_orders WHERE id = ${orderId}`)[0]!.status;

  it('a batch by id: each id answered in the order given, an unknown and another trader’s id reported while the rest cancel', async () => {
    const svc = build();
    const a = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const b = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2') }));
    const c = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), symbol: OTHER }));
    const bobs = await svc.place(principal(BOB), order({ userId: BOB, side: 'buy', qty: A('1') }));
    expect(await free(ALICE)).toBeLessThan(A('1000'));
    const unknown = randomUUID();

    const out = await svc.cancelMany(principal(ALICE), { orderIds: [a.orderId, unknown, b.orderId, bobs.orderId, c.orderId, a.orderId] });
    expect(out.more).toBe(false);
    expect(out.results.map((r) => [r.orderId, r.outcome])).toEqual([
      [a.orderId, 'cancelled'],
      [unknown, 'not_found'],
      [b.orderId, 'cancelled'],
      [bobs.orderId, 'not_found'],
      [c.orderId, 'cancelled'],
    ]);
    expect(out.results[1]).toMatchObject({ error: 'trade.futures_order_not_found' });
    // Every hold released, once; Bob's order untouched and the engine never asked about it.
    expect(await free(ALICE)).toBe(A('1000'));
    for (const o of [a, b, c]) expect(await held(ALICE, o.orderId)).toBe(0n);
    expect(await statusOf(bobs.orderId)).toBe('open');
    expect(engine.cancels).toEqual([a.orderId, b.orderId, c.orderId]);

    // The same batch again moves nothing: each order answers as it stands.
    const again = await svc.cancelMany(principal(ALICE), { orderIds: [a.orderId, b.orderId] });
    expect(again.results).toEqual([
      { orderId: a.orderId, outcome: 'cancelled', status: 'cancelled' },
      { orderId: b.orderId, outcome: 'cancelled', status: 'cancelled' },
    ]);
    expect(await free(ALICE)).toBe(A('1000'));
    expect(engine.cancels).toHaveLength(3);
  });

  it('a single id is a batch of one', async () => {
    const svc = build();
    const a = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const out = await svc.cancelMany(principal(ALICE), { orderIds: [a.orderId] });
    expect(out.results).toEqual([{ orderId: a.orderId, outcome: 'cancelled', status: 'cancelled' }]);
    expect(await free(ALICE)).toBe(A('1000'));
  });

  it('by contract: only that contract’s open orders, only the caller’s', async () => {
    const svc = build();
    const sol = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const eth = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), symbol: OTHER }));
    const bobs = await svc.place(principal(BOB), order({ userId: BOB, side: 'buy', qty: A('1') }));
    const ethHeld = await held(ALICE, eth.orderId);

    const out = await svc.cancelMany(principal(ALICE), { symbol: SYMBOL });
    expect(out.results.map((r) => [r.orderId, r.outcome])).toEqual([[sol.orderId, 'cancelled']]);
    expect(await statusOf(eth.orderId)).toBe('open');
    expect(await held(ALICE, eth.orderId)).toBe(ethHeld);
    expect(await statusOf(bobs.orderId)).toBe('open');
    expect(await free(ALICE)).toBe(A('1000') - ethHeld);
  });

  it('by label, and by label on one contract', async () => {
    const svc = build();
    const g1 = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), orderLabel: 'grid-7' }));
    const g2 = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), orderLabel: 'grid-7', symbol: OTHER }));
    const plain = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const bobs = await svc.place(principal(BOB), order({ userId: BOB, side: 'buy', qty: A('1'), orderLabel: 'grid-7' }));

    const one = await svc.cancelMany(principal(ALICE), { symbol: OTHER, label: 'grid-7' });
    expect(one.results.map((r) => r.orderId)).toEqual([g2.orderId]);
    const rest = await svc.cancelMany(principal(ALICE), { label: 'grid-7' });
    expect(rest.results.map((r) => [r.orderId, r.outcome])).toEqual([[g1.orderId, 'cancelled']]);
    expect(await statusOf(plain.orderId)).toBe('open');
    expect(await statusOf(bobs.orderId)).toBe('open');
    // Nothing left to match: an empty answer, nothing asked of the engine.
    const cancels = engine.cancels.length;
    expect((await svc.cancelMany(principal(ALICE), { label: 'grid-7' })).results).toEqual([]);
    expect(engine.cancels).toHaveLength(cancels);
  });

  it('a liquidation’s order is never taken by a filter, and is refused on its own line when named', async () => {
    const svc = build();
    // A position for the liquidation to work on: Alice's buy filled against Bob's sell.
    const buy = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2') }));
    const sell = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('2') }));
    await svc.settleFill({
      marketId: MARKET,
      makerOrderId: buy.orderId,
      takerOrderId: sell.orderId,
      price: formatAmount(A('100')),
      qty: formatAmount(A('2')),
      sequence: 1,
    });
    const [position] = await sql<{ id: string }[]>`
      SELECT id FROM trade.positions WHERE user_id = ${ALICE} AND market_id = ${MARKET} AND status = 'open'
    `;
    const mine = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const liquidation = randomUUID();
    const rung = randomUUID();
    await sql`
      INSERT INTO trade.futures_orders (
        id, user_id, market_id, client_order_id, side, order_type, qty, limit_price, mark_price, band_low, band_high,
        leverage, hold_asset, status, reduce_only, position_id, bankruptcy_price, liquidation_rung_id, origin, origin_ref
      ) VALUES (
        ${liquidation}, ${ALICE}, ${MARKET}, ${`liq:${rung}`}, 'sell', 'market', '2', '95', '100', '95', '105',
        '10', ${USDT}, 'open', true, ${position!.id}, '90', ${rung}, 'liquidation', ${rung}
      )
    `;
    const byContract = await svc.cancelMany(principal(ALICE), { symbol: SYMBOL });
    expect(byContract.results.map((r) => r.orderId)).toEqual([mine.orderId]);
    const named = await svc.cancelMany(principal(ALICE), { orderIds: [liquidation] });
    expect(named.results).toEqual([
      expect.objectContaining({ orderId: liquidation, outcome: 'refused', error: 'trade.futures_order_not_cancellable' }),
    ]);
    expect(await statusOf(liquidation)).toBe('open');
    expect(engine.cancels).toEqual([mine.orderId]);
  });

  it('refuses a request that names nothing, too many ids, or a bad label, before the engine is asked', async () => {
    const svc = build();
    const ids = Array.from({ length: FUTURES_CANCEL_BATCH_MAX + 1 }, () => randomUUID());
    for (const input of [{ orderIds: [] }, { orderIds: ids }, {}, { symbol: null, label: null }]) {
      await expect(svc.cancelMany(principal(ALICE), input)).rejects.toMatchObject({ code: 'trade.futures_cancel_batch_invalid' });
    }
    await expect(svc.cancelMany(principal(ALICE), { label: 'two words' })).rejects.toMatchObject({ code: 'trade.order_label_invalid' });
    expect(engine.cancels).toEqual([]);
  });

  it('a filter matching more than one request answers takes the oldest first and says more are left', async () => {
    const svc = build();
    const placed: string[] = [];
    for (let i = 0; i < FUTURES_CANCEL_BATCH_MAX + 2; i += 1) {
      placed.push((await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.01'), orderLabel: 'many' }))).orderId);
    }
    const first = await svc.cancelMany(principal(ALICE), { label: 'many' });
    expect(first.more).toBe(true);
    expect(first.results).toHaveLength(FUTURES_CANCEL_BATCH_MAX);
    const second = await svc.cancelMany(principal(ALICE), { label: 'many' });
    expect(second.more).toBe(false);
    expect(new Set([...first.results, ...second.results].map((r) => r.orderId))).toEqual(new Set(placed));
    expect(await free(ALICE)).toBe(A('1000'));
  }, 60_000);
});
