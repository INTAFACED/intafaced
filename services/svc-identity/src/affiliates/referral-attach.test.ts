import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { assertAttachWindowOpen, attachWindowStatus, parseAttachWindowSeconds } from './attach-window.js';
import { REFERRAL_CODE_ALPHABET, ReferralCodeService, drawReferralCode, parseReferralCodeLength } from './referral-code.js';
import { ReferralService } from './referral-service.js';

// CM-referral-01 (J-campaigns-05 #1, #4, #5): the short code and the late-attach window.

const REF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FRIEND = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OLD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('attach window (owner setting)', () => {
  it('blank stays unset; malformed stops the service', () => {
    expect(parseAttachWindowSeconds(undefined)).toBeUndefined();
    expect(parseAttachWindowSeconds('  ')).toBeUndefined();
    expect(parseAttachWindowSeconds('600')).toBe(600);
    for (const bad of ['0', '-5', '1.5', '10m', '99999999999']) expect(() => parseAttachWindowSeconds(bad)).toThrow();
  });

  it('is measured from the account creation time on the server', () => {
    const created = new Date('2026-10-23T10:00:00Z');
    expect(attachWindowStatus(created, undefined, created)).toEqual({ state: 'unset', accountCreatedAt: created });
    expect(attachWindowStatus(created, 60, new Date('2026-10-23T10:00:59Z')).state).toBe('open');
    const closed = attachWindowStatus(created, 60, new Date('2026-10-23T10:01:00Z'));
    expect(closed).toMatchObject({ state: 'closed', closesAt: new Date('2026-10-23T10:01:00Z') });
    expect(() => assertAttachWindowOpen(created, undefined, created)).toThrow(
      expect.objectContaining({ code: 'referral.attach_window_unset' }),
    );
    expect(() => assertAttachWindowOpen(created, 60, new Date('2026-10-23T10:05:00Z'))).toThrow(
      expect.objectContaining({ code: 'referral.attach_window_closed' }),
    );
  });
});

describe('referral code (owner setting)', () => {
  it('length is 4 to 16; blank stays unset', () => {
    expect(parseReferralCodeLength('')).toBeUndefined();
    expect(parseReferralCodeLength('8')).toBe(8);
    for (const bad of ['3', '17', 'eight', '8.0']) expect(() => parseReferralCodeLength(bad)).toThrow();
  });

  it('draws from the alphabet without look-alike characters', () => {
    const code = drawReferralCode(16);
    expect(code).toHaveLength(16);
    for (const ch of code) expect(REFERRAL_CODE_ALPHABET).toContain(ch);
    expect(REFERRAL_CODE_ALPHABET).not.toMatch(/[0O1I]/);
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
  describe.skip('referral attach SQL (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const referral = new ReferralService(db.sql);

  async function seedUser(id: string, handle: string, ageSeconds = 0) {
    await db.sql`
      INSERT INTO users (id, handle, email, password_hash, status, created_at)
      VALUES (${id}, ${handle}, ${handle + '@example.com'}, 'x', 'active', now() - make_interval(secs => ${ageSeconds}))
    `;
  }
  const edges = async () => (await db.sql`SELECT user_id FROM referral_edges`).length;

  beforeEach(async () => {
    await db.truncateAll();
    await seedUser(REF, 'referrer');
    await seedUser(FRIEND, 'friend');
    await seedUser(OLD, 'oldtimer', 3600);
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('late attach through a link', () => {
    it('inside the window attaches once; a second attach is refused', async () => {
      const edge = await referral.attribute({ userId: FRIEND, referrerId: REF }, { windowSeconds: 600 });
      expect(edge.referrerId).toBe(REF);
      await expect(referral.attribute({ userId: FRIEND, referrerId: OLD }, { windowSeconds: 600 })).rejects.toMatchObject({
        code: 'referral.already_set',
      });
      expect(await edges()).toBe(1);
    });

    it('a blank window refuses and writes nothing', async () => {
      await expect(referral.attribute({ userId: FRIEND, referrerId: REF }, { windowSeconds: undefined })).rejects.toMatchObject({
        code: 'referral.attach_window_unset',
      });
      expect(await edges()).toBe(0);
    });

    it('an account older than the window is refused and nothing is written', async () => {
      await expect(referral.attribute({ userId: OLD, referrerId: REF }, { windowSeconds: 600 })).rejects.toMatchObject({
        code: 'referral.attach_window_closed',
      });
      expect(await edges()).toBe(0);
    });

    it('a cycle is refused inside the window', async () => {
      await referral.attribute({ userId: FRIEND, referrerId: REF }, { windowSeconds: 600 });
      await expect(referral.attribute({ userId: REF, referrerId: FRIEND }, { windowSeconds: 600 })).rejects.toMatchObject({
        code: 'referral.cycle',
      });
    });

    it('a referrer named at sign-up completion is not subject to the window', async () => {
      const edge = await referral.attribute({ userId: OLD, referrerId: REF });
      expect(edge.userId).toBe(OLD);
    });

    it('reads the account creation time for the window screen', async () => {
      const created = await referral.accountCreatedAt(OLD);
      expect(Date.now() - created!.getTime()).toBeGreaterThanOrEqual(3_599_000);
      expect(await referral.accountCreatedAt('dddddddd-dddd-4ddd-8ddd-dddddddddddd')).toBeNull();
    });
  });

  describe('ReferralCodeService', () => {
    it('makes one code per person; repeats return it', async () => {
      const codes = new ReferralCodeService(db.sql, 8);
      expect(await codes.codeOf(REF)).toBeNull();
      const first = await codes.createCode(REF);
      expect(first.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      expect((await codes.createCode(REF)).code).toBe(first.code);
      expect((await codes.codeOf(REF))?.code).toBe(first.code);
    });

    it('a blank length refuses and writes nothing', async () => {
      const codes = new ReferralCodeService(db.sql, undefined);
      await expect(codes.createCode(REF)).rejects.toMatchObject({ code: 'referral.code_length_unset' });
      expect(await codes.codeOf(REF)).toBeNull();
    });

    it('a collision draws a new random value, never reusing a taken code', async () => {
      const draws = ['AAAAAAAA', 'AAAAAAAA', 'BBBBBBBB'];
      const codes = new ReferralCodeService(db.sql, 8, () => draws.shift()!);
      expect((await codes.createCode(REF)).code).toBe('AAAAAAAA');
      expect((await codes.createCode(FRIEND)).code).toBe('BBBBBBBB');
    });

    it('a person who already has a code keeps it even while the length is blank', async () => {
      await new ReferralCodeService(db.sql, 6).createCode(REF);
      expect((await new ReferralCodeService(db.sql, undefined).createCode(REF)).code).toHaveLength(6);
    });
  });
}
