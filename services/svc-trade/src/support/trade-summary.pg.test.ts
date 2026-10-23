/**
 * Support trade summary (D-ops-06), through the tRPC door against Postgres.
 *
 * Promise: svc-support, and only svc-support, reads one customer's positions, liquidation rungs and orders; the read is
 * audited with the agent and case ids before it is returned; and it is whole or refused.
 * Break: a caller that is not svc-support reads it; an omitted limit becomes a default; a cut list reads as the whole
 * history; a read goes out unaudited; a failed section shows as an empty list; another customer's rows ride along.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  createEdgeContext,
  retainRawBody,
  serviceAuthHeadersForBody,
  supportTradeSummarySchema,
  SUPPORT_TRADE_SUMMARY_PROCEDURE,
} from '@intafaced/contracts';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';
import { SupportTradeSummaryReader, supportTradeSummaryAuditId } from './trade-summary.js';

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

const EDGE_SECRET = 'a-support-trade-summary-edge-secret-32x';
const INTERNAL = 'a-support-trade-summary-internal-secret-32';
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, internalSecret: INTERNAL, serviceName: 'svc-trade', bodyBindMode: 'require' });

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const CASE = '44444444-4444-4444-8444-444444444444';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SPOT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = new Date('2026-10-20T12:00:00.000Z');

describe('support.tradeSummary', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.operator_audit, trade.liquidation_rungs, trade.order_stop_trigger, trade.orders,
      trade.positions, trade.markets RESTART IDENTITY CASCADE`;
    await db.sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES
        (${MARKET}, 'BTC/USDT-PERP', 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now()),
        (${SPOT}, 'BTC/USDT', 'BTC', 'USDT', 'spot', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC spot', now())`;
  });

  async function position(
    userId: string,
    input: {
      status?: string;
      size?: string;
      entry?: string;
      liq?: string | null;
      openedAt: string;
      closedAt?: string | null;
      leverage?: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    await db.sql`
      INSERT INTO trade.positions (id, user_id, market_id, side, status, size, entry_price, leverage, margin_initial, margin_current,
        margin_asset, liq_price, opened_at, closed_at, accepted_mark)
      VALUES (${id}, ${userId}, ${MARKET}, 'long', ${input.status ?? 'open'}, ${input.size ?? '1'}, ${input.entry ?? '50000'},
        ${input.leverage ?? '5'}, '10000', '9500', 'USDT', ${input.liq ?? null}, ${input.openedAt}, ${input.closedAt ?? null}, '51000')`;
    return id;
  }

  async function rung(positionId: string, state: string, createdAt: string): Promise<string> {
    const id = randomUUID();
    await db.sql`
      INSERT INTO trade.liquidation_rungs (rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state, created_at, updated_at)
      VALUES (${id}, ${positionId}, ${`liq:${id}`}, 'closing', '1', '5000', ${db.sql.json({ fromInsurance: '7770.5' } as never)}, ${state},
        ${createdAt}, ${createdAt})`;
    return id;
  }

  async function order(
    userId: string,
    input: {
      market?: string;
      status: string;
      qty?: string;
      filled?: string;
      price?: string | null;
      reject?: string | null;
      recovery?: boolean;
      at: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    await db.sql`
      INSERT INTO trade.orders (id, user_id, market_id, client_order_id, side, type, price, qty, filled_qty, status, tif, hold_asset,
        hold_amount, created_at, reject_code, recovery_reason, reconciliation_key)
      VALUES (${id}, ${userId}, ${input.market ?? MARKET}, ${`c-${id}`}, 'buy', ${input.price === null ? 'market' : 'limit'},
        ${input.price === undefined ? '49000' : input.price}, ${input.qty ?? '2'}, ${input.filled ?? '0'}, ${input.status}, 'GTC', 'USDT',
        98000, ${input.at}, ${input.reject ?? null}, ${input.recovery ? 'SUBMIT_UNKNOWN' : null}, ${input.recovery ? `recon:${id}` : null})`;
    return id;
  }

  /** Alice: two positions (one open, one liquidated), a rung on the liquidated one, three orders (one a stop-limit). */
  async function seedAlice() {
    const open = await position(ALICE, { liq: '45000', openedAt: '2026-10-02T00:00:00Z' });
    const liquidated = await position(ALICE, {
      status: 'liquidated',
      size: '0.5',
      entry: '60000',
      openedAt: '2026-10-01T00:00:00Z',
      closedAt: '2026-10-03T00:00:00Z',
    });
    const liqRung = await rung(liquidated, 'applied', '2026-10-03T00:00:00Z');
    const limit = await order(ALICE, { status: 'open', at: '2026-10-04T00:00:00Z' });
    const rejected = await order(ALICE, { status: 'rejected', price: null, reject: 'trade.price_band', at: '2026-10-05T00:00:00Z' });
    const stop = await order(ALICE, { status: 'open', market: SPOT, at: '2026-10-06T00:00:00Z' });
    await db.sql`INSERT INTO trade.order_stop_trigger (order_id, user_id, stop_price) VALUES (${stop}, ${ALICE}, '48000')`;
    return { open, liquidated, liqRung, limit, rejected, stop };
  }

  /** Bob's rows, which must never appear in Alice's summary. */
  async function seedBob() {
    const p = await position(BOB, { liq: '1', openedAt: '2026-10-02T12:00:00Z' });
    const r = await rung(p, 'posted', '2026-10-03T12:00:00Z');
    const o = await order(BOB, { status: 'open', at: '2026-10-04T12:00:00Z' });
    return { p, r, o };
  }

  function app(reader: SupportTradeSummaryReader | undefined) {
    const router = createTradeRouter({} as unknown as TradeService, undefined, undefined, undefined, undefined, undefined, reader);
    return (async () => {
      const server = Fastify({ logger: false });
      // As svc-trade boots: the raw bytes are kept, so a service call binds its (empty) body.
      retainRawBody(server);
      await server.register(fastifyTRPCPlugin, {
        prefix: '/trpc',
        trpcOptions: { router, createContext: ({ req }) => edgeContext(req) } satisfies FastifyTRPCPluginOptions<
          typeof router
        >['trpcOptions'],
      });
      await server.ready();
      return server;
    })();
  }

  async function call(
    reader: SupportTradeSummaryReader | undefined,
    caller: string | null,
    input: Record<string, unknown>,
  ): Promise<{ status: number; body: any; text: string }> {
    const server = await app(reader);
    try {
      const res = await server.inject({
        method: 'GET',
        url: `/trpc/${SUPPORT_TRADE_SUMMARY_PROCEDURE}?input=${encodeURIComponent(JSON.stringify(input))}`,
        headers: caller ? serviceAuthHeadersForBody(caller, INTERNAL, '') : {},
      });
      return { status: res.statusCode, body: JSON.parse(res.body), text: res.body };
    } finally {
      await server.close();
    }
  }

  const reader = () => new SupportTradeSummaryReader({ sql: db.sql, now: () => NOW });
  const ask = (extra: Record<string, unknown> = { limit: 10 }) => ({ userId: ALICE, caseId: CASE, agentId: AGENT, ...extra });
  const auditCount = async () => Number((await db.sql`SELECT count(*)::int AS n FROM trade.operator_audit`)[0]!.n);

  it('refuses a caller that is not svc-support, and an unauthenticated one, before anything is read or audited', async () => {
    await seedAlice();
    for (const caller of ['svc-bank', 'svc-edge', 'svc-ops', 'svc-trade']) {
      const res = await call(reader(), caller, ask());
      expect(res.status, caller).toBe(403);
      expect(res.text).not.toContain('positions');
    }
    expect((await call(reader(), null, ask())).status).toBe(401);
    expect(await auditCount()).toBe(0);
  });

  it('refuses an omitted limit with the named code and reads and audits nothing', async () => {
    await seedAlice();
    const res = await call(reader(), 'svc-support', ask({}));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('trade.support_summary_limit_unset');
    expect(res.text).not.toContain('"items"');
    expect(await auditCount()).toBe(0);
  });

  it('returns exactly the contract shape for a customer with two positions, a rung and orders', async () => {
    const ids = await seedAlice();
    await seedBob();
    const res = await call(reader(), 'svc-support', ask());
    expect(res.status).toBe(200);
    const summary = supportTradeSummarySchema.parse(res.body.result.data);

    expect(summary).toMatchObject({ userId: ALICE, caseId: CASE, agentId: AGENT, limit: 10, readAt: NOW.toISOString() });
    expect(summary.positions.truncated).toBe(false);
    expect(summary.positions.items.map((p) => p.positionId)).toEqual([ids.open, ids.liquidated]);
    expect(summary.positions.items[0]).toEqual({
      positionId: ids.open,
      symbol: 'BTC/USDT-PERP',
      side: 'long',
      status: 'open',
      closingReason: null,
      contracts: '1',
      entryPrice: '50000',
      liquidationPrice: '45000',
      marginMode: 'isolated',
      marginAsset: 'USDT',
      collateral: '9500',
      initialMargin: '10000',
      maintenanceMargin: null,
      leverage: '5',
      openedAt: '2026-10-02T00:00:00.000Z',
      closedAt: null,
      fieldReasons: { maintenanceMargin: 'mark_not_read' },
    });
    expect(summary.positions.items[1]).toMatchObject({
      status: 'liquidated',
      contracts: '0.5',
      closedAt: '2026-10-03T00:00:00.000Z',
      liquidationPrice: null,
      fieldReasons: { maintenanceMargin: 'position_closed', liquidationPrice: 'liquidation_price_not_recorded' },
    });

    expect(summary.liquidations).toEqual({
      items: [
        {
          rungId: ids.liqRung,
          positionId: ids.liquidated,
          kind: 'closing',
          state: 'applied',
          startedAt: '2026-10-03T00:00:00.000Z',
          updatedAt: '2026-10-03T00:00:00.000Z',
        },
      ],
      truncated: false,
    });
    // No amount from the rung's plan (the insurance figure) is on the wire.
    expect(res.text).not.toContain('7770.5');
    expect(res.text).not.toContain('fromInsurance');

    expect(summary.orders.items).toEqual([
      {
        orderId: ids.stop,
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'stop_limit',
        status: 'open',
        qty: '2',
        filledQty: '0',
        limitPrice: '49000',
        rejectCode: null,
        recoveryRequired: false,
        createdAt: '2026-10-06T00:00:00.000Z',
      },
      {
        orderId: ids.rejected,
        symbol: 'BTC/USDT-PERP',
        side: 'buy',
        type: 'market',
        status: 'rejected',
        qty: '2',
        filledQty: '0',
        limitPrice: null,
        rejectCode: 'trade.price_band',
        recoveryRequired: false,
        createdAt: '2026-10-05T00:00:00.000Z',
      },
      expect.objectContaining({ orderId: ids.limit, type: 'limit', status: 'open' }),
    ]);
  });

  it('shows an order whose outcome is unknown as recoveryRequired, not as plain open', async () => {
    const id = await order(ALICE, { status: 'recovery_required', recovery: true, at: '2026-10-04T00:00:00Z' });
    const res = await call(reader(), 'svc-support', ask());
    const summary = supportTradeSummarySchema.parse(res.body.result.data);
    expect(summary.orders.items).toEqual([expect.objectContaining({ orderId: id, status: 'open', recoveryRequired: true })]);
  });

  it('cuts every list to limit and sets truncated only when more rows exist', async () => {
    const ids = await seedAlice();
    const second = await rung(ids.open, 'planned', '2026-10-07T00:00:00Z');

    const cutAtOne = supportTradeSummarySchema.parse((await call(reader(), 'svc-support', ask({ limit: 1 }))).body.result.data);
    expect(cutAtOne.limit).toBe(1);
    expect(cutAtOne.positions).toMatchObject({ truncated: true });
    expect(cutAtOne.positions.items.map((p) => p.positionId)).toEqual([ids.open]);
    expect(cutAtOne.liquidations.truncated).toBe(true);
    expect(cutAtOne.liquidations.items.map((r) => r.rungId)).toEqual([second]);
    expect(cutAtOne.orders.truncated).toBe(true);
    expect(cutAtOne.orders.items).toHaveLength(1);

    // Exactly at the limit is not truncated: positions 2 of 2, rungs 2 of 2, orders 3 of 3.
    const exact = supportTradeSummarySchema.parse((await call(reader(), 'svc-support', ask({ limit: 2 }))).body.result.data);
    expect(exact.positions).toMatchObject({ truncated: false });
    expect(exact.positions.items).toHaveLength(2);
    expect(exact.liquidations).toMatchObject({ truncated: false });
    expect(exact.liquidations.items).toHaveLength(2);
    expect(exact.orders.truncated).toBe(true);
    expect(exact.orders.items).toHaveLength(2);

    const all = supportTradeSummarySchema.parse((await call(reader(), 'svc-support', ask({ limit: 3 }))).body.result.data);
    expect(all.orders).toMatchObject({ truncated: false });
    expect(all.orders.items).toHaveLength(3);
  });

  it('writes the audit row with the agent id, case id and customer id, and returns its id and time', async () => {
    await seedAlice();
    const res = await call(reader(), 'svc-support', ask());
    const summary = supportTradeSummarySchema.parse(res.body.result.data);
    const rows = await db.sql`SELECT id, kind, operator_id, account_id, object_id, occurred_at, detail FROM trade.operator_audit`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: summary.auditId,
      kind: 'support.trade_summary.read',
      operator_id: AGENT,
      account_id: ALICE,
      object_id: CASE,
    });
    expect((rows[0]!.occurred_at as Date).toISOString()).toBe(summary.readAt);
    expect(rows[0]!.detail).toMatchObject({
      caseId: CASE,
      agentId: AGENT,
      userId: ALICE,
      limit: 10,
      positions: { count: 2, truncated: false },
      liquidations: { count: 1, truncated: false },
      orders: { count: 3, truncated: false },
    });
  });

  it('derives auditId from the read, never at random: the same read is one row, a later read is its own row', async () => {
    await seedAlice();
    const first = await reader().read(ask() as never);
    const again = await reader().read(ask() as never);
    expect(again.auditId).toBe(first.auditId);
    expect(await auditCount()).toBe(1);
    expect(first.auditId).toBe(
      supportTradeSummaryAuditId({ caseId: CASE, agentId: AGENT, userId: ALICE, limit: 10, readAt: NOW.toISOString() }),
    );

    const later = await new SupportTradeSummaryReader({ sql: db.sql, now: () => new Date(NOW.getTime() + 1) }).read(ask() as never);
    expect(later.auditId).not.toBe(first.auditId);
    expect(await auditCount()).toBe(2);
    // Different case or agent, same instant: a different record.
    const other = await reader().read({ ...ask(), caseId: randomUUID() } as never);
    expect(other.auditId).not.toBe(first.auditId);
  });

  it('refuses and returns nothing when the audit row cannot be written', async () => {
    await seedAlice();
    await db.sql`ALTER TABLE trade.operator_audit RENAME TO operator_audit_gone`;
    try {
      const res = await call(reader(), 'svc-support', ask());
      expect(res.status).toBe(503);
      expect(res.body.error.message).toContain('trade.support_summary_audit_unavailable');
      expect(res.body.result).toBeUndefined();
      expect(res.text).not.toContain('"items"');
    } finally {
      await db.sql`ALTER TABLE trade.operator_audit_gone RENAME TO operator_audit`;
    }
    expect(await auditCount()).toBe(0);
  });

  it.each([
    ['positions', 'trade.positions'],
    ['liquidation rungs', 'trade.liquidation_rungs'],
    ['orders', 'trade.orders'],
  ])('refuses the whole summary when the %s section cannot be read, never an empty list, and writes no audit row', async (_name, table) => {
    await seedAlice();
    const bare = table.replace('trade.', '');
    await db.sql.unsafe(`ALTER TABLE ${table} RENAME TO ${bare}_gone`);
    try {
      const res = await call(reader(), 'svc-support', ask());
      expect(res.status).toBe(503);
      expect(res.body.error.message).toContain('trade.support_summary_unavailable');
      expect(res.body.result).toBeUndefined();
      expect(res.text).not.toContain('"items"');
    } finally {
      await db.sql.unsafe(`ALTER TABLE trade.${bare}_gone RENAME TO ${bare}`);
    }
    expect(await auditCount()).toBe(0);
  });

  it('refuses closed when the door is mounted without a reader', async () => {
    const res = await call(undefined, 'svc-support', ask());
    expect(res.status).toBe(503);
    expect(res.body.error.message).toContain('trade.support_summary_unavailable');
  });

  it("never shows another customer's data, and a customer with nothing gets honest empty lists", async () => {
    const ids = await seedAlice();
    const bob = await seedBob();
    const res = await call(reader(), 'svc-support', ask({ limit: 500 }));
    for (const foreign of [bob.p, bob.r, bob.o, BOB]) expect(res.text).not.toContain(foreign);
    const summary = supportTradeSummarySchema.parse(res.body.result.data);
    expect(summary.positions.items.map((p) => p.positionId).sort()).toEqual([ids.open, ids.liquidated].sort());

    const bobs = supportTradeSummarySchema.parse(
      (await call(reader(), 'svc-support', { userId: BOB, caseId: CASE, agentId: AGENT, limit: 500 })).body.result.data,
    );
    expect(bobs.positions.items.map((p) => p.positionId)).toEqual([bob.p]);
    expect(bobs.liquidations.items.map((r) => r.rungId)).toEqual([bob.r]);
    expect(bobs.orders.items.map((o) => o.orderId)).toEqual([bob.o]);

    const nobody = supportTradeSummarySchema.parse(
      (await call(reader(), 'svc-support', { userId: randomUUID(), caseId: CASE, agentId: AGENT, limit: 5 })).body.result.data,
    );
    expect(nobody.positions).toEqual({ items: [], truncated: false });
    expect(nobody.liquidations).toEqual({ items: [], truncated: false });
    expect(nobody.orders).toEqual({ items: [], truncated: false });
  });
});
