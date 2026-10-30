import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { PAYMENT_UNMASK_REASON_MIN } from '@intafaced/contracts/pay-payment-views';
import { ActivityFeed } from './activity.js';
import { resolveExportColumns } from './exports.js';
import { maskRailRef, PaymentPrivacy, PaymentViews, seesClearRailRef } from './payment-views.js';
import type { MerchantCaller, MerchantRole } from './roles.js';

/** M-adv-payments-core-01: saved payment views, the masked payer email and the unmask audit, on real Postgres. */
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
    .withDatabase('intafaced_payment_views_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('payment views and unmask (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  let views!: PaymentViews;
  let privacy!: PaymentPrivacy;
  let merchant = '';
  let otherMerchant = '';
  let paid = '';
  let bare = '';
  let foreign = '';
  const owner = randomUUID();
  const email = 'ada.test@example.test';

  const caller = (role: MerchantRole, userId: string = randomUUID(), extra: Partial<MerchantCaller> = {}): MerchantCaller => ({
    merchantId: merchant,
    userId,
    role,
    viaApiKey: false,
    interactive: true,
    ...extra,
  });
  const base = {
    visibility: 'private' as const,
    filters: { status: 'captured' as const },
    columns: ['amount' as const, 'customerEmail' as const],
  };

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    views = new PaymentViews(sql);
    privacy = new PaymentPrivacy(sql);
    merchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
    otherMerchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${randomUUID()}) RETURNING id`)[0]!.id;
    const rows = await sql<Array<{ id: string; rail_ref: string | null }>>`
      INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, rail_ref, status)
      VALUES (${merchant}, 10, 'USDT', 'card', 'card-sandbox', 'TEST-rail-ref-0001', 'captured'),
             (${merchant}, 4, 'USDT', 'card', 'card-sandbox', NULL, 'created'),
             (${otherMerchant}, 5, 'USDT', 'card', 'card-sandbox', 'TEST-rail-ref-0002', 'captured')
      RETURNING id, rail_ref`;
    [paid, bare, foreign] = rows.map((r) => r.id) as [string, string, string];
    await sql`
      INSERT INTO pay.merchant_invoices (merchant_id, status, asset_id, amount, customer_email, payment_id, paid_at, created_by)
      VALUES (${merchant}, 'paid', 'USDT', 10, ${email}, ${paid}, now(), ${owner})`;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  it('saves a private view and answers the same view again for the same name and content', async () => {
    const me = caller('viewer');
    const first = await views.create(me, { ...base, name: 'TEST captured' });
    expect(first).toMatchObject({
      name: 'TEST captured',
      visibility: 'private',
      filters: { status: 'captured' },
      mine: true,
      editable: true,
    });
    expect(first.columns).toEqual(['amount', 'customerEmail']);
    const again = await views.create(me, { ...base, name: 'TEST captured' });
    expect(again.id).toBe(first.id);
    expect(await refusal(() => views.create(me, { ...base, name: 'test CAPTURED', columns: ['amount'] }))).toBe(
      'pay.payment_view_name_taken',
    );
    const listed = await views.list(me, { limit: 50 });
    expect(listed.items.map((v) => v.id)).toContain(first.id);
  });

  it('keeps a private view from teammates: it is not listed and reads as not found', async () => {
    const maker = caller('finance');
    const view = await views.create(maker, { ...base, name: 'TEST mine only' });
    const mate = caller('admin');
    expect((await views.list(mate, { limit: 50 })).items.map((v) => v.id)).not.toContain(view.id);
    expect(await refusal(() => views.remove(mate, { viewId: view.id }))).toBe('pay.payment_view_not_found');
  });

  it('lets only the owner or an admin share a view; a teammate sees it and cannot change it', async () => {
    expect(await refusal(() => views.create(caller('finance'), { ...base, name: 'TEST shared', visibility: 'shared' }))).toBe(
      'pay.payment_view_shared_admin_only',
    );
    const shared = await views.create(caller('owner', owner), { ...base, name: 'TEST shared', visibility: 'shared' });
    const viewer = caller('viewer');
    const seen = (await views.list(viewer, { limit: 50 })).items.find((v) => v.id === shared.id);
    expect(seen).toMatchObject({ mine: false, editable: false });
    expect(await refusal(() => views.update(viewer, { viewId: shared.id, expectedRevision: 0, columns: ['amount'] }))).toBe(
      'pay.payment_view_forbidden',
    );
    const admin = caller('admin');
    const changed = await views.update(admin, { viewId: shared.id, expectedRevision: 0, columns: ['amount', 'status'] });
    expect(changed).toMatchObject({ revision: 1, columns: ['amount', 'status'] });
    expect(await refusal(() => views.update(admin, { viewId: shared.id, expectedRevision: 0, name: 'TEST late' }))).toBe(
      'pay.payment_view_stale',
    );
    expect(await views.remove(admin, { viewId: shared.id })).toEqual({ deleted: true });
  });

  it('treats the same columns in another order as the same view, and stores them in list order', async () => {
    const me = caller('developer');
    const first = await views.create(me, { ...base, name: 'TEST order', columns: ['customerEmail', 'amount'] });
    expect(first.columns).toEqual(['amount', 'customerEmail']);
    const again = await views.create(me, { ...base, name: 'TEST order', columns: ['amount', 'customerEmail'] });
    expect(again.id).toBe(first.id);
  });

  it('leaves the rail reference out of a payments export for roles that read it masked', () => {
    expect(resolveExportColumns('payments', 'viewer', undefined)).not.toContain('rail_reference');
    expect(resolveExportColumns('payments', 'developer', undefined)).not.toContain('rail_reference');
    expect(resolveExportColumns('payments', 'finance', undefined)).toContain('rail_reference');
    expect(() => resolveExportColumns('payments', 'viewer', ['payment_id', 'rail_reference'])).toThrow(/pay\.export_columns_forbidden/);
  });

  it('refuses a view write from an API key or a session without MFA', async () => {
    expect(await refusal(() => views.create(caller('owner', owner, { viaApiKey: true }), { ...base, name: 'TEST key' }))).toBe(
      'pay.payment_view_interactive_only',
    );
    expect(await refusal(() => views.create(caller('owner', owner, { interactive: false }), { ...base, name: 'TEST nomfa' }))).toBe(
      'pay.payment_view_interactive_only',
    );
  });

  it('masks the payer email from the invoice the payment paid, and none for a payment without one', async () => {
    const masked = await privacy.maskedEmails(merchant, [paid, bare, foreign]);
    expect(masked.get(paid)).toBe('a***@e***.test');
    expect(masked.has(bare)).toBe(false);
    expect(masked.has(foreign)).toBe(false);
  });

  it('masks the rail reference for roles that cannot unmask', () => {
    expect(maskRailRef('TEST-rail-ref-0001')).toBe('***0001');
    expect(maskRailRef('short')).toBe('***');
    expect(maskRailRef(null)).toBeNull();
    expect(seesClearRailRef('viewer')).toBe(false);
    expect(seesClearRailRef('developer')).toBe(false);
    expect(seesClearRailRef('finance')).toBe(true);
    expect(seesClearRailRef('owner')).toBe(true);
  });

  it('refuses unmask to a viewer and a developer, and writes no audit line', async () => {
    const before = (await sql`SELECT count(*)::int AS n FROM pay.payment_unmask_reads`)[0]!.n as number;
    for (const role of ['viewer', 'developer'] as const)
      expect(
        await refusal(() => privacy.unmask(caller(role), { paymentId: paid, field: 'customerEmail', reason: 'TEST reason here' })),
      ).toBe('pay.team_role_forbidden');
    expect((await sql`SELECT count(*)::int AS n FROM pay.payment_unmask_reads`)[0]!.n).toBe(before);
  });

  it('refuses unmask without a reason, from an API key, and for another business’s payment', async () => {
    const finance = caller('finance');
    // The contract lets any reason through (no minimum there), so the service's check is the one rule: none, a short
    // one, and one that is short only once trimmed are each refused with the typed code.
    for (const reason of ['', '  short ', ` ${'x'.repeat(PAYMENT_UNMASK_REASON_MIN - 1)} `]) {
      expect(await refusal(() => privacy.unmask(finance, { paymentId: paid, field: 'customerEmail', reason }))).toBe(
        'pay.payment_unmask_reason_required',
      );
    }
    expect(
      await refusal(() =>
        privacy.unmask(caller('finance', randomUUID(), { viaApiKey: true }), {
          paymentId: paid,
          field: 'customerEmail',
          reason: 'TEST reason here',
        }),
      ),
    ).toBe('pay.payment_unmask_interactive_only');
    expect(await refusal(() => privacy.unmask(finance, { paymentId: foreign, field: 'customerEmail', reason: 'TEST reason here' }))).toBe(
      'pay.payment_not_found',
    );
  });

  it('gives finance the clear value and writes the audit line first, which the owner reads and the activity feed shows', async () => {
    const financeId = randomUUID();
    const finance = caller('finance', financeId);
    const out = await privacy.unmask(finance, { paymentId: paid, field: 'customerEmail', reason: '  TEST payer asked for a receipt ' });
    expect(out).toMatchObject({ paymentId: paid, field: 'customerEmail', value: email });
    // A payment that paid no invoice has no email: the answer says none, and the ask is still on the audit.
    const none = await privacy.unmask(finance, { paymentId: bare, field: 'customerEmail', reason: 'TEST checking a payer' });
    expect(none.value).toBeNull();
    expect((await sql`SELECT count(*)::int AS n FROM pay.payment_unmask_reads WHERE id = ${none.auditId}`)[0]!.n).toBe(1);
    expect(await refusal(() => privacy.reads(finance, { limit: 10 }))).toBe('pay.team_role_forbidden');
    const reads = await privacy.reads(caller('owner', owner), { paymentId: paid, limit: 10 });
    const line = reads.items.find((r) => r.id === out.auditId);
    expect(line).toMatchObject({
      paymentId: paid,
      field: 'customerEmail',
      actorId: financeId,
      actorRole: 'finance',
      reason: 'TEST payer asked for a receipt',
    });
    // The audit line never holds the clear value.
    expect(JSON.stringify(reads.items)).not.toContain(email);
    const feed = await new ActivityFeed(sql).list(caller('owner', owner), { limit: 50, action: 'payment.unmasked' });
    const shown = feed.items.find((a) => a.objectId === paid && a.actorId === financeId);
    expect(shown).toMatchObject({ objectType: 'payment', action: 'payment.unmasked' });
    expect(shown?.detail).toMatchObject({ field: 'customerEmail', role: 'finance' });
  });
});
