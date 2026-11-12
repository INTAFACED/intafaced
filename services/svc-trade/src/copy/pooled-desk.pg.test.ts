/**
 * Pooled masters on the founders' desk on Postgres (CB-copy-pro-share-11, -06, -09, -03; J-copy-bots-otc-10 #6 #7):
 * one master application per person under its business key, the same submit answering it, a different one refused
 * with nothing written; the founders read applications oldest first, whitelists with the owner's batch limit (unset
 * when blank), no takeovers while no pool exists, and every lead's level unset with no maximum ratio. TEST people only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestDatabase } from '@intafaced/db';
import { principalFor } from '../spot/testing.js';
import { ALICE, BOB, openTradeDatabase } from '../spot/__tests__/saga-trade-fixture.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';
import { sqlLeaderDirectory } from './leader-directory.js';
import { PooledDesk, parsePoolWhitelistBatchMax, poolApplyKey } from './pooled-desk.js';

const FOUNDER = '33333333-3333-4333-8333-333333333333';
const reader = () => principalFor(FOUNDER, ['admin:read']);
const operator = () => principalFor(FOUNDER, ['admin:read', 'admin:write']);
const customer = (id: string) => principalFor(id, ['trade:read', 'trade:write']);

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
  await truncateTradeExceptOrderEvents(sql());
});

let tick = Date.parse('2026-11-12T00:00:00.000Z');
const now = () => new Date((tick += 1_000));
const count = async () => (await sql()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.copy_pool_master_applications`)[0]!.n;

describe('pooled master applications', () => {
  it('keeps one application per person under its key: the same submit answers it, another refuses and writes nothing', async () => {
    const desk = new PooledDesk({ sql: sql(), now });
    const first = await desk.apply(customer(ALICE), { nickname: '  TEST master   a ', style: 'TEST swing' });
    expect(first).toMatchObject({ key: poolApplyKey(ALICE), state: 'applied', nickname: 'TEST master a', style: 'TEST swing' });
    expect((await desk.apply(customer(ALICE), { nickname: 'TEST master a', style: 'TEST swing' })).applicationId).toBe(first.applicationId);
    await expect(desk.apply(customer(ALICE), { nickname: 'TEST master b', style: 'TEST swing' })).rejects.toMatchObject({
      code: 'trade.pool_master_application_open',
    });
    await expect(desk.apply(customer(BOB), { nickname: ' ', style: 'TEST' })).rejects.toMatchObject({
      code: 'trade.pool_master_name_invalid',
    });
    await expect(desk.apply(customer(BOB), { nickname: 'TEST', style: '' })).rejects.toMatchObject({
      code: 'trade.pool_master_style_invalid',
    });
    expect(await count()).toBe(1);
    expect(await desk.mine(customer(ALICE))).toEqual(first);
    expect(await desk.mine(customer(BOB))).toBeNull();
  });

  it('two submits at once write one row', async () => {
    const desk = new PooledDesk({ sql: sql(), now });
    const input = { nickname: 'TEST master', style: 'TEST' };
    const [a, b] = await Promise.all([desk.apply(customer(ALICE), input), desk.apply(customer(ALICE), input)]);
    expect(a.applicationId).toBe(b.applicationId);
    expect(await count()).toBe(1);
  });

  it('a decided row is never rewritten', async () => {
    const desk = new PooledDesk({ sql: sql(), now });
    const a = await desk.apply(customer(ALICE), { nickname: 'TEST master', style: 'TEST' });
    await expect(sql()`UPDATE trade.copy_pool_master_applications SET nickname = 'x' WHERE id = ${a.applicationId}`).rejects.toThrow();
  });
});

describe('the founders’ pooled desk', () => {
  it('reads applications oldest first, the unset batch limit, no takeovers, and every lead with no level and no maximum ratio', async () => {
    const desk = new PooledDesk({ sql: sql(), now });
    const a = await desk.apply(customer(ALICE), { nickname: 'TEST master a', style: 'TEST' });
    const b = await desk.apply(customer(BOB), { nickname: 'TEST master b', style: 'TEST' });
    const directory = sqlLeaderDirectory(sql(), { now, feeShareLaw: { published: false } });
    const listed = await directory.upsertListing(operator(), {
      clientRequestId: 'TEST-listing-1',
      leaderUserId: ALICE,
      displayName: 'TEST lead a',
      recordKind: 'self_reported',
      state: 'listed',
    });
    const read = await desk.desk(reader());
    expect(read.pools).toEqual({ count: 0, reason: 'custody_layer_off' });
    expect(read.masterApplications.map((r) => [r.applicationId, r.userId])).toEqual([
      [a.applicationId, ALICE],
      [b.applicationId, BOB],
    ]);
    expect(read.whitelists).toEqual({ batchLimit: null, rows: [] });
    expect(read.takeovers).toEqual({ rows: [] });
    expect(read.levels).toEqual({
      maxRatio: null,
      rows: [{ leaderRef: listed.leaderRef, displayName: 'TEST lead a', state: 'listed', level: null }],
    });
    await expect(desk.desk(customer(ALICE))).rejects.toThrow();
  });

  it('reads the owner’s batch limit when set', async () => {
    const desk = new PooledDesk({ sql: sql(), now, whitelistBatchMax: 20 });
    expect((await desk.desk(reader())).whitelists.batchLimit).toBe(20);
  });
});

describe('the batch limit owner value', () => {
  it('blank is unset; a whole number 1..1000 is the limit; anything else stops the boot', () => {
    expect(parsePoolWhitelistBatchMax(undefined)).toBeNull();
    expect(parsePoolWhitelistBatchMax('  ')).toBeNull();
    expect(parsePoolWhitelistBatchMax('20')).toBe(20);
    for (const bad of ['0', '1001', '2.5', '-1', 'twenty']) expect(() => parsePoolWhitelistBatchMax(bad)).toThrow();
    expect(() => new PooledDesk({ sql: sql(), now, whitelistBatchMax: 0 })).toThrow();
  });
});
