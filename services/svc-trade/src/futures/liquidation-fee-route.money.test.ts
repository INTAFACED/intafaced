/** D-margin-07: GET /api/v1/futures/liquidations shows the fee decision each rung stored. Postgres; TEST figures only. */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { encodeRungPlan } from './liquidation-rungs.js';
import { listCallerLiquidations } from './futures-reads.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-dddddddddddd';
const SECRET = 'a-trade-position-liquidation-edge-secret';

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim() ?? '';
  if (raw === '') throw new Error('TEST_DATABASE_URL is not set; this suite does not start Postgres');
  const url = new URL(raw);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

function principal(userId: string, scopes: string[] = ['trade:read', 'trade:write']): Principal {
  return {
    sub: userId,
    userId,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed(userId: string, scopes?: string[]): Record<string, string> {
  const raw = encodePrincipal(principal(userId, scopes));
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

describe('liquidation read fee decision route (D-margin-07)', () => {
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
    sql = db.sql;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE trade.positions, trade.markets, trade.liquidation_rungs RESTART IDENTITY CASCADE`;
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET}, 'TEST/USDT:USDT', 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1',
        10, 20, 'active', 'TEST/USDT:USDT', now()
      )
    `;
  });

  async function position(userId: string): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO trade.positions (
        id, user_id, market_id, side, status, margin_mode, size, entry_price,
        leverage, margin_initial, margin_current, margin_asset
      ) VALUES (
        ${id}, ${userId}, ${MARKET}, 'long', 'open', 'isolated', '1'::numeric, '50000'::numeric,
        '2'::numeric, '100'::numeric, '100'::numeric, 'USDT'
      )
    `;
    return id;
  }

  // TEST figures only.
  function planJson(withMark: boolean, fee: Record<string, unknown> = {}) {
    return sql.json(
      JSON.parse(
        JSON.stringify(
          encodeRungPlan({
            recipes: [],
            sizeClosed: parseAmount('0.2'),
            marginRemaining: parseAmount('80'),
            marginTaken: parseAmount('20'),
            releaseShort: 0n,
            lossShort: 0n,
            reason: 'partial',
            fromInsurance: parseAmount('1.5'),
            marginAsset: 'USDT',
            ...(withMark ? { markPrice: parseAmount('49000') } : {}),
            ...fee,
          }),
        ),
      ),
    );
  }

  async function rung(positionId: string, state: string, at: string, withMark = true, fee: Record<string, unknown> = {}) {
    await sql`
      INSERT INTO trade.liquidation_rungs (
        rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state, created_at
      ) VALUES (
        ${randomUUID()}, ${positionId}, ${`liq-${positionId}`}, 'partial', '1', '100', ${planJson(withMark, fee)}, ${state}, ${new Date(at)}
      )
    `;
  }

  function app() {
    const a = Fastify();
    const unused = async () => {
      throw new Error('unused');
    };
    registerPrivateRest(a, {
      edgeSecret: SECRET,
      serviceName: 'svc-trade',
      openOrders: async () => [],
      orderHistory: async () => [],
      getOrder: unused as PrivateRestDeps['getOrder'],
      placeOrder: unused as PrivateRestDeps['placeOrder'],
      cancelOrder: unused as PrivateRestDeps['cancelOrder'],
      cancelAllOrders: async () => [],
      massCancelOrders: async () => [],
      myFills: async () => [],
      marketBySymbol: async () => null,
      marketById: async () => null,
      markets: async () => [],
      userBalances: async () => [],
      listPositions: async () => [],
      listClosedPositions: async () => [],
      getPosition: unused as PrivateRestDeps['getPosition'],
      openPosition: unused as PrivateRestDeps['openPosition'],
      closePosition: unused as PrivateRestDeps['closePosition'],
      setLeverage: unused as PrivateRestDeps['setLeverage'],
      addIsolatedMargin: unused as PrivateRestDeps['addIsolatedMargin'],
      reduceIsolatedMargin: unused as PrivateRestDeps['reduceIsolatedMargin'],
      getOpenMarginCall: async () => null,
      getAdlDisclosure: unused as PrivateRestDeps['getAdlDisclosure'],
      ackAdlDisclosure: unused as PrivateRestDeps['ackAdlDisclosure'],
      listAdlDisclosureEvents: async () => [],
      listLiquidations: (p) => listCallerLiquidations(sql, p.userId),
    } as PrivateRestDeps);
    return a;
  }

  it('each rung shows the decision it stored: fee_unset, ledger_job_pending with planned fee, or not recorded', async () => {
    const id = await position(ALICE);
    await rung(id, 'applied', '2026-10-03T00:00:00.000Z', true, { feeState: 'fee_unset' });
    await rung(id, 'applied', '2026-10-03T01:00:00.000Z', true, { feeState: 'ledger_job_pending', plannedFee: parseAmount('2.5') });
    await rung(id, 'applied', '2026-10-03T02:00:00.000Z', true);
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/api/v1/futures/liquidations', headers: signed(ALICE) });
    expect(res.statusCode).toBe(200);
    const rungs = res.json().events[0].rungs as Array<Record<string, unknown>>;
    expect(rungs.map((r) => r.feeReason)).toEqual(['fee_unset', 'ledger_job_pending', 'liquidation_fee_not_recorded']);
    expect(rungs.map((r) => r.fee)).toEqual([null, null, null]);
    expect(rungs[1]!.plannedFee).toBe('2.5');
    expect(typeof rungs[0]!.feeExplanation).toBe('string');
    expect(rungs[2]).not.toHaveProperty('feeExplanation');
    await a.close();
  });
});
