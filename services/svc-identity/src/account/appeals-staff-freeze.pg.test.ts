/**
 * Appeals against a staff freeze (I-account-lifecycle-12, J-identity-11 #5), against Postgres: filed signed out once the
 * account is proved, never for an active or closed account, never decided by the founder who froze it, and lifted only
 * through the founder control's unfreeze four-eyes with the appeal as its reason.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { appealLiftReason, type Context } from '@intafaced/contracts';
import { createTestDatabase } from '../fixture-truncate.testkit.js';
import { FounderControls, parseFounderPair } from '../controls/founder-controls.js';
import { approvedUnfreeze } from '../controls/unfreeze-approval.testkit.js';
import type { KycRejectReasons } from '../kyc/cases.js';
import { AccountAppeals, AppealError } from './appeals.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(migrationDirectory, file), 'utf8'));
const tokens = {
  secret: 'a-staff-freeze-appeals-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const available = await postgresAvailable(url);
const REASONS: KycRejectReasons = new Map([
  ['review_complete', { code: 'review_complete', reason: 'TEST: we reviewed the account', guidance: 'TEST: sign in again' }],
  ['restriction_stands', { code: 'restriction_stands', reason: 'TEST: the freeze stands', guidance: 'TEST: contact support' }],
]);

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppealError) return err.code;
    throw err;
  }
  return 'no refusal';
};

if (!available) {
  describe.skip('staff freeze appeals (Postgres unavailable)', () => {
    it('requires isolated Postgres evidence', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'identity', url, migrations });
  let first: Context;
  let second: Context;
  let operator: Context;
  let target: string;
  let controls: FounderControls;

  const seed = async (scopes: string[]): Promise<Context> => {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const handle = `s${userId.replaceAll('-', '').slice(0, 16)}`;
    await db.sql`INSERT INTO users (id, handle, email, email_verified_at, password_hash, totp_secret, totp_enrolled_at) VALUES (${userId}, ${handle}, ${`${handle}@example.com`}, ${new Date()}, ${'test-password-hash'}, ${'verified-test-factor'}, ${new Date()})`;
    await db.sql`INSERT INTO sessions (id, user_id, refresh_hash, mfa, expires_at) VALUES (${sessionId}, ${userId}, ${`refresh:${sessionId}`}, ${true}, ${new Date(Date.now() + 3600000)})`;
    const { token } = await issueAccessToken({ userId, sessionId, scopes: scopes as never, mfa: true }, tokens);
    return { principal: await verifyAccessToken(token, tokens), service: null, region: 'DE', requestId: randomUUID() };
  };
  const staffScopes = ['identity:read', 'identity:write', 'ops:read', 'ops:write', 'admin:compliance'];

  const freeze = async () => {
    const done = await controls.change(first, {
      requestId: randomUUID(),
      target: { area: 'identity', userId: target },
      action: 'restrict',
      reason: 'Incident review',
      expectedVersion: '0',
    });
    expect(done.outcome).toBe('changed');
  };
  const account = async () =>
    (
      await db.sql<
        Array<{ status: string; version: string }>
      >`SELECT status, identity_control_version::text AS version FROM users WHERE id = ${target}`
    )[0];
  const desk = () => new AccountAppeals(db.sql, { windowDays: 30, decisionReasons: REASONS, controls });
  const file = (status: 'active' | 'frozen' | 'closed' = 'frozen', clientRequestId = randomUUID()) =>
    desk().submitSignedOut({ userId: target, status }, { text: 'TEST: I did nothing wrong', clientRequestId });

  beforeEach(async () => {
    await db.truncateAll();
    first = await seed(staffScopes);
    second = await seed(staffScopes);
    operator = await seed(staffScopes);
    target = (await seed(['identity:read'])).principal!.userId;
    controls = new FounderControls(db.sql, parseFounderPair(first.principal!.userId, second.principal!.userId));
    expect(await controls.bootstrap()).toBe(true);
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('a staff freeze appeal', () => {
    it('is filed signed out for a frozen account, names the founder who froze it, and keeps one open', async () => {
      await freeze();
      const appeal = await file();
      expect(appeal).toMatchObject({ restriction: 'staff_freeze', status: 'submitted', decision: null });
      const [row] = await db.sql<
        Array<{ restriction_ref: string; restricted_by: string }>
      >`SELECT restriction_ref, restricted_by FROM account_appeals`;
      expect(row).toEqual({ restriction_ref: 'staff_freeze:1', restricted_by: first.principal!.userId });
      expect(await codeOf(file())).toBe('identity.appeal_open');
    });

    it('is refused for an active account (sign in instead) and for a closed one, and for a frozen account staff never froze', async () => {
      expect(await codeOf(file('active'))).toBe('identity.appeal_sign_in');
      expect(await codeOf(file('closed'))).toBe('identity.appeal_not_allowed');
      // Told frozen, but the account reads active: there is nothing to appeal.
      expect(await codeOf(file('frozen'))).toBe('identity.appeal_no_restriction');
      expect(await db.sql`SELECT id FROM account_appeals`).toHaveLength(0);
    });

    it('is never decided by the founder who froze it; an uphold keeps the freeze', async () => {
      await freeze();
      const appeal = await file();
      const uphold = { appealId: appeal.id, decision: 'uphold' as const, reasonCode: 'restriction_stands', expectedVersion: '1' };
      expect(await codeOf(desk().decide(first, uphold))).toBe('identity.appeal_decider_restricted');
      expect(await desk().decide(second, uphold)).toMatchObject({ status: 'upheld', decision: { outcome: 'upheld' } });
      expect(await account()).toEqual({ status: 'frozen', version: '1' });
    });

    it('is lifted through the unfreeze four-eyes with the appeal as its reason, once', async () => {
      await freeze();
      const appeal = await file();
      const approvalId = await approvedUnfreeze(db.sql, {
        requesterId: second.principal!.userId,
        approverId: operator.principal!.userId,
        userId: target,
        reason: appealLiftReason(appeal.id),
        expectedVersion: '1',
      });
      const lift = {
        appealId: appeal.id,
        decision: 'lift' as const,
        reasonCode: 'review_complete',
        expectedVersion: '1',
        approvalId,
        restrictionVersion: '1',
      };
      const done = await desk().decide(second, lift);
      expect(done).toMatchObject({ status: 'lifted', decision: { outcome: 'lifted', reason: { code: 'review_complete' } } });
      expect(await account()).toEqual({ status: 'active', version: '2' });
      expect(await desk().decide(second, lift)).toEqual(done);
      const notices = await db.sql`SELECT detail FROM mail_outbox WHERE user_id = ${target} AND purpose = 'appeal-decided'`;
      expect(notices).toEqual([{ detail: 'lifted' }]);
    });
  });
}
