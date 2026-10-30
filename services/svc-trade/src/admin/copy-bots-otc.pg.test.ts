/**
 * Copy, bots and OTC operator reads on Postgres (CB-ops-05, CB-ops-04; J-copy-bots-otc-13): counts come from the rows,
 * a count that fails to read is null with its code and never 0, a blank metrics window refuses, a lookup needs the
 * lookup scope and writes one audit row, and a quote accepted but not settled by its deadline is a settlement exception
 * carrying its saga key. TEST people and TEST quotes only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthError, type Principal } from '@intafaced/auth';
import { MemoryLedger } from '@intafaced/ledger-client';
import type { TestDatabase } from '@intafaced/db';
import { StubMatching } from '../spot/testing.js';
import { ALICE, BOB, MARKET_ID, openTradeDatabase, resetAndListMarket } from '../spot/__tests__/saga-trade-fixture.js';
import { parseOtcDeskLawJson, type OtcDeskLaw } from '../otc/desk-law.js';
import { TradeOpsError } from './common.js';
import {
  COPY_LOOKUP_AUDIT_KIND,
  COPY_LOOKUP_SCOPE,
  CopyBotsOtcAdmin,
  copyLookupAuditId,
  parseMetricsWindowSeconds,
} from './copy-bots-otc.js';

const OP = '33333333-3333-4333-8333-333333333333';
const LEADER = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-29T12:00:00.000Z');
const LAW = parseOtcDeskLawJson(
  JSON.stringify({
    published: true,
    spreadBps: 20,
    minStake: '100',
    counterparty: 'platform',
    quoteTtlMs: 60_000,
    maxMidAgeSeconds: 86_400,
    settleWindowMs: 60_000,
    minNotional: { USDT: '1000' },
  }),
);

const principal = (scopes: readonly string[]): Principal => ({
  sub: OP,
  userId: OP,
  scopes: [...scopes],
  tier: 'basic',
  mfa: true,
  sid: '99999999-9999-4999-8999-999999999999',
  expiresAt: new Date(NOW.getTime() + 3_600_000),
});
const reader = () => principal(['admin:read']);
const looker = () => principal(['admin:read', COPY_LOOKUP_SCOPE]);

let db: TestDatabase | undefined;
let stop: () => Promise<void> = async () => undefined;
const sql = () => {
  if (!db) throw new Error('database not ready');
  return db.sql;
};

beforeAll(async () => {
  const opened = await openTradeDatabase();
  db = opened.db;
  stop = opened.stop;
}, 120_000);
afterAll(async () => {
  await db?.drop();
  await stop();
}, 30_000);
beforeEach(async () => {
  await resetAndListMarket(db!, new MemoryLedger(), new StubMatching());
  await sql()`TRUNCATE trade.copy_follows, trade.copy_leader_listings, trade.algo_parents, trade.otc_desk_quotes, trade.operator_audit CASCADE`;
});

const desk = (opts: { window?: number | null; law?: OtcDeskLaw; sqlOverride?: unknown } = {}) =>
  new CopyBotsOtcAdmin({
    sql: (opts.sqlOverride ?? sql()) as never,
    otcLaw: opts.law ?? LAW,
    metricsWindowSeconds: opts.window === undefined ? 86_400 : opts.window,
    now: () => NOW,
  });

async function follow(
  followerId: string,
  state = 'ACTIVE',
  leaderId = LEADER,
  expiresAt = new Date(NOW.getTime() + 86_400_000),
): Promise<void> {
  await sql()`INSERT INTO trade.copy_follows (
    follow_id, follower_id, leader_id, region, permitted_markets, max_notional_per_order, max_aggregate_exposure,
    expires_at, relationship_state
  ) VALUES (
    ${`follow-${followerId}-${leaderId}`}, ${followerId}, ${leaderId}, 'DE', ${sql().json(['BTC/USDT'])}, '100', '1000',
    ${expiresAt.toISOString()}, ${state}
  )`;
}

async function bot(id: string, userId: string, status = 'active'): Promise<void> {
  await sql()`INSERT INTO trade.algo_parents (
    id, user_id, market_id, symbol, side, kind, total_qty, duration_ms, slice_interval_ms, status, started_at,
    slices_planned, plan_slices, next_due_at, projected_ends_at
  ) VALUES (
    ${id}, ${userId}, ${MARKET_ID}, 'BTC/USDT', 'buy', 'twap', '1', 60000, 10000, ${status}, ${NOW.toISOString()},
    6, ${sql().json(['0.2', '0.2', '0.2', '0.2', '0.1', '0.1'])}, ${NOW.toISOString()},
    ${new Date(NOW.getTime() + 60_000).toISOString()}
  )`;
}

/** A TEST quote row in the given lifecycle; accepted and settled times follow the lifecycle's constraint. */
async function quote(
  quoteId: string,
  userId: string,
  lifecycle: 'open' | 'bound' | 'settled' | 'expired',
  at: { createdAt: Date; acceptedAt?: Date; settledAt?: Date },
): Promise<void> {
  const accepted = lifecycle === 'bound' || lifecycle === 'settled';
  await sql()`INSERT INTO trade.otc_desk_quotes (
    quote_id, user_id, lifecycle, side, base_asset, quote_asset, qty, mid_price, quoted_price, mid_notional,
    user_notional, spread_bps, spread_notional, counterparty, counterparty_id, created_at, expires_at, accepted_at,
    fill_price, fill_notional, settled_at
  ) VALUES (
    ${quoteId}, ${userId}, ${lifecycle}, 'buy', 'BTC', 'USDT', '0.02', '65000', '65130', '1300', '1302.6', 20, '2.6',
    'platform', 'house', ${at.createdAt.toISOString()}, ${new Date(at.createdAt.getTime() + 60_000).toISOString()},
    ${accepted ? (at.acceptedAt ?? at.createdAt).toISOString() : null}, ${accepted ? '65130' : null},
    ${accepted ? '1302.6' : null}, ${lifecycle === 'settled' ? (at.settledAt ?? at.createdAt).toISOString() : null}
  )`;
}

const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('copy, bots and OTC counts (CB-ops-05)', () => {
  it('counts 4 active copiers as 4, from the rows, with the window and as-of time', async () => {
    for (const follower of [ALICE, BOB, OP, '66666666-6666-4666-8666-666666666666']) await follow(follower);
    await follow('77777777-0000-4777-8777-777777777777', 'PAUSED');
    await bot('bot-1', ALICE);
    await bot('bot-2', BOB, 'cancelled');
    await quote('q-in', ALICE, 'settled', { createdAt: ago(3_600_000), settledAt: ago(3_500_000) });
    await quote('q-out', ALICE, 'open', { createdAt: ago(2 * 86_400_000) });

    const metrics = await desk().metrics(reader());

    expect(metrics.activeCopiers).toEqual({ value: 4, unavailable: null });
    expect(metrics.activeBots).toEqual({ value: 1, unavailable: null });
    expect(metrics.rfqsRequested).toEqual({ value: 1, unavailable: null });
    expect(metrics.rfqsSettled).toEqual({ value: 1, unavailable: null });
    expect(metrics.asOf).toBe(NOW.toISOString());
    expect(metrics.window).toEqual({ seconds: 86_400, from: ago(86_400_000).toISOString(), to: NOW.toISOString() });
  });

  it('does not count a follow past its expiry as an active copier, and the lookup shows it expired', async () => {
    await follow(ALICE);
    await follow(BOB, 'ACTIVE', LEADER, ago(1_000));

    expect((await desk().metrics(reader())).activeCopiers).toEqual({ value: 1, unavailable: null });
    expect((await desk().lookup(looker(), { userId: BOB })).follows.map((f) => f.state)).toEqual(['Expired']);
  });

  it('shows a count whose source fails as null with its code, never 0, and keeps the others', async () => {
    await follow(ALICE);
    const real = sql();
    // A database handle whose bot table read fails; every other read goes through.
    const failing = new Proxy(real, {
      apply(target, self, args: [TemplateStringsArray, ...unknown[]]) {
        if (Array.isArray(args[0]) && args[0].join('').includes('trade.algo_parents')) {
          return Promise.reject(new Error('TEST read failure'));
        }
        return Reflect.apply(target as never, self, args);
      },
    });

    const metrics = await desk({ sqlOverride: failing }).metrics(reader());

    expect(metrics.activeBots).toEqual({ value: null, unavailable: 'trade.ops_metric_unavailable' });
    expect(metrics.activeCopiers).toEqual({ value: 1, unavailable: null });
  });

  it('refuses with a blank window by its typed code', async () => {
    await expect(desk({ window: null }).metrics(reader())).rejects.toMatchObject({ code: 'trade.ops_metrics_window_not_set' });
    await expect(desk({ window: null }).metrics(reader())).rejects.toBeInstanceOf(TradeOpsError);
  });

  it('reads the owner window as whole seconds and leaves anything else unset', () => {
    expect(parseMetricsWindowSeconds('86400')).toBe(86_400);
    for (const raw of [undefined, '', ' ', '0', '-1', '1.5', '24h', '99999999']) expect(parseMetricsWindowSeconds(raw)).toBeNull();
  });

  it('refuses a caller without the desk read scope', async () => {
    await expect(desk().metrics(principal(['trade:read']))).rejects.toBeInstanceOf(AuthError);
  });
});

describe('customer lookup (J-copy-bots-otc-13 #2, #3)', () => {
  it('returns the follows, bots and quotes of one customer and writes one audit row', async () => {
    await sql()`INSERT INTO trade.copy_leader_listings (
      leader_ref, leader_user_id, state, display_name, record_kind, assets, state_changed_at, created_at, updated_at
    ) VALUES ('lead-test', ${LEADER}, 'listed', 'TEST leader', 'paper', ${sql().json(['BTC'])}, now(), now(), now())`;
    await follow(ALICE);
    await follow(BOB);
    await bot('bot-a1', ALICE);
    await bot('bot-a2', ALICE, 'paused');
    await bot('bot-b1', BOB);
    await quote('q-a', ALICE, 'open', { createdAt: ago(1_000) });

    const read = await desk().lookup(looker(), { userId: ALICE });

    expect(read.follows).toEqual([
      { followId: `follow-${ALICE}-${LEADER}`, leader: 'TEST leader', state: 'Active', startedAt: expect.any(String) },
    ]);
    expect(read.bots.map((b) => [b.botId, b.status]).sort()).toEqual([
      ['bot-a1', 'active'],
      ['bot-a2', 'paused'],
    ]);
    expect(read.quotes.map((q) => [q.quoteId, q.lifecycle, q.pair, q.qty])).toEqual([['q-a', 'open', 'BTC/USDT', '0.02']]);
    const audit = await sql()<Array<{ id: string; kind: string; operator_id: string; account_id: string }>>`
      SELECT id, kind, operator_id, account_id FROM trade.operator_audit`;
    expect(audit).toEqual([
      {
        id: copyLookupAuditId({ operatorId: OP, userId: ALICE, readAt: NOW.toISOString() }),
        kind: COPY_LOOKUP_AUDIT_KIND,
        operator_id: OP,
        account_id: ALICE,
      },
    ]);
  });

  it('refuses a caller without the lookup scope by its typed code and writes nothing', async () => {
    await follow(ALICE);
    await expect(desk().lookup(reader(), { userId: ALICE })).rejects.toMatchObject({ code: 'scope.denied' });
    const [audit] = await sql()<Array<{ n: string }>>`SELECT count(*) AS n FROM trade.operator_audit`;
    expect(Number(audit!.n)).toBe(0);
  });
});

describe('quote desk (CB-ops-04, J-copy-bots-otc-13 #4)', () => {
  it('lists quotes and a quote accepted but not settled by its deadline as an exception with its saga key', async () => {
    await quote('q-open', ALICE, 'open', { createdAt: ago(10_000) });
    await quote('q-settled', ALICE, 'settled', { createdAt: ago(200_000), settledAt: ago(190_000) });
    await quote('q-late', BOB, 'bound', { createdAt: ago(130_000), acceptedAt: ago(120_000) });
    await quote('q-in-window', BOB, 'bound', { createdAt: ago(40_000), acceptedAt: ago(30_000) });
    await quote('q-expired', BOB, 'expired', { createdAt: ago(300_000) });

    const read = await desk().quoteDesk(reader());

    expect(read.quotes.map((q) => q.quoteId).sort()).toEqual(['q-in-window', 'q-late', 'q-open', 'q-settled']);
    expect(read.exceptions).toEqual([
      {
        quoteId: 'q-late',
        userId: BOB,
        sagaKey: 'otc.settle:q-late',
        reason: 'not_settled_by_deadline',
        acceptedAt: ago(120_000).toISOString(),
        deadline: ago(60_000).toISOString(),
      },
    ]);
    // Listing it moved nothing: the quote is still accepted and unsettled.
    const [row] = await sql()<Array<{ lifecycle: string; settled_at: Date | null }>>`
      SELECT lifecycle::text AS lifecycle, settled_at FROM trade.otc_desk_quotes WHERE quote_id = 'q-late'`;
    expect(row).toEqual({ lifecycle: 'bound', settled_at: null });
  });

  it('reads an open quote past its expiry as expired, as the customer read does, and changes nothing', async () => {
    await quote('q-lapsed', ALICE, 'open', { createdAt: ago(120_000) });

    expect((await desk().quoteDesk(reader())).quotes.map((q) => [q.quoteId, q.lifecycle])).toEqual([['q-lapsed', 'expired']]);
    expect((await desk().lookup(looker(), { userId: ALICE })).quotes.map((q) => q.lifecycle)).toEqual(['expired']);
    const [row] = await sql()<Array<{ lifecycle: string }>>`
      SELECT lifecycle::text AS lifecycle FROM trade.otc_desk_quotes WHERE quote_id = 'q-lapsed'`;
    expect(row).toEqual({ lifecycle: 'open' });
  });

  it('lists the longest-stranded exception first', async () => {
    await quote('q-later', BOB, 'bound', { createdAt: ago(130_000), acceptedAt: ago(120_000) });
    await quote('q-oldest', BOB, 'bound', { createdAt: ago(600_000), acceptedAt: ago(590_000) });

    expect((await desk().quoteDesk(reader())).exceptions.map((e) => e.quoteId)).toEqual(['q-oldest', 'q-later']);
  });

  it('with the settle window blank, the deadline is the quote expiry', async () => {
    const blankWindow = parseOtcDeskLawJson(
      JSON.stringify({
        published: true,
        spreadBps: 20,
        minStake: '100',
        counterparty: 'platform',
        quoteTtlMs: 60_000,
        maxMidAgeSeconds: 86_400,
        settleWindowMs: null,
        minNotional: { USDT: '1000' },
      }),
    );
    await quote('q-past-expiry', BOB, 'bound', { createdAt: ago(70_000), acceptedAt: ago(65_000) });
    await quote('q-before-expiry', BOB, 'bound', { createdAt: ago(30_000), acceptedAt: ago(20_000) });

    const read = await desk({ law: blankWindow }).quoteDesk(reader());

    expect(read.exceptions.map((e) => [e.quoteId, e.deadline])).toEqual([['q-past-expiry', ago(10_000).toISOString()]]);
  });

  it('shows no exception when every accepted quote is still in its window', async () => {
    await quote('q-in-window', BOB, 'bound', { createdAt: ago(40_000), acceptedAt: ago(30_000) });
    expect((await desk().quoteDesk(reader())).exceptions).toEqual([]);
  });

  it('refuses with the desk law unpublished by its typed code', async () => {
    await expect(desk({ law: { published: false } }).quoteDesk(reader())).rejects.toMatchObject({ code: 'trade.otc_desk_law_unset' });
  });
});
