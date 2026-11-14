import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { PartnerApplicationService, parsePartnerMinQualified, parsePartnerReapplyDays } from './partner-application.js';
import { parseProgrammeDepth, requireProgrammeDepth } from './programme-depth.js';

// CM-referral-05, RC-campaigns-07 (J-campaigns-07): partner eligibility, application, decision, and the sub-tree.

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const ME = id(1);
const OPERATOR = id(2);
const OTHER = id(3);

describe('partner owner values parse with no default', () => {
  it('blank is unset; malformed stops the service', () => {
    for (const blank of [undefined, '', '  ']) {
      expect(parsePartnerMinQualified(blank)).toBeUndefined();
      expect(parsePartnerReapplyDays(blank)).toBeUndefined();
      expect(parseProgrammeDepth(blank)).toBeUndefined();
    }
    expect(parsePartnerMinQualified('3')).toBe(3);
    expect(parsePartnerReapplyDays('30')).toBe(30);
    expect(parseProgrammeDepth('2')).toBe(2);
    for (const bad of ['0', '-1', '1.5', 'two', 'off']) {
      expect(() => parsePartnerMinQualified(bad)).toThrow();
      expect(() => parsePartnerReapplyDays(bad)).toThrow();
      expect(() => parseProgrammeDepth(bad)).toThrow();
    }
    // Never past the referral tree's own cap.
    expect(() => parseProgrammeDepth('6')).toThrow();
    expect(() => requireProgrammeDepth(undefined)).toThrow(expect.objectContaining({ code: 'affiliate.programme_depth_unset' }));
    expect(requireProgrammeDepth(3)).toBe(3);
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('partner applications SQL (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const service = (over: Partial<{ min: number; days: number; depth: number }> & { blank?: 'min' | 'days' | 'depth' } = {}) =>
    new PartnerApplicationService(db.sql, {
      minQualifiedInvitees: over.blank === 'min' ? undefined : (over.min ?? 2),
      reapplyDays: over.blank === 'days' ? undefined : (over.days ?? 30),
      programmeDepth: over.blank === 'depth' ? undefined : (over.depth ?? 2),
    });

  async function user(userId: string, handle: string) {
    await db.sql`INSERT INTO users (id, handle, email, password_hash, status) VALUES (${userId}, ${handle}, ${handle + '@example.com'}, 'x', 'active')`;
  }
  async function invite(referrerId: string, userId: string, handle: string, verified: boolean) {
    await user(userId, handle);
    await db.sql`INSERT INTO referral_edges (user_id, referrer_id, attributed_at) VALUES (${userId}, ${referrerId}, now())`;
    if (verified)
      await db.sql`INSERT INTO kyc_records (user_id, tier, jurisdiction, status, reviewed_at) VALUES (${userId}, 'basic', 'DE', 'approved', now())`;
  }
  const count = async () => Number((await db.sql`SELECT count(*)::int AS n FROM partner_applications`)[0]!.n);

  beforeEach(async () => {
    await db.truncateAll();
    await user(ME, 'partnerme');
    await user(OPERATOR, 'operator');
    await user(OTHER, 'stranger');
  });

  afterAll(async () => {
    await db.drop();
  });

  it('eligibility counts only direct invitees whose verification was approved; a blank count refuses and records nothing', async () => {
    await invite(ME, id(10), 'inv_verified', true);
    await invite(ME, id(11), 'inv_unverified', false);
    // A pending or rejected verification is not qualified, nor is someone my invitee introduced.
    await db.sql`INSERT INTO kyc_records (user_id, tier, jurisdiction, status) VALUES (${id(11)}, 'basic', 'DE', 'pending')`;
    await invite(id(10), id(12), 'inv_grandchild', true);
    expect(await service().eligibility(ME)).toEqual({ requiredCount: 2, qualifiedCount: 1, eligible: false });
    await expect(service().apply(ME)).rejects.toMatchObject({ code: 'partner.not_eligible' });
    await expect(service({ blank: 'min' }).eligibility(ME)).rejects.toMatchObject({ code: 'partner.eligibility_unset' });
    await expect(service({ blank: 'min' }).apply(ME)).rejects.toMatchObject({ code: 'partner.eligibility_unset' });
    expect(await count()).toBe(0);
  });

  it('applies once, even when pressed twice at once', async () => {
    await invite(ME, id(10), 'inv_a', true);
    await invite(ME, id(11), 'inv_b', true);
    const svc = service();
    expect(await svc.eligibility(ME)).toEqual({ requiredCount: 2, qualifiedCount: 2, eligible: true });
    const [a, b] = await Promise.all([svc.apply(ME), svc.apply(ME)]);
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ state: 'submitted', qualifiedCount: 2, requiredCount: 2 });
    expect(await count()).toBe(1);
    expect((await svc.queue(10)).map((x) => x.id)).toEqual([a.id]);
  });

  it('an operator approves with a reason; the applicant cannot decide their own; a repeat returns the decision', async () => {
    await invite(ME, id(10), 'inv_a', true);
    await invite(ME, id(11), 'inv_b', true);
    const svc = service();
    const filed = await svc.apply(ME);
    await expect(svc.decide(ME, filed.id, 'approve', 'my own')).rejects.toMatchObject({ code: 'partner.self_decision' });
    await expect(svc.decide(OPERATOR, filed.id, 'approve', 'no')).rejects.toMatchObject({ code: 'partner.invalid' });
    const approved = await svc.decide(OPERATOR, filed.id, 'approve', 'TEST: two verified invitees');
    expect(approved).toMatchObject({ state: 'approved', decidedBy: OPERATOR, decisionReason: 'TEST: two verified invitees' });
    expect((await svc.decide(OPERATOR, filed.id, 'approve', 'again')).decidedAt).toEqual(approved.decidedAt);
    await expect(svc.decide(OPERATOR, filed.id, 'reject', 'too late', 'other')).rejects.toMatchObject({ code: 'partner.not_open' });
    // Applying again returns the approved application, never a second one.
    expect((await svc.apply(ME)).id).toBe(filed.id);
    expect(await svc.queue(10)).toEqual([]);
  });

  it('a rejection names its category and a reapply date; before it the person is refused, after it they may apply again', async () => {
    await invite(ME, id(10), 'inv_a', true);
    await invite(ME, id(11), 'inv_b', true);
    const svc = service({ days: 30 });
    const filed = await svc.apply(ME);
    await expect(svc.decide(OPERATOR, filed.id, 'reject', 'TEST: needs a category', undefined)).rejects.toMatchObject({
      code: 'partner.invalid',
    });
    // A blank wait refuses the rejection and leaves the application open.
    await expect(service({ blank: 'days' }).decide(OPERATOR, filed.id, 'reject', 'TEST', 'other')).rejects.toMatchObject({
      code: 'partner.reapply_unset',
    });
    expect((await svc.latestOf(ME))!.state).toBe('submitted');
    const at = new Date();
    const rejected = await svc.decide(OPERATOR, filed.id, 'reject', 'TEST: invitees inactive', 'not_enough_activity', at);
    expect(rejected).toMatchObject({ state: 'rejected', rejectCategory: 'not_enough_activity' });
    expect(rejected.reapplyAt!.getTime()).toBe(at.getTime() + 30 * 86_400_000);
    await expect(svc.apply(ME)).rejects.toMatchObject({ code: 'partner.reapply_too_soon' });
    expect(await count()).toBe(1);
    const again = await svc.apply(ME, new Date(rejected.reapplyAt!.getTime() + 1000));
    expect(again.id).not.toBe(filed.id);
    expect(again.state).toBe('submitted');
  });

  it('the sub-tree shows only my own downline to the programme depth; deeper people are counted, never named', async () => {
    // ME → a → b → c, plus a stranger's branch that must never appear.
    await invite(ME, id(10), 'level_one', true);
    await invite(ME, id(11), 'level_one_b', true);
    await invite(id(10), id(12), 'level_two', false);
    await invite(id(12), id(13), 'level_three', false);
    await invite(OTHER, id(14), 'not_mine', true);
    const svc = service({ depth: 2 });
    await expect(svc.subTree(ME)).rejects.toMatchObject({ code: 'partner.not_partner' });
    const filed = await svc.apply(ME);
    await svc.decide(OPERATOR, filed.id, 'approve', 'TEST: approved');
    const tree = await svc.subTree(ME);
    expect(tree.depth).toBe(2);
    expect(tree.members.map((m) => [m.handle, m.level])).toEqual([
      ['level_one', 1],
      ['level_one_b', 1],
      ['level_two', 2],
    ]);
    expect(tree.beyondDepth).toBe(1);
    expect((await service({ depth: 3 }).subTree(ME)).members.map((m) => m.handle)).toContain('level_three');
    await expect(service({ blank: 'depth' }).subTree(ME)).rejects.toMatchObject({ code: 'affiliate.programme_depth_unset' });
  });
}
