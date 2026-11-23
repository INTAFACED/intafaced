/**
 * VIP trial passes on Postgres (CM-vip-tiers-01, J-campaigns-14 #2 to #4): a pass granted by svc-campaigns is the tier
 * an order is charged at while it lasts, a later pass replaces the one in force, a pass ends once (at its end time, or
 * at the grant that replaced it) and the tier goes back, a retry of the same key writes nothing, and the grant door
 * refuses any caller but svc-campaigns and any tier the programme in force does not name. TEST tiers and people only.
 */
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import type { TestDatabase } from '@intafaced/db';
import { parseFeeScheduleJson, type OwnerFeeSchedule } from './fee-schedule.js';
import { feeTierAt } from './fee-tier-store.js';
import { tierRates } from './fee-tier-rest.js';
import { registerTierPassGrant, TIER_PASS_PATH } from './tier-pass-internal.js';
import { endExpiredPasses, grantTierPass, passInForce, passesOf } from './tier-passes.js';
import { ALICE, BOB, openTradeDatabase } from './__tests__/saga-trade-fixture.js';

const SECRET = 'test-internal-service-secret-at-least-32-characters';
const T0 = new Date('2026-11-16T03:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const schedule = (programme: boolean): OwnerFeeSchedule =>
  parseFeeScheduleJson(
    JSON.stringify({
      published: true,
      version: 'test-tier-pass',
      defaultPairGroup: 'g',
      rows: ['regular', 'test-vip-1', 'test-vip-2'].map((tierId, i) => ({
        pairGroup: 'g',
        tierId,
        zeroFee: false,
        makerBps: String(8 - i),
        takerBps: String(10 - i),
        minFee: null,
      })),
      tierProgram: programme
        ? {
            thresholds: [
              { tierId: 'test-vip-1', minVolume30d: '1000' },
              { tierId: 'test-vip-2', minVolume30d: '5000' },
            ],
            volumeQuotes: ['USDT'],
            snapshotTimeUtc: null,
            downgradeGraceDays: null,
            subAccounts: null,
            botsAndCopy: null,
          }
        : undefined,
    }),
  );
const TIERED = schedule(true);
const FLAT = schedule(false);

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
  await sql().unsafe('ALTER TABLE trade.tier_passes DISABLE TRIGGER tier_passes_end_once_trg');
  await sql()`TRUNCATE trade.tier_passes, trade.fee_tier_snapshots, trade.fee_tier_snapshot_runs`;
  await sql().unsafe('ALTER TABLE trade.tier_passes ENABLE TRIGGER tier_passes_end_once_trg');
});

const grant = (campaignId: string, tierId: string, seconds: number, when: Date, userId = ALICE) =>
  grantTierPass(sql(), { userId, campaignId, tierId, seconds, scheduleVersion: 'test-tier-pass', grantedBy: 'TEST operator', at: when });

describe('a trial pass', () => {
  it('is the tier an order is charged at while it is in force, for its holder only, and not after its end', async () => {
    expect(await feeTierAt(sql(), TIERED, ALICE, at(0))).toBe('regular');
    const { pass, granted, replaced } = await grant('test-pass-a', 'test-vip-1', 120, at(0));
    expect({ granted, replaced }).toEqual({ granted: true, replaced: null });
    expect(pass).toMatchObject({
      passKey: `trial-pass:test-pass-a:${ALICE}`,
      tierId: 'test-vip-1',
      startsAt: at(0).toISOString(),
      endsAt: at(120).toISOString(),
      endedAt: null,
    });
    expect(await feeTierAt(sql(), TIERED, ALICE, at(1))).toBe('test-vip-1');
    expect(await feeTierAt(sql(), TIERED, BOB, at(1))).toBe('regular');
    expect(await feeTierAt(sql(), TIERED, ALICE, at(120))).toBe('regular');
    // A schedule with no programme charges regular whatever pass is held.
    expect(await feeTierAt(sql(), FLAT, ALICE, at(1))).toBe('regular');
  });

  it('granted again under the same key answers the pass it granted and writes nothing', async () => {
    const first = await grant('test-pass-a', 'test-vip-1', 120, at(0));
    const again = await grant('test-pass-a', 'test-vip-2', 600, at(30));
    expect(again).toEqual({ pass: first.pass, granted: false, replaced: null });
    expect(await passesOf(sql(), ALICE, 10)).toHaveLength(1);
  });

  it('is replaced by a later pass: the earlier ends at the grant, once, and only the later is in force', async () => {
    await grant('test-pass-a', 'test-vip-2', 600, at(0));
    const later = await grant('test-pass-b', 'test-vip-1', 120, at(30));
    expect(later.replaced).toMatchObject({
      passKey: `trial-pass:test-pass-a:${ALICE}`,
      endedAt: at(30).toISOString(),
      endReason: 'replaced',
      replacedBy: `trial-pass:test-pass-b:${ALICE}`,
    });
    // The later replaces the earlier even when the earlier named a higher tier.
    expect((await passInForce(sql(), ALICE, at(31)))?.passKey).toBe(`trial-pass:test-pass-b:${ALICE}`);
    expect(await feeTierAt(sql(), TIERED, ALICE, at(31))).toBe('test-vip-1');
    // The replaced pass is never ended again: not by the sweep after its own end time, nor by a write.
    expect(await endExpiredPasses(sql(), at(700))).toHaveLength(1);
    const [b, a] = await passesOf(sql(), ALICE, 10);
    expect([a?.endReason, a?.endedAt, b?.endReason, b?.endedAt]).toEqual([
      'replaced',
      at(30).toISOString(),
      'expired',
      at(150).toISOString(),
    ]);
    await expect(sql()`UPDATE trade.tier_passes SET ended_at = ${at(40).toISOString()} WHERE pass_key = ${a!.passKey}`).rejects.toThrow(
      /only an open pass's end is written, once/,
    );
    await expect(sql()`DELETE FROM trade.tier_passes`).rejects.toThrow(/never deleted/);
  });

  it('ends once at its end time: the sweep writes the end, a second sweep writes nothing, and the tier goes back', async () => {
    await grant('test-pass-a', 'test-vip-1', 60, at(0));
    expect(await endExpiredPasses(sql(), at(59))).toEqual([]);
    const ended = await endExpiredPasses(sql(), at(61));
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ endReason: 'expired', endedAt: at(60).toISOString() });
    expect(await endExpiredPasses(sql(), at(90))).toEqual([]);
    expect(await passInForce(sql(), ALICE, at(61))).toBeNull();
    expect(await feeTierAt(sql(), TIERED, ALICE, at(61))).toBe('regular');
  });

  it('sweeps one person only when asked for one', async () => {
    await grant('test-pass-a', 'test-vip-1', 60, at(0));
    await grant('test-pass-a', 'test-vip-1', 60, at(0), BOB);
    expect((await endExpiredPasses(sql(), at(61), BOB)).map((p) => p.passKey)).toEqual([`trial-pass:test-pass-a:${BOB}`]);
    expect(await endExpiredPasses(sql(), at(61))).toHaveLength(1);
  });

  it('a pass whose tier the programme no longer names gives regular', async () => {
    await grant('test-pass-a', 'test-vip-3', 120, at(0));
    expect(await feeTierAt(sql(), TIERED, ALICE, at(1))).toBe('regular');
  });
});

describe('tierRates', () => {
  it("names each tier's default-group rates and its taker rate over regular's", () => {
    expect(tierRates(TIERED, ['test-vip-1', 'test-vip-2'])).toEqual([
      { tierId: 'regular', makerBps: 8, takerBps: 10, takerMultiplier: '1' },
      { tierId: 'test-vip-1', makerBps: 7, takerBps: 9, takerMultiplier: '0.9' },
      { tierId: 'test-vip-2', makerBps: 6, takerBps: 8, takerMultiplier: '0.8' },
    ]);
  });
});

describe(`POST ${TIER_PASS_PATH}`, () => {
  async function app(fees: OwnerFeeSchedule = TIERED) {
    const a = Fastify();
    retainRawBody(a);
    registerTierPassGrant(a, { sql: sql(), secret: SECRET, scheduleAt: async () => fees, now: () => at(0) });
    await a.ready();
    return a;
  }
  const post = (body: unknown, service = 'svc-campaigns') => {
    const payload = JSON.stringify(body);
    return {
      method: 'POST' as const,
      url: TIER_PASS_PATH,
      payload,
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) },
    };
  };
  const BODY = { userId: ALICE, campaignId: 'test-pass-a', tierId: 'test-vip-1', seconds: 120, grantedBy: 'TEST operator' };

  it('grants for svc-campaigns (201), and answers the same pass on a retry (200) without writing', async () => {
    const a = await app();
    const first = await a.inject(post(BODY));
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ granted: true, pass: { tierId: 'test-vip-1', endsAt: at(120).toISOString() } });
    const retry = await a.inject(post(BODY));
    expect([retry.statusCode, retry.json().granted]).toEqual([200, false]);
    expect(await passesOf(sql(), ALICE, 10)).toHaveLength(1);
  });

  it('refuses without credentials, any other service, bad input, no programme and an unnamed tier, writing nothing', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: TIER_PASS_PATH, payload: BODY })).statusCode).toBe(401);
    expect((await a.inject(post(BODY, 'svc-tax'))).json().code).toBe('trade.tier_pass_forbidden');
    expect((await a.inject(post({ ...BODY, seconds: 30 }))).json().code).toBe('trade.tier_pass_input');
    expect((await a.inject(post({ ...BODY, tierId: 'regular' }))).json().code).toBe('trade.tier_pass_input');
    expect((await a.inject(post({ ...BODY, tierId: 'test-vip-9' }))).json().code).toBe('trade.tier_pass_tier_unknown');
    expect((await (await app(FLAT)).inject(post(BODY))).json().code).toBe('trade.tier_pass_no_programme');
    expect(await passesOf(sql(), ALICE, 10)).toEqual([]);
  });
});
