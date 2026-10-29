import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { ActionApprovalConsumeInput, CategoryPolicyPreviewInput } from '@intafaced/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ActionApprovalConsumeError,
  ACTION_APPROVAL_PAYLOAD_MISMATCH,
  stubApprovalConsumer,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from '../action-approval-consume.js';
import { createPayNamespaces } from '../namespaces/index.js';
import { FRESH } from '../seams/guards.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { KybService } from '../kyb-service.js';
import { loadKybDecisionBinding } from '../kyb-decision-binding.js';
import { writeKybDecision } from '../payment-service/merchants.js';
import { CategoryPolicyService, categoryBlockers, checkoutCategoryRule, createCategoryGuards } from './category.js';

/**
 * Business categories (RC-merchant-08, J-merchant-02 step 7): the owner's table, two founders for every edit, the
 * business's choice and what each class does to new payments. Postgres required: TEST_DATABASE_URL, or a
 * Testcontainers postgres:16-alpine. No skip. TEST DATA ONLY: every category here stands in for an owner's table.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_categories_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const FOUNDER = 'founder-a';
const SECOND = 'founder-b';
const OWNER = '66666666-6666-4666-8666-666666666666';

type Err = { code: string; cause?: { code?: string } };
async function refused(p: Promise<unknown>): Promise<Err> {
  try {
    await p;
  } catch (e) {
    return e as Err;
  }
  throw new Error('expected the call to be refused');
}

const SOFTWARE: CategoryPolicyPreviewInput = {
  key: 'test-software',
  label: 'TEST Software',
  class: 'permissionless',
  reserve: null,
  extraDocuments: [],
  expectedVersion: null,
  reason: 'TEST add software',
};
const TRAVEL: CategoryPolicyPreviewInput = {
  key: 'test-travel',
  label: 'TEST Travel agencies',
  class: 'restricted',
  reserve: null,
  extraDocuments: ['TEST travel licence'],
  expectedVersion: null,
  reason: 'TEST add travel',
};
const WEAPONS: CategoryPolicyPreviewInput = {
  key: 'test-weapons',
  label: 'TEST Weapons',
  class: 'prohibited',
  reserve: null,
  extraDocuments: [],
  expectedVersion: null,
  reason: 'TEST add weapons',
};

describe('business categories', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let approver: string | null = SECOND;
  let consumed: ActionApprovalConsumeInput[] = [];
  let bindHash: string | null = null;
  let merchantId: string;

  const approvals: ActionApprovalConsumer = {
    async consume(input) {
      consumed.push(input);
      if (bindHash !== null && input.payloadHash !== bindHash) {
        throw new ActionApprovalConsumeError('payload hash does not match the approved action', ACTION_APPROVAL_PAYLOAD_MISMATCH);
      }
      if (approver === null) return unwiredApprovalConsumer().consume(input);
      return stubApprovalConsumer(approver).consume(input);
    },
  };
  const merchants = {
    getMerchant: async (id: string) => {
      const [row] = await db.sql<Array<{ id: string; kyb_status: string }>>`SELECT id, kyb_status FROM pay.merchants WHERE id = ${id}`;
      if (!row) throw new Error('missing merchant');
      return { id: row.id, kybStatus: row.kyb_status };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  const policy = () => api.founderAdmin.categoryPolicy;
  const approval = { approvalId: 'appr-1', operationId: 'op-1' };
  const add = async (input: CategoryPolicyPreviewInput) => {
    const preview = await policy().preview(input);
    bindHash = preview.payloadHash;
    try {
      return await policy().set({ ...input, ...approval });
    } finally {
      bindHash = null;
    }
  };

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const ns = createPayNamespaces({ founderAuthority: async () => FOUNDER, categoryPolicy: { sql: db.sql, approvals } });
    const userId = randomUUID();
    const principal: Principal = {
      userId,
      sub: userId,
      sid: randomUUID(),
      scopes: [...SESSION_SCOPES],
      mfa: true,
      tier: 'full',
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    api = ns.createCaller({ principal, service: null, region: 'DE', requestId: 'r' });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  beforeEach(async () => {
    approver = SECOND;
    consumed = [];
    bindHash = null;
    await truncatePayForTest(
      db.sql,
      'pay',
      `TRUNCATE pay.merchant_category_events, pay.merchant_categories, pay.business_category_events, pay.business_categories,
                pay.payment_links, pay.merchant_kyb_events, pay.merchant_status_events, pay.merchants RESTART IDENTITY CASCADE`,
    );
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id, mode, status, pricing) VALUES (${OWNER}, 'psp', 'active', ${db.sql.json({ feeBps: 250 } as never)}) RETURNING id
    `;
    merchantId = row!.id;
  });

  it('an empty table is no rule set: a business cannot choose and is not ready to go live', async () => {
    const service = new CategoryPolicyService(db.sql, approvals);
    expect(await policy().list()).toEqual({ tableVersion: 0, categories: [] });
    expect(await service.merchantView(merchants, merchantId)).toEqual({
      merchantId,
      policy: { tableVersion: 0, categories: [] },
      chosen: null,
      locked: false,
    });
    expect(
      await refused(service.choose(merchants, OWNER, { merchantId, categoryKey: 'test-software', expectedTableVersion: 1 })),
    ).toMatchObject({ code: 'pay.business_category_policy_unset' });
    expect(await categoryBlockers(db.sql, merchantId)).toEqual(['category_policy_unset']);
  });

  it('every edit needs a different founder bound to the exact change, and nothing is written without one', async () => {
    const preview = await policy().preview(SOFTWARE);
    expect(preview).toMatchObject({ needsDualControl: true, reasons: ['category_added'], actionType: 'pay.business_category_change' });

    approver = FOUNDER;
    expect(await refused(policy().set({ ...SOFTWARE, ...approval }))).toMatchObject({ code: 'PRECONDITION_FAILED' });
    approver = null;
    expect(await refused(policy().set({ ...SOFTWARE, ...approval }))).toMatchObject({ code: 'PRECONDITION_FAILED' });
    approver = SECOND;
    bindHash = preview.payloadHash;
    expect(await refused(policy().set({ ...SOFTWARE, label: 'TEST Other words', ...approval }))).toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect((await policy().list()).categories).toHaveLength(0);

    const saved = await policy().set({ ...SOFTWARE, ...approval });
    expect(saved).toMatchObject({ key: 'test-software', class: 'permissionless', version: 1, updatedBy: FOUNDER, approvedBy: SECOND });
    expect(consumed.at(-1)).toMatchObject({ payloadHash: preview.payloadHash, targetId: 'pay.business_category_change' });
    expect(await refused(policy().preview(SOFTWARE))).toMatchObject({ code: 'CONFLICT', cause: { code: 'pay.category_exists' } });
  });

  it('a category is versioned: an edit raises its version, keeps its history, and refuses a stale or empty change', async () => {
    await add(SOFTWARE);
    await add(TRAVEL);
    expect((await policy().list()).tableVersion).toBe(2);
    const reserve = { percent: '7.50', holdDays: 90 };
    const edited = await add({ ...TRAVEL, reserve, expectedVersion: 1, reason: 'TEST set the travel reserve' });
    expect(edited).toMatchObject({ version: 2, reserve: { percent: '7.5', holdDays: 90 } });
    expect(await refused(policy().preview({ ...TRAVEL, reserve, expectedVersion: 1 }))).toMatchObject({
      cause: { code: 'pay.category_version_conflict' },
    });
    expect(await refused(policy().preview({ ...TRAVEL, reserve: { percent: '7.5', holdDays: 90 }, expectedVersion: 2 }))).toMatchObject({
      cause: { code: 'pay.category_unchanged' },
    });
    expect(await refused(policy().preview({ ...TRAVEL, reserve: { percent: '07.50', holdDays: 90 }, expectedVersion: 2 }))).toMatchObject({
      cause: { code: 'pay.category_unchanged' },
    });
    expect(await refused(policy().preview({ ...SOFTWARE, expectedVersion: 3 }))).toMatchObject({
      cause: { code: 'pay.category_version_conflict' },
    });
    expect(await refused(policy().preview({ ...SOFTWARE, key: 'test-nothing', expectedVersion: 1 }))).toMatchObject({
      code: 'NOT_FOUND',
    });
    // Reserve terms and extra documents belong to a restricted category only.
    expect(await refused(policy().preview({ ...SOFTWARE, key: 'test-games', extraDocuments: ['TEST licence'] }))).toMatchObject({
      code: 'BAD_REQUEST',
    });
    const history = await policy().history({ key: 'test-travel' });
    expect(history.map((e: { seq: number }) => e.seq)).toEqual([3, 2]);
    expect(history[0]).toMatchObject({
      actorId: FOUNDER,
      approverId: SECOND,
      before: { reserve: null },
      after: { reserve: { percent: '7.5', holdDays: 90 } },
      reason: 'TEST set the travel reserve',
    });
  });

  it('a business chooses against the version it read; the same choice again is a replay; a verified business is locked', async () => {
    const service = new CategoryPolicyService(db.sql, approvals);
    await add(SOFTWARE);
    await add(TRAVEL);
    expect(await categoryBlockers(db.sql, merchantId)).toEqual(['category_not_chosen']);
    expect(
      await refused(service.choose(merchants, OWNER, { merchantId, categoryKey: 'test-travel', expectedTableVersion: 1 })),
    ).toMatchObject({ code: 'pay.category_policy_changed' });
    expect(
      await refused(service.choose(merchants, OWNER, { merchantId, categoryKey: 'test-nothing', expectedTableVersion: 2 })),
    ).toMatchObject({ code: 'pay.category_not_found' });

    const chosen = await service.choose(merchants, OWNER, { merchantId, categoryKey: 'test-travel', expectedTableVersion: 2 });
    expect(chosen.chosen).toMatchObject({ category: { key: 'test-travel', class: 'restricted', reserve: null }, tableVersion: 2 });
    expect(await categoryBlockers(db.sql, merchantId)).toEqual(['reserve_terms_unset']);
    await service.choose(merchants, OWNER, { merchantId, categoryKey: 'test-travel', expectedTableVersion: 1 });
    expect(await db.sql`SELECT 1 FROM pay.merchant_category_events`).toHaveLength(1);

    await service.choose(merchants, OWNER, { merchantId, categoryKey: 'test-software', expectedTableVersion: 2 });
    expect(await categoryBlockers(db.sql, merchantId)).toEqual([]);
    await db.sql`UPDATE pay.merchants SET kyb_status = 'approved' WHERE id = ${merchantId}`;
    expect((await service.merchantView(merchants, merchantId)).locked).toBe(true);
    expect(
      await refused(service.choose(merchants, OWNER, { merchantId, categoryKey: 'test-travel', expectedTableVersion: 2 })),
    ).toMatchObject({ code: 'pay.category_locked' });
    expect((await service.merchantView(merchants, merchantId)).chosen?.category.key).toBe('test-software');
  });

  it('a verified business with no category (approved before the table had any) makes its first choice, then is locked', async () => {
    const service = new CategoryPolicyService(db.sql, approvals);
    await db.sql`UPDATE pay.merchants SET kyb_status = 'approved' WHERE id = ${merchantId}`;
    await add(SOFTWARE);
    await add(TRAVEL);
    expect((await service.merchantView(merchants, merchantId)).locked).toBe(false);
    await service.choose(merchants, OWNER, { merchantId, categoryKey: 'test-travel', expectedTableVersion: 2 });
    expect((await service.merchantView(merchants, merchantId)).locked).toBe(true);
    expect(
      await refused(service.choose(merchants, OWNER, { merchantId, categoryKey: 'test-software', expectedTableVersion: 2 })),
    ).toMatchObject({ code: 'pay.category_locked' });
  });

  it('once the table has categories, approving a business needs a chosen category that is not prohibited, on both KYB doors', async () => {
    const service = new CategoryPolicyService(db.sql, approvals);
    const actor = { id: 'TEST-compliance', scope: 'admin:compliance' };
    const pending = async () => {
      await db.sql`UPDATE pay.merchants SET kyb_status = 'pending', kyb_ref = 'TEST-kyb-ref' WHERE id = ${merchantId}`;
    };
    let consumedApproval = 0;
    const kyb = new KybService(db.sql);
    const decide = async () => {
      const binding = await loadKybDecisionBinding(db.sql, merchantId);
      return kyb.decide({
        merchantId,
        decision: 'approved',
        reason: 'TEST reviewed',
        actorId: actor.id,
        actorScope: actor.scope,
        identityHash: binding!.identityHash,
        beforeWrite: async () => {
          consumedApproval += 1;
        },
      });
    };
    const stub = () => writeKybDecision({ sql: db.sql } as never, merchantId, 'approved', actor, 'TEST reviewed');

    // An empty table refuses nothing here: the go-live checklist names it.
    await pending();
    await expect(stub()).resolves.toMatchObject({ kybStatus: 'approved' });

    await add(SOFTWARE);
    await add(WEAPONS);
    await pending();
    expect(await refused(stub())).toMatchObject({ code: 'pay.category_not_chosen' });
    expect(await refused(decide())).toMatchObject({ code: 'pay.category_not_chosen' });
    // Refused before the founder approval is consumed and before any write.
    expect(consumedApproval).toBe(0);
    expect((await merchants.getMerchant(merchantId)).kybStatus).toBe('pending');

    await service.choose(merchants, OWNER, { merchantId, categoryKey: 'test-weapons', expectedTableVersion: 2 });
    expect(await refused(stub())).toMatchObject({ code: 'pay.category_prohibited' });
    expect(await refused(decide())).toMatchObject({ code: 'pay.category_prohibited' });

    await service.choose(merchants, OWNER, { merchantId, categoryKey: 'test-software', expectedTableVersion: 2 });
    await expect(decide()).resolves.toMatchObject({ kybStatus: 'approved' });
    expect(consumedApproval).toBe(1);
  });

  it('new payments follow the class: prohibited takes nothing, a blank reserve takes nothing, permissionless takes crypto-native only', async () => {
    const service = new CategoryPolicyService(db.sql, approvals);
    const guard = createCategoryGuards({ sql: db.sql }).beforePaymentAdmit!;
    const admit = (railAdapter: string, extra: Partial<Parameters<typeof guard>[0]> = {}) =>
      guard({
        tx: db.sql,
        kind: 'payment.create',
        paymentId: randomUUID(),
        merchantId,
        payload: { railAdapter },
        replay: FRESH,
        ...extra,
      });
    // No category chosen: the go-live checklist says so, and nothing is refused here.
    await expect(admit('card-sandbox')).resolves.toBeUndefined();

    await add(SOFTWARE);
    await add(TRAVEL);
    await add(WEAPONS);
    await service.choose(merchants, OWNER, { merchantId, categoryKey: 'test-software', expectedTableVersion: 3 });
    await expect(admit('crypto-native')).resolves.toBeUndefined();
    expect(await refused(admit('card-sandbox'))).toMatchObject({ code: 'pay.guard_category_rail_refused', kind: 'refused' });
    // A sandbox API key may only use sandbox rails, which move no value: its integration tests keep working.
    await expect(admit('card-sandbox', { payload: { railAdapter: 'card-sandbox', sandbox: true } })).resolves.toBeUndefined();

    await service.choose(merchants, OWNER, { merchantId, categoryKey: 'test-travel', expectedTableVersion: 3 });
    expect(await refused(admit('crypto-native'))).toMatchObject({ code: 'pay.guard_reserve_terms_unset' });

    await service.choose(merchants, OWNER, { merchantId, categoryKey: 'test-weapons', expectedTableVersion: 3 });
    expect(await refused(admit('crypto-native'))).toMatchObject({ code: 'pay.guard_category_prohibited' });
    expect(await categoryBlockers(db.sql, merchantId)).toEqual(['category_prohibited']);
    // A payment already admitted is never refused by the category: authorize, capture, a replay and a recovery pass.
    await expect(admit('crypto-native', { kind: 'payment.capture' })).resolves.toBeUndefined();
    await expect(admit('crypto-native', { replay: { kind: 'replay', reason: 'payment_exists' } })).resolves.toBeUndefined();

    // The hosted checkout reads the same rule from the link before it routes.
    const token = 'pl_test_category_token';
    await db.sql`
      INSERT INTO pay.payment_links (merchant_id, token_hash, token_prefix, label)
      VALUES (${merchantId}, ${createHash('sha256').update(token).digest('hex')}, 'pl_cat', 'TEST link')
    `;
    expect(await checkoutCategoryRule(db.sql, token)).toEqual({ key: 'test-weapons', class: 'prohibited', reserveSet: false });
    expect(await checkoutCategoryRule(db.sql, 'pl_unknown')).toBeNull();
  });

  it('the database keeps every category, raises versions by one, keeps history, and needs two people', async () => {
    await add(SOFTWARE);
    await expect(db.sql`DELETE FROM pay.business_categories WHERE key = 'test-software'`).rejects.toThrow(/DELETE is not permitted/);
    await expect(db.sql`UPDATE pay.business_categories SET version = 5 WHERE key = 'test-software'`).rejects.toThrow(
      /raises its version by one/,
    );
    await expect(db.sql`UPDATE pay.business_categories SET key = 'test-other', version = 2`).rejects.toThrow(/keeps its key/);
    await expect(db.sql`UPDATE pay.business_category_events SET reason = 'TEST rewritten'`).rejects.toThrow(/append-only/);
    await expect(
      db.sql`UPDATE pay.business_categories SET approved_by = updated_by, version = version + 1 WHERE key = 'test-software'`,
    ).rejects.toThrow(/business_categories_two_people/);
    await expect(
      db.sql`UPDATE pay.business_categories SET reserve_percent = 5, reserve_hold_days = 30, version = version + 1 WHERE key = 'test-software'`,
    ).rejects.toThrow(/business_categories_restricted_only/);
  });
});
