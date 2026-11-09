/**
 * Self-trade prevention on the futures book (J-derivatives-04 step 7, D-orders-08), against the real trade schema and
 * MemoryLedger. The engine's one mode cancels the trader's resting order when their new order would trade with it, and
 * opens a surveillance case. Here: that cancellation is recorded on the futures order as `trade.self_trade_prevention`,
 * from the submit's own reply or from the cancellation event, and its hold is released once.
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
      .withDatabase('intafaced_self_trade_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`self-trade recording needs Postgres: TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
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

describe('svc-trade futures self-trade prevention, recorded (PG-backed)', () => {
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
  const rowOf = async (orderId: string) =>
    (
      await sql<
        { status: string; refusal_code: string | null }[]
      >`SELECT status, refusal_code FROM trade.futures_orders WHERE id = ${orderId}`
    )[0]!;

  it('a resting order the engine cancels for self-trade, named in the submit reply: recorded with its reason', async () => {
    const svc = build();
    const resting = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), limitPrice: A('99') }));
    const real = engine.submit.bind(engine);
    engine.submit = async (marketId, request) => {
      const out = await real(marketId, request);
      return {
        ...out,
        cancellations: [{ orderId: resting.orderId, accountId: ALICE, remainingQty: '1', sequence: 9001, reason: 'self_trade_prevention' }],
      };
    };
    await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), limitPrice: A('100') }));
    expect((await rowOf(resting.orderId)).refusal_code).toBe('trade.self_trade_prevention');
    // The engine's cancellation event then takes it off and releases its hold, once.
    expect(await svc.releaseEngineCancellation(resting.orderId, '1', 'self_trade_prevention')).toBe(true);
    expect(await svc.releaseEngineCancellation(resting.orderId, '1', 'self_trade_prevention')).toBe(true);
    expect(await rowOf(resting.orderId)).toMatchObject({ status: 'cancelled', refusal_code: 'trade.self_trade_prevention' });
    expect(await free(ALICE)).toBe(
      A('1000') - (await svc.listForUser(ALICE, { scope: 'open', limit: 10 })).reduce((n, o) => n + A(o.holdAmount), 0n),
    );
  });

  it('named only by the cancellation event, it is recorded too; any other cancel keeps no such reason', async () => {
    const svc = build();
    const a = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const b = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    await svc.releaseEngineCancellation(a.orderId, '1', 'self_trade_prevention');
    await svc.releaseEngineCancellation(b.orderId, '1', 'cancel');
    expect(await rowOf(a.orderId)).toMatchObject({ status: 'cancelled', refusal_code: 'trade.self_trade_prevention' });
    expect(await rowOf(b.orderId)).toMatchObject({ status: 'cancelled', refusal_code: null });
    expect(await free(ALICE)).toBe(A('1000'));
  });
});
