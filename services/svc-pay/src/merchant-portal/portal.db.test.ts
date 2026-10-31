import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { LedgerClient } from '@intafaced/ledger-client';
import type { Context } from '@intafaced/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { ActionApprovalConsumeError, stubApprovalConsumer, type ActionApprovalConsumer } from '../action-approval-consume.js';
import {
  PAY_KYB_DECIDE,
  PAY_MERCHANT_DECIDE_KYB,
  kybApprovalFields,
  kybDecisionPayloadHash,
  loadKybDecisionBinding,
} from '../kyb-decision-binding.js';
import { createPayRouter } from '../router.js';
import type { UserMoneyService } from '../user-money-service.js';
import { createFounderAuthority } from '../founder-authority.js';
import { KybService } from '../kyb-service.js';
import { createKybPspRouter } from '../kyb-router.js';
import { teamReadFromSql } from '../merchant-team-read.js';
import { createMerchantOpsRouter } from '../merchant-ops/router.js';
import { PayError, PayService, type MerchantRecord } from '../payment-service.js';
import type { PspModeService } from '../psp-mode.js';
import { RailRegistry } from '../rails/registry.js';
import { SubMerchantService } from '../submerchants.js';
import { createSubMerchantRouter } from '../submerchant-router.js';
import { createMerchantPortalRouter } from './router.js';

/** Who moves KYB in these tests; `merchant_kyb_events` records it. */
const KYB_ACTOR = { id: 'kyb-test-actor', scope: 'pay:onboard' };

/**
 * Portal procedures against Postgres: membership source, reviewed profile
 * changes, onboarding progress, per-asset analytics, customer series, and a
 * PayFac child summary. A foreign merchant id matches a missing id.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const id = () => randomUUID();
const ADDRESS = { line1: '1 Market', line2: null, city: 'Berlin', region: null, postalCode: '10115', country: 'DE' };
const APPROVAL = { approvalId: 'appr-profile', operationId: 'op-profile' };
const GRAND_DEST = '0x222222222222222222222222222222222222abcd';
const WINDOW = { from: '2026-10-05T00:00:00.000Z', to: '2026-10-19T00:00:00.000Z' };

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_portal_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const principalOf = (userId: string, over: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: id(),
  scopes: ['pay:read', 'pay:write', 'pay:onboard'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
  ...over,
});
const ctxOf = (principal: Principal): Context => ({ principal, service: null, region: 'DE', requestId: id() });

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    const err = e as { code: string; message: string; cause?: { code?: string } };
    return { code: err.code, message: err.message, cause: err.cause?.code };
  }
  throw new Error('expected a refusal');
}

const norm = (value: string) => value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');

function payLookup(sql: Sql) {
  const load = async (merchantId: string): Promise<MerchantRecord | null> => {
    const rows = await sql<
      Array<{
        id: string;
        user_id: string;
        mode: MerchantRecord['mode'];
        status: MerchantRecord['status'];
        kyb_status: MerchantRecord['kybStatus'];
      }>
    >`
      SELECT id, user_id, mode::text AS mode, status::text AS status, kyb_status::text AS kyb_status
        FROM pay.merchants WHERE id = ${merchantId}`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      mode: row.mode,
      tier: 0,
      kybStatus: row.kyb_status,
      kybRef: null,
      status: row.status,
      pricing: {},
      settlementPrefs: {},
    };
  };
  return {
    async getMerchant(merchantId: string) {
      const row = await load(merchantId);
      if (!row) throw new PayError(`Merchant ${merchantId} not found`, 'pay.merchant_not_found');
      return row;
    },
    async getMerchantByUserId(userId: string) {
      const rows = await sql<Array<{ id: string }>>`SELECT id FROM pay.merchants WHERE user_id = ${userId}`;
      const found = rows[0];
      return found ? load(found.id) : null;
    },
  };
}

describe('merchant portal procedures', () => {
  let db: TestDatabase;
  let sql: Sql;
  let stop: () => Promise<void>;
  const owner = id();
  const admin = id();
  const adminA = id();
  const finance = id();
  const viewer = id();
  const developer = id();
  const invited = id();
  const removed = id();
  const stranger = id();
  const parentUser = id();
  const childUser = id();
  const grandUser = id();
  const merchantA = id();
  const merchantB = id();
  const parentId = id();
  const childId = id();
  const grandId = id();
  const destRef = '0x1111111111111111111111111111111111111111';
  const complianceUser = id();

  beforeAll(async () => {
    const adminDb = await openAdmin();
    stop = adminDb.stop;
    db = await createTestDatabase({ service: 'pay', url: adminDb.url, migrations });
    sql = db.sql;
    const insert = async (
      merchantId: string,
      userId: string,
      over: { parent?: string | null; mode?: string; kyb?: string; name?: string | null } = {},
    ) => {
      await sql`
        INSERT INTO pay.merchants (id, user_id, mode, status, kyb_status, parent_merchant_id, display_name, legal_name)
        VALUES (
          ${merchantId}, ${userId}, ${over.mode ?? 'gateway'}::pay.merchant_mode, 'active'::pay.merchant_status,
          ${over.kyb ?? 'none'}::pay.kyb_status, ${over.parent ?? null}, ${over.name ?? null}, ${over.name ?? null}
        )`;
    };
    await insert(merchantA, owner, { kyb: 'approved', name: 'Alpha' });
    await insert(merchantB, stranger, { kyb: 'approved', name: 'Beta' });
    await insert(parentId, parentUser, { mode: 'payfac', kyb: 'approved', name: 'Parent' });
    await insert(childId, childUser, { parent: parentId, mode: 'payfac', name: 'Child' });
    await insert(grandId, grandUser, { parent: childId, mode: 'payfac', name: 'Grand' });
    for (const area of ['merchant.profile', 'submerchant']) {
      await sql`
        INSERT INTO pay.merchant_permission_events
          (grantee_merchant_id, subject_merchant_id, area, action, reason, actor_id, actor_merchant_id, actor_scope)
        VALUES (
          ${childId}, ${grandId}, ${area}, 'grant',
          'default grant at onboarding — visibility only, no value-moving area',
          ${parentUser}, ${parentId}, 'pay:write'
        )`;
    }
    const member = async (merchantId: string, userId: string, role: string, status: string) => {
      await sql`
        INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at, removed_at)
        VALUES (
          ${merchantId}, ${userId}, ${role}, ${status}, ${owner},
          CASE WHEN ${status} = 'active' THEN now() ELSE NULL END,
          CASE WHEN ${status} = 'removed' THEN now() ELSE NULL END
        )`;
    };
    await member(merchantA, adminA, 'admin', 'active');
    await member(merchantB, admin, 'admin', 'active');
    await member(merchantA, finance, 'finance', 'active');
    await member(merchantA, viewer, 'viewer', 'active');
    await member(merchantA, developer, 'developer', 'active');
    await member(merchantA, invited, 'viewer', 'invited');
    await member(merchantA, removed, 'viewer', 'removed');
    await member(merchantA, owner, 'viewer', 'invited');
    await sql`
      INSERT INTO pay.merchant_payout_destinations (merchant_id, rail_id, kind, ref, verified, verified_at)
      VALUES (${merchantA}, 'crypto-native', 'crypto', ${destRef}, true, now()),
             (${grandId}, 'crypto-native', 'crypto', ${GRAND_DEST}, true, now())`;
    await sql`
      UPDATE pay.merchants SET
        legal_name = 'Alpha Ltd', display_name = 'Alpha',
        address_line1 = '1 Market', address_city = 'Berlin', address_postal_code = '10115', address_country = 'DE'
      WHERE id = ${merchantA}`;
    await sql`
      INSERT INTO pay.metrics_merchant_day (merchant_id, day, asset_code, captured, captured_count, settle_gross, settle_fees, settle_net)
      VALUES
        (${merchantA}, '2026-10-05', 'USDT', 1, 1, 10, 1, 9),
        (${merchantA}, '2026-10-06', 'USDT', 2, 1, 0, 0, 0),
        (${merchantA}, '2026-10-05', 'USDC', 4, 1, 4, 1, 3),
        (${merchantA}, '2026-10-12', 'USDT', 8, 1, 0, 0, 0),
        (${childId}, '2026-10-05', 'USDT', 5, 1, 0, 0, 0),
        (${childId}, '2026-10-05', 'USDC', 6, 1, 0, 0, 0)`;
    const payId = (
      await sql<Array<{ id: string }>>`
        INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, rail_ref, status)
        VALUES (${childId}, 3, 'USDT', 'card', 'card-sandbox', ${'rail-' + id()}, 'captured'::pay.payment_status)
        RETURNING id`
    )[0]!.id;
    await sql`
      INSERT INTO pay.payment_events (payment_id, event, payload, ts)
      VALUES (${payId}, 'created', ${sql.json({ amount: '3', customerRef: 'cust-child' })}, '2026-10-05T12:00:00Z')`;
    const seedCustomer = async (merchantId: string, ref: string, asset: string, amount: string, at: string) => {
      const payment = (
        await sql<Array<{ id: string }>>`
          INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, rail_ref, status)
          VALUES (${merchantId}, ${amount}, ${asset}, 'card', 'card-sandbox', ${'rail-' + id()}, 'captured'::pay.payment_status)
          RETURNING id`
      )[0]!.id;
      await sql`
        INSERT INTO pay.payment_events (payment_id, event, payload, ts) VALUES
          (${payment}, 'created', ${sql.json({ amount, customerRef: ref })}, ${at}),
          (${payment}, 'captured', ${sql.json({ amount })}, ${at})`;
    };
    await seedCustomer(merchantA, 'cust-a', 'USDT', '1', '2026-10-05T12:00:00Z');
    await seedCustomer(merchantA, 'cust-a', 'USDT', '2', '2026-10-06T12:00:00Z');
    await seedCustomer(merchantA, 'cust-a', 'USDC', '4', '2026-10-05T12:00:00Z');
    await seedCustomer(merchantB, 'cust-b', 'USDT', '9', '2026-10-05T12:00:00Z');
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await stop?.();
  });

  const portalDeps = (withTrees: boolean) => ({
    sql,
    pay: payLookup(sql),
    trees: withTrees ? new SubMerchantService(sql) : null,
    team: teamReadFromSql(sql),
    approvals: stubApprovalConsumer('approver-founder'),
  });
  const as = (userId: string, over: Partial<Principal> = {}) =>
    createMerchantPortalRouter(portalDeps(false)).createCaller(ctxOf(principalOf(userId, over)));
  const asTree = (userId: string) => createMerchantPortalRouter(portalDeps(true)).createCaller(ctxOf(principalOf(userId)));
  const compliance = () =>
    createMerchantPortalRouter(portalDeps(false)).createCaller(ctxOf(principalOf(complianceUser, { scopes: ['admin:compliance'] })));
  const ops = (userId: string) =>
    createMerchantOpsRouter({
      sql,
      founderAuthority: createFounderAuthority({
        identityUrl: 'https://identity.invalid',
        serviceSecret: 's'.repeat(32),
        fetcher: vi.fn(async () => {
          throw new Error('founder lookup is not part of a merchant series read');
        }),
      }),
      exportKick: () => undefined,
    }).createCaller(ctxOf(principalOf(userId)));
  const trees = (userId: string) =>
    createSubMerchantRouter(new SubMerchantService(sql), payLookup(sql), sql).createCaller(ctxOf(principalOf(userId)));

  it('myAccess lists owned and active team rows, owner first, and skips invited and removed', async () => {
    const mine = await as(owner).merchant.myAccess({});
    expect(mine.memberships.map((m) => ({ merchantId: m.merchantId, role: m.role }))).toEqual([{ merchantId: merchantA, role: 'owner' }]);
    expect(mine.memberships[0]?.verified).toBe(true);
    expect(mine.memberships[0]?.identityChangePending).toBe(false);
    expect(mine.memberships[0]?.sessionInteractive).toBe(true);
    expect(mine.memberships[0]?.pricingVisibility).toBe('full');
    expect(mine.memberships[0]?.capabilities['profile.manage']).toBe(true);
    const keyed = await as(owner, { kid: 'ifc_test', mfa: true }).merchant.myAccess({});
    expect(keyed.memberships[0]?.sessionInteractive).toBe(false);
    expect(keyed.memberships[0]?.capabilities['profile.read']).toBe(true);
    expect(keyed.memberships[0]?.capabilities['profile.manage']).toBe(false);
    expect(keyed.memberships[0]?.capabilities['payout.approve']).toBe(false);
    const noMfa = await as(owner, { mfa: false }).merchant.myAccess({});
    expect(noMfa.memberships[0]?.sessionInteractive).toBe(false);
    expect(noMfa.memberships[0]?.capabilities['team.manage']).toBe(false);
    expect(noMfa.memberships[0]?.capabilities['payments.read']).toBe(true);
    const both = await as(admin).merchant.myAccess({});
    expect(both.memberships.map((m) => m.role)).toEqual(['admin']);
    expect(both.memberships[0]?.merchantId).toBe(merchantB);
    expect(both.memberships[0]?.capabilities['profile.manage']).toBe(true);
    expect((await as(viewer).merchant.myAccess({})).memberships[0]?.pricingVisibility).toBe('fee_only');
    expect((await as(invited).merchant.myAccess({})).memberships).toEqual([]);
    expect((await as(removed).merchant.myAccess({})).memberships).toEqual([]);
    expect((await as(id()).merchant.myAccess({})).memberships).toEqual([]);
  });

  it('reviews sensitive profile fields and refuses a foreign merchant like a missing one', async () => {
    const applied = await as(owner).merchant.businessProfile.submit({
      merchantId: merchantA,
      expectedVersion: '0',
      reason: 'public name',
      displayName: 'Alpha Shop',
    });
    expect(applied.outcome).toBe('applied');
    expect(applied.changeHash).toBeNull();
    expect(applied.profile.displayName).toBe('Alpha Shop');
    const pending = await as(owner).merchant.businessProfile.submit({
      merchantId: merchantA,
      expectedVersion: applied.version,
      reason: 'legal name',
      legalName: 'Alpha Legal Ltd',
    });
    expect(pending.outcome).toBe('pending_review');
    expect(pending.changeHash).toEqual(expect.any(String));
    expect(pending.profile.legalName).toBe('Alpha Ltd');
    const waiting = await as(owner).merchant.myAccess({});
    expect(waiting.memberships[0]).toMatchObject({ verified: true, identityChangePending: true, legalName: 'Alpha Ltd' });
    const self = await refusal(() =>
      as(owner).merchant.businessProfile.confirm({
        merchantId: merchantA,
        requestId: pending.requestId,
        decision: 'confirm',
        expectedChangeHash: pending.changeHash!,
        reason: 'self',
      }),
    );
    expect(self.cause).toBe('pay.profile_compliance_review');
    const mismatch = await refusal(() =>
      as(adminA).merchant.businessProfile.confirm({
        merchantId: merchantA,
        requestId: pending.requestId,
        decision: 'confirm',
        expectedChangeHash: 'sha256:' + 'b'.repeat(64),
        reason: 'wrong hash',
      }),
    );
    expect(mismatch.cause).toBe('pay.change_hash_mismatch');
    const merchantConfirm = await refusal(() =>
      as(adminA).merchant.businessProfile.confirm({
        merchantId: merchantA,
        requestId: pending.requestId,
        decision: 'confirm',
        expectedChangeHash: pending.changeHash!,
        reason: 'second approval',
      }),
    );
    expect(merchantConfirm.cause).toBe('pay.profile_compliance_review');
    const still = await as(owner).merchant.businessProfile.get({ merchantId: merchantA });
    expect(still.legalName).toBe('Alpha Ltd');
    const renamed = await as(owner).merchant.businessProfile.submit({
      merchantId: merchantA,
      expectedVersion: still.version,
      reason: 'public name while identity waits',
      displayName: 'Alpha Window',
    });
    expect(renamed.outcome).toBe('applied');
    expect(renamed.profile.displayName).toBe('Alpha Window');
    expect(renamed.profile.legalName).toBe('Alpha Ltd');
    await expect(
      as(finance).merchant.businessProfile.submit({
        merchantId: merchantA,
        expectedVersion: renamed.version,
        reason: 'finance cannot',
        industry: 'Retail',
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'pay.team_role_forbidden' }) });
    for (const userId of [viewer, developer]) {
      await expect(
        as(userId).merchant.businessProfile.submit({
          merchantId: merchantA,
          expectedVersion: renamed.version,
          reason: 'role fence',
          displayName: 'Nope',
        }),
      ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'pay.team_role_forbidden' }) });
    }
    await expect(
      as(owner, { kid: 'ifc_test', mfa: true }).merchant.businessProfile.submit({
        merchantId: merchantA,
        expectedVersion: renamed.version,
        reason: 'key',
        displayName: 'Nope',
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'pay.profile_interactive_only' }) });
    await expect(
      as(owner).merchant.businessProfile.review({
        merchantId: merchantA,
        requestId: pending.requestId,
        decision: 'approved',
        reason: 'merchant cannot review',
        expectedChangeHash: pending.changeHash!,
        ...APPROVAL,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const confirmed = await compliance().merchant.businessProfile.review({
      merchantId: merchantA,
      requestId: pending.requestId,
      decision: 'approved',
      reason: 'dossier matches',
      expectedChangeHash: pending.changeHash!,
      confirmOperatorId: 'typed-name-is-not-approval',
      ...APPROVAL,
    });
    expect(confirmed.outcome).toBe('applied');
    expect(confirmed.confirmOperatorId).toBe('approver-founder');
    expect(confirmed.profile.legalName).toBe('Alpha Legal Ltd');
    expect(confirmed.profile.displayName).toBe('Alpha Window');
    const settled = await as(owner).merchant.myAccess({});
    expect(settled.memberships[0]).toMatchObject({ verified: true, identityChangePending: false, legalName: 'Alpha Legal Ltd' });
    const history = await as(viewer).merchant.businessProfile.history({ merchantId: merchantA, limit: 10 });
    expect(
      history.items.some((item) => item.requestId === pending.requestId && item.status === 'applied' && item.checkerId === complianceUser),
    ).toBe(true);
    const ghost = id();
    const foreign = await refusal(() => as(stranger).merchant.businessProfile.get({ merchantId: merchantA }));
    const missing = await refusal(() => as(stranger).merchant.businessProfile.get({ merchantId: ghost }));
    expect(norm(foreign.message)).toBe(norm(missing.message));
    expect(foreign.code).toBe(missing.code);
    expect(foreign.message).not.toContain('Alpha');
  });

  it('lets the maker withdraw a pending sensitive change', async () => {
    const submitted = await as(stranger).merchant.businessProfile.submit({
      merchantId: merchantB,
      expectedVersion: '0',
      reason: 'legal name',
      legalName: 'Beta Legal',
    });
    expect(submitted.outcome).toBe('pending_review');
    await expect(
      as(admin).merchant.businessProfile.confirm({
        merchantId: merchantB,
        requestId: submitted.requestId,
        decision: 'withdraw',
        expectedChangeHash: submitted.changeHash!,
        reason: 'not the maker',
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'pay.profile_withdraw_forbidden' }) });
    const withdrawn = await as(stranger).merchant.businessProfile.confirm({
      merchantId: merchantB,
      requestId: submitted.requestId,
      decision: 'withdraw',
      expectedChangeHash: submitted.changeHash!,
      reason: 'withdraw',
    });
    expect(withdrawn.outcome).toBe('rejected');
    expect(withdrawn.profile.legalName).toBe('Beta');
    await expect(
      as(admin).merchant.businessProfile.confirm({
        merchantId: merchantB,
        requestId: submitted.requestId,
        decision: 'confirm',
        expectedChangeHash: submitted.changeHash!,
        reason: 'already withdrawn',
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'pay.profile_change_not_pending' }) });
  });

  it('keeps the old legal name when compliance rejects', async () => {
    const current = await as(stranger).merchant.businessProfile.get({ merchantId: merchantB });
    const submitted = await as(stranger).merchant.businessProfile.submit({
      merchantId: merchantB,
      expectedVersion: current.version,
      reason: 'legal name',
      legalName: 'Beta Rejected Ltd',
    });
    expect(submitted.outcome).toBe('pending_review');
    const rejected = await compliance().merchant.businessProfile.review({
      merchantId: merchantB,
      requestId: submitted.requestId,
      decision: 'rejected',
      reason: 'name does not match the dossier',
      expectedChangeHash: submitted.changeHash!,
      ...APPROVAL,
    });
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.profile.legalName).toBe('Beta');
    const history = await as(admin).merchant.businessProfile.history({ merchantId: merchantB, limit: 5 });
    expect(history.items.find((item) => item.requestId === submitted.requestId)).toMatchObject({
      status: 'rejected',
      checkerId: complianceUser,
      checkerReason: 'name does not match the dossier',
    });
    expect((await as(stranger).merchant.myAccess({})).memberships[0]?.identityChangePending).toBe(false);
  });

  it('auto-rejects when the maker is no longer an active admin', async () => {
    const current = await as(stranger).merchant.businessProfile.get({ merchantId: merchantB });
    const submitted = await as(admin).merchant.businessProfile.submit({
      merchantId: merchantB,
      expectedVersion: current.version,
      reason: 'legal name',
      legalName: 'Beta Gone Admin',
    });
    expect(submitted.outcome).toBe('pending_review');
    await sql`
      UPDATE pay.merchant_team_members SET status = 'removed', removed_at = now()
       WHERE merchant_id = ${merchantB} AND user_id = ${admin}`;
    const decided = await compliance().merchant.businessProfile.review({
      merchantId: merchantB,
      requestId: submitted.requestId,
      decision: 'approved',
      reason: 'would have approved',
      expectedChangeHash: submitted.changeHash!,
      ...APPROVAL,
    });
    expect(decided.outcome).toBe('rejected');
    expect(decided.profile.legalName).toBe('Beta');
    const row = (await as(stranger).merchant.businessProfile.history({ merchantId: merchantB, limit: 5 })).items.find(
      (item) => item.requestId === submitted.requestId,
    );
    expect(row).toMatchObject({ status: 'rejected', checkerReason: 'maker_no_longer_authorized' });
    await sql`
      UPDATE pay.merchant_team_members SET status = 'active', removed_at = NULL
       WHERE merchant_id = ${merchantB} AND user_id = ${admin}`;
  });

  it('a merchant second approver does not apply a legal name, and a removed maker is auto-rejected', async () => {
    expect((await as(stranger).merchant.businessProfile.get({ merchantId: merchantB })).secondApprovalEnabled).toBe(false);
    await as(stranger).merchant.businessProfile.setSecondApproval({ merchantId: merchantB, enabled: true });
    const current = await as(stranger).merchant.businessProfile.get({ merchantId: merchantB });
    expect(current.secondApprovalEnabled).toBe(true);
    const submitted = await as(stranger).merchant.businessProfile.submit({
      merchantId: merchantB,
      expectedVersion: current.version,
      reason: 'legal name',
      legalName: 'Beta Checked',
    });
    expect(submitted.outcome).toBe('pending_second_approval');
    const advanced = await as(admin).merchant.businessProfile.confirm({
      merchantId: merchantB,
      requestId: submitted.requestId,
      decision: 'confirm',
      expectedChangeHash: submitted.changeHash!,
      reason: 'merchant check',
    });
    expect(advanced.outcome).toBe('pending_review');
    expect(advanced.profile.legalName).toBe('Beta');
    const applied = await compliance().merchant.businessProfile.review({
      merchantId: merchantB,
      requestId: submitted.requestId,
      decision: 'approved',
      reason: 'dossier matches',
      expectedChangeHash: submitted.changeHash!,
      ...APPROVAL,
    });
    expect(applied.outcome).toBe('applied');
    expect(applied.profile.legalName).toBe('Beta Checked');
    const again = await as(admin).merchant.businessProfile.submit({
      merchantId: merchantB,
      expectedVersion: applied.version,
      reason: 'legal name',
      legalName: 'Beta After Removal',
    });
    expect(again.outcome).toBe('pending_second_approval');
    await sql`
      UPDATE pay.merchant_team_members SET status = 'removed', removed_at = now()
       WHERE merchant_id = ${merchantB} AND user_id = ${admin}`;
    const dropped = await as(stranger).merchant.businessProfile.confirm({
      merchantId: merchantB,
      requestId: again.requestId,
      decision: 'confirm',
      expectedChangeHash: again.changeHash!,
      reason: 'maker left',
    });
    expect(dropped.outcome).toBe('rejected');
    expect(dropped.profile.legalName).toBe('Beta Checked');
    await as(stranger).merchant.businessProfile.setSecondApproval({ merchantId: merchantB, enabled: false });
  });

  const kybOf = async (merchantId: string) => {
    const rows = await sql<Array<{ kyb_status: string }>>`
      SELECT kyb_status::text AS kyb_status FROM pay.merchants WHERE id = ${merchantId}`;
    return rows[0]?.kyb_status;
  };
  const seedMerchant = async (merchantId: string, userId: string, kyb: 'none' | 'pending' | 'approved' | 'rejected') => {
    await sql`
      INSERT INTO pay.merchants (id, user_id, mode, status, kyb_status)
      VALUES (
        ${merchantId}, ${userId}, 'gateway'::pay.merchant_mode, 'active'::pay.merchant_status, ${kyb}::pay.kyb_status
      )`;
  };

  it('takes pay:onboard alone from the owner before verification and from an admin of a verified business, and from nobody else', async () => {
    const onboard = { scopes: ['pay:onboard'] as Principal['scopes'] };
    const user = id();
    const merchantId = id();
    await seedMerchant(merchantId, user, 'none');
    // J-merchant-02 #1: a new owner fills in the address before sending verification.
    const entered = await as(user, onboard).merchant.businessProfile.submit({
      merchantId,
      expectedVersion: '0',
      reason: 'our address',
      address: ADDRESS,
    });
    expect(entered.outcome).toBe('applied');
    expect(entered.profile.address).toEqual(ADDRESS);
    await as(user, onboard).merchant.businessProfile.setSecondApproval({ merchantId, enabled: true });
    await as(user, onboard).merchant.businessProfile.setSecondApproval({ merchantId, enabled: false });

    const helper = id();
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchantId}, ${helper}, 'admin', 'active', ${user}, now())`;
    const unverifiedAdmin = await refusal(() =>
      as(helper, onboard).merchant.businessProfile.submit({
        merchantId,
        expectedVersion: entered.version,
        reason: 'early',
        website: 'https://a.example',
      }),
    );
    expect(unverifiedAdmin.message).toBe('pay.owner_grant_withdrawn');
    // `admin` owns no business here but works for verified Beta; a pay:write session it holds says nothing about this one.
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchantId}, ${admin}, 'admin', 'active', ${user}, now())`;
    const otherWrite = await refusal(() =>
      as(admin).merchant.businessProfile.submit({ merchantId, expectedVersion: entered.version, reason: 'rename', legalName: 'Taken Ltd' }),
    );
    expect(otherWrite.message).toBe('pay.owner_grant_withdrawn');
    const outsider = await refusal(() => as(id(), onboard).merchant.businessProfile.setSecondApproval({ merchantId, enabled: true }));
    expect(outsider).toMatchObject({ code: 'NOT_FOUND', message: `Merchant ${merchantId} not found` });
    await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${merchantId}`;
    const shutOwner = await refusal(() => as(user, onboard).merchant.businessProfile.setSecondApproval({ merchantId, enabled: true }));
    expect(shutOwner.message).toBe('pay.owner_grant_withdrawn');
    await sql`UPDATE pay.merchants SET status = 'active' WHERE id = ${merchantId}`;
    expect((await as(user).merchant.businessProfile.get({ merchantId })).legalName).toBeNull();

    await sql`UPDATE pay.merchants SET kyb_status = 'approved' WHERE id = ${merchantId}`;
    const withdrawn = await refusal(() =>
      as(user, onboard).merchant.businessProfile.submit({
        merchantId,
        expectedVersion: entered.version,
        reason: 'after approval',
        website: 'https://shop.example',
      }),
    );
    expect(withdrawn).toMatchObject({ code: 'FORBIDDEN', message: 'pay.owner_grant_withdrawn' });
    expect((await as(user).merchant.businessProfile.get({ merchantId })).website).toBeNull();

    // The owner grant law never gives an admin pay:write, so an admin of a verified business writes on pay:onboard.
    const changed = await as(helper, onboard).merchant.businessProfile.submit({
      merchantId,
      expectedVersion: entered.version,
      reason: 'support contact',
      supportEmail: 'help@shop.example',
    });
    expect(changed.outcome).toBe('applied');
    // Second approval binds admins, so it is the owner's alone to switch.
    const adminRule = await refusal(() => as(helper, onboard).merchant.businessProfile.setSecondApproval({ merchantId, enabled: false }));
    expect(adminRule.message).toBe('pay.team_role_forbidden');
    await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${merchantId}`;
    const shut = await refusal(() =>
      as(helper, onboard).merchant.businessProfile.submit({
        merchantId,
        expectedVersion: changed.version,
        reason: 'while shut',
        website: 'https://b.example',
      }),
    );
    expect(shut.message).toBe('pay.owner_grant_withdrawn');
    await sql`UPDATE pay.merchants SET status = 'active' WHERE id = ${merchantId}`;

    const reader = id();
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchantId}, ${reader}, 'viewer', 'active', ${user}, now())`;
    const viewerWrite = await refusal(() => as(reader, onboard).merchant.businessProfile.setSecondApproval({ merchantId, enabled: true }));
    expect(viewerWrite.message).toBe('pay.team_role_forbidden');
    const keyed = await refusal(() =>
      as(user, { ...onboard, kid: 'ifc_test' }).merchant.businessProfile.setSecondApproval({ merchantId, enabled: true }),
    );
    // An API key never carries pay:onboard as a write.
    expect(keyed.code).toBe('FORBIDDEN');
    expect((await as(user).merchant.businessProfile.get({ merchantId })).secondApprovalEnabled).toBe(false);
  });

  it('applies sensitive identity before KYB is submitted, refuses it while pending, and holds it once approved', async () => {
    const user = id();
    const merchantId = id();
    await seedMerchant(merchantId, user, 'none');
    await as(user).merchant.businessProfile.setSecondApproval({ merchantId, enabled: true });
    const entered = await as(user).merchant.businessProfile.submit({
      merchantId,
      expectedVersion: '0',
      reason: 'onboarding identity',
      legalName: 'New Shop Ltd',
      address: ADDRESS,
      statementDescriptor: 'NEWSHOP',
      industry: 'Retail',
    });
    expect(entered.outcome).toBe('applied');
    expect(entered.changeHash).toBeNull();
    expect(entered.profile).toMatchObject({
      legalName: 'New Shop Ltd',
      address: ADDRESS,
      statementDescriptor: 'NEWSHOP',
      industry: 'Retail',
      version: '1',
    });
    const logged = (await as(user).merchant.businessProfile.history({ merchantId, limit: 5 })).items.find(
      (item) => item.requestId === entered.requestId,
    );
    expect(logged).toMatchObject({
      status: 'applied_pre_kyb',
      sensitiveKeys: ['legalName', 'address', 'statementDescriptor', 'industry'],
      checkerId: null,
    });
    expect(logged?.decidedAt).toEqual(expect.any(String));
    expect((await as(user).merchant.myAccess({})).memberships[0]).toMatchObject({
      verified: false,
      identityChangePending: false,
      legalName: 'New Shop Ltd',
    });
    expect(await kybOf(merchantId)).toBe('none');

    await sql`UPDATE pay.merchants SET kyb_status = 'pending' WHERE id = ${merchantId}`;
    const whilePending = await refusal(() =>
      as(user).merchant.businessProfile.submit({
        merchantId,
        expectedVersion: entered.version,
        reason: 'still onboarding',
        legalName: 'Pending Shop Ltd',
      }),
    );
    expect(whilePending).toMatchObject({ code: 'CONFLICT', cause: 'pay.profile_kyb_pending' });
    expect((await as(user).merchant.businessProfile.get({ merchantId })).legalName).toBe('New Shop Ltd');

    await sql`UPDATE pay.merchants SET kyb_status = 'rejected' WHERE id = ${merchantId}`;
    const whileRejected = await as(user).merchant.businessProfile.submit({
      merchantId,
      expectedVersion: entered.version,
      reason: 'after a rejection',
      address: { ...ADDRESS, line1: '2 Market' },
    });
    expect(whileRejected.outcome).toBe('applied');
    expect(whileRejected.profile.address?.line1).toBe('2 Market');

    await sql`UPDATE pay.merchants SET kyb_status = 'approved' WHERE id = ${merchantId}`;
    await as(user).merchant.businessProfile.setSecondApproval({ merchantId, enabled: false });
    const held = await as(user).merchant.businessProfile.submit({
      merchantId,
      expectedVersion: whileRejected.version,
      reason: 'after approval',
      legalName: 'Approved Bypass Ltd',
    });
    expect(held.outcome).toBe('pending_review');
    expect(held.changeHash).toEqual(expect.any(String));
    expect(held.profile.legalName).toBe('New Shop Ltd');
    expect((await as(user).merchant.myAccess({})).memberships[0]).toMatchObject({
      verified: true,
      identityChangePending: true,
      legalName: 'New Shop Ltd',
    });
  });

  it('refuses the whole request when a sensitive identity key is present while KYB is pending', async () => {
    const user = id();
    const merchantId = id();
    await seedMerchant(merchantId, user, 'pending');
    const sensitive = await refusal(() =>
      as(user).merchant.businessProfile.submit({
        merchantId,
        expectedVersion: '0',
        reason: 'rename during review',
        legalName: 'Sneaky Shop Ltd',
      }),
    );
    expect(sensitive).toMatchObject({ code: 'CONFLICT', cause: 'pay.profile_kyb_pending' });
    expect(await as(user).merchant.businessProfile.get({ merchantId })).toMatchObject({
      legalName: null,
      displayName: null,
      version: '0',
    });
    expect((await as(user).merchant.businessProfile.history({ merchantId, limit: 5 })).items).toEqual([]);

    const mixed = await refusal(() =>
      as(user).merchant.businessProfile.submit({
        merchantId,
        expectedVersion: '0',
        reason: 'display name and legal name',
        legalName: 'Sneaky Shop Ltd',
        displayName: 'Counter',
      }),
    );
    expect(mixed).toMatchObject({ code: 'CONFLICT', cause: 'pay.profile_kyb_pending' });
    const afterMixed = await as(user).merchant.businessProfile.get({ merchantId });
    expect(afterMixed.legalName).toBeNull();
    expect(afterMixed.displayName).toBeNull();
    expect(afterMixed.version).toBe('0');
    expect((await as(user).merchant.businessProfile.history({ merchantId, limit: 5 })).items).toEqual([]);

    const displayOnly = await as(user).merchant.businessProfile.submit({
      merchantId,
      expectedVersion: afterMixed.version,
      reason: 'support name',
      displayName: 'Counter Two',
    });
    expect(displayOnly.outcome).toBe('applied');
    expect(displayOnly.profile.displayName).toBe('Counter Two');
    expect(displayOnly.profile.legalName).toBeNull();
    expect(await kybOf(merchantId)).toBe('pending');
  });

  it('a merchant cannot clear an approved KYB status to skip identity review', async () => {
    const user = id();
    const merchantId = id();
    await seedMerchant(merchantId, user, 'none');
    const kyb = new KybService(sql);
    let consumes = 0;
    const approvals: ActionApprovalConsumer = {
      async consume(input) {
        consumes += 1;
        return stubApprovalConsumer('approver-founder').consume(input);
      },
    };
    const kybApi = createKybPspRouter(kyb, {} as PspModeService, approvals, payLookup(sql));
    const merchant = kybApi.createCaller(ctxOf(principalOf(user)));
    const complianceCaller = kybApi.createCaller(ctxOf(principalOf(complianceUser, { scopes: ['admin:compliance'] })));
    const submitted = await merchant.kyb.submit({ merchantId, kybRef: 'dossier-1', reason: 'onboarding dossier' });
    expect(submitted.kybStatus).toBe('pending');
    expect(consumes).toBe(0);
    const approved = await complianceCaller.kyb.decide({
      merchantId,
      decision: 'approved',
      reason: 'dossier matches',
      approvalId: 'appr-kyb',
      operationId: 'op-kyb',
    });
    expect(approved.kybStatus).toBe('approved');
    expect(consumes).toBe(1);

    await expect(
      merchant.kyb.decide({
        merchantId,
        decision: 'rejected',
        reason: 'clear my own approval',
        approvalId: 'appr-drop',
        operationId: 'op-drop',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(consumes).toBe(1);
    const sandbox = new PayService(sql, {} as LedgerClient, new RailRegistry([]), { valueMovement: 'allow-sandbox' });
    await expect(sandbox.submitKyb({ actor: KYB_ACTOR, merchantId, kybRef: 'dossier-2' })).rejects.toMatchObject({
      code: 'pay.kyb_invalid',
    });
    await expect(merchant.kyb.submit({ merchantId, kybRef: 'dossier-3', reason: 'try again' })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'pay.kyb_invalid' }),
    });
    await expect(sandbox.decideKybStub({ actor: KYB_ACTOR, merchantId, decision: 'rejected' })).rejects.toMatchObject({
      code: 'pay.kyb_invalid',
    });
    const liveOnly = new PayService(sql, {} as LedgerClient, new RailRegistry([]), { valueMovement: 'live-only' });
    await expect(liveOnly.decideKybStub({ actor: KYB_ACTOR, merchantId, decision: 'rejected' })).rejects.toMatchObject({
      code: 'pay.kyb_operator_required',
    });
    expect(await kybOf(merchantId)).toBe('approved');

    const held = await as(user).merchant.businessProfile.submit({
      merchantId,
      expectedVersion: '0',
      reason: 'legal name after approval',
      legalName: 'Should Wait Ltd',
      address: ADDRESS,
    });
    expect(held.outcome).toBe('pending_review');
    expect(held.profile.legalName).toBeNull();
    expect(held.profile.address).toBeNull();
    expect(await kybOf(merchantId)).toBe('approved');
  });

  it('does not consume a founder approval unless the profile change is pending review', async () => {
    const user = id();
    const checker = id();
    const merchantId = id();
    await seedMerchant(merchantId, user, 'none');
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchantId}, ${checker}, 'admin', 'active', ${user}, now())`;
    let consumes = 0;
    const approvals: ActionApprovalConsumer = {
      async consume(input) {
        consumes += 1;
        return stubApprovalConsumer('approver-founder').consume(input);
      },
    };
    const complianceCaller = createMerchantPortalRouter({ ...portalDeps(false), approvals }).createCaller(
      ctxOf(principalOf(complianceUser, { scopes: ['admin:compliance'] })),
    );
    const attempt = (requestId: string, hash = `sha256:${'a'.repeat(64)}`) =>
      complianceCaller.merchant.businessProfile.review({
        merchantId,
        requestId,
        decision: 'approved',
        reason: 'dossier matches',
        expectedChangeHash: hash,
        ...APPROVAL,
      });

    const missing = await refusal(() => attempt(id()));
    expect(missing).toMatchObject({ code: 'NOT_FOUND', cause: 'pay.profile_change_not_found' });
    expect(consumes).toBe(0);

    const entered = await as(user).merchant.businessProfile.submit({
      merchantId,
      expectedVersion: '0',
      reason: 'onboarding identity',
      legalName: 'Early Shop Ltd',
      address: ADDRESS,
    });
    expect(entered.outcome).toBe('applied');
    const early = await refusal(() => attempt(entered.requestId));
    expect(early).toMatchObject({ code: 'CONFLICT', cause: 'pay.profile_change_not_pending' });
    expect(consumes).toBe(0);
    expect((await as(user).merchant.businessProfile.get({ merchantId })).legalName).toBe('Early Shop Ltd');

    await sql`UPDATE pay.merchants SET kyb_status = 'approved' WHERE id = ${merchantId}`;
    await as(user).merchant.businessProfile.setSecondApproval({ merchantId, enabled: true });
    const current = await as(user).merchant.businessProfile.get({ merchantId });
    const waiting = await as(user).merchant.businessProfile.submit({
      merchantId,
      expectedVersion: current.version,
      reason: 'legal name',
      legalName: 'Later Shop Ltd',
    });
    expect(waiting.outcome).toBe('pending_second_approval');
    const tooSoon = await refusal(() => attempt(waiting.requestId));
    expect(tooSoon).toMatchObject({ code: 'CONFLICT', cause: 'pay.profile_change_not_pending' });
    expect(consumes).toBe(0);

    const advanced = await as(checker).merchant.businessProfile.confirm({
      merchantId,
      requestId: waiting.requestId,
      decision: 'confirm',
      expectedChangeHash: waiting.changeHash!,
      reason: 'merchant check',
    });
    expect(advanced.outcome).toBe('pending_review');
    const wrongHash = await refusal(() => attempt(waiting.requestId, `sha256:${'b'.repeat(64)}`));
    expect(wrongHash).toMatchObject({ code: 'CONFLICT', cause: 'pay.change_hash_mismatch' });
    expect(consumes).toBe(0);
    expect((await as(user).merchant.businessProfile.get({ merchantId })).legalName).toBe('Early Shop Ltd');

    const quiet = createMerchantPortalRouter({ ...portalDeps(false), approvals }).createCaller(
      ctxOf(principalOf(complianceUser, { scopes: ['admin:compliance'], mfa: false })),
    );
    await expect(
      quiet.merchant.businessProfile.review({
        merchantId,
        requestId: waiting.requestId,
        decision: 'approved',
        reason: 'no mfa',
        expectedChangeHash: waiting.changeHash!,
        ...APPROVAL,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(consumes).toBe(0);

    const decided = await attempt(waiting.requestId, waiting.changeHash!);
    expect(decided.outcome).toBe('applied');
    expect(decided.profile.legalName).toBe('Later Shop Ltd');
    expect(consumes).toBe(1);
  });

  it('refuses a KYB approval that was proposed against an older identity', async () => {
    const user = id();
    const merchantId = id();
    await seedMerchant(merchantId, user, 'none');
    const entered = await as(user).merchant.businessProfile.submit({
      merchantId,
      expectedVersion: '0',
      reason: 'onboarding identity',
      legalName: 'Reviewed Shop Ltd',
      address: ADDRESS,
      statementDescriptor: 'REVIEWED',
      industry: 'Retail',
    });
    expect(entered.outcome).toBe('applied');
    const reviewed = await loadKybDecisionBinding(sql, merchantId);
    expect(reviewed?.identity.legalName).toBe('Reviewed Shop Ltd');
    expect(reviewed?.fields('approved')).not.toHaveProperty('profileVersion');
    const proposedHash = kybDecisionPayloadHash(PAY_MERCHANT_DECIDE_KYB, reviewed!.fields('approved'));
    let consumes = 0;
    const approvals: ActionApprovalConsumer = {
      async consume(input) {
        if (input.payloadHash !== proposedHash) {
          throw new ActionApprovalConsumeError('payload hash does not match the approved action', 'action_approval.consume_failed');
        }
        consumes += 1;
        return stubApprovalConsumer('approver-founder').consume(input);
      },
    };
    const pay = new PayService(sql, {} as LedgerClient, new RailRegistry([]), { valueMovement: 'live-only' });
    const decide = () =>
      createPayRouter(pay, new RailRegistry([]), {} as UserMoneyService, null, undefined, approvals, null, undefined, sql)
        .createCaller(ctxOf(principalOf(complianceUser, { scopes: ['admin:compliance'] })))
        .merchant.decideKyb({
          merchantId,
          decision: 'approved',
          approvalId: 'appr-kyb-identity',
          operationId: 'op-kyb-identity',
        });

    const changed = await as(user).merchant.businessProfile.submit({
      merchantId,
      expectedVersion: entered.version,
      reason: 'identity before the dossier',
      legalName: 'Unreviewed Shop Ltd',
    });
    expect(changed.outcome).toBe('applied');
    expect(changed.profile.legalName).toBe('Unreviewed Shop Ltd');
    await pay.submitKyb({ actor: KYB_ACTOR, merchantId, kybRef: 'dossier-stale' });
    expect(await kybOf(merchantId)).toBe('pending');

    await expect(decide()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(consumes).toBe(0);
    expect(await kybOf(merchantId)).toBe('pending');
    expect((await as(user).merchant.businessProfile.get({ merchantId })).legalName).toBe('Unreviewed Shop Ltd');

    let paySideEffects = 0;
    await expect(
      pay.decideKyb({
        actor: KYB_ACTOR,
        merchantId,
        decision: 'approved',
        identityHash: reviewed!.identityHash,
        beforeWrite: async () => {
          paySideEffects += 1;
        },
      }),
    ).rejects.toMatchObject({ code: 'pay.kyb_identity_changed' });
    expect(paySideEffects).toBe(0);
    expect(await kybOf(merchantId)).toBe('pending');

    const kyb = new KybService(sql);
    const staleKybHash = kybDecisionPayloadHash(
      PAY_KYB_DECIDE,
      kybApprovalFields({
        merchantId,
        decision: 'approved',
        identityHash: reviewed!.identityHash,
        reason: 'stale identity',
      }),
    );
    const kybApprovals: ActionApprovalConsumer = {
      async consume(input) {
        if (input.payloadHash !== staleKybHash) {
          throw new ActionApprovalConsumeError('payload hash does not match the approved action', 'action_approval.consume_failed');
        }
        consumes += 1;
        return stubApprovalConsumer('approver-founder').consume(input);
      },
    };
    await expect(
      createKybPspRouter(kyb, {} as PspModeService, kybApprovals, payLookup(sql))
        .createCaller(ctxOf(principalOf(complianceUser, { scopes: ['admin:compliance'] })))
        .kyb.decide({
          merchantId,
          decision: 'approved',
          reason: 'stale identity',
          approvalId: 'appr-kyb-stale',
          operationId: 'op-kyb-stale',
        }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(consumes).toBe(0);
    let sideEffects = 0;
    await expect(
      kyb.decide({
        merchantId,
        decision: 'approved',
        reason: 'stale identity',
        actorId: complianceUser,
        actorScope: 'admin:compliance',
        identityHash: reviewed!.identityHash,
        beforeWrite: async () => {
          sideEffects += 1;
        },
      }),
    ).rejects.toMatchObject({ code: 'pay.kyb_identity_changed' });
    expect(sideEffects).toBe(0);
    expect(await kybOf(merchantId)).toBe('pending');

    const current = await loadKybDecisionBinding(sql, merchantId);
    const currentHash = kybDecisionPayloadHash(PAY_MERCHANT_DECIDE_KYB, current!.fields('approved'));
    expect(currentHash).not.toBe(proposedHash);
    const fresh: ActionApprovalConsumer = {
      async consume(input) {
        if (input.payloadHash !== currentHash) {
          throw new ActionApprovalConsumeError('payload hash does not match the approved action', 'action_approval.consume_failed');
        }
        consumes += 1;
        return stubApprovalConsumer('approver-founder').consume(input);
      },
    };
    const approved = await createPayRouter(pay, new RailRegistry([]), {} as UserMoneyService, null, undefined, fresh, null, undefined, sql)
      .createCaller(ctxOf(principalOf(complianceUser, { scopes: ['admin:compliance'] })))
      .merchant.decideKyb({
        merchantId,
        decision: 'approved',
        approvalId: 'appr-kyb-current',
        operationId: 'op-kyb-current',
      });
    expect(approved.kybStatus).toBe('approved');
    expect(consumes).toBe(1);
    expect(await kybOf(merchantId)).toBe('approved');
  });

  it('keeps a KYB approval valid when website or support email changes while the dossier is pending', async () => {
    const user = id();
    const merchantId = id();
    await seedMerchant(merchantId, user, 'none');
    const entered = await as(user).merchant.businessProfile.submit({
      merchantId,
      expectedVersion: '0',
      reason: 'onboarding identity',
      legalName: 'Reviewed Shop Ltd',
      address: ADDRESS,
      statementDescriptor: 'REVIEWED',
      industry: 'Retail',
    });
    const reviewed = await loadKybDecisionBinding(sql, merchantId);
    const proposedHash = kybDecisionPayloadHash(PAY_MERCHANT_DECIDE_KYB, reviewed!.fields('approved'));
    const pay = new PayService(sql, {} as LedgerClient, new RailRegistry([]), { valueMovement: 'live-only' });
    await pay.submitKyb({ actor: KYB_ACTOR, merchantId, kybRef: 'dossier-contact' });
    const contact = await as(user).merchant.businessProfile.submit({
      merchantId,
      expectedVersion: entered.version,
      reason: 'public contact',
      website: 'https://shop.example',
      supportEmail: 'help@shop.example',
    });
    expect(contact.outcome).toBe('applied');
    expect(contact.profile.version).not.toBe(entered.version);
    expect(contact.profile.website).toBe('https://shop.example');
    expect(contact.profile.supportEmail).toBe('help@shop.example');
    expect(contact.profile.legalName).toBe('Reviewed Shop Ltd');
    const live = await loadKybDecisionBinding(sql, merchantId);
    expect(live?.identityHash).toBe(reviewed!.identityHash);
    expect(kybDecisionPayloadHash(PAY_MERCHANT_DECIDE_KYB, live!.fields('approved'))).toBe(proposedHash);

    let consumes = 0;
    const approvals: ActionApprovalConsumer = {
      async consume(input) {
        if (input.payloadHash !== proposedHash) {
          throw new ActionApprovalConsumeError('payload hash does not match the approved action', 'action_approval.consume_failed');
        }
        consumes += 1;
        return stubApprovalConsumer('approver-founder').consume(input);
      },
    };
    const approved = await createPayRouter(
      pay,
      new RailRegistry([]),
      {} as UserMoneyService,
      null,
      undefined,
      approvals,
      null,
      undefined,
      sql,
    )
      .createCaller(ctxOf(principalOf(complianceUser, { scopes: ['admin:compliance'] })))
      .merchant.decideKyb({
        merchantId,
        decision: 'approved',
        approvalId: 'appr-kyb-contact',
        operationId: 'op-kyb-contact',
      });
    expect(approved.kybStatus).toBe('approved');
    expect(approved.confirmOperatorId).toBe('approver-founder');
    expect(consumes).toBe(1);
    expect(await kybOf(merchantId)).toBe('approved');
  });

  it('kyb.decisionBinding returns the reviewed identity to compliance and refuses everyone else', async () => {
    const user = id();
    const other = id();
    const merchantId = id();
    const otherMerchant = id();
    await seedMerchant(merchantId, user, 'none');
    await seedMerchant(otherMerchant, other, 'none');
    await as(user).merchant.businessProfile.submit({
      merchantId,
      expectedVersion: '0',
      reason: 'onboarding identity',
      legalName: 'Reviewed Shop Ltd',
      address: ADDRESS,
      statementDescriptor: 'REVIEWED',
      industry: 'Retail',
    });
    await as(other).merchant.businessProfile.submit({
      merchantId: otherMerchant,
      expectedVersion: '0',
      reason: 'other identity',
      legalName: 'Other Shop Ltd',
      address: { ...ADDRESS, line1: '9 Other' },
    });
    const reviewed = await loadKybDecisionBinding(sql, merchantId);
    const kyb = new KybService(sql);
    const api = createKybPspRouter(kyb, {} as PspModeService, stubApprovalConsumer('approver-founder'), payLookup(sql));
    const compliance = api.createCaller(ctxOf(principalOf(complianceUser, { scopes: ['admin:compliance'] })));
    const view = await compliance.kyb.decisionBinding({ merchantId });
    expect(view).toEqual({
      merchantId,
      legalName: 'Reviewed Shop Ltd',
      address: ADDRESS,
      statementDescriptor: 'REVIEWED',
      industry: 'Retail',
      identityHash: reviewed!.identityHash,
    });
    expect(view).not.toHaveProperty('profileVersion');
    expect(JSON.stringify(view)).not.toContain('Other Shop Ltd');
    const otherView = await compliance.kyb.decisionBinding({ merchantId: otherMerchant });
    expect(otherView.legalName).toBe('Other Shop Ltd');
    expect(otherView.identityHash).not.toBe(view.identityHash);

    await expect(api.createCaller(ctxOf(principalOf(user))).kyb.decisionBinding({ merchantId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      api.createCaller(ctxOf(principalOf(complianceUser, { scopes: ['admin:read'] }))).kyb.decisionBinding({ merchantId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      api.createCaller(ctxOf(principalOf(complianceUser, { scopes: ['admin:write'] }))).kyb.decisionBinding({ merchantId: otherMerchant }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      api
        .createCaller(ctxOf(principalOf(complianceUser, { scopes: ['admin:compliance'], mfa: false })))
        .kyb.decisionBinding({ merchantId }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(compliance.kyb.decisionBinding({ merchantId: id() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await as(user).merchant.businessProfile.get({ merchantId })).legalName).toBe('Reviewed Shop Ltd');
  });

  it('J-merchant-02 #5: onboarding counts a verified or held destination as present, never an unverified one', async () => {
    const present = async () => {
      const progress = await as(viewer).merchant.onboarding.progress({ merchantId: merchantA });
      return { present: progress.destination.present, missing: progress.blocking.includes('destination_missing') };
    };
    try {
      await sql`UPDATE pay.merchant_payout_destinations SET verified = false, verified_at = NULL WHERE merchant_id = ${merchantA}`;
      expect(await present()).toEqual({ present: false, missing: true });
      // Held: stored fail closed (verified = false) with its hold end; verified all the same, so it counts.
      await sql`
        UPDATE pay.merchant_payout_destinations
           SET verified_at = now(), activates_at = now() + interval '1 hour'
         WHERE merchant_id = ${merchantA}`;
      expect(await present()).toEqual({ present: true, missing: false });
    } finally {
      await sql`
        UPDATE pay.merchant_payout_destinations
           SET verified = true, verified_at = now(), activates_at = NULL
         WHERE merchant_id = ${merchantA}`;
    }
    expect(await present()).toEqual({ present: true, missing: false });
  });

  it('reports onboarding blockers without a document vendor, a terms version, a category table, or a raw destination', async () => {
    const progress = await as(viewer).merchant.onboarding.progress({ merchantId: merchantA });
    expect(progress.documents).toEqual({ state: 'pending_vendor' });
    expect(progress.terms).toEqual({ state: 'not_configured' });
    expect(progress.business.done).toBe(true);
    expect(progress.destination.present).toBe(true);
    // The business category table is empty here, so no business can go live (RC-merchant-08).
    expect(progress.blocking).toEqual(['documents_pending_vendor', 'terms_not_configured', 'category_policy_unset']);
    // norm() blanks the random ids first, so a uuid that happens to hold '1111' or 'abcd' can neither pass nor fail these checks.
    const text = norm(JSON.stringify(progress));
    expect(text).not.toContain(destRef);
    expect(text).toContain('1111');
    const parent = await asTree(parentUser).merchant.onboarding.progress({ merchantId: grandId });
    expect(parent.destination.present).toBe(true);
    expect(parent.destination.destinations.map((row) => row.destinationMasked).join(' ')).toContain('abcd');
    expect(JSON.stringify(parent)).not.toContain(GRAND_DEST);
    const mid = await asTree(childUser).merchant.onboarding.progress({ merchantId: grandId });
    expect(mid.destination.present).toBe(true);
    expect(mid.destination.destinations).toEqual([]);
    const hidden = norm(JSON.stringify(mid));
    expect(hidden).not.toContain(GRAND_DEST);
    expect(hidden).not.toContain('abcd');
  });

  it('takes the published terms from the owner once per version, and refuses everyone else', async () => {
    const TERMS = { version: 'TEST-terms-1', url: 'https://terms.example/TEST-terms-1' };
    const withTerms = (userId: string, over: Partial<Principal> = {}, terms: typeof TERMS | null = TERMS) =>
      createMerchantPortalRouter({ ...portalDeps(false), terms }).createCaller(ctxOf(principalOf(userId, over)));
    const onboard = { scopes: ['pay:onboard'] as Principal['scopes'] };
    const user = id();
    const merchantId = id();
    await seedMerchant(merchantId, user, 'none');

    const unpublished = await refusal(() => withTerms(user, onboard, null).merchant.terms.accept({ merchantId, version: 'TEST-terms-1' }));
    expect(unpublished).toMatchObject({ code: 'PRECONDITION_FAILED', message: 'pay.merchant_terms_unset' });
    expect((await withTerms(user, onboard).merchant.onboarding.progress({ merchantId })).terms).toEqual({
      state: 'not_accepted',
      ...TERMS,
    });
    expect((await withTerms(user, onboard).merchant.onboarding.progress({ merchantId })).blocking).toContain('terms_not_accepted');

    const stale = await refusal(() => withTerms(user, onboard).merchant.terms.accept({ merchantId, version: 'TEST-terms-0' }));
    expect(stale).toMatchObject({ code: 'CONFLICT', message: 'pay.merchant_terms_version_stale' });
    const helper = id();
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchantId}, ${helper}, 'admin', 'active', ${user}, now())`;
    const teammate = await refusal(() => withTerms(helper, onboard).merchant.terms.accept({ merchantId, version: TERMS.version }));
    expect(teammate.message).toBe('pay.team_role_forbidden');
    const stranger = await refusal(() => withTerms(id(), onboard).merchant.terms.accept({ merchantId, version: TERMS.version }));
    expect(stranger.code).toBe('NOT_FOUND');
    const keyed = await refusal(() => withTerms(user, { kid: 'ifc_test' }).merchant.terms.accept({ merchantId, version: TERMS.version }));
    expect(keyed.message).toBe('pay.profile_interactive_only');

    const accepted = await withTerms(user, onboard).merchant.terms.accept({ merchantId, version: TERMS.version });
    expect(accepted).toMatchObject({ merchantId, version: TERMS.version });
    const again = await withTerms(user).merchant.terms.accept({ merchantId, version: TERMS.version });
    expect(again.acceptedAt).toBe(accepted.acceptedAt);
    const rows = await sql<Array<{ accepted_by: string; actor_scope: string; terms_url: string }>>`
      SELECT accepted_by, actor_scope, terms_url FROM pay.merchant_terms_acceptances WHERE merchant_id = ${merchantId}`;
    expect(rows).toEqual([{ accepted_by: user, actor_scope: 'pay:onboard', terms_url: TERMS.url }]);
    const progress = await withTerms(user, onboard).merchant.onboarding.progress({ merchantId });
    expect(progress.terms).toEqual({ state: 'accepted', ...TERMS, acceptedAt: accepted.acceptedAt });
    expect(progress.blocking).not.toContain('terms_not_accepted');
    // The acceptance keeps the address it was read at, even if the setting later points somewhere else for the same version.
    const moved = { version: TERMS.version, url: 'https://terms.example/elsewhere' };
    expect((await withTerms(user, onboard, moved).merchant.onboarding.progress({ merchantId })).terms).toMatchObject({ url: TERMS.url });
    // A new published version needs a new acceptance.
    const next = { version: 'TEST-terms-2', url: 'https://terms.example/TEST-terms-2' };
    expect((await withTerms(user, onboard, next).merchant.onboarding.progress({ merchantId })).terms.state).toBe('not_accepted');
    await expect(sql`UPDATE pay.merchant_terms_acceptances SET version = 'x' WHERE merchant_id = ${merchantId}`).rejects.toThrow(
      /append-only/,
    );

    // This test's own merchant, so leaving it suspended touches no other test.
    await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${merchantId}`;
    const shut = await refusal(() => withTerms(user, onboard, next).merchant.terms.accept({ merchantId, version: next.version }));
    expect(shut.message).toBe('pay.owner_grant_withdrawn');
  });

  it('reads volume and fees per asset and per week, and never adds two assets together', async () => {
    const volume = await as(viewer).merchantAnalytics.volume({ merchantId: merchantA, ...WINDOW, bucket: 'week', limit: 10 });
    const usdt = volume.items.filter((item) => item.assetCode === 'USDT');
    const usdc = volume.items.filter((item) => item.assetCode === 'USDC');
    expect(usdt.map((item) => item.volume).sort()).toEqual(['3', '8']);
    expect(usdc.map((item) => item.volume)).toEqual(['4']);
    expect(volume.items.some((item) => item.volume === '7' || item.volume === '15')).toBe(false);
    const page = await as(finance).merchantAnalytics.volume({ merchantId: merchantA, ...WINDOW, bucket: 'day', limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = await as(finance).merchantAnalytics.volume({
      merchantId: merchantA,
      ...WINDOW,
      bucket: 'day',
      limit: 10,
      cursor: page.nextCursor!,
    });
    expect(next.items.map((item) => `${item.period}:${item.assetCode}`)).not.toContain(
      `${page.items[0]!.period}:${page.items[0]!.assetCode}`,
    );
    const fees = await as(developer).merchantAnalytics.fees({ merchantId: merchantA, ...WINDOW, bucket: 'day', limit: 10 });
    const feeText = JSON.stringify(fees);
    expect(fees.effectiveRate).toBeNull();
    expect(fees.effectiveRateReason).toBe('not_aggregated');
    expect(fees.rates).toEqual([
      { assetCode: 'USDC', fees: '1', gross: '4', rate: '0.25', rateStatus: 'exact' },
      { assetCode: 'USDT', fees: '1', gross: '10', rate: '0.1', rateStatus: 'exact' },
    ]);
    const paged = await as(developer).merchantAnalytics.fees({ merchantId: merchantA, ...WINDOW, bucket: 'day', limit: 1 });
    expect(paged.items).toHaveLength(1);
    expect(paged.rates).toEqual(fees.rates);
    const oneAsset = await as(developer).merchantAnalytics.fees({
      merchantId: merchantA,
      ...WINDOW,
      bucket: 'day',
      limit: 10,
      assetId: 'USDT',
    });
    expect(oneAsset.rates).toEqual([{ assetCode: 'USDT', fees: '1', gross: '10', rate: '0.1', rateStatus: 'exact' }]);
    await sql`
      INSERT INTO pay.metrics_merchant_day (merchant_id, day, asset_code, settle_gross, settle_fees, settle_net)
      VALUES
        (${merchantA}, '2026-10-07', 'BTC', 0, 1, 0),
        (${merchantA}, '2026-10-07', 'ETH', 3, 1, 2)`;
    const odd = await as(developer).merchantAnalytics.fees({ merchantId: merchantA, ...WINDOW, bucket: 'day', limit: 10 });
    expect(odd.rates).toEqual(
      expect.arrayContaining([
        { assetCode: 'BTC', fees: '1', gross: '0', rate: null, rateStatus: 'no_volume' },
        { assetCode: 'ETH', fees: '1', gross: '3', rate: '0.333333', rateStatus: 'rounded' },
      ]),
    );
    expect(fees.conversionCost).toBeNull();
    expect(fees.byRule).toEqual([]);
    expect(feeText).not.toContain('feeBps');
    expect(feeText).not.toContain('ruleId');
    const usdtFees = fees.items.find((item) => item.assetCode === 'USDT' && item.period === '2026-10-05');
    expect(usdtFees).toMatchObject({ gross: '10', fees: '1', net: '9' });
    const ghost = id();
    const foreign = await refusal(() => as(stranger).merchantAnalytics.fees({ merchantId: merchantA, ...WINDOW, bucket: 'day', limit: 5 }));
    const missing = await refusal(() => as(stranger).merchantAnalytics.fees({ merchantId: ghost, ...WINDOW, bucket: 'day', limit: 5 }));
    expect(norm(foreign.message)).toBe(norm(missing.message));
    expect(foreign.code).toBe('NOT_FOUND');
  });

  it('aggregates one customer per asset and refuses another merchant’s ref like a missing ref', async () => {
    const series = await ops(owner).merchantOps.customers.series({
      customerRef: 'cust-a',
      ...WINDOW,
      bucket: 'week',
      limit: 10,
    });
    expect(series.items.filter((item) => item.assetCode === 'USDT').map((item) => item.volume)).toEqual(['3']);
    expect(series.items.filter((item) => item.assetCode === 'USDC').map((item) => ({ volume: item.volume, count: item.count }))).toEqual([
      { volume: '4', count: 1 },
    ]);
    expect(series.items.some((item) => item.volume === '7')).toBe(false);
    const foreign = await refusal(() =>
      ops(owner).merchantOps.customers.series({ customerRef: 'cust-b', ...WINDOW, bucket: 'day', limit: 5 }),
    );
    const missing = await refusal(() =>
      ops(owner).merchantOps.customers.series({ customerRef: 'cust-missing', ...WINDOW, bucket: 'day', limit: 5 }),
    );
    expect(foreign).toEqual(missing);
    expect(foreign.cause).toBe('pay.customer_not_found');
  });

  it('summarizes a PayFac child under the parent and withholds areas the node does not hold', async () => {
    const summary = await trees(parentUser).submerchant.summary({ merchantId: childId, recentPaymentsLimit: 5, grantsLimit: 10 });
    expect(summary.displayName).toBe('Child');
    expect(summary.volume?.items.map((item) => item.volume).sort()).toEqual(['5', '6']);
    expect(summary.recentPayments?.items.map((item) => item.amount)).toContain('3');
    expect(JSON.stringify(summary.recentPayments)).not.toContain('rail-');
    expect(summary.grants?.items).toEqual([]);
    const mid = await trees(childUser).submerchant.summary({ merchantId: grandId, recentPaymentsLimit: 5, grantsLimit: 10 });
    expect(mid.volume).toBeNull();
    expect(mid.recentPayments).toBeNull();
    expect(mid.grants).toBeNull();
    const ghost = id();
    const foreign = await refusal(() => trees(owner).submerchant.summary({ merchantId: childId, recentPaymentsLimit: 5, grantsLimit: 10 }));
    const missing = await refusal(() => trees(owner).submerchant.summary({ merchantId: ghost, recentPaymentsLimit: 5, grantsLimit: 10 }));
    expect(norm(foreign.message)).toBe(norm(missing.message));
    expect(foreign.code).toBe(missing.code);
  });
});
