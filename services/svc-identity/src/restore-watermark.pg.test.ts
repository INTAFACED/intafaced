import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterAll } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { randomBytes } from 'node:crypto';
import { restoreWatermarkReadSchema } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { AuthService } from './auth/auth-service.js';
import { totp } from './auth/totp.js';
import { RankService } from './rank/rank-service.js';
import { createTestDb } from './fixture-truncate.testkit.js';
import { APPROVAL_TABLES, OPERATOR_TRAFFIC_TABLES, WATERMARK_KIND, digestCounts, readIdentityWatermark } from './restore-watermark.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

describe('digestCounts', () => {
  it('does not depend on the order the tables come in, and moves when a count does', () => {
    const a = [
      { table: 'a', rows: 1n },
      { table: 'b', rows: 2n },
    ];
    expect(digestCounts(a)).toBe(digestCounts([...a].reverse()));
    expect(digestCounts(a)).not.toBe(
      digestCounts([
        { table: 'a', rows: 1n },
        { table: 'b', rows: 3n },
      ]),
    );
  });
});

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('identity restore watermark (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_restore_wm',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('identity restore watermark (real Postgres)', () => {
    it('reads a contract-shaped position, stable while nothing is written', async () => {
      const first = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect(restoreWatermarkReadSchema.parse(first).service).toBe('identity');
      const second = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect({ ...second, readAt: '' }).toEqual({ ...first, readAt: '' });
    });

    it('moves the position, the digest and lastWriteAt when a row is written, and is back once the write is rolled back', async () => {
      const before = await readIdentityWatermark(db.sql, new Date(), db.schema);
      const ROLLBACK = new Error('rollback');
      let inside: Awaited<ReturnType<typeof readIdentityWatermark>> | undefined;
      await db.sql
        .begin(async (tx) => {
          await tx`INSERT INTO users (handle, email, password_hash) VALUES ('wm_user', 'wm@example.com', 'x')`;
          inside = await readIdentityWatermark(tx as unknown as typeof db.sql, new Date(), db.schema);
          throw ROLLBACK;
        })
        .catch((err: unknown) => {
          if (err !== ROLLBACK) throw err;
        });
      expect(BigInt(inside!.position)).toBeGreaterThan(BigInt(before.position));
      expect(inside!.integrity).not.toBe(before.integrity);
      expect(inside!.lastWriteAt).not.toBeNull();
      expect(Date.parse(inside!.lastWriteAt!)).toBeLessThanOrEqual(Date.now() + 1000);
      const after = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect(after.position).toBe(before.position);
      expect(after.integrity).toBe(before.integrity);
    });

    it('reads the same lastWriteAt whatever timezone the session runs in', async () => {
      await db.sql`INSERT INTO users (handle, email, password_hash) VALUES ('wm_tz', 'wmtz@example.com', 'x')`;
      const utc = await readIdentityWatermark(db.sql, new Date(), db.schema);
      const west = await db.sql.begin(async (tx) => {
        await tx`SET LOCAL timezone = 'America/New_York'`;
        return readIdentityWatermark(tx as unknown as typeof db.sql, new Date(), db.schema);
      });
      expect(west.lastWriteAt).not.toBeNull();
      expect(west.lastWriteAt).toBe(utc.lastWriteAt);
    });

    it('names only tables that exist, so a renamed table cannot drop out of the exclusions unseen', async () => {
      const tables = await db.sql<Array<{ t: string }>>`
        SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ${db.schema} AND table_type = 'BASE TABLE'`;
      const present = new Set(tables.map((r) => r.t));
      for (const name of [...Object.keys(OPERATOR_TRAFFIC_TABLES), ...APPROVAL_TABLES]) {
        expect(present.has(name), name).toBe(true);
      }
    });

    it('is unmoved by sign-in traffic, and still moves for a change to an existing record (J-ops-console-08 #7)', async () => {
      const [user] = await db.sql<Array<{ id: string }>>`
        INSERT INTO users (handle, email, password_hash, created_at, updated_at)
        VALUES ('wm_signin', 'wmsignin@example.com', 'x', now() - interval '1 hour', now() - interval '1 hour') RETURNING id`;
      await db.sql`UPDATE users SET updated_at = now() - interval '1 hour'`;
      const before = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect(before.kind).toBe(WATERMARK_KIND);
      // A failed second step at sign-in: the attempt row is traffic.
      await db.sql`INSERT INTO auth_attempts (user_id, kind, failures) VALUES (${user!.id}, 'mfa', 1)`;
      const signedIn = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect({ ...signedIn, readAt: '' }).toEqual({ ...before, readAt: '' });
      // Freezing the account changes no count, but it is a write after the cut-off and shows as one.
      await db.sql`UPDATE users SET status = 'frozen', updated_at = now() WHERE id = ${user!.id}`;
      const frozen = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect(frozen.position).toBe(before.position);
      expect(Date.parse(frozen.lastWriteAt!)).toBeGreaterThan(Date.parse(before.lastWriteAt!));
    });

    it("a sign-in's second step moves nothing: the authenticator step leaves updated_at alone", async () => {
      const tokenConfig = {
        secret: 'an-identity-restore-watermark-test-secret-long-enough',
        issuer: 'intafaced',
        audience: 'intafaced.api',
        accessTtlSeconds: 900,
        refreshTtlSeconds: 2_592_000,
      };
      const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };
      const bus = new MemoryEventBus('svc-identity');
      const auth = new AuthService(
        db.sql,
        bus,
        new RankService(db.sql, bus),
        tokenConfig,
        webauthnConfig,
        randomBytes(32).toString('base64'),
      );
      const password = { mfa: false, privileged: false } as const;
      const session = await auth.register({
        handle: 'wm_totp',
        email: 'wmtotp@example.com',
        password: 'correct horse battery staple',
        region: 'DE',
      });
      const started = await auth.startTotpEnrolment(session.userId, password);
      // Enrolled one step back, so the code below is a fresh step.
      await auth.confirmTotpEnrolment(
        session.userId,
        password,
        started.secret,
        totp(started.secret, { at: new Date(Date.now() - 30_000) }),
      );
      await db.sql`UPDATE users SET updated_at = now() - interval '1 hour' WHERE id = ${session.userId}`;
      const [was] = await db.sql<Array<{ updated_at: Date; totp_last_step: string }>>`
        SELECT updated_at, totp_last_step FROM users WHERE id = ${session.userId}`;
      await auth.proveFreshFactor({
        userId: session.userId,
        sessionId: session.sessionId,
        totpCode: totp(started.secret),
        purpose: 'signin',
      });
      const [now] = await db.sql<Array<{ updated_at: Date; totp_last_step: string }>>`
        SELECT updated_at, totp_last_step FROM users WHERE id = ${session.userId}`;
      expect(BigInt(now!.totp_last_step)).toBeGreaterThan(BigInt(was!.totp_last_step));
      expect(now!.updated_at.toISOString()).toBe(was!.updated_at.toISOString());
    });

    it("leaves out the restore's own approval requests, and counts every other approval", async () => {
      const approval = (id: string, actionType: string) => db.sql`
        INSERT INTO action_approvals (approval_id, action_type, target_service, target_id, expected_version, payload_hash,
                                      requester_id, policy_version, operation_id, status, created_at, expires_at)
        VALUES (${id}, ${actionType}, 'svc-ops', 'run-1', '1', 'h', 'founder-a', 'v1', ${id}, 'PENDING', now(), now() + interval '1 hour')`;
      const before = await readIdentityWatermark(db.sql, new Date(), db.schema);
      await approval('appr_wm_restore', 'ops.restore.record');
      const restoring = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect({ ...restoring, readAt: '' }).toEqual({ ...before, readAt: '' });
      await approval('appr_wm_freeze', 'identity.account.freeze');
      const freezing = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect(BigInt(freezing.position)).toBe(BigInt(before.position) + 1n);
      expect(freezing.integrity).not.toBe(before.integrity);
      expect(Date.parse(freezing.lastWriteAt!)).toBeGreaterThan(Date.parse(before.lastWriteAt!));
      // Revoking it changes no count and sets no time, but the per-status digest moves.
      await db.sql`UPDATE action_approvals SET status = 'REVOKED' WHERE approval_id = 'appr_wm_freeze'`;
      const revoked = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect(revoked.position).toBe(freezing.position);
      expect(revoked.integrity).not.toBe(freezing.integrity);
      // A vote cast later moves the count and lastWriteAt; a vote on the restore's own request moves neither.
      await db.sql`INSERT INTO action_approval_votes (approval_id, approver_id, approved_at) VALUES ('appr_wm_restore', 'founder-b', now() + interval '1 minute')`;
      const ownVote = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect({ ...ownVote, readAt: '' }).toEqual({ ...revoked, readAt: '' });
      await db.sql`INSERT INTO action_approval_votes (approval_id, approver_id, approved_at) VALUES ('appr_wm_freeze', 'founder-b', now() + interval '1 minute')`;
      const voted = await readIdentityWatermark(db.sql, new Date(), db.schema);
      expect(BigInt(voted.position)).toBe(BigInt(revoked.position) + 1n);
      expect(Date.parse(voted.lastWriteAt!)).toBeGreaterThan(Date.parse(revoked.lastWriteAt!));
    });
  });
}
