/**
 * `auth.subAccountSession` against Postgres (I-account-lifecycle-04; J-copy-bots-otc-01 #5): a person signed in on the
 * main account gets an access token on the same session that names one of their own live sub-accounts. Another
 * person's, a revoked or a frozen sub-account is refused; an API key or a token already acting as a sub-account is
 * refused; a revoked session or a frozen account is refused. No refresh token is issued.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { AuthService } from './auth-service.js';
import { createIdentityRouter } from '../router.js';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '').split('/')[0] ?? '';
  if (name.length > 0 && !name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const DATABASE_URL = testDatabaseUrl();
const tokenConfig = {
  secret: 'an-identity-sub-account-session-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('sub-account session (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: DATABASE_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, randomBytes(32).toString('base64'), undefined, undefined, 25);
  const appRouter = createIdentityRouter(auth, rank, { registrationOpen: true });

  let n = 0;
  beforeEach(async () => {
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  async function register() {
    const handle = `sas${process.pid}x${++n}`;
    return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  }
  type Signed = { userId: string; sessionId: string; accessToken: string };
  async function callerFor(token: string) {
    return appRouter.createCaller({ principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'r' });
  }
  async function delegated(session: Signed, extra: { apiKeyId?: string; subAccountId?: string }) {
    const base = await verifyAccessToken(session.accessToken, tokenConfig);
    const { token } = await issueAccessToken(
      { userId: session.userId, sessionId: session.sessionId, scopes: [...base.scopes], tier: 'none', mfa: false, ...extra },
      tokenConfig,
    );
    return callerFor(token);
  }
  async function code(run: Promise<unknown>): Promise<string | undefined> {
    try {
      await run;
    } catch (err) {
      const e = err as { cause?: { code?: string }; code?: string };
      return e.cause?.code ?? e.code;
    }
    throw new Error('expected a refusal');
  }

  it('issues a token on the same session that names the sub-account, with no refresh token', async () => {
    const me = await register();
    const { id } = await auth.createSubAccount(me.userId, 'desk');
    const issued = await (await callerFor(me.accessToken)).auth.subAccountSession({ subAccountId: id.toUpperCase() });
    expect(issued).toMatchObject({ userId: me.userId, subAccountId: id, label: 'desk', refreshable: false });
    expect(issued).not.toHaveProperty('refreshToken');
    const principal = await verifyAccessToken(issued.accessToken, tokenConfig);
    expect(principal).toMatchObject({ userId: me.userId, sid: me.sessionId, sub_account: id });
    expect(principal.kid).toBeUndefined();
    const main = await verifyAccessToken(me.accessToken, tokenConfig);
    expect([...principal.scopes].sort()).toEqual([...main.scopes].sort());
  });

  it("refuses another person's, an unknown, a revoked and a frozen sub-account", async () => {
    const me = await register();
    const other = await register();
    const mine = await callerFor(me.accessToken);
    const theirs = await auth.createSubAccount(other.userId, 'theirs');
    expect(await code(mine.auth.subAccountSession({ subAccountId: theirs.id }))).toBe('auth.sub_account_denied');
    expect(await code(mine.auth.subAccountSession({ subAccountId: randomUUID() }))).toBe('auth.sub_account_denied');
    const revoked = await auth.createSubAccount(me.userId, 'old');
    await auth.revokeSubAccount(me.userId, revoked.id);
    expect(await code(mine.auth.subAccountSession({ subAccountId: revoked.id }))).toBe('auth.sub_account_revoked');
    const frozen = await auth.createSubAccount(me.userId, 'cold');
    await db.sql`UPDATE sub_accounts SET frozen = 1 WHERE id = ${frozen.id}`;
    expect(await code(mine.auth.subAccountSession({ subAccountId: frozen.id }))).toBe('auth.sub_account_denied');
  });

  it('refuses an API key and a token already acting as a sub-account', async () => {
    const me = await register();
    const { id } = await auth.createSubAccount(me.userId, 'desk');
    const asKey = await delegated(me, { apiKeyId: randomUUID() });
    expect(await code(asKey.auth.subAccountSession({ subAccountId: id }))).toBe('auth.sub_account_denied');
    const asSub = await delegated(me, { subAccountId: id });
    expect(await code(asSub.auth.subAccountSession({ subAccountId: id }))).toBe('auth.sub_account_denied');
  });

  it('refuses on a revoked session and on a frozen account', async () => {
    const me = await register();
    const { id } = await auth.createSubAccount(me.userId, 'desk');
    const mine = await callerFor(me.accessToken);
    await db.sql`UPDATE sessions SET revoked = true WHERE id = ${me.sessionId}`;
    expect(await code(mine.auth.subAccountSession({ subAccountId: id }))).toBe('auth.session_invalid');
    const other = await register();
    const sub = await auth.createSubAccount(other.userId, 'desk');
    await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${other.userId}`;
    expect(await code((await callerFor(other.accessToken)).auth.subAccountSession({ subAccountId: sub.id }))).toBe('auth.account_frozen');
  });
}
