/**
 * I-signin-sessions-30 against Postgres: failed sign-ins counted per address, the challenge asked for at the owner's
 * count (or always with the count blank), a solved token good once, and blank settings refusing by name.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { signInChallengeMet, signInChallengeText, type Context, type SignInChallenge } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import { AuthService } from './auth-service.js';
import { requestIpAls } from './auth-service-ip.js';
import { SignInChallengeService, parseSignInChallengePolicy, type SignInChallengePolicy } from './signin-challenge.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced:intafaced@127.0.0.1:5432/intafaced_test';
const drizzleDir = join(process.cwd(), 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));
const tokenConfig = {
  secret: 'an-identity-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };
const KEY = 'a-test-sign-in-challenge-key-long-enough-0001';
const POLICY: SignInChallengePolicy = { afterFailures: 3, bits: 8, ttlSeconds: 120, key: KEY };
const PASSWORD = 'correct horse battery staple';

function solve(challenge: SignInChallenge): string {
  for (let n = 0; ; n += 1) {
    const nonce = n.toString(36);
    const digest = createHash('sha256').update(signInChallengeText(challenge.token, nonce)).digest();
    if (signInChallengeMet(digest, challenge.bits)) return nonce;
  }
}

if (!(await postgresAvailable(URL))) {
  describe.skip('sign-in challenge (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_signin_challenge',
    url: URL,
    migrations: migrations.map((b) => (s: string) => rewriteSchemaSql(b, 'identity', s)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(
    db.sql,
    bus,
    rank,
    tokenConfig,
    webauthnConfig,
    randomBytes(32).toString('base64'),
    undefined,
    undefined,
    25,
  );
  await rank.seedTiers();
  let clockMs = Date.now();
  const clock = () => new Date(clockMs);
  let counter = 0;
  const register = () => {
    const handle = `sc${process.pid}${++counter}`;
    return auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' }).then(() => handle);
  };
  const anon = { principal: null, service: null, region: 'DE', requestId: 'req-signin-challenge' } as unknown as Context;
  const callerWith = (policy: SignInChallengePolicy) =>
    createIdentityRouter(auth, rank, {
      registrationOpen: true,
      signInChallenge: new SignInChallengeService(db.sql, policy, clock),
    }).createCaller(anon);
  const from = <T>(address: string, fn: () => Promise<T>) => requestIpAls.run(address, fn);
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      return cause?.code ?? (err as { code?: string }).code;
    }
  };

  beforeEach(async () => {
    clockMs = Date.now();
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('parseSignInChallengePolicy', () => {
    it('keeps blanks blank and refuses malformed values', () => {
      expect(parseSignInChallengePolicy({})).toEqual({ afterFailures: null, bits: null, ttlSeconds: null, key: null });
      expect(
        parseSignInChallengePolicy({
          IDENTITY_SIGNIN_CHALLENGE_AFTER_FAILURES: '5',
          IDENTITY_SIGNIN_CHALLENGE_BITS: '12',
          IDENTITY_SIGNIN_CHALLENGE_TTL_SECONDS: '120',
          IDENTITY_SIGNIN_CHALLENGE_KEY: KEY,
        }),
      ).toEqual({ afterFailures: 5, bits: 12, ttlSeconds: 120, key: KEY });
      expect(() => parseSignInChallengePolicy({ IDENTITY_SIGNIN_CHALLENGE_BITS: '33' })).toThrow(/BITS/);
      expect(() => parseSignInChallengePolicy({ IDENTITY_SIGNIN_CHALLENGE_AFTER_FAILURES: '0' })).toThrow(/AFTER_FAILURES/);
      expect(() => parseSignInChallengePolicy({ IDENTITY_SIGNIN_CHALLENGE_TTL_SECONDS: 'soon' })).toThrow(/TTL_SECONDS/);
      expect(() => parseSignInChallengePolicy({ IDENTITY_SIGNIN_CHALLENGE_KEY: 'short' })).toThrow(/KEY/);
    });
  });

  describe('auth.login with the challenge', () => {
    it("asks for a challenge after the owner's count of failures from one address, known names and unknown alike", async () => {
      const handle = await register();
      const api = callerWith(POLICY);
      // Two wrong passwords for a real account and one for a name that does not exist: three failures from this address.
      expect(await from('203.0.113.7', () => codeOf(api.auth.login({ identifier: handle, password: 'wrong one' })))).toBe(
        'auth.invalid_credentials',
      );
      expect(await from('203.0.113.7', () => codeOf(api.auth.login({ identifier: handle, password: 'wrong two' })))).toBe(
        'auth.invalid_credentials',
      );
      expect(await from('203.0.113.7', () => codeOf(api.auth.login({ identifier: 'nobody_here', password: 'wrong' })))).toBe(
        'auth.invalid_credentials',
      );
      // The fourth sign-in from that address needs a challenge, even with the right password, and the answer is the same
      // for a name that does not exist.
      expect(await from('203.0.113.7', () => codeOf(api.auth.login({ identifier: handle, password: PASSWORD })))).toBe(
        'auth.challenge_required',
      );
      expect(await from('203.0.113.7', () => codeOf(api.auth.login({ identifier: 'nobody_here', password: PASSWORD })))).toBe(
        'auth.challenge_required',
      );
      // Another address is not affected.
      expect(await from('198.51.100.9', () => codeOf(api.auth.login({ identifier: handle, password: PASSWORD })))).toBe('ok');

      // A solved challenge lets one sign-in through; the same token again is refused.
      const challenge = await api.auth.challenge();
      expect(challenge.bits).toBe(8);
      const proof = { token: challenge.token, nonce: solve(challenge) };
      expect(await from('203.0.113.7', () => codeOf(api.auth.login({ identifier: handle, password: PASSWORD, challenge: proof })))).toBe(
        'ok',
      );
      expect(await from('203.0.113.7', () => codeOf(api.auth.login({ identifier: handle, password: PASSWORD, challenge: proof })))).toBe(
        'auth.challenge_used',
      );
    });

    it('refuses a token that is forged, unsolved, from another key, expired, or easier than the current difficulty', async () => {
      const handle = await register();
      const api = callerWith({ ...POLICY, afterFailures: null });
      const challenge = await api.auth.challenge();
      const nonce = solve(challenge);
      const login = (proof: { token: string; nonce: string }) =>
        from('203.0.113.8', () => codeOf(api.auth.login({ identifier: handle, password: PASSWORD, challenge: proof })));
      const parts = challenge.token.split('.');
      expect(await login({ token: [...parts.slice(0, 4), 'forged'].join('.'), nonce })).toBe('auth.challenge_invalid');
      expect(await login({ token: [parts[0], parts[1], '1', parts[3], parts[4]].join('.'), nonce })).toBe('auth.challenge_invalid');
      let unsolved = 0;
      while (
        signInChallengeMet(
          createHash('sha256')
            .update(signInChallengeText(challenge.token, `x${unsolved}`))
            .digest(),
          challenge.bits,
        )
      )
        unsolved += 1;
      expect(await login({ token: challenge.token, nonce: `x${unsolved}` })).toBe('auth.challenge_invalid');
      const otherKey = callerWith({ ...POLICY, afterFailures: null, key: `${KEY}-other` });
      const foreign = await otherKey.auth.challenge();
      expect(await login({ token: foreign.token, nonce: solve(foreign) })).toBe('auth.challenge_invalid');
      const harder = callerWith({ ...POLICY, afterFailures: null, bits: 12 });
      expect(
        await from('203.0.113.8', () =>
          codeOf(harder.auth.login({ identifier: handle, password: PASSWORD, challenge: { token: challenge.token, nonce } })),
        ),
      ).toBe('auth.challenge_invalid');
      clockMs += 121_000;
      expect(await login({ token: challenge.token, nonce })).toBe('auth.challenge_expired');
    });

    it('with the count blank, every sign-in needs a challenge', async () => {
      const handle = await register();
      const api = callerWith({ ...POLICY, afterFailures: null });
      expect(await from('203.0.113.9', () => codeOf(api.auth.login({ identifier: handle, password: PASSWORD })))).toBe(
        'auth.challenge_required',
      );
      const challenge = await api.auth.challenge();
      expect(
        await from('203.0.113.9', () =>
          codeOf(
            api.auth.login({ identifier: handle, password: PASSWORD, challenge: { token: challenge.token, nonce: solve(challenge) } }),
          ),
        ),
      ).toBe('ok');
    });

    it('with the difficulty, lifetime or key blank, a sign-in that needs a challenge refuses by name and none is issued', async () => {
      const handle = await register();
      for (const blank of [{ bits: null }, { ttlSeconds: null }, { key: null }] as const) {
        const api = callerWith({ ...POLICY, afterFailures: null, ...blank });
        expect(await codeOf(api.auth.challenge())).toBe('identity.challenge_unconfigured');
        expect(await from('203.0.113.10', () => codeOf(api.auth.login({ identifier: handle, password: PASSWORD })))).toBe(
          'identity.challenge_unconfigured',
        );
      }
    });

    it('parallel wrong passwords from one address cannot all slip past the count: each reserves its place first', async () => {
      const handle = await register();
      const api = callerWith(POLICY);
      const codes = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          from('203.0.113.13', () => codeOf(api.auth.login({ identifier: handle, password: `wrong ${i}` }))),
        ),
      );
      expect(codes.filter((c) => c === 'auth.invalid_credentials')).toHaveLength(3);
      expect(codes.filter((c) => c === 'auth.challenge_required')).toHaveLength(7);
    });

    it('a right password gives its place back, so ordinary sign-ins never build up the count', async () => {
      const handle = await register();
      const api = callerWith(POLICY);
      for (let i = 0; i < 5; i++)
        expect(await from('203.0.113.14', () => codeOf(api.auth.login({ identifier: handle, password: PASSWORD })))).toBe('ok');
      const rows = await db.sql`SELECT failures FROM signin_address_failures`;
      expect(rows).toHaveLength(0);
    });

    it('a window that ended starts the count again', async () => {
      const handle = await register();
      const api = callerWith(POLICY);
      for (let i = 0; i < 3; i++) await from('203.0.113.11', () => codeOf(api.auth.login({ identifier: handle, password: `wrong ${i}` })));
      expect(await from('203.0.113.11', () => codeOf(api.auth.login({ identifier: handle, password: PASSWORD })))).toBe(
        'auth.challenge_required',
      );
      clockMs += 15 * 60_000 + 1_000;
      expect(await from('203.0.113.11', () => codeOf(api.auth.login({ identifier: handle, password: PASSWORD })))).toBe('ok');
    });

    it('stores a keyed hash of the address, never the address', async () => {
      const handle = await register();
      const api = callerWith(POLICY);
      await from('203.0.113.12', () => codeOf(api.auth.login({ identifier: handle, password: 'wrong' })));
      const rows = await db.sql<Array<{ address_hash: string }>>`SELECT address_hash FROM signin_address_failures`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.address_hash).not.toContain('203.0.113.12');
      expect(rows[0]!.address_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });
}
