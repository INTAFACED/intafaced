/**
 * Liquidation and insurance fund desk reads (D-ops-06), against Postgres.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AuthError } from '@intafaced/auth';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { principalFor } from '../spot/testing.js';
import { MemoryApprovalBook } from './common.js';
import { TradeOpsAdmin } from './service.js';
import { INSURANCE_TOPUPS_NOT_BOOKED_HERE, LIQ_PRICE_NOT_RECORDED, MARK_NOT_ACCEPTED } from './futures-desk.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const url = (() => {
  const parsed = new URL(rawUrl);
  if (decodeURIComponent(parsed.pathname.replace(/^\//, '')).endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '55555555-5555-4555-8555-555555555555';
const DAVE = '66666666-6666-4666-8666-666666666666';
const OP = '33333333-3333-4333-8333-333333333333';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operator = () => principalFor(OP, ['admin:read']);
const customer = () => principalFor(ALICE, ['trade:read']);

describe('futures liquidation and insurance desk', () => {
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let admin: TradeOpsAdmin;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.operator_audit, trade.liquidation_rungs, trade.futures_adl_pairs, trade.futures_payouts,
      trade.positions, trade.markets RESTART IDENTITY CASCADE`;
    await db.sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (${MARKET}, 'BTC/USDT-PERP', 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now())
    `;
    ledger = new MemoryLedger();
    admin = new TradeOpsAdmin({
      sql: db.sql,
      approvals: new MemoryApprovalBook(),
      ledger,
      reconcileOrder: async () => {
        throw new Error('unused');
      },
      cancelOrder: async () => undefined,
    });
  });

  async function position(userId: string, input: { mark: string | null; liq: string | null }): Promise<string> {
    const id = randomUUID();
    await db.sql`
      INSERT INTO trade.positions (id, user_id, market_id, side, status, size, entry_price, margin_initial, margin_current, margin_asset,
        accepted_mark, liq_price)
      VALUES (${id}, ${userId}, ${MARKET}, 'long', 'open', '1', '50000', '5000', '5000', 'USDT', ${input.mark}, ${input.liq})
    `;
    return id;
  }

  async function rung(positionId: string, state: string, fromInsurance: string): Promise<string> {
    const id = randomUUID();
    const plan = {
      recipes: [],
      sizeClosed: amt('1').toString(),
      marginRemaining: '0',
      marginTaken: amt('5000').toString(),
      releaseShort: '0',
      lossShort: '0',
      reason: 'closing',
      fromInsurance: amt(fromInsurance).toString(),
      marginAsset: 'USDT',
    };
    await db.sql`
      INSERT INTO trade.liquidation_rungs (rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state)
      VALUES (${id}, ${positionId}, ${`liq:${positionId}`}, 'closing', '1', '5000', ${db.sql.json(plan as never)}, ${state})
    `;
    return id;
  }

  it('shows rungs, parked positions, nearest to liquidation, ADL pairs and owed payouts', async () => {
    const near = await position(ALICE, { mark: '46000', liq: '45500' });
    const far = await position(BOB, { mark: '50000', liq: '40000' });
    const dark = await position(CAROL, { mark: null, liq: '45000' });
    const parkedId = await position(DAVE, { mark: '50000', liq: null });
    await rung(parkedId, 'abandoned', '0');
    const applied = await rung(far, 'applied', '120');
    await db.sql`
      INSERT INTO trade.futures_adl_pairs (pair_id, ordinal, bankrupt_position_id, bankrupt_user_id, candidate_position_id, candidate_user_id,
        asset_id, size, bankruptcy_price, bankrupt_margin_taken, bankrupt_initial_taken, candidate_margin_released,
        candidate_initial_released, candidate_release_sequence, candidate_profit, disclosure_event_id)
      VALUES (${`futures.adl:${near}:1:${far}`}, 1, ${near}, ${ALICE}, ${far}, ${BOB}, 'USDT', '1', '45000', '5000', '5000', '5000', '5000', 2, '5000', 'evt-1')
    `;
    await db.sql`
      INSERT INTO trade.futures_payouts (profit_id, position_id, user_id, asset_id, amount, state, refusal_code, attempts)
      VALUES ('p1', ${far}, ${BOB}, 'USDT', '700', 'pending', 'trade.clearing_pot_short', 1)
    `;

    const desk = await admin.futuresLiquidations(operator(), { market: MARKET, limit: 50 });

    expect(desk.rungs.map((r) => [r.state, r.fromInsurance])).toEqual([
      ['abandoned', '0'],
      ['applied', '120'],
    ]);
    expect(desk.rungs[1]!.rungId).toBe(applied);
    expect(desk.parked).toEqual([parkedId]);
    // Closest first (near is 108 bps away), unknown distances after, never ranked as zero.
    expect(desk.nearThreshold.map((p) => [p.positionId, p.distanceBps, p.reason])).toEqual(
      expect.arrayContaining([
        [near, 108, null],
        [far, 2000, null],
      ]),
    );
    expect(desk.nearThreshold[0]!.positionId).toBe(near);
    expect(desk.nearThreshold.find((p) => p.positionId === dark)).toMatchObject({ distanceBps: null, reason: MARK_NOT_ACCEPTED });
    expect(desk.nearThreshold.find((p) => p.positionId === parkedId)).toMatchObject({ distanceBps: null, reason: LIQ_PRICE_NOT_RECORDED });
    expect(desk.nearThreshold.slice(-2).every((p) => p.distanceBps === null)).toBe(true);
    expect(desk.adlPairs).toMatchObject([
      { bankruptPositionId: near, candidatePositionId: far, bankruptcyPrice: '45000', state: 'planned' },
    ]);
    expect(desk.owedPayouts).toEqual([{ assetId: 'USDT', owed: '700', count: 1 }]);

    const [audit] = await db.sql<{ kind: string }[]>`SELECT kind FROM trade.operator_audit`;
    expect(audit?.kind).toBe('futures.liquidations');
  });

  it('refuses a customer and a missing page size', async () => {
    await expect(admin.futuresLiquidations(customer(), { limit: 10 })).rejects.toBeInstanceOf(AuthError);
    await expect(admin.futuresLiquidations(operator(), { limit: 0 })).rejects.toMatchObject({ code: 'liquidations_limit_unset' });
  });

  it('shows the insurance fund balance and the draws this service booked, and says top-ups are not readable here', async () => {
    await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('900'), rail: 'test', railRef: 'fund' }));
    await ledger.post(
      recipes.feeCharge({ chargeId: 'fee-seed', userId: ALICE, module: 'trade', mode: 'asset', assetId: 'USDT', amount: amt('900') }),
    );
    await ledger.post(recipes.futuresInsuranceTopup({ topupId: 'seed', assetId: 'USDT', amount: amt('900') }));
    const p = await position(ALICE, { mark: '50000', liq: '45000' });
    await rung(p, 'applied', '120');
    await rung(p, 'abandoned', '50');

    const history = await admin.futuresInsuranceHistory(operator(), { asset: 'USDT', limit: 10 });
    expect(history.balance).toEqual({ value: '900', reason: null });
    expect(history.draws.map((d) => d.amount)).toEqual(['120']);
    expect(history.topUps).toEqual({ value: null, reason: INSURANCE_TOPUPS_NOT_BOOKED_HERE });
  });

  it('shows an error, never 0, when the insurance read fails', async () => {
    const failing = new TradeOpsAdmin({
      sql: db.sql,
      approvals: new MemoryApprovalBook(),
      ledger: {
        async balance() {
          throw new Error('ledger unreachable');
        },
      },
      reconcileOrder: async () => {
        throw new Error('unused');
      },
      cancelOrder: async () => undefined,
    });
    await expect(failing.futuresInsuranceHistory(operator(), { asset: 'USDT', limit: 10 })).rejects.toThrow('ledger unreachable');
  });
});
