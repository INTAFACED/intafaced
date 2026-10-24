import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { ReferralLapseService, attachWindowStart, lapseSweepStatusLine, parseLapsePeriodSeconds } from './referral-lapse.js';
import { ReferralService } from './referral-service.js';

// CM-referral-01 RF-4 (J-campaigns-05 #7): a relationship ends after the owner's inactivity period, once.

const FRIEND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REFERRER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INVITEE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DAY = 86_400;

describe('lapse owner values', () => {
  it('a blank period stays blank, a malformed one stops the service, and the status line names what is off', () => {
    expect(parseLapsePeriodSeconds(undefined)).toBeUndefined();
    expect(parseLapsePeriodSeconds('  ')).toBeUndefined();
    expect(parseLapsePeriodSeconds('7776000')).toBe(7_776_000);
    for (const bad of ['0', '-1', '1.5', '90d', '999999999999']) expect(() => parseLapsePeriodSeconds(bad)).toThrow();
    expect(lapseSweepStatusLine(undefined, 60)).toContain('referral.lapse_period_unset');
    expect(lapseSweepStatusLine(600, undefined)).toContain('IDENTITY_REFERRAL_LAPSE_SWEEP_SECONDS is unset');
    expect(lapseSweepStatusLine(600, 60)).toBe('referral lapse sweep on: period 600s, every 60s');
  });
});

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('referral lapse SQL (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const referral = new ReferralService(db.sql);
  const lapse = (periodSeconds: number | 'blank' = 30 * DAY) =>
    new ReferralLapseService(db.sql, { periodSeconds: periodSeconds === 'blank' ? undefined : periodSeconds });

  async function seedUser(id: string, handle: string, ageSeconds: number) {
    await db.sql`
      INSERT INTO users (id, handle, email, password_hash, status, created_at)
      VALUES (${id}, ${handle}, ${handle + '@example.com'}, 'x', 'active', now() - make_interval(secs => ${ageSeconds}))
    `;
  }
  /** Attaches at sign-up (no window), then moves the attach back by `ageSeconds`. */
  async function attachAged(userId: string, referrerId: string, ageSeconds: number) {
    await referral.attribute({ userId, referrerId });
    await db.sql`UPDATE referral_edges SET attributed_at = attributed_at - make_interval(secs => ${ageSeconds}) WHERE user_id = ${userId}`;
  }
  async function feeEvent(payerId: string, beneficiaryId: string, ageSeconds: number, id: string) {
    await db.sql`
      INSERT INTO affiliate_commission_accruals
        (fee_event_id, beneficiary_id, payer_id, hop, rate, fee_amount, commission_amount, asset, accrued_at, source_module)
      VALUES (${id}, ${beneficiaryId}, ${payerId}, 0, '0.2', '10', '2', 'USDT', now() - make_interval(secs => ${ageSeconds}), 'trade')
    `;
  }
  const edgeOf = async (userId: string) => (await db.sql`SELECT referrer_id FROM referral_edges WHERE user_id = ${userId}`)[0] ?? null;
  const lapseRows = async () => db.sql`SELECT * FROM referral_lapses ORDER BY lapsed_at`;

  beforeEach(async () => {
    await db.truncateAll();
    await seedUser(FRIEND, 'friend', 200 * DAY);
    await seedUser(REFERRER, 'referrer', 400 * DAY);
    await seedUser(OTHER, 'other', 400 * DAY);
    await seedUser(INVITEE, 'invitee', 100 * DAY);
  });

  afterAll(async () => {
    await db.drop();
  });

  it('a blank period refuses the sweep by name and ends nothing', async () => {
    await attachAged(FRIEND, REFERRER, 365 * DAY);
    await expect(lapse('blank').sweep()).rejects.toMatchObject({ code: 'referral.lapse_period_unset' });
    expect(await edgeOf(FRIEND)).toMatchObject({ referrer_id: REFERRER });
    expect(await lapse('blank').standingOf(FRIEND)).toEqual({ state: 'unset' });
    expect(await lapseRows()).toHaveLength(0);
  });

  it('past the period with no fee event: two sweeps end it once, record one event, and nobody above earns any more', async () => {
    await attachAged(FRIEND, REFERRER, 31 * DAY);
    await feeEvent(FRIEND, REFERRER, 40 * DAY, 'fee:before-attach');
    const stored = await db.sql`SELECT * FROM affiliate_commission_accruals ORDER BY fee_event_id`;

    const first = await lapse().sweep();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ userId: FRIEND, referrerId: REFERRER, periodSeconds: 30 * DAY });
    // No fee event after the attach: activity counts from the attach.
    expect(first[0]!.lastActivityAt.getTime()).toBe(first[0]!.attributedAt.getTime());
    expect(await lapse().sweep()).toEqual([]);

    expect(await edgeOf(FRIEND)).toBeNull();
    expect(await lapseRows()).toHaveLength(1);
    expect(await referral.ancestorsOf(FRIEND)).toEqual([]);
    // Stored accruals are left exactly as they were.
    expect(await db.sql`SELECT * FROM affiliate_commission_accruals ORDER BY fee_event_id`).toEqual(stored);
    expect(await lapse().latestOf(FRIEND)).toMatchObject({ userId: FRIEND, referrerId: REFERRER });
    expect(await lapse().standingOf(FRIEND)).toEqual({ state: 'none' });
  });

  it('a fee event inside the period keeps the relationship and moves its end date', async () => {
    await attachAged(FRIEND, REFERRER, 300 * DAY);
    await feeEvent(FRIEND, REFERRER, 10 * DAY, 'fee:recent');
    expect(await lapse().sweep()).toEqual([]);
    expect(await edgeOf(FRIEND)).toMatchObject({ referrer_id: REFERRER });
    const standing = await lapse().standingOf(FRIEND);
    expect(standing.state).toBe('active');
    if (standing.state !== 'active') return;
    expect(standing.endsAt.getTime() - standing.lastActivityAt.getTime()).toBe(30 * DAY * 1000);
    expect(Math.abs(standing.endsAt.getTime() - (Date.now() + 20 * DAY * 1000))).toBeLessThan(60_000);
    // A shorter period ends it.
    expect(await lapse(5 * DAY).sweep()).toHaveLength(1);
  });

  it("only the inactive person's own edge ends; the people they invited keep them as referrer", async () => {
    await attachAged(FRIEND, REFERRER, 31 * DAY);
    await attachAged(INVITEE, FRIEND, 31 * DAY);
    await feeEvent(INVITEE, FRIEND, 1 * DAY, 'fee:invitee');
    const ended = await lapse().sweep();
    expect(ended.map((l) => l.userId)).toEqual([FRIEND]);
    expect(await edgeOf(INVITEE)).toMatchObject({ referrer_id: FRIEND });
    expect(await referral.ancestorsOf(INVITEE)).toEqual([FRIEND]);
  });

  it('two sweeps at once end the relationship once', async () => {
    await attachAged(FRIEND, REFERRER, 31 * DAY);
    const [a, b] = await Promise.all([lapse().sweep(), lapse().sweep()]);
    expect(a.length + b.length).toBe(1);
    expect(await lapseRows()).toHaveLength(1);
  });

  it('after a lapse the attach window runs again from the lapse, so a link can attach the person again', async () => {
    await attachAged(FRIEND, REFERRER, 31 * DAY);
    // Before the lapse the window counts from sign-up, long closed.
    expect((await attachWindowStart(db.sql, FRIEND))?.reopenedAt).toBeNull();
    await lapse().sweep();
    const opens = await attachWindowStart(db.sql, FRIEND);
    expect(opens?.reopenedAt).toBeInstanceOf(Date);
    expect(opens?.start.getTime()).toBe(opens?.reopenedAt?.getTime());
    const edge = await referral.attribute({ userId: FRIEND, referrerId: OTHER }, { windowSeconds: 600 });
    expect(edge).toMatchObject({ userId: FRIEND, referrerId: OTHER });
    // The new relationship has its own key: it can lapse later in its own right.
    await db.sql`UPDATE referral_edges SET attributed_at = attributed_at - make_interval(secs => ${31 * DAY}) WHERE user_id = ${FRIEND}`;
    expect(await lapse().sweep()).toHaveLength(1);
    expect(await lapseRows()).toHaveLength(2);
  });

  it('a person who never had a referrer keeps their sign-up window', async () => {
    const opens = await attachWindowStart(db.sql, INVITEE);
    expect(opens?.reopenedAt).toBeNull();
    await expect(referral.attribute({ userId: INVITEE, referrerId: REFERRER }, { windowSeconds: 600 })).rejects.toMatchObject({
      code: 'referral.attach_window_closed',
    });
  });
}
