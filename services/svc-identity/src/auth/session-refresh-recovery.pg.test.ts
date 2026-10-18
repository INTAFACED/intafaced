import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyAccessToken } from '@intafaced/auth';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import postgres from 'postgres';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService, AuthError, predecessorSealCleanup, type SessionTokens } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { hashToken } from './passwords.js';
import { parseRefreshRecoverySeconds, REFRESH_RECOVERY_SECONDS_CEILING } from './refresh-cookie.js';

/**
 * A lost refresh reply, presented again after the 10s grace.
 *
 * With REFRESH_RECOVERY_SECONDS unpublished the old cookie is reuse and every
 * live session burns. With it published, the same cookie returns the successor
 * pair and rotates nothing, until the window ends or the successor moves.
 */

const PASSWORD = 'correct horse battery staple';
const tokenConfig = {
  secret: 'an-identity-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const migrations = readdirSync(join(here, '..', '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8'));

describe('REFRESH_RECOVERY_SECONDS', () => {
  it('treats blank and 0 as off, accepts 120, and rejects a value past the ceiling', () => {
    expect(REFRESH_RECOVERY_SECONDS_CEILING).toBe(600);
    expect(parseRefreshRecoverySeconds(undefined)).toBeUndefined();
    expect(parseRefreshRecoverySeconds(null)).toBeUndefined();
    expect(parseRefreshRecoverySeconds('')).toBeUndefined();
    expect(parseRefreshRecoverySeconds('   ')).toBeUndefined();
    expect(parseRefreshRecoverySeconds('0')).toBe(0);
    expect(parseRefreshRecoverySeconds(0)).toBe(0);
    expect(parseRefreshRecoverySeconds('120')).toBe(120);
    expect(parseRefreshRecoverySeconds(120)).toBe(120);
    expect(() => parseRefreshRecoverySeconds('601')).toThrow(/600/);
    expect(() => parseRefreshRecoverySeconds(601)).toThrow(/600/);
    expect(() => parseRefreshRecoverySeconds('12.5')).toThrow(/integer/);
    expect(() => parseRefreshRecoverySeconds('nope')).toThrow(/integer/);
  });

  it('is not given a default and is not set in compose or the example env', () => {
    const envSrc = readFileSync(join(here, '..', 'env.ts'), 'utf8');
    const start = envSrc.indexOf('REFRESH_RECOVERY_SECONDS');
    expect(start).toBeGreaterThan(-1);
    expect(envSrc.slice(start, start + 900)).not.toContain('.default(');
    for (const rel of ['docker-compose.apps.yml', 'docker-compose.yml', '.env.example']) {
      const path = join(repoRoot, rel);
      if (!existsSync(path)) continue;
      expect(readFileSync(path, 'utf8')).not.toContain('REFRESH_RECOVERY_SECONDS');
    }
  });
});

async function harnessUrl(): Promise<string | null> {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw || !(await postgresAvailable(raw))) return null;
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '').split('/')[0] ?? '';
  if (!name.endsWith('_test')) {
    const admin = postgres(raw, { max: 1, onnotice: () => undefined });
    try {
      await admin.unsafe('CREATE DATABASE intafaced_test');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) throw err;
    } finally {
      await admin.end({ timeout: 5 });
    }
    url.pathname = '/intafaced_test';
  }
  const target = url.toString();
  const sql = postgres(target, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS citext');
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  } finally {
    await sql.end({ timeout: 5 });
  }
  return target;
}

const databaseUrl = await harnessUrl();

if (!databaseUrl) {
  describe.skip('session refresh recovery (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: databaseUrl,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const totpKey = randomBytes(32).toString('base64');
  /** Published 120s window. Grace stays 10s. */
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, totpKey, undefined, undefined, 25, 10, 120);
  /** The arg omitted: the same constructor index.ts uses when the env var is unset. */
  const blank = new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, totpKey, undefined, undefined, 25, 10);
  const zero = new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, totpKey, undefined, undefined, 25, 10, 0);
  await rank.seedTiers();
  let n = 0;
  const unique = () => `rr${process.pid}${++n}`;

  beforeEach(async () => {
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  async function sessionCount(userId: string): Promise<number> {
    const rows = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId}`;
    return Number(rows[0]?.n ?? 0);
  }

  async function sessionsText(userId: string): Promise<string> {
    const rows = await db.sql<Array<{ row: string }>>`SELECT s::text AS row FROM sessions s WHERE user_id = ${userId}`;
    return rows.map((row) => row.row).join('\n');
  }

  function expectNoRawToken(text: string, ...tokens: string[]): void {
    for (const token of tokens) {
      expect(token.length).toBeGreaterThan(20);
      expect(text.includes(token)).toBe(false);
    }
  }

  async function backdate(refreshToken: string, seconds: number): Promise<void> {
    const rotatedAt = new Date(Date.now() - seconds * 1000);
    await db.sql`UPDATE sessions SET rotated_at = ${rotatedAt} WHERE refresh_hash = ${hashToken(refreshToken)}`;
  }

  async function twoDevices(service: AuthService): Promise<{ phone: SessionTokens; laptop: SessionTokens }> {
    const handle = unique();
    await service.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
    const phone = await service.login({ identifier: handle, password: PASSWORD, device: 'phone' });
    const laptop = await service.login({ identifier: handle, password: PASSWORD, device: 'laptop' });
    return { phone, laptop };
  }

  async function lostReply(
    service: AuthService,
    seconds: number,
  ): Promise<{ phone: SessionTokens; laptop: SessionTokens; rotated: SessionTokens }> {
    const { phone, laptop } = await twoDevices(service);
    const rotated = await service.refresh(phone.refreshToken, { device: 'phone' });
    await backdate(phone.refreshToken, seconds);
    return { phone, laptop, rotated };
  }

  it('returns the successor pair at 12s when the window is 120 and leaves the other device live', async () => {
    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    auth.useLogger({
      warn(obj, msg) {
        lines.push({ obj, msg });
      },
    });
    const { phone, laptop, rotated } = await lostReply(auth, 12);
    const before = await sessionCount(phone.userId);
    const recovered = await auth.refresh(phone.refreshToken, { device: 'phone' });
    expect(recovered.refreshToken).toBe(rotated.refreshToken);
    expect(recovered.sessionId).toBe(rotated.sessionId);
    expect(recovered.userId).toBe(phone.userId);
    expect(await sessionCount(phone.userId)).toBe(before);
    const principal = await verifyAccessToken(recovered.accessToken, tokenConfig);
    expect(principal.sid).toBe(rotated.sessionId);
    expect(principal.userId).toBe(phone.userId);
    const tip = await db.sql<Array<{ revoked: boolean; rotated_at: Date | null; successor_id: string | null }>>`
      SELECT revoked, rotated_at, successor_id FROM sessions WHERE id = ${rotated.sessionId}
    `;
    expect(tip[0]?.revoked).toBe(false);
    expect(tip[0]?.rotated_at).toBeNull();
    expect(tip[0]?.successor_id).toBeNull();
    const laptopRow = await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM sessions WHERE id = ${laptop.sessionId}`;
    expect(laptopRow[0]?.revoked).toBe(false);
    const stamped = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM sessions WHERE user_id = ${phone.userId} AND reuse_detected_at IS NOT NULL
    `;
    expect(Number(stamped[0]?.n ?? 0)).toBe(0);
    expectNoRawToken(await sessionsText(phone.userId), phone.refreshToken, rotated.refreshToken);
    const logged = lines.filter((line) => line.msg === 'auth.refresh_recovered');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.obj).toMatchObject({
      userId: phone.userId,
      predecessorId: phone.sessionId,
      successorId: rotated.sessionId,
    });
    expect(logged[0]?.obj.ageSeconds).toBeGreaterThanOrEqual(12);
    expect(logged[0]?.obj.ageSeconds).toBeLessThan(30);
    const dumped = JSON.stringify(logged[0]);
    expect(dumped).not.toContain(phone.refreshToken);
    expect(dumped).not.toContain(rotated.refreshToken);
    expect(dumped).not.toContain('enc:v1:');
    await expect(auth.refresh(laptop.refreshToken, { device: 'laptop' })).resolves.toMatchObject({ userId: phone.userId });
  });

  it('burns every session at 121s, and ignores a sealed copy that is still on the row', async () => {
    const { phone, laptop, rotated } = await lostReply(auth, 121);
    const seal = await db.sql<Array<{ successor_refresh: string | null }>>`
      SELECT successor_refresh FROM sessions WHERE id = ${phone.sessionId}
    `;
    expect(seal[0]?.successor_refresh?.startsWith('enc:v1:')).toBe(true);
    expect(seal[0]?.successor_refresh).not.toContain(rotated.refreshToken);
    await expect(auth.refresh(phone.refreshToken, { device: 'phone' })).rejects.toMatchObject({ code: 'auth.session_reused' });
    const live = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM sessions WHERE user_id = ${phone.userId} AND revoked = false
    `;
    expect(Number(live[0]?.n ?? 0)).toBe(0);
    await expect(auth.refresh(rotated.refreshToken)).rejects.toThrow(AuthError);
    await expect(auth.refresh(laptop.refreshToken)).rejects.toThrow(AuthError);
    expectNoRawToken(await sessionsText(phone.userId), phone.refreshToken, rotated.refreshToken);
  });

  it('burns at 12s when the recovery window is unset, the same as today', async () => {
    const { phone, laptop, rotated } = await lostReply(blank, 12);
    await expect(blank.refresh(phone.refreshToken, { device: 'phone' })).rejects.toMatchObject({ code: 'auth.session_reused' });
    const live = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM sessions WHERE user_id = ${phone.userId} AND revoked = false
    `;
    expect(Number(live[0]?.n ?? 0)).toBe(0);
    await expect(blank.refresh(rotated.refreshToken)).rejects.toThrow(AuthError);
    await expect(blank.refresh(laptop.refreshToken)).rejects.toThrow(AuthError);
  });

  it('burns at 12s when the recovery window is 0', async () => {
    const { phone, laptop } = await lostReply(zero, 12);
    await expect(zero.refresh(phone.refreshToken, { device: 'phone' })).rejects.toMatchObject({ code: 'auth.session_reused' });
    const live = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM sessions WHERE user_id = ${phone.userId} AND revoked = false
    `;
    expect(Number(live[0]?.n ?? 0)).toBe(0);
    await expect(zero.refresh(laptop.refreshToken)).rejects.toThrow(AuthError);
  });

  it('clears the sealed copy once the successor rotates, and the old token burns', async () => {
    const handle = unique();
    await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
    const t0 = await auth.login({ identifier: handle, password: PASSWORD, device: 'phone' });
    const t1 = await auth.refresh(t0.refreshToken, { device: 'phone' });
    const t2 = await auth.refresh(t1.refreshToken, { device: 'phone' });
    const pred = await db.sql<Array<{ successor_refresh: string | null }>>`
      SELECT successor_refresh FROM sessions WHERE id = ${t0.sessionId}
    `;
    expect(pred[0]?.successor_refresh).toBeNull();
    const before = await sessionCount(t0.userId);
    await expect(auth.refresh(t0.refreshToken, { device: 'phone' })).rejects.toMatchObject({ code: 'auth.session_reused' });
    expect(await sessionCount(t0.userId)).toBe(before);
    expectNoRawToken(await sessionsText(t0.userId), t0.refreshToken, t1.refreshToken, t2.refreshToken);
  });

  it('plans the predecessor seal cleanup as an index scan on sessions', async () => {
    const handle = unique();
    await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
    const session = await auth.login({ identifier: handle, password: PASSWORD, device: 'phone' });
    const plan = await db.sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      const query = predecessorSealCleanup(session.userId, session.sessionId);
      const rows = await tx.unsafe<Array<Record<string, unknown>>>(`EXPLAIN ${query.text}`, query.values);
      return rows.map((row) => Object.values(row).join(' ')).join('\n');
    });
    expect(plan).toMatch(/Index Scan/);
    expect(plan).toMatch(/sessions_user_idx/);
    expect(plan).toMatch(/on sessions/);
    expect(plan).not.toMatch(/Seq Scan/);
  });

  it('does not recover a successor that logout already revoked', async () => {
    const { phone, rotated } = await lostReply(auth, 12);
    await auth.logout(rotated.refreshToken);
    const before = await sessionCount(phone.userId);
    await expect(auth.refresh(phone.refreshToken, { device: 'phone' })).rejects.toMatchObject({ code: 'auth.session_reused' });
    expect(await sessionCount(phone.userId)).toBe(before);
    await expect(auth.refresh(rotated.refreshToken)).rejects.toThrow(AuthError);
  });

  it('refuses a frozen account with auth.account_frozen and mints nothing', async () => {
    const { phone, rotated } = await lostReply(auth, 12);
    const before = await sessionCount(phone.userId);
    await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${phone.userId}`;
    await expect(auth.refresh(phone.refreshToken, { device: 'phone' })).rejects.toMatchObject({ code: 'auth.account_frozen' });
    expect(await sessionCount(phone.userId)).toBe(before);
    await expect(auth.refresh(rotated.refreshToken)).rejects.toThrow(AuthError);
  });

  it('refuses a closed account with auth.account_frozen and mints nothing', async () => {
    const { phone, rotated } = await lostReply(auth, 12);
    const before = await sessionCount(phone.userId);
    await db.sql`UPDATE users SET status = 'closed' WHERE id = ${phone.userId}`;
    await expect(auth.refresh(phone.refreshToken, { device: 'phone' })).rejects.toMatchObject({ code: 'auth.account_frozen' });
    expect(await sessionCount(phone.userId)).toBe(before);
    await expect(auth.refresh(rotated.refreshToken)).rejects.toThrow(AuthError);
  });

  it('burns when the request device label does not match the predecessor', async () => {
    const { phone, laptop, rotated } = await lostReply(auth, 12);
    const stored = await db.sql<Array<{ device: string | null }>>`SELECT device FROM sessions WHERE id = ${phone.sessionId}`;
    expect(stored[0]?.device).toBe('phone');
    await expect(auth.refresh(phone.refreshToken, { device: 'other-phone' })).rejects.toMatchObject({ code: 'auth.session_reused' });
    const live = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM sessions WHERE user_id = ${phone.userId} AND revoked = false
    `;
    expect(Number(live[0]?.n ?? 0)).toBe(0);
    await expect(auth.refresh(rotated.refreshToken)).rejects.toThrow(AuthError);
    await expect(auth.refresh(laptop.refreshToken)).rejects.toThrow(AuthError);
  });

  it('returns the same successor pair on a second presentation and does not rotate', async () => {
    const { phone, rotated } = await lostReply(auth, 12);
    const first = await auth.refresh(phone.refreshToken, { device: 'phone' });
    const mid = await sessionCount(phone.userId);
    const second = await auth.refresh(phone.refreshToken, { device: 'phone' });
    expect(first.refreshToken).toBe(rotated.refreshToken);
    expect(second.refreshToken).toBe(first.refreshToken);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.sessionId).toBe(rotated.sessionId);
    expect(await sessionCount(phone.userId)).toBe(mid);
    const tip = await db.sql<Array<{ revoked: boolean; rotated_at: Date | null; successor_id: string | null }>>`
      SELECT revoked, rotated_at, successor_id FROM sessions WHERE id = ${rotated.sessionId}
    `;
    expect(tip[0]?.revoked).toBe(false);
    expect(tip[0]?.rotated_at).toBeNull();
    expect(tip[0]?.successor_id).toBeNull();
  });

  it('two concurrent presentations recover the same successor and neither rotates', async () => {
    const { phone, rotated } = await lostReply(auth, 12);
    const before = await sessionCount(phone.userId);
    const [left, right] = await Promise.all([
      auth.refresh(phone.refreshToken, { device: 'phone' }),
      auth.refresh(phone.refreshToken, { device: 'phone' }),
    ]);
    expect(left.refreshToken).toBe(rotated.refreshToken);
    expect(right.refreshToken).toBe(rotated.refreshToken);
    expect(left.sessionId).toBe(rotated.sessionId);
    expect(right.sessionId).toBe(rotated.sessionId);
    expect(await sessionCount(phone.userId)).toBe(before);
    const tip = await db.sql<Array<{ revoked: boolean; rotated_at: Date | null; successor_id: string | null }>>`
      SELECT revoked, rotated_at, successor_id FROM sessions WHERE id = ${rotated.sessionId}
    `;
    expect(tip[0]?.revoked).toBe(false);
    expect(tip[0]?.rotated_at).toBeNull();
    expect(tip[0]?.successor_id).toBeNull();
  });
}
