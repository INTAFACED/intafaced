/**
 * AC-certificates-02 (J-academy-17 #5): issuing one learner a certificate as an exception, against Postgres. The learner
 * holds it without every required item; one record names both people, the operator and the reason; the issued list and
 * the grant audit show the reason; a repeat writes nothing; a held or revoked certificate refuses before anything is written.
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
const PROPOSER = '66666666-6666-4666-8666-666666666666';
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

const except = (academy: AcademyService, reason = 'TEST a learner who finished elsewhere') =>
  academy.grantCertException({
    userId: USER,
    certId: CERT,
    reason,
    proposedBy: PROPOSER,
    approvedBy: APPROVER,
    operatorId: OPERATOR,
    now: T0,
  });

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

describe('certificate exception', () => {
  it('issues the certificate to a learner who has not completed every item, with the reason recorded once', async () => {
    const academy = service();
    await academy.enrollCertPath({ userId: USER, pathSlug: 'foundations' });
    await academy.markCurriculumComplete({ userId: USER, itemSlug: FOUNDATIONS_V1.requiredItemSlugs[0]!, now: T0 });
    expect(await academy.certException(USER, CERT)).toBeNull();
    const first = await except(academy);
    expect(first).toMatchObject({
      userId: USER,
      certId: CERT,
      proposedBy: PROPOSER,
      approvedBy: APPROVER,
      grantedBy: OPERATOR,
      reason: 'TEST a learner who finished elsewhere',
    });
    expect((await academy.certVerify(first.publicId)).status).toBe('valid');
    const mine = await academy.myCertGrants(USER, 10);
    expect(mine.map((g) => g.publicId)).toEqual([first.publicId]);
    // A repeat answers with the first record and writes nothing more.
    expect(await except(academy, 'TEST a different reason')).toEqual(first);
    const rows = await sql`SELECT count(*)::int AS n FROM academy.cert_exceptions`;
    expect(rows[0]!.n).toBe(1);
    // The grant audit's issue line carries who and why.
    const audit = await academy.grantAudit({ limit: 10, certificate: CERT });
    expect(audit.items).toEqual([
      expect.objectContaining({
        kind: 'certificate_granted',
        accountId: USER,
        source: 'exception',
        actorId: OPERATOR,
        reason: first.reason,
      }),
    ]);
  });

  it('refuses a learner who already holds the certificate, and one whose certificate was revoked, before writing', async () => {
    const academy = service();
    await academy.enrollCertPath({ userId: USER, pathSlug: 'foundations' });
    for (const itemSlug of FOUNDATIONS_V1.requiredItemSlugs) await academy.markCurriculumComplete({ userId: USER, itemSlug, now: T0 });
    const held = (await academy.grantCert({ userId: USER, certId: CERT })).grant.publicId;
    await expect(academy.certException(USER, CERT)).rejects.toMatchObject({ code: 'academy.cert_already_granted' });
    await expect(except(academy)).rejects.toMatchObject({ code: 'academy.cert_already_granted' });
    await academy.revokeCert({
      publicId: held,
      reason: 'TEST revoked',
      proposedBy: PROPOSER,
      approvedBy: APPROVER,
      operatorId: OPERATOR,
      now: T0,
    });
    await expect(except(academy)).rejects.toMatchObject({ code: 'academy.cert_revoked' });
    const rows = await sql`SELECT count(*)::int AS n FROM academy.cert_exceptions`;
    expect(rows[0]!.n).toBe(0);
  });

  it('refuses an unpublished certificate and a blank reason', async () => {
    const academy = service();
    await expect(academy.certException(USER, 'no-such-cert')).rejects.toMatchObject({ code: 'academy.cert_not_found' });
    await expect(except(academy, '   ')).rejects.toMatchObject({ code: 'academy.cert_invalid' });
  });
});
