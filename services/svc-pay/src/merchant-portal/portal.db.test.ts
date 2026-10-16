import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Context } from '@intafaced/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createFounderAuthority } from '../founder-authority.js';
import { teamReadFromSql } from '../merchant-team-read.js';
import { createMerchantOpsRouter } from '../merchant-ops/router.js';
import { PayError, type MerchantRecord } from '../payment-service.js';
import { SubMerchantService } from '../submerchants.js';
import { createSubMerchantRouter } from '../submerchant-router.js';
import { createMerchantPortalRouter } from './router.js';

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
  scopes: ['pay:read', 'pay:write'],
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
    await insert(merchantB, stranger, { name: 'Beta' });
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
      INSERT INTO pay.merchant_payout_destinations (merchant_id, rail_id, kind, ref)
      VALUES (${merchantA}, 'crypto-native', 'crypto', ${destRef})`;
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

  const portal = () =>
    createMerchantPortalRouter({ sql, pay: payLookup(sql), trees: null, team: teamReadFromSql(sql) }).createCaller(
      ctxOf(principalOf(owner)),
    );
  const as = (userId: string, over: Partial<Principal> = {}) =>
    createMerchantPortalRouter({ sql, pay: payLookup(sql), trees: null, team: teamReadFromSql(sql) }).createCaller(
      ctxOf(principalOf(userId, over)),
    );
  const ops = (userId: string) =>
    createMerchantOpsRouter({
      sql,
      founderAuthority: createFounderAuthority({
        identityUrl: 'https://identity.invalid',
        serviceSecret: 's'.repeat(32),
        principalSecret: 'p'.repeat(32),
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
    expect(mine.memberships[0]?.pricingVisibility).toBe('full');
    expect(mine.memberships[0]?.capabilities['profile.manage']).toBe(true);
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
    expect(pending.outcome).toBe('pending_second_approval');
    expect(pending.changeHash).toEqual(expect.any(String));
    expect(pending.profile.legalName).toBe('Alpha Ltd');
    const self = await refusal(() =>
      as(owner).merchant.businessProfile.confirm({
        merchantId: merchantA,
        requestId: pending.requestId,
        decision: 'confirm',
        expectedChangeHash: pending.changeHash!,
        reason: 'self',
      }),
    );
    expect(self.cause).toBe('pay.profile_self_approval');
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
    const still = await as(owner).merchant.businessProfile.get({ merchantId: merchantA });
    expect(still.legalName).toBe('Alpha Ltd');
    await expect(
      as(finance).merchant.businessProfile.submit({
        merchantId: merchantA,
        expectedVersion: still.version,
        reason: 'finance cannot',
        industry: 'Retail',
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'pay.team_role_forbidden' }) });
    for (const userId of [viewer, developer]) {
      await expect(
        as(userId).merchant.businessProfile.submit({
          merchantId: merchantA,
          expectedVersion: still.version,
          reason: 'role fence',
          displayName: 'Nope',
        }),
      ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'pay.team_role_forbidden' }) });
    }
    await expect(
      as(owner, { kid: 'ifc_test', mfa: true }).merchant.businessProfile.submit({
        merchantId: merchantA,
        expectedVersion: still.version,
        reason: 'key',
        displayName: 'Nope',
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'pay.profile_interactive_only' }) });
    const confirmed = await as(adminA).merchant.businessProfile.confirm({
      merchantId: merchantA,
      requestId: pending.requestId,
      decision: 'confirm',
      expectedChangeHash: pending.changeHash!,
      reason: 'second approval',
    });
    expect(confirmed.outcome).toBe('applied');
    expect(confirmed.profile.legalName).toBe('Alpha Legal Ltd');
    const history = await as(viewer).merchant.businessProfile.history({ merchantId: merchantA, limit: 10 });
    expect(history.items.some((item) => item.requestId === pending.requestId && item.status === 'applied')).toBe(true);
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
    expect(submitted.outcome).toBe('pending_second_approval');
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

  it('reports onboarding blockers without a document vendor, a terms version, or a raw destination', async () => {
    const progress = await as(viewer).merchant.onboarding.progress({ merchantId: merchantA });
    expect(progress.documents).toEqual({ state: 'pending_vendor' });
    expect(progress.terms).toEqual({ state: 'not_configured' });
    expect(progress.business.done).toBe(true);
    expect(progress.destination.present).toBe(true);
    expect(progress.blocking).toEqual(['documents_pending_vendor', 'terms_not_configured']);
    const text = JSON.stringify(progress);
    expect(text).not.toContain(destRef);
    expect(text).toContain('1111');
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
