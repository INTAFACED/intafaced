/**
 * Amend (J-derivatives-04 step 3, D-orders-02), against the real trade schema and MemoryLedger. The book has no native
 * futures amend, so an amend is a reviewed cancel-and-replace: nothing changes until the trader confirms, a replacement
 * that could not rest is refused with the original still on the book, the original's hold is released once and the
 * replacement's locked once, and the same amend sent again finds the same replacement.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLedger, futuresOrderMarginAccount, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type { EngineCancelResult, EngineSubmitRequest, EngineSubmitResult, MatchingClient } from '../spot/matching-client.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { MatchedFuturesOrders, type MatchedOrdersDeps, type PlaceMatchedOrderInput } from './matched-orders.js';
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
      .withDatabase('intafaced_amend_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`futures amend needs Postgres: TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
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

describe('svc-trade futures amend: a reviewed cancel-and-replace (PG-backed)', () => {
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

  it('a new price: the original cancelled and released once, the replacement resting with its label, its hold locked once', async () => {
    const svc = build();
    const original = await svc.place(
      principal(ALICE),
      order({ userId: ALICE, side: 'buy', qty: A('1'), limitPrice: A('99'), orderLabel: 'grid-7' }),
    );
    const out = await svc.replace(principal(ALICE), original.orderId, { limitPrice: A('98') });
    expect(out.replaced).toMatchObject({ orderId: original.orderId, status: 'cancelled' });
    expect(out.replacement).toMatchObject({
      status: 'open',
      limitPrice: '98',
      qty: '1',
      orderLabel: 'grid-7',
      clientOrderId: `replace:${original.orderId}`,
    });
    expect(await held(ALICE, original.orderId)).toBe(0n);
    const replacementHeld = await held(ALICE, out.replacement.orderId);
    expect(replacementHeld).toBe(A(out.replacement.holdAmount));
    expect(await free(ALICE)).toBe(A('1000') - replacementHeld);
    expect(engine.cancels).toEqual([original.orderId]);
    expect(engine.submits).toHaveLength(2);

    // The same amend again: the same replacement, nothing more cancelled, placed or held.
    const again = await svc.replace(principal(ALICE), original.orderId, { limitPrice: A('98') });
    expect(again.replacement.orderId).toBe(out.replacement.orderId);
    expect(engine.submits).toHaveLength(2);
    expect(engine.cancels).toHaveLength(1);
    expect(await free(ALICE)).toBe(A('1000') - replacementHeld);
    // Other terms under the same original: a different request, refused; nothing moves.
    await expect(svc.replace(principal(ALICE), original.orderId, { limitPrice: A('97') })).rejects.toMatchObject({
      code: 'trade.client_order_id_conflict',
    });
    expect(await free(ALICE)).toBe(A('1000') - replacementHeld);
  });

  it('sent again after a stop between the cancel and the place, the amend finishes: one replacement, holds once', async () => {
    const svc = build();
    const original = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    // As the first try left it: the original cancelled through the book and marked as amended, nothing placed yet.
    await svc.cancel(principal(ALICE), original.orderId);
    await sql`UPDATE trade.futures_orders SET refusal_code = 'trade.futures_order_amended' WHERE id = ${original.orderId}`;
    expect(await free(ALICE)).toBe(A('1000'));
    const out = await svc.replace(principal(ALICE), original.orderId, { limitPrice: A('98') });
    expect(out.replacement).toMatchObject({ status: 'open', limitPrice: '98', clientOrderId: `replace:${original.orderId}` });
    const again = await svc.replace(principal(ALICE), original.orderId, { limitPrice: A('98') });
    expect(again.replacement.orderId).toBe(out.replacement.orderId);
    expect(await free(ALICE)).toBe(A('1000') - (await held(ALICE, out.replacement.orderId)));
    // A cancel the trader made themselves is not an amend to finish.
    const own = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    await svc.cancel(principal(ALICE), own.orderId);
    await expect(svc.replace(principal(ALICE), own.orderId, { limitPrice: A('98') })).rejects.toMatchObject({
      code: 'trade.futures_order_not_amendable',
    });
  });

  it('every opening check runs before the cancel: a leverage the position no longer has is refused with the original resting', async () => {
    const svc = build();
    const buy = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const sell = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('1') }));
    await svc.settleFill({ marketId: MARKET, makerOrderId: buy.orderId, takerOrderId: sell.orderId, price: '100', qty: '1', sequence: 1 });
    const resting = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), limitPrice: A('99') }));
    await sql`UPDATE trade.positions SET leverage = '5' WHERE user_id = ${ALICE} AND status = 'open'`;
    const cancels = engine.cancels.length;
    await expect(svc.replace(principal(ALICE), resting.orderId, { limitPrice: A('98') })).rejects.toMatchObject({
      code: 'trade.futures_leverage_mismatch',
    });
    expect(await statusOf(resting.orderId)).toBe('open');
    expect(engine.cancels).toHaveLength(cancels);
  });

  it('the margin tier is read as it stands once the original is off: a tier only the original reached is asked before the cancel', async () => {
    // A ladder of two tiers: any live opening order puts the side in tier 2, so a first order is asked to confirm it.
    // Counted, the original keeps the side in tier 2 and the replacement crosses nothing; once it is cancelled, the
    // replacement crosses into tier 2 alone. The tier is read without the original, so the amend asks before it cancels.
    const svc = build({
      riskTier: async ({ userId, marketId, side, qty, excludeOrderId }) => {
        const live = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM trade.futures_orders
           WHERE user_id = ${userId} AND market_id = ${marketId} AND reduce_only = false
             AND side = ${side === 'long' ? 'buy' : 'sell'}
             AND status IN ('pending', 'held', 'submitting', 'open', 'submit_unknown')
             AND (${excludeOrderId ?? null}::text IS NULL OR id::text <> ${excludeOrderId ?? null}::text)
        `;
        const currentTier = live[0]!.n > 0 ? 2 : null;
        return { currentTier, projectedTier: 2, maintenanceBps: 250, notional: qty * 100n, confirmRequired: currentTier === null };
      },
    });
    const resting = await svc.place(
      principal(ALICE),
      order({ userId: ALICE, side: 'buy', qty: A('1'), limitPrice: A('99'), confirmTier: 2 }),
    );
    expect(resting.status).toBe('open');
    const cancels = engine.cancels.length;
    await expect(svc.replace(principal(ALICE), resting.orderId, { limitPrice: A('98') })).rejects.toMatchObject({
      code: 'trade.risk_limit_confirm_required',
      status: 409,
    });
    expect(await statusOf(resting.orderId)).toBe('open');
    expect(engine.cancels).toHaveLength(cancels);
    // Confirmed, the amend goes through: the original cancelled once, the replacement resting at the new price.
    const done = await svc.replace(principal(ALICE), resting.orderId, { limitPrice: A('98'), confirmTier: 2 });
    expect(done.replaced.status).toBe('cancelled');
    expect(done.replacement).toMatchObject({ status: 'open', limitPrice: '98' });
  });

  it('a reduce-only order is not amended: a close is cancelled and placed again', async () => {
    const svc = build();
    const buy = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const sell = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('1') }));
    await svc.settleFill({ marketId: MARKET, makerOrderId: buy.orderId, takerOrderId: sell.orderId, price: '100', qty: '1', sequence: 1 });
    const close = await svc.place(
      principal(ALICE),
      order({ userId: ALICE, side: 'sell', qty: A('1'), limitPrice: A('101'), reduceOnly: true }),
    );
    await expect(svc.replace(principal(ALICE), close.orderId, { limitPrice: A('102') })).rejects.toMatchObject({
      code: 'trade.futures_order_not_amendable',
    });
    expect(await statusOf(close.orderId)).toBe('open');
  });

  it('a new size, and the replacement can itself be amended', async () => {
    const svc = build();
    const original = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const bigger = await svc.replace(principal(ALICE), original.orderId, { qty: A('2') });
    expect(bigger.replacement).toMatchObject({ qty: '2', limitPrice: '100', status: 'open' });
    const smaller = await svc.replace(principal(ALICE), bigger.replacement.orderId, { qty: A('0.5'), limitPrice: A('99') });
    expect(smaller.replacement).toMatchObject({ qty: '0.5', limitPrice: '99', status: 'open' });
    expect(await free(ALICE)).toBe(A('1000') - (await held(ALICE, smaller.replacement.orderId)));
  });

  it('a replacement that could not rest is refused with the original untouched: past the band, or more than could be held', async () => {
    const svc = build();
    const original = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const before = await free(ALICE);
    await expect(svc.replace(principal(ALICE), original.orderId, { limitPrice: A('80') })).rejects.toMatchObject({
      code: 'trade.futures_price_outside_band',
    });
    await expect(svc.replace(principal(ALICE), original.orderId, { qty: A('500') })).rejects.toMatchObject({
      code: 'trade.futures_margin_insufficient',
    });
    expect(await statusOf(original.orderId)).toBe('open');
    expect(await free(ALICE)).toBe(before);
    expect(engine.cancels).toEqual([]);
    expect(engine.submits).toHaveLength(1);
  });

  it('a partly filled original, one the book has not confirmed off, and unchanged terms are refused before anything is placed', async () => {
    const svc = build();
    const part = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2') }));
    await sql`UPDATE trade.futures_orders SET engine_filled_qty = '1' WHERE id = ${part.orderId}`;
    await expect(svc.replace(principal(ALICE), part.orderId, { limitPrice: A('99') })).rejects.toMatchObject({
      code: 'trade.futures_amend_partly_filled',
    });
    expect(engine.cancels).toEqual([]);

    const stuck = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    engine.cancel = async (_m, orderId) => ({ cancelled: false, orderId, sequence: null, cancellation: null }) as never;
    await expect(svc.replace(principal(ALICE), stuck.orderId, { limitPrice: A('99') })).rejects.toMatchObject({
      code: 'trade.futures_amend_not_confirmed',
    });
    expect(await statusOf(stuck.orderId)).toBe('open');
    expect(engine.submits).toHaveLength(2);

    await expect(svc.replace(principal(ALICE), stuck.orderId, { limitPrice: A('100') })).rejects.toMatchObject({
      code: 'trade.futures_amend_invalid',
    });
    await expect(svc.replace(principal(ALICE), stuck.orderId, {})).rejects.toMatchObject({ code: 'trade.futures_amend_invalid' });
  });

  it('only the trader’s own resting limit order: another’s or an unknown id is not found, an ended one not amendable', async () => {
    const svc = build();
    const bobs = await svc.place(principal(BOB), order({ userId: BOB, side: 'buy', qty: A('1') }));
    await expect(svc.replace(principal(ALICE), bobs.orderId, { limitPrice: A('99') })).rejects.toMatchObject({
      code: 'trade.futures_order_not_found',
    });
    await expect(svc.replace(principal(ALICE), randomUUID(), { limitPrice: A('99') })).rejects.toMatchObject({
      code: 'trade.futures_order_not_found',
    });
    const mine = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    await svc.cancel(principal(ALICE), mine.orderId);
    await expect(svc.replace(principal(ALICE), mine.orderId, { limitPrice: A('99') })).rejects.toMatchObject({
      code: 'trade.futures_order_not_amendable',
    });
    expect(await statusOf(bobs.orderId)).toBe('open');
    expect(await free(ALICE)).toBe(A('1000'));
  });
});
