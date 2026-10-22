import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { verifyAccessToken } from '@intafaced/auth';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { createTestDb } from './fixture-truncate.testkit.js';
import { AuthService } from './auth/auth-service.js';
import { assertMayDropFactor } from './auth/merchant-mfa-last-factor.js';
import { MERCHANT_MFA_ENROL_SCOPES, type MerchantMfaRule } from './auth/merchant-mfa-rule.js';
import { RankService } from './rank/rank-service.js';

/**
 * M-plat-org-06 (svc-identity half): the merchant owner's require-MFA rule, read from svc-pay, shapes sign-in and
 * refuses removing the last factor. The pay read is a stub here; its S2S client is covered in merchant-mfa-rule.test.ts.
 */
const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));
const tokenConfig = {
  secret: 'an-identity-merchant-mfa-pg-test-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 3600,
};
const PASSWORD = 'correct horse battery staple';
const PASSKEY = { credentialId: 'Y3JlZC1tbWZhLTE', publicKey: 'pk-1', counter: 0 };

if (!(await postgresAvailable(URL))) {
  describe.skip('merchant require-MFA at sign-in (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_merchant_mfa',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const auth = new AuthService(db.sql, bus, new RankService(db.sql, bus), tokenConfig);
  afterAll(async () => {
    await db.drop();
  });

  let rule: MerchantMfaRule | Error = 'none';
  const asked: string[] = [];
  const read = async (userId: string): Promise<MerchantMfaRule> => {
    asked.push(userId);
    if (rule instanceof Error) throw rule;
    return rule;
  };
  auth.useMerchantMfaRuleSource(read);

  let counter = 0;
  const person = async (opts: { passkey?: boolean; totp?: boolean } = {}) => {
    const handle = `mmfa${process.pid}x${++counter}`;
    const reg = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
    if (opts.passkey) await db.sql`UPDATE users SET webauthn_creds = ${db.sql.json([PASSKEY] as never)} WHERE id = ${reg.userId}`;
    if (opts.totp) await db.sql`UPDATE users SET totp_secret = 'sealed-test-secret' WHERE id = ${reg.userId}`;
    return { handle, userId: reg.userId };
  };
  const scopesOf = async (token: string) => (await verifyAccessToken(token, tokenConfig)).scopes;
  const storedOf = async (sessionId: string) =>
    (await db.sql<Array<{ merchant_mfa: string | null }>>`SELECT merchant_mfa FROM sessions WHERE id = ${sessionId}`)[0]!.merchant_mfa;

  describe('merchant require-MFA at sign-in (M-plat-org-06)', () => {
    it('none and not_required: an ordinary session, no signal', async () => {
      for (const r of ['none', 'not_required'] as const) {
        rule = r;
        const p = await person();
        const s = await auth.login({ identifier: p.handle, password: PASSWORD });
        expect(s.merchantMfa).toBeUndefined();
        expect(await storedOf(s.sessionId)).toBeNull();
        expect((await scopesOf(s.accessToken)).length).toBeGreaterThan(MERCHANT_MFA_ENROL_SCOPES.length);
      }
    });

    it('unset: sign-in is not restricted and carries rule_unset', async () => {
      rule = 'unset';
      const p = await person();
      const s = await auth.login({ identifier: p.handle, password: PASSWORD });
      expect(s.merchantMfa).toBe('rule_unset');
      expect(await storedOf(s.sessionId)).toBeNull();
      expect((await scopesOf(s.accessToken)).length).toBeGreaterThan(MERCHANT_MFA_ENROL_SCOPES.length);
    });

    it('required with no factor: enrol_required, enrolment scopes only, kept across refresh', async () => {
      rule = 'required';
      const p = await person();
      const s = await auth.login({ identifier: p.handle, password: PASSWORD });
      expect(s.merchantMfa).toBe('enrol_required');
      expect(await storedOf(s.sessionId)).toBe('enrol_required');
      expect([...(await scopesOf(s.accessToken))].sort()).toEqual([...MERCHANT_MFA_ENROL_SCOPES].sort());
      rule = 'not_required';
      const next = await auth.refresh(s.refreshToken);
      expect(await storedOf(next.sessionId)).toBe('enrol_required');
      expect([...(await scopesOf(next.accessToken))].sort()).toEqual([...MERCHANT_MFA_ENROL_SCOPES].sort());
    });

    it('required with a factor but a password-only sign-in: second_step_required, restricted', async () => {
      rule = 'required';
      const p = await person({ passkey: true });
      const s = await auth.login({ identifier: p.handle, password: PASSWORD });
      expect(s.merchantMfa).toBe('second_step_required');
      expect([...(await scopesOf(s.accessToken))].sort()).toEqual([...MERCHANT_MFA_ENROL_SCOPES].sort());
    });

    it('pay unreachable: sign-in refuses typed and no session is written', async () => {
      rule = new Error('pay down');
      const p = await person();
      const before = (await db.sql`SELECT 1 FROM sessions WHERE user_id = ${p.userId}`).length;
      await expect(auth.login({ identifier: p.handle, password: PASSWORD })).rejects.toMatchObject({
        code: 'auth.merchant_mfa_rule_unavailable',
      });
      const rows = await db.sql`SELECT 1 FROM sessions WHERE user_id = ${p.userId}`;
      expect(rows.length).toBe(before);
    });

    it('signInVerifiedIdentity applies the same rule', async () => {
      rule = 'required';
      const p = await person();
      const s = await auth.signInVerifiedIdentity(p.userId, {});
      expect(s.merchantMfa).toBe('enrol_required');
    });

    it('a session that passed MFA meets the rule: pay is not asked', async () => {
      rule = 'required';
      const p = await person();
      asked.length = 0;
      const decide = (auth as unknown as { merchantMfaFor: (u: string, mfa: boolean, f: boolean) => Promise<unknown> }).merchantMfaFor.bind(
        auth,
      );
      expect(await decide(p.userId, true, true)).toBeNull();
      expect(asked).toEqual([]);
    });

    it('no rule source wired (no PAY_URL): sign-in does not consult it', async () => {
      const bare = new AuthService(db.sql, bus, new RankService(db.sql, bus), tokenConfig);
      rule = 'required';
      const p = await person();
      asked.length = 0;
      const s = await bare.login({ identifier: p.handle, password: PASSWORD });
      expect(s.merchantMfa).toBeUndefined();
      expect(asked).toEqual([]);
    });
  });

  describe('removing the last factor while the rule is on (M-plat-org-06 Failures row)', () => {
    it('refuses dropping the only passkey or the only TOTP when required', async () => {
      rule = 'required';
      const pk = await person({ passkey: true });
      await expect(
        assertMayDropFactor(db.sql, read, pk.userId, { kind: 'passkey', credentialId: PASSKEY.credentialId }),
      ).rejects.toMatchObject({
        code: 'auth.merchant_mfa_last_factor',
      });
      const totp = await person({ totp: true });
      await expect(assertMayDropFactor(db.sql, read, totp.userId, { kind: 'totp' })).rejects.toMatchObject({
        code: 'auth.merchant_mfa_last_factor',
      });
    });

    it('allows it when another factor stays, when the rule is not on, or when nothing would be removed', async () => {
      rule = 'required';
      const both = await person({ passkey: true, totp: true });
      await assertMayDropFactor(db.sql, read, both.userId, { kind: 'totp' });
      await assertMayDropFactor(db.sql, read, both.userId, { kind: 'passkey', credentialId: PASSKEY.credentialId });
      const pk = await person({ passkey: true });
      await assertMayDropFactor(db.sql, read, pk.userId, { kind: 'passkey', credentialId: 'not-enrolled' });
      await assertMayDropFactor(db.sql, read, pk.userId, { kind: 'totp' });
      for (const r of ['unset', 'not_required', 'none'] as const) {
        rule = r;
        await assertMayDropFactor(db.sql, read, pk.userId, { kind: 'passkey', credentialId: PASSKEY.credentialId });
      }
      await assertMayDropFactor(db.sql, null, pk.userId, { kind: 'passkey', credentialId: PASSKEY.credentialId });
    });

    it('pay unreachable refuses typed', async () => {
      rule = new Error('pay down');
      const pk = await person({ passkey: true });
      await expect(
        assertMayDropFactor(db.sql, read, pk.userId, { kind: 'passkey', credentialId: PASSKEY.credentialId }),
      ).rejects.toMatchObject({
        code: 'auth.merchant_mfa_rule_unavailable',
      });
    });

    it('webauthn.remove (AuthService) refuses the last passkey and keeps it', async () => {
      rule = 'required';
      const pk = await person({ passkey: true });
      await expect(auth.removeWebauthnCredential(pk.userId, { mfa: true, privileged: false }, PASSKEY.credentialId)).rejects.toMatchObject({
        code: 'auth.merchant_mfa_last_factor',
      });
      const [row] = await db.sql<
        Array<{ n: number }>
      >`SELECT jsonb_array_length(webauthn_creds)::int AS n FROM users WHERE id = ${pk.userId}`;
      expect(row!.n).toBe(1);
    });
  });
}
