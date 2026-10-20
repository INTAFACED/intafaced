import { truncatePayForTest } from './payment-events-test-reset.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { beforeEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KybEntityTypeService } from './kyb-entity-types.js';
import { createKybPspRouter } from './kyb-router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { KybError, KybService } from './kyb-service.js';
import { PspModeService } from './psp-mode.js';

/**
 * KYB entity types and requirements (I-kyc-compliance-20). Postgres required, like the other KYB suites:
 * TEST_DATABASE_URL, or a Testcontainers postgres:16-alpine. No skip.
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

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(IMAGE)
      .withDatabase('intafaced_kyb_types_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `KYB entity types are PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start ${IMAGE}: ${msg}`,
    );
  }
}

async function ctx(scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId: '66666666-6666-4666-8666-666666666666', sessionId: '77777777-7777-4777-8777-777777777777', scopes, tier: 'full', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'kyb-entity-types' };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection, but the call resolved');
}

describe('kyb entity types and requirements', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let service: KybEntityTypeService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await truncatePayForTest(sql, 'pay', `TRUNCATE pay.kyb_entity_types`);
    service = new KybEntityTypeService(sql);
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function publish(
    entityType: string,
    over: { documents?: string[]; roles?: string[]; questionnaires?: string[]; countries?: string[] } = {},
  ) {
    await sql`
      INSERT INTO pay.kyb_entity_types (entity_type, document_keys, people_roles, questionnaire_keys, countries)
      VALUES (${entityType}, ${over.documents ?? []}, ${over.roles ?? []}, ${over.questionnaires ?? []}, ${over.countries ?? ['DE']})
    `;
  }

  const api = async (scopes: string[]) =>
    createKybPspRouter(
      new KybService(sql),
      new PspModeService(sql),
      stubApprovalConsumer('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      undefined,
      service,
    ).createCaller(await ctx(scopes));

  it('offers nothing while the owner has published nothing', async () => {
    expect(await service.list()).toEqual([]);
    expect(await (await api(['pay:onboard'])).kyb.entityTypes.read()).toEqual({ entityTypes: [] });
  });

  it('a trust requires grantor, trustee and beneficiary', async () => {
    await publish('trust', { roles: ['grantor', 'trustee', 'beneficiary'], documents: ['trust_deed'] });
    const view = await (await api(['pay:onboard'])).kyb.requirements.read({ entityType: 'trust', country: 'DE' });
    expect(view).toEqual({
      entityType: 'trust',
      country: 'DE',
      documentKeys: ['trust_deed'],
      peopleRoles: ['grantor', 'trustee', 'beneficiary'],
      questionnaireKeys: [],
    });
  });

  it('lists only the published types, each with its requirements and countries', async () => {
    await publish('trust', { roles: ['grantor'], countries: ['DE', 'FR'] });
    await publish('fund', { questionnaires: ['fund_questionnaire'] });
    const { entityTypes } = await (await api(['pay:onboard'])).kyb.entityTypes.read();
    expect(entityTypes.map((t) => t.entityType)).toEqual(['fund', 'trust']);
    expect(entityTypes[1]).toMatchObject({ peopleRoles: ['grantor'], countries: ['DE', 'FR'] });
  });

  it('a type with no published requirements refuses and starts nothing', async () => {
    await publish('trust', { roles: ['grantor'] });
    const err = await rejection(service.requirements('fund', 'DE'));
    expect(err).toBeInstanceOf(KybError);
    expect(err).toMatchObject({ code: 'pay.kyb_requirements_unset' });
    const viaRouter = await rejection((await api(['pay:onboard'])).kyb.requirements.read({ entityType: 'fund', country: 'DE' }));
    expect(viaRouter).toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('a country the type is not offered in is refused, and a lower-case country is accepted', async () => {
    await publish('trust', { roles: ['grantor'], countries: ['DE'] });
    const caller = await api(['pay:onboard']);
    expect(await rejection(caller.kyb.requirements.read({ entityType: 'trust', country: 'FR' }))).toMatchObject({ code: 'BAD_REQUEST' });
    expect(await caller.kyb.requirements.read({ entityType: 'trust', country: 'de' })).toMatchObject({ country: 'DE' });
  });

  it('is behind pay:onboard', async () => {
    const caller = await api(['pay:read']);
    expect(await rejection(caller.kyb.entityTypes.read())).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('the table refuses a row that publishes nothing, no country, or a malformed key', async () => {
    await expect(publish('trust', { countries: ['DE'] })).rejects.toThrow(/kyb_entity_types_requirements_published/);
    await expect(publish('trust', { roles: ['grantor'], countries: [] })).rejects.toThrow(/kyb_entity_types_countries_format/);
    await expect(publish('trust', { roles: ['Grantor'] })).rejects.toThrow(/kyb_entity_types_people_roles_format/);
    await expect(publish('trust', { roles: ['grantor'], countries: ['de'] })).rejects.toThrow(/kyb_entity_types_countries_format/);
    await expect(publish('cooperative', { roles: ['grantor'] })).rejects.toThrow(/kyb_entity_types_type_known/);
  });
});
