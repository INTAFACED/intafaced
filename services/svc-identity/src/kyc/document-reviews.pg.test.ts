import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import postgres from 'postgres';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from '../auth/auth-service.js';
import { KycDocumentStore } from './document-store.js';
import { bindProviderRefToDocument, documentReviews } from './provider-ref-bind.js';

/**
 * The review status each of one subject's documents shows on the console's document list (J-ops-console-02 #5): the
 * newest KYC record of that same subject that points at the document, read from identity's own tables.
 */

const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
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

async function harnessUrl(): Promise<string | null> {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw || !(await postgresAvailable(raw))) return null;
  const name = new URL(raw).pathname.replace(/^\//, '').split('/')[0] ?? '';
  let target = raw;
  if (!name.endsWith('_test')) {
    const admin = postgres(raw, { max: 1, onnotice: () => undefined });
    try {
      await admin.unsafe('CREATE DATABASE identbe_docreviews_test');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) throw err;
    } finally {
      await admin.end({ timeout: 5 });
    }
    const url = new URL(raw);
    url.pathname = '/identbe_docreviews_test';
    target = url.toString();
  }
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
  describe.skip('KYC document review status (Postgres unavailable)', () => {
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
  const keyMaterial = randomBytes(32).toString('base64');
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, webauthnConfig, keyMaterial, undefined, undefined, 25);
  const vault = new KycDocumentStore(db.sql, randomBytes(32).toString('base64'));
  let counter = 0;

  const register = async () => {
    const handle = `dr${process.pid}x${++counter}`;
    return (await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple' })).userId;
  };
  const doc = (userId: string) => vault.put({ userId, contentType: 'image/png', bytes: Buffer.from('TEST scan'), storedBy: 'op' });
  /** A settled record pointing at `documentId`, written directly: approve and reject are covered by their own tests. */
  const settled = async (userId: string, documentId: string, status: 'approved' | 'rejected', expiresAt: Date | null) => {
    const rows = await db.sql<Array<{ id: string }>>`
      INSERT INTO kyc_records (user_id, tier, jurisdiction, provider_ref, status, reviewed_by, reviewed_at, expires_at)
      VALUES (${userId}, 'basic', 'DE', ${documentId}, ${status}, 'op', now(), ${expiresAt})
      RETURNING id
    `;
    return rows[0]!.id;
  };

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('KYC document review status', () => {
    it('a bound document shows its record pending; an unbound one is absent', async () => {
      const user = await register();
      const bound = await doc(user);
      const loose = await doc(user);
      const record = await auth.submitKyc({ userId: user, tier: 'full', jurisdiction: 'DE' });
      await bindProviderRefToDocument(db.sql, vault, { recordId: record.id, documentId: bound.id, operatorId: 'op' });

      const reviews = await documentReviews(db.sql, user, [bound.id, loose.id]);
      expect(reviews.get(bound.id)).toEqual({ recordId: record.id, tier: 'full', status: 'pending' });
      expect(reviews.has(loose.id)).toBe(false);
      expect(await documentReviews(db.sql, user, [])).toEqual(new Map());
    });

    it('the newest record wins, and an approval past its expiry reads expired', async () => {
      const user = await register();
      const scan = await doc(user);
      await settled(user, scan.id, 'rejected', null);
      const newer = await settled(user, scan.id, 'approved', new Date(Date.now() - 60_000));
      expect((await documentReviews(db.sql, user, [scan.id])).get(scan.id)).toEqual({ recordId: newer, tier: 'basic', status: 'expired' });

      const live = await settled(user, scan.id, 'approved', new Date(Date.now() + 86_400_000));
      expect((await documentReviews(db.sql, user, [scan.id])).get(scan.id)?.status).toBe('approved');
      expect((await documentReviews(db.sql, user, [scan.id])).get(scan.id)?.recordId).toBe(live);
    });

    it('a record of another subject pointing at the document does not count', async () => {
      const owner = await register();
      const other = await register();
      const scan = await doc(owner);
      await settled(other, scan.id, 'approved', null);
      expect((await documentReviews(db.sql, owner, [scan.id])).has(scan.id)).toBe(false);
    });
  });
}
