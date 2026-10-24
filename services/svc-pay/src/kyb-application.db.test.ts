import { truncatePayForTest } from './payment-events-test-reset.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { beforeEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KybApplicationService, readKybApplicationDueDays, requiredSectionsFor } from './kyb-application.js';
import { KybEntityTypeService } from './kyb-entity-types.js';
import { createKybPspRouter } from './kyb-router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { KybService } from './kyb-service.js';
import { PspModeService } from './psp-mode.js';

/**
 * KYB application: sections, draft, save and resume, submit (I-kyc-compliance-21).
 * Postgres required, like the other KYB suites: TEST_DATABASE_URL, or a Testcontainers postgres:16-alpine. No skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const IMAGE = 'postgres:16-alpine';
const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const OWNER = '66666666-6666-4666-8666-666666666666';
const STRANGER = '88888888-8888-4888-8888-888888888888';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(IMAGE)
      .withDatabase('intafaced_kyb_app_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `KYB applications are PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start ${IMAGE}: ${msg}`,
    );
  }
}

async function ctx(userId: string, scopes: string[] = ['pay:onboard']): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId, sessionId: '77777777-7777-4777-8777-777777777777', scopes, tier: 'full', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'kyb-application' };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection, but the call resolved');
}

describe('requiredSectionsFor', () => {
  it('always asks for company details and only the other sections the type calls for', () => {
    expect(requiredSectionsFor({ documentKeys: [], peopleRoles: [], questionnaireKeys: ['q'] })).toEqual([
      'company_details',
      'questionnaires',
    ]);
    expect(requiredSectionsFor({ documentKeys: ['d'], peopleRoles: ['grantor'], questionnaireKeys: [] })).toEqual([
      'company_details',
      'people',
      'documents',
    ]);
  });
});

describe('readKybApplicationDueDays', () => {
  it('is null while unpublished, a whole number of days when set, and refuses to boot on anything else', () => {
    expect(readKybApplicationDueDays({})).toBeNull();
    expect(readKybApplicationDueDays({ PAY_KYB_APPLICATION_DUE_DAYS: '  ' })).toBeNull();
    expect(readKybApplicationDueDays({ PAY_KYB_APPLICATION_DUE_DAYS: ' 30 ' })).toBe(30);
    for (const bad of ['0', '-1', '1.5', '366', '30d', '030'])
      expect(() => readKybApplicationDueDays({ PAY_KYB_APPLICATION_DUE_DAYS: bad }), bad).toThrow(/1 to 365/);
  });
});

describe('kyb application', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let merchantId: string;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.kyb_application_events, pay.kyb_application_sections, pay.kyb_applications, pay.kyb_entity_types, pay.merchant_kyb_events, pay.merchant_status_events, pay.merchants RESTART IDENTITY CASCADE`,
    );
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id, mode, status, pricing) VALUES (${OWNER}, 'psp', 'active', ${sql.json({ feeBps: 250 } as never)}) RETURNING id
    `;
    if (!row) throw new Error('no merchant');
    merchantId = row.id;
    await sql`
      INSERT INTO pay.kyb_entity_types (entity_type, document_keys, people_roles, questionnaire_keys, countries)
      VALUES ('trust', ${['trust_deed']}, ${['grantor', 'trustee']}, ${[]}, ${['DE']}),
             ('fund', ${[]}, ${[]}, ${['fund_questionnaire']}, ${['DE']})
    `;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const api = async (userId = OWNER, scopes?: string[], dueDays: number | null = null) => {
    const kyb = new KybService(sql);
    const types = new KybEntityTypeService(sql);
    return createKybPspRouter(
      kyb,
      new PspModeService(sql),
      stubApprovalConsumer('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      {
        getMerchant: async (id) =>
          (await sql<Array<{ user_id: string }>>`SELECT user_id FROM pay.merchants WHERE id = ${id}`).map((r) => ({
            userId: r.user_id,
          }))[0] ?? Promise.reject(new Error('missing')),
      },
      types,
      new KybApplicationService(sql, kyb, types, dueDays),
    ).createCaller(await ctx(userId, scopes));
  };

  /** An upload row as kyb-documents.ts writes it (the bytes do not matter here, only which key has a current upload). */
  const upload = async (applicationId: string, key: string, state: 'provided' | 'accepted' | 'rejected' = 'provided') => {
    await sql`
      INSERT INTO pay.kyb_documents (application_id, document_key, content_type, byte_length, sha256, ciphertext, nonce, state, rejection_reason, uploaded_by)
      VALUES (${applicationId}, ${key}, 'application/pdf', 4, ${'a'.repeat(64)}, ${Buffer.from('test')}, ${Buffer.alloc(12)}, ${state},
              ${state === 'rejected' ? 'TEST unreadable scan' : null}, ${OWNER})
    `;
  };
  const complete = (applicationId: string, section: 'company_details' | 'people' | 'documents', expectedVersion = 0) => ({
    applicationId,
    section,
    expectedVersion,
    complete: true,
    data: section === 'people' ? { person_1_role: 'trustee', person_1_name: 'TEST Trustee' } : { legal_name: 'TEST Trust' },
  });

  it('changing the type clears the sections, asks what the new type needs, and records the change; the same type again changes nothing', async () => {
    const caller = await api();
    const trust = await caller.kyb.application.start({ merchantId, entityType: 'trust', country: 'DE' });
    await caller.kyb.application.saveSection(complete(trust.applicationId, 'company_details'));
    const fund = await caller.kyb.application.changeType({ applicationId: trust.applicationId, entityType: 'fund', country: 'de' });
    expect(fund).toMatchObject({ applicationId: trust.applicationId, entityType: 'fund', country: 'DE', state: 'draft' });
    expect(fund.missing).toEqual(['company_details', 'questionnaires']);
    expect(fund.sections.every((section) => section.state === 'empty' && section.version === 0)).toBe(true);
    expect(fund.sections.filter((section) => section.required).map((section) => section.section)).toEqual([
      'company_details',
      'questionnaires',
    ]);

    const same = await caller.kyb.application.changeType({ applicationId: trust.applicationId, entityType: 'fund', country: 'DE' });
    expect(same).toEqual(fund);
    const events = await sql<Array<{ kind: string; entity_type: string | null; country: string | null }>>`
      SELECT kind, entity_type, country FROM pay.kyb_application_events WHERE application_id = ${trust.applicationId} ORDER BY seq`;
    expect(events).toEqual([
      { kind: 'started', entity_type: null, country: null },
      { kind: 'section_saved', entity_type: null, country: null },
      { kind: 'type_changed', entity_type: 'fund', country: 'DE' },
    ]);
    await expect(
      sql`INSERT INTO pay.kyb_application_events (application_id, kind, actor_id) VALUES (${trust.applicationId}, 'type_changed', ${OWNER})`,
    ).rejects.toThrow(/type_change_named/);
  });

  it('a type change refuses an unpublished type, an unserved country, a submitted application and a stranger', async () => {
    const caller = await api();
    const { applicationId } = await caller.kyb.application.start({ merchantId, entityType: 'fund', country: 'DE' });
    expect(await rejection(caller.kyb.application.changeType({ applicationId, entityType: 'partnership', country: 'DE' }))).toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(await rejection(caller.kyb.application.changeType({ applicationId, entityType: 'trust', country: 'FR' }))).toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(
      await rejection((await api(STRANGER)).kyb.application.changeType({ applicationId, entityType: 'trust', country: 'DE' })),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect((await caller.kyb.application.current({ merchantId }))?.entityType).toBe('fund');

    await caller.kyb.application.saveSection(complete(applicationId, 'company_details'));
    await caller.kyb.application.saveSection({
      applicationId,
      section: 'questionnaires',
      expectedVersion: 0,
      complete: true,
      data: { a: 'b' },
    });
    await caller.kyb.application.submit({ applicationId });
    expect(await rejection(caller.kyb.application.changeType({ applicationId, entityType: 'trust', country: 'DE' }))).toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('documents count only once uploaded and not rejected, and a restart or type change asks for them again', async () => {
    const caller = await api();
    const { applicationId } = await caller.kyb.application.start({ merchantId, entityType: 'trust', country: 'DE' });
    await caller.kyb.application.saveSection(complete(applicationId, 'company_details'));
    await caller.kyb.application.saveSection(complete(applicationId, 'people'));

    const none = await rejection(caller.kyb.application.saveSection(complete(applicationId, 'documents')));
    expect(none).toMatchObject({ code: 'PRECONDITION_FAILED', cause: expect.objectContaining({ code: 'pay.kyb_documents_missing' }) });
    await upload(applicationId, 'trust_deed', 'rejected');
    expect(await rejection(caller.kyb.application.saveSection(complete(applicationId, 'documents')))).toMatchObject({
      cause: expect.objectContaining({ code: 'pay.kyb_documents_missing', detail: { missing: ['trust_deed'] } }),
    });
    await upload(applicationId, 'trust_deed');
    const saved = await caller.kyb.application.saveSection(complete(applicationId, 'documents'));
    expect(saved.missing).toEqual([]);

    // A rejection after the section was marked complete still stops the submit.
    await upload(applicationId, 'trust_deed', 'rejected');
    expect(await rejection(caller.kyb.application.submit({ applicationId }))).toMatchObject({
      cause: expect.objectContaining({ code: 'pay.kyb_documents_missing' }),
    });
    const [still] = await sql<Array<{ kyb_status: string }>>`SELECT kyb_status FROM pay.merchants WHERE id = ${merchantId}`;
    expect(still?.kyb_status).toBe('none');
    await upload(applicationId, 'trust_deed');

    await caller.kyb.application.restart({ applicationId, confirm: true });
    await caller.kyb.application.saveSection(complete(applicationId, 'company_details'));
    await caller.kyb.application.saveSection(complete(applicationId, 'people'));
    expect(await rejection(caller.kyb.application.saveSection(complete(applicationId, 'documents')))).toMatchObject({
      cause: expect.objectContaining({ code: 'pay.kyb_documents_missing' }),
    });
    await upload(applicationId, 'trust_deed');
    await caller.kyb.application.saveSection(complete(applicationId, 'documents'));
    const submitted = await caller.kyb.application.submit({ applicationId });
    expect(submitted.state).toBe('submitted');
  });

  it('shows the due date the owner publishes from the start of the application, and none while unpublished', async () => {
    const started = await (await api()).kyb.application.start({ merchantId, entityType: 'fund', country: 'DE' });
    expect(started.dueAt).toBeNull();
    const withDue = await (await api(OWNER, undefined, 30)).kyb.application.current({ merchantId });
    expect(withDue?.startedAt).toBe(started.startedAt);
    expect(Date.parse(withDue!.dueAt!) - Date.parse(started.startedAt)).toBe(30 * 86_400_000);
    // A type change does not move the due date.
    const changed = await (
      await api(OWNER, undefined, 30)
    ).kyb.application.changeType({
      applicationId: started.applicationId,
      entityType: 'trust',
      country: 'DE',
    });
    expect(changed.dueAt).toBe(withDue?.dueAt);
  });

  it('a trust application needs company details, people and documents; progress persists across a leave and return', async () => {
    const caller = await api();
    const started = await caller.kyb.application.start({ merchantId, entityType: 'trust', country: 'de' });
    expect(started.state).toBe('draft');
    expect(started.missing).toEqual(['company_details', 'people', 'documents']);

    const saved = await caller.kyb.application.saveSection({
      applicationId: started.applicationId,
      section: 'company_details',
      expectedVersion: 0,
      complete: false,
      data: { legal_name: 'Acme Trust' },
    });
    expect(saved.sections.find((s) => s.section === 'company_details')).toMatchObject({ state: 'draft', version: 1, required: true });

    const resumed = await (await api()).kyb.application.current({ merchantId });
    expect(resumed?.applicationId).toBe(started.applicationId);
    expect(resumed?.sections.find((s) => s.section === 'company_details')?.data).toEqual({ legal_name: 'Acme Trust' });
  });

  it('starting again with the same type returns the same draft; another type is a conflict', async () => {
    const caller = await api();
    const first = await caller.kyb.application.start({ merchantId, entityType: 'trust', country: 'DE' });
    const again = await caller.kyb.application.start({ merchantId, entityType: 'trust', country: 'DE' });
    expect(again.applicationId).toBe(first.applicationId);
    expect(await rejection(caller.kyb.application.start({ merchantId, entityType: 'fund', country: 'DE' }))).toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('an unpublished type or an unserved country cannot start', async () => {
    const caller = await api();
    expect(await rejection(caller.kyb.application.start({ merchantId, entityType: 'partnership', country: 'DE' }))).toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(await rejection(caller.kyb.application.start({ merchantId, entityType: 'trust', country: 'FR' }))).toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await caller.kyb.application.current({ merchantId })).toBeNull();
  });

  it('a save replayed after it landed is a no-op; a stale version is a conflict', async () => {
    const caller = await api();
    const { applicationId } = await caller.kyb.application.start({ merchantId, entityType: 'fund', country: 'DE' });
    const body = {
      applicationId,
      section: 'company_details' as const,
      expectedVersion: 0,
      complete: true,
      data: { legal_name: 'Fund One' },
    };
    const one = await caller.kyb.application.saveSection(body);
    const replay = await caller.kyb.application.saveSection(body);
    expect(replay.sections.find((s) => s.section === 'company_details')?.version).toBe(1);
    expect(replay.sections).toEqual(one.sections);
    expect(await rejection(caller.kyb.application.saveSection({ ...body, data: { legal_name: 'Changed' } }))).toMatchObject({
      code: 'CONFLICT',
    });
    const events = await sql<
      Array<{ kind: string }>
    >`SELECT kind FROM pay.kyb_application_events WHERE application_id = ${applicationId} ORDER BY seq`;
    expect(events.map((e) => e.kind)).toEqual(['started', 'section_saved']);
  });

  it('submit with a missing section names it; submit when complete moves KYB to pending and freezes the application', async () => {
    const caller = await api();
    const { applicationId } = await caller.kyb.application.start({ merchantId, entityType: 'fund', country: 'DE' });
    await caller.kyb.application.saveSection({
      applicationId,
      section: 'company_details',
      expectedVersion: 0,
      complete: true,
      data: { legal_name: 'Fund One' },
    });

    const incomplete = await rejection(caller.kyb.application.submit({ applicationId }));
    expect(incomplete).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((incomplete as { message: string }).message).toContain('questionnaires');
    const [still] = await sql<Array<{ kyb_status: string }>>`SELECT kyb_status FROM pay.merchants WHERE id = ${merchantId}`;
    expect(still?.kyb_status).toBe('none');

    await caller.kyb.application.saveSection({
      applicationId,
      section: 'questionnaires',
      expectedVersion: 0,
      complete: true,
      data: { aml_programme: true },
    });
    const submitted = await caller.kyb.application.submit({ applicationId });
    expect(submitted).toMatchObject({ state: 'submitted', missing: [], kybRef: `application:${applicationId}` });
    const [after] = await sql<
      Array<{ kyb_status: string; kyb_ref: string }>
    >`SELECT kyb_status, kyb_ref FROM pay.merchants WHERE id = ${merchantId}`;
    expect(after).toMatchObject({ kyb_status: 'pending', kyb_ref: `application:${applicationId}` });

    expect(
      await rejection(
        caller.kyb.application.saveSection({ applicationId, section: 'company_details', expectedVersion: 1, complete: true, data: {} }),
      ),
    ).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await rejection(caller.kyb.application.restart({ applicationId, confirm: true }))).toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(await rejection(caller.kyb.application.start({ merchantId, entityType: 'fund', country: 'DE' }))).toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('restart clears the sections, keeps the history and restarts versions at zero', async () => {
    const caller = await api();
    const { applicationId } = await caller.kyb.application.start({ merchantId, entityType: 'fund', country: 'DE' });
    await caller.kyb.application.saveSection({
      applicationId,
      section: 'company_details',
      expectedVersion: 0,
      complete: true,
      data: { legal_name: 'Fund One' },
    });
    const cleared = await caller.kyb.application.restart({ applicationId, confirm: true });
    expect(cleared.sections.every((s) => s.state === 'empty' && s.version === 0)).toBe(true);
    const kinds = await sql<
      Array<{ kind: string }>
    >`SELECT kind FROM pay.kyb_application_events WHERE application_id = ${applicationId} ORDER BY seq`;
    expect(kinds.map((e) => e.kind)).toEqual(['started', 'section_saved', 'restarted']);
    expect(
      await rejection(
        caller.kyb.application.saveSection({ applicationId, section: 'company_details', expectedVersion: 1, complete: true, data: {} }),
      ),
    ).toMatchObject({ code: 'CONFLICT' });
  });

  it("another user cannot see, save, restart or submit someone else's application, and the refusal matches an unknown id", async () => {
    const owner = await api();
    const { applicationId } = await owner.kyb.application.start({ merchantId, entityType: 'fund', country: 'DE' });
    const stranger = await api(STRANGER);
    const ghost = '99999999-9999-4999-8999-999999999999';
    for (const id of [applicationId, ghost]) {
      expect(
        await rejection(
          stranger.kyb.application.saveSection({ applicationId: id, section: 'people', expectedVersion: 0, complete: false, data: {} }),
        ),
      ).toMatchObject({ code: 'NOT_FOUND' });
      expect(await rejection(stranger.kyb.application.restart({ applicationId: id, confirm: true }))).toMatchObject({ code: 'NOT_FOUND' });
      expect(await rejection(stranger.kyb.application.submit({ applicationId: id }))).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(await rejection(stranger.kyb.application.current({ merchantId }))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await rejection(stranger.kyb.application.start({ merchantId, entityType: 'fund', country: 'DE' }))).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('is behind pay:onboard', async () => {
    const caller = await api(OWNER, ['pay:read']);
    expect(await rejection(caller.kyb.application.current({ merchantId }))).toMatchObject({ code: 'FORBIDDEN' });
  });
});
