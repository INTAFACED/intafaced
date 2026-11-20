/**
 * AC-certificates-03: certificate designs and the issued list, against Postgres. Activation refuses a design with no
 * signatory or a blank disclaimer, each by its own code; an issued certificate keeps the revision it was issued under;
 * the issued counts and the stored export agree, and a blank owner row limit refuses.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AcademyService } from '../academy-service.js';
import { NullStreamProvider } from '../stream/provider.js';
import { FOUNDATIONS_V1 } from './catalog.js';
import { expectRefusal } from '@intafaced/service-kit/testing';

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
const LEARNER_B = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-10-24T12:00:00.000Z');

function service(options: { certIssuedRows?: number } = { certIssuedRows: 50 }) {
  return new AcademyService(
    sql,
    { stakeOf: async () => 0n },
    {
      async perksOf() {
        throw new Error('host rights unused');
      },
    },
    new NullStreamProvider(),
    { tournamentEnabled: false, paperTradingEnabled: false, ...options },
  );
}

async function issued(academy: AcademyService, userId = USER): Promise<string> {
  await academy.enrollCertPath({ userId, pathSlug: 'foundations' });
  for (const itemSlug of FOUNDATIONS_V1.requiredItemSlugs) await academy.markCurriculumComplete({ userId, itemSlug, now: T0 });
  return (await academy.grantCert({ userId, certId: CERT })).grant.publicId;
}

const DRAFT = {
  certId: CERT,
  title: 'TEST Foundations',
  body: 'TEST completed every Foundations lesson.',
  signatories: [] as Array<{ name: string; role: string }>,
  disclaimer: null as string | null,
  language: 'en',
  size: 'a4' as const,
  effortHours: '12.5',
  reason: 'TEST draft',
};
const save = (academy: AcademyService, revision: number, patch: Partial<typeof DRAFT> = {}) =>
  academy.certDesigns.save({ ...DRAFT, ...patch, revision, operatorId: OPERATOR, now: T0 });
const activate = (academy: AcademyService, revision: number) =>
  academy.certDesigns.activate({ certId: CERT, revision, reason: 'TEST activate', operatorId: OPERATOR, now: T0 });

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

describe('certificate designs', () => {
  it('refuses to activate with no signatory, then with a blank disclaimer, each by its own code, and writes nothing', async () => {
    const academy = service();
    const first = await save(academy, 0);
    expect(first.design.design?.current.revision).toBe(1);
    await expectRefusal(activate(academy, 1), 'academy.cert_signatory_missing');
    await save(academy, 1, { signatories: [{ name: 'TEST Signer', role: 'TEST Director' }], disclaimer: '   ' });
    await expectRefusal(activate(academy, 2), 'academy.cert_disclaimer_unset');
    expect((await academy.certDesigns.design(CERT)).design?.activeRevision).toBeNull();
    await save(academy, 2, { signatories: [{ name: 'TEST Signer', role: 'TEST Director' }], disclaimer: 'TEST disclaimer' });
    const active = await activate(academy, 3);
    expect(active.design?.activeRevision).toBe(3);
    // A repeat activation answers the design unchanged.
    expect((await activate(academy, 3)).design?.activatedAt).toBe(active.design?.activatedAt);
  });

  it('answers a replayed save with the revision it made, and refuses a save over an older revision', async () => {
    const academy = service();
    await save(academy, 0);
    const replay = await save(academy, 0);
    expect(replay.design.design?.current.revision).toBe(1);
    await save(academy, 1, { title: 'TEST Foundations two' });
    await expectRefusal(save(academy, 1, { title: 'TEST Foundations three' }), 'academy.cert_design_stale');
  });

  it('keeps an issued certificate on the revision it was issued under, and warns when an active design with issued ones is edited', async () => {
    const academy = service();
    const signed = { signatories: [{ name: 'TEST Signer', role: 'TEST Director' }], disclaimer: 'TEST disclaimer' };
    await save(academy, 0, signed);
    await activate(academy, 1);
    const publicId = await issued(academy);
    // An active design may not be edited into one that could not be activated.
    await expectRefusal(save(academy, 1, { ...signed, disclaimer: '' }), 'academy.cert_disclaimer_unset');
    const edited = await save(academy, 1, { ...signed, title: 'TEST Foundations, new wording' });
    expect(edited.warning).toEqual({ issuedKeepingEarlier: 1, activeRevision: 2 });
    expect(edited.design.design?.activeRevision).toBe(2);
    const [mine] = await academy.myCertGrants(USER, 10);
    expect(mine!.publicId).toBe(publicId);
    expect(mine!.design).toMatchObject({ revision: 1, title: 'TEST Foundations', signatories: signed.signatories });
    await issued(academy, LEARNER_B);
    const [theirs] = await academy.myCertGrants(LEARNER_B, 10);
    expect(theirs!.design).toMatchObject({ revision: 2, title: 'TEST Foundations, new wording' });
  });

  it('after deactivation issues with no design, and the certificate issued before keeps its revision', async () => {
    const academy = service();
    await save(academy, 0, { signatories: [{ name: 'TEST Signer', role: 'TEST Director' }], disclaimer: 'TEST disclaimer' });
    await activate(academy, 1);
    await issued(academy);
    const off = await academy.certDesigns.deactivate({ certId: CERT, reason: 'TEST off', operatorId: OPERATOR, now: T0 });
    expect(off.design?.activeRevision).toBeNull();
    await issued(academy, LEARNER_B);
    expect((await academy.myCertGrants(USER, 10))[0]!.design?.revision).toBe(1);
    expect((await academy.myCertGrants(LEARNER_B, 10))[0]!.design).toBeNull();
  });

  it('issues with no design when none is active', async () => {
    const academy = service();
    await save(academy, 0);
    await issued(academy);
    const [mine] = await academy.myCertGrants(USER, 10);
    expect(mine!.design).toBeNull();
  });
});

describe('issued certificates list and export', () => {
  it('shows zero counts and no rows when none is issued', async () => {
    const academy = service();
    expect(await academy.certDesigns.issued(null)).toEqual({ counts: [], total: 0, items: [] });
  });

  it('refuses the list and an export while the owner row limit is blank', async () => {
    const academy = service({});
    await expectRefusal(academy.certDesigns.issued(null), 'academy.report_limit_unset');
    await expectRefusal(academy.certDesigns.makeExport({ n: 1, operatorId: OPERATOR, now: T0 }), 'academy.report_limit_unset');
  });

  it('counts by certificate and status, and the stored export holds the same rows', async () => {
    const academy = service();
    const a = await issued(academy);
    await issued(academy, LEARNER_B);
    await sql`UPDATE academy.cert_grants SET status = 'revoked' WHERE public_id = ${a}`;
    const list = await academy.certDesigns.issued(null);
    expect(list.counts).toEqual([{ certId: CERT, valid: 1, revoked: 1 }]);
    expect(list.total).toBe(2);
    expect(list.items).toHaveLength(2);
    const made = await academy.certDesigns.makeExport({ n: 1, operatorId: OPERATOR, now: T0 });
    expect(made.rows).toBe(2);
    const file = await academy.certDesigns.exportFile(1);
    const lines = file.csv.trim().split('\r\n').slice(2);
    expect(lines.filter((l) => l.includes(',revoked,'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes(',valid,'))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith(`${a},`))).toBe(true);
    // A retry of export 1 answers the stored one; a number past the next refuses.
    expect((await academy.certDesigns.makeExport({ n: 1, operatorId: OPERATOR, now: new Date() })).sha256).toBe(made.sha256);
    await expectRefusal(academy.certDesigns.makeExport({ n: 3, operatorId: OPERATOR, now: T0 }), 'academy.report_out_of_order');
  });

  it('refuses an export of a list longer than one export may hold, rather than cut it', async () => {
    const academy = service({ certIssuedRows: 1 });
    await issued(academy);
    await issued(academy, LEARNER_B);
    await expectRefusal(academy.certDesigns.makeExport({ n: 1, operatorId: OPERATOR, now: T0 }), 'academy.report_too_large');
    expect((await academy.certDesigns.exports()).exports).toEqual([]);
  });
});
