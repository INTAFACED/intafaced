/**
 * AC-certificates-03: revoking an issued certificate against Postgres. The public check says revoked, one record names
 * both people, the reason and the time, a repeat writes nothing, and a revoked certificate is never issued again.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AcademyService } from '../academy-service.js';
import { NullStreamProvider } from '../stream/provider.js';
import { FOUNDATIONS_V1 } from './catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const db: TestDatabase = await createTestDatabase({ service: 'academy', url: adminUrl(), migrations: MIGRATIONS });
const sql = db.sql;
const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '44444444-4444-4444-8444-444444444444';
const CERT = FOUNDATIONS_V1.id;
const APPROVER = '55555555-5555-4555-8555-555555555555';
const T0 = new Date('2026-10-24T12:00:00.000Z');

function service() {
  return new AcademyService(
    sql,
    { stakeOf: async () => 0n },
    {
      async perksOf() {
        throw new Error('host rights unused');
      },
    },
    new NullStreamProvider(),
    { tournamentEnabled: false, paperTradingEnabled: false },
  );
}

async function issued(academy: AcademyService): Promise<string> {
  await academy.enrollCertPath({ userId: USER, pathSlug: 'foundations' });
  for (const itemSlug of FOUNDATIONS_V1.requiredItemSlugs) await academy.markCurriculumComplete({ userId: USER, itemSlug, now: T0 });
  return (await academy.grantCert({ userId: USER, certId: CERT })).grant.publicId;
}

const revoke = (academy: AcademyService, publicId: string, reason = 'TEST revoked in error') =>
  academy.revokeCert({ publicId, reason, operatorId: OPERATOR, approverId: APPROVER, now: T0 });

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

describe('certificate revocation', () => {
  it('turns the public check to revoked and records both people, the reason and the time once', async () => {
    const academy = service();
    const publicId = await issued(academy);
    expect((await academy.certVerify(publicId)).status).toBe('valid');
    const first = await revoke(academy, publicId);
    expect(first).toEqual({
      publicId,
      certId: CERT,
      revokedBy: OPERATOR,
      approvedBy: APPROVER,
      reason: 'TEST revoked in error',
      revokedAt: T0,
    });
    expect((await academy.certVerify(publicId)).status).toBe('revoked');
    // A repeat (a lost reply, a second click) answers with the first record and writes nothing.
    expect(await revoke(academy, publicId, 'TEST another reason')).toEqual(first);
    expect(await sql`SELECT 1 FROM academy.cert_revocations`).toHaveLength(1);
  });

  it('a revoked certificate cannot be claimed again', async () => {
    const academy = service();
    const publicId = await issued(academy);
    await revoke(academy, publicId);
    const again = await academy.grantCert({ userId: USER, certId: CERT });
    expect(again.alreadyGranted).toBe(true);
    expect((await academy.certVerify(publicId)).status).toBe('revoked');
  });

  it('refuses an unknown or malformed code and a blank reason, writing nothing', async () => {
    const academy = service();
    const publicId = await issued(academy);
    await expect(revoke(academy, '0'.repeat(32))).rejects.toMatchObject({ code: 'academy.cert_not_found' });
    await expect(revoke(academy, 'not-a-code')).rejects.toMatchObject({ code: 'academy.cert_not_found' });
    await expect(revoke(academy, publicId, '   ')).rejects.toMatchObject({ code: 'academy.cert_invalid' });
    expect(await sql`SELECT 1 FROM academy.cert_revocations`).toHaveLength(0);
    expect((await academy.certVerify(publicId)).status).toBe('valid');
  });
});
