/** D-margin-06: GET /api/v1/positions/:id/liquidation against Postgres. TEST figures only. */
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
import { loadPositionLiquidation, presentPositionLiquidation } from './futures-reads.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-cccccccccccc';
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

describe('position liquidation timeline (D-margin-06)', () => {
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
  function planJson(withMark: boolean) {
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
          }),
        ),
      ),
    );
  }

  async function rung(positionId: string, state: string, at: string, withMark = true) {
    await sql`
      INSERT INTO trade.liquidation_rungs (
        rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state, created_at
      ) VALUES (
        ${randomUUID()}, ${positionId}, ${`liq-${positionId}`}, 'partial', '1', '100', ${planJson(withMark)}, ${state}, ${new Date(at)}
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
      positionLiquidation: (p, id) => loadPositionLiquidation(sql, p.userId, id),
    } as PrivateRestDeps);
    return a;
  }

  it('a live (posted) rung: timeline shows posted, edits refused code named, figures from the plan', async () => {
    const id = await position(ALICE);
    await rung(id, 'applied', '2026-10-03T00:00:00.000Z');
    await rung(id, 'posted', '2026-10-03T01:00:00.000Z');
    const a = app();
    const res = await a.inject({ method: 'GET', url: `/api/v1/positions/${id}/liquidation`, headers: signed(ALICE) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ positionId: id, live: true, parked: false, editsRefusedCode: 'trade.liquidation_in_progress' });
    expect(body.rungs.map((r: { state: string }) => r.state)).toEqual(['applied', 'posted']);
    expect(body.rungs[0]).toMatchObject({ size: '0.2', mark: '49000', marginTaken: '20', fromInsurance: '1.5', releaseShort: '0' });
    expect(body.rungs[0].fee).toBeNull();
    expect(body.rungs[0].feeReason).toBe('liquidation_fee_not_recorded');
    await a.close();
  });

  it('an abandoned last rung: parked, not live, no edits code', async () => {
    const id = await position(ALICE);
    await rung(id, 'abandoned', '2026-10-03T00:00:00.000Z');
    const wire = await loadPositionLiquidation(sql, ALICE, id);
    expect(wire).toMatchObject({ live: false, parked: true, editsRefusedCode: null });
  });

  it('resolved after abandoned: neither parked nor live', async () => {
    const id = await position(ALICE);
    await rung(id, 'abandoned', '2026-10-03T00:00:00.000Z');
    await rung(id, 'resolved', '2026-10-03T01:00:00.000Z');
    expect(await loadPositionLiquidation(sql, ALICE, id)).toMatchObject({ live: false, parked: false });
  });

  it('no rungs: empty timeline', async () => {
    const id = await position(ALICE);
    expect(await loadPositionLiquidation(sql, ALICE, id)).toEqual({
      positionId: id,
      live: false,
      parked: false,
      editsRefusedCode: null,
      rungs: [],
    });
  });

  it('a mark the rung did not record stays null', async () => {
    const id = await position(ALICE);
    await rung(id, 'applied', '2026-10-03T00:00:00.000Z', false);
    const wire = await loadPositionLiquidation(sql, ALICE, id);
    expect(wire.rungs[0]!.mark).toBeNull();
  });

  it("another account's position answers 404 position_not_found, same as a missing one; no foreign rung leaks", async () => {
    const bobs = await position(BOB);
    await rung(bobs, 'posted', '2026-10-03T00:00:00.000Z');
    const a = app();
    for (const url of [`/api/v1/positions/${bobs}/liquidation`, `/api/v1/positions/${randomUUID()}/liquidation`]) {
      const res = await a.inject({ method: 'GET', url, headers: signed(ALICE) });
      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.json())).toContain('trade.position_not_found');
      expect(JSON.stringify(res.json())).not.toContain('liq-');
    }
    await a.close();
  });

  it('a read never writes: rung states unchanged after the read', async () => {
    const id = await position(ALICE);
    await rung(id, 'planned', '2026-10-03T00:00:00.000Z');
    await loadPositionLiquidation(sql, ALICE, id);
    const rows = await sql<Array<{ state: string }>>`SELECT state FROM trade.liquidation_rungs WHERE position_id = ${id}`;
    expect(rows.map((r) => r.state)).toEqual(['planned']);
  });

  it('a principal without trade:read is refused and no rung is read', async () => {
    const id = await position(ALICE);
    await rung(id, 'posted', '2026-10-03T00:00:00.000Z');
    const a = app();
    const res = await a.inject({ method: 'GET', url: `/api/v1/positions/${id}/liquidation`, headers: signed(ALICE, ['trade:write']) });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).not.toContain('liq-');
    await a.close();
  });

  it('unwired door answers 503; unsigned answers 401', async () => {
    const a = Fastify();
    registerPrivateRest(a, { edgeSecret: SECRET, serviceName: 'svc-trade' } as PrivateRestDeps);
    const res = await a.inject({ method: 'GET', url: `/api/v1/positions/${randomUUID()}/liquidation`, headers: signed(ALICE) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('trade.liquidations_unwired');
    const unsigned = await a.inject({ method: 'GET', url: `/api/v1/positions/${randomUUID()}/liquidation` });
    expect(unsigned.statusCode).toBe(401);
    await a.close();
  });
});

describe('presentPositionLiquidation', () => {
  it('a non-object plan yields null figures, never zeros', () => {
    const wire = presentPositionLiquidation('p', [
      { rung_id: 'r', position_id: 'p', liquidation_id: 'l', kind: 'partial', state: 'applied', plan: null, created_at: new Date(0) },
    ]);
    expect(wire.rungs[0]).toMatchObject({ size: null, mark: null, marginTaken: null, fromInsurance: null, fee: null });
  });
});
