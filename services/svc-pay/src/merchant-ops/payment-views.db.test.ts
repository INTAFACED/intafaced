import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createPaymentViewsNamespaceRouter } from './payment-views-router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

const nid = () => randomUUID();
const principalOf = (userId: string, over: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: nid(),
  scopes: ['pay:read', 'pay:onboard', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
  ...over,
});
const ctxOf = (principal: Principal): Context => ({
  principal,
  service: null,
  region: 'DE',
  requestId: nid(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
});

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    const err = error as { code?: string; message?: string; cause?: { code?: string } };
    return { code: err.code, message: err.message, cause: err.cause?.code };
  }
  throw new Error('expected a refusal');
}

const saved = {
  name: 'Open',
  visibility: 'private' as const,
  filters: { status: 'captured' },
  sort: { field: 'createdAt', direction: 'desc' },
  columns: ['status', 'amount'],
};

describe('saved payment views and shopper unmask (M-adv-payments-core-01)', () => {
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = nid();
  const other = nid();
  const admin = nid();
  const finance = nid();
  const viewer = nid();
  let merchant = '';
  let paymentId = '';
  const email = 'buyer@example.com';
  const person = 'Ada Lovelace';
  const railRef = 'rail-secret-1234';

  const api = (userId: string, over: Partial<Principal> = {}) =>
    createPaymentViewsNamespaceRouter({ sql }).createCaller(ctxOf(principalOf(userId, over)));

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'pay', migrations });
    sql = db.sql;
    merchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
    await sql`INSERT INTO pay.merchants (user_id) VALUES (${other})`;
    for (const [userId, role] of [
      [admin, 'admin'],
      [finance, 'finance'],
      [viewer, 'viewer'],
    ] as const) {
      await sql`
        INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
        VALUES (${merchant}, ${userId}, ${role}, 'active', ${owner}, now())`;
    }
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, rail_ref, status)
      VALUES (${merchant}, '10', 'USDT', 'crypto', 'crypto-native', ${railRef}, 'created')
      RETURNING id`;
    paymentId = rows[0]!.id;
    await sql`
      INSERT INTO pay.payment_events (payment_id, event, payload)
      VALUES (
        ${paymentId},
        'created',
        ${sql.json({ metadata: { email, name: person, customerEmail: 'ignored@example.com' } })}
      )`;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('saves a private view once, restores the filter and columns, and refuses a different body for the same name', async () => {
    const ownerApi = api(owner);
    const first = await ownerApi.paymentViews.create(saved);
    const again = await ownerApi.paymentViews.create({ ...saved, name: '  Open  ' });
    expect(again.id).toBe(first.id);
    expect(again.filters).toEqual({ status: 'captured' });
    expect(again.columns).toEqual(['status', 'amount']);
    expect(again.sort).toEqual({ field: 'createdAt', direction: 'desc' });
    const conflict = await refusal(() => ownerApi.paymentViews.create({ ...saved, columns: ['amount'] }));
    expect(conflict.cause).toBe('pay.payment_view_conflict');
    const listed = await ownerApi.paymentViews.list({});
    expect(listed.items.map((item) => item.id)).toContain(first.id);
    const hidden = await refusal(() => api(viewer).paymentViews.delete({ viewId: first.id }));
    expect(hidden.cause).toBe('pay.payment_view_not_found');
    const extra = await ownerApi.paymentViews.create({ ...saved, name: 'Disposable', columns: ['id'] });
    expect(await ownerApi.paymentViews.delete({ viewId: extra.id })).toEqual({ deleted: true });
    expect((await ownerApi.paymentViews.list({})).items.map((item) => item.name)).not.toContain('Disposable');
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.merchant_payment_views WHERE merchant_id = ${merchant} AND name = 'Open'`;
    expect(rows[0]?.n).toBe(1);
  });

  it('two identical creates leave one view', async () => {
    const ownerApi = api(owner);
    const input = { ...saved, name: 'Together', columns: ['id', 'createdAt'] };
    const [left, right] = await Promise.all([ownerApi.paymentViews.create(input), ownerApi.paymentViews.create(input)]);
    expect(left.id).toBe(right.id);
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.merchant_payment_views WHERE name = 'Together'`;
    expect(rows[0]?.n).toBe(1);
  });

  it('hides a private view from a teammate and refuses a blank name without writing', async () => {
    const before = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.merchant_payment_views`;
    const blank = await refusal(() => api(owner).paymentViews.create({ ...saved, name: '   ' }));
    expect(blank.cause).toBe('pay.payment_view_name_blank');
    const mine = await api(viewer).paymentViews.list({});
    expect(mine.items.map((item) => item.name)).not.toContain('Open');
    const after = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.merchant_payment_views`;
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it('lets an admin share a view, shows it to finance, and refuses a finance edit', async () => {
    const shared = await api(admin).paymentViews.create({
      ...saved,
      name: 'Shared',
      visibility: 'shared',
      columns: ['status', 'customerEmail'],
    });
    const seen = await api(finance).paymentViews.list({});
    expect(seen.items.map((item) => item.id)).toContain(shared.id);
    const refused = await refusal(() =>
      api(finance).paymentViews.update({
        viewId: shared.id,
        filters: saved.filters,
        sort: saved.sort,
        columns: ['amount'],
      }),
    );
    expect(refused.cause).toBe('pay.payment_view_shared_forbidden');
    const financeCreate = await refusal(() => api(finance).paymentViews.create({ ...saved, name: 'Finance shared', visibility: 'shared' }));
    expect(financeCreate.cause).toBe('pay.payment_view_shared_forbidden');
    const updated = await api(admin).paymentViews.update({
      viewId: shared.id,
      name: 'Shared renamed',
      filters: { status: 'failed' },
      sort: { field: 'amount', direction: 'asc' },
      columns: ['amount', 'status'],
    });
    expect(updated.name).toBe('Shared renamed');
    expect(updated.columns).toEqual(['amount', 'status']);
    expect(updated.visibility).toBe('shared');
  });

  it('a stranger gets the same not-found for a real view and a missing one', async () => {
    const [real] = await sql<Array<{ id: string }>>`
      SELECT id FROM pay.merchant_payment_views WHERE merchant_id = ${merchant} AND visibility = 'private' LIMIT 1`;
    const patch = { filters: saved.filters, sort: saved.sort, columns: saved.columns };
    const foreign = await refusal(() => api(other).paymentViews.update({ viewId: real!.id, ...patch }));
    const missing = await refusal(() => api(other).paymentViews.update({ viewId: nid(), ...patch }));
    expect(foreign).toEqual(missing);
    expect(foreign.cause).toBe('pay.payment_view_not_found');
    expect(await api(other).paymentViews.list({})).toEqual({ items: [] });
  });

  it('masks shopper fields for every role and reveals them only through unmask, with an audit that does not copy the values', async () => {
    const masked = await api(viewer).paymentViews.shopper({ paymentId });
    expect(masked.customerEmail).toBe('b***@e***.com');
    expect(masked.customerName).toBe('A***');
    expect(masked.railRef).toBe('****1234');
    expect(masked.canUnmask).toBe(false);
    expect(JSON.stringify(masked)).not.toContain(email);
    expect(JSON.stringify(masked)).not.toContain(person);
    expect(JSON.stringify(masked)).not.toContain('secret');

    const viewerOwn = await refusal(() => api(viewer).paymentViews.unmask({ paymentId, reason: 'looking' }));
    const viewerMissing = await refusal(() => api(viewer).paymentViews.unmask({ paymentId: nid(), reason: 'looking' }));
    expect(viewerOwn).toEqual(viewerMissing);
    expect(viewerOwn.cause).toBe('pay.payment_unmask_forbidden');

    const blank = await refusal(() => api(finance).paymentViews.unmask({ paymentId, reason: '   ' }));
    expect(blank.cause).toBe('pay.payment_unmask_reason_blank');
    const keyed = await refusal(() => api(finance, { kid: 'ifc_test' }).paymentViews.unmask({ paymentId, reason: 'a key cannot reveal' }));
    expect(keyed.cause).toBe('pay.payment_unmask_interactive_only');

    const clear = await api(finance).paymentViews.unmask({ paymentId, reason: 'dispute evidence' });
    expect(clear).toEqual({ paymentId, customerEmail: email, customerName: person, railRef });
    await api(owner).paymentViews.unmask({ paymentId, reason: 'owner check' });

    const foreign = await refusal(() => api(other).paymentViews.unmask({ paymentId, reason: 'not mine' }));
    const missing = await refusal(() => api(other).paymentViews.unmask({ paymentId: nid(), reason: 'not mine' }));
    expect(foreign).toEqual(missing);
    expect(foreign.cause).toBe('pay.payment_not_found');

    const audit = await sql<Array<{ n: number; reasons: string; after: string }>>`
      SELECT count(*)::int AS n,
             string_agg(reason, '|') AS reasons,
             string_agg(after::text, '|') AS after
        FROM pay.control_audit
       WHERE kind = 'payment.unmask' AND merchant_id = ${merchant}`;
    expect(audit[0]?.n).toBe(2);
    expect(audit[0]?.reasons).toContain('dispute evidence');
    expect(audit[0]?.after ?? '').not.toContain(email);
    expect(audit[0]?.after ?? '').not.toContain(person);
    expect(audit[0]?.after ?? '').not.toContain('secret');

    const financeShopper = await api(finance).paymentViews.shopper({ paymentId });
    expect(financeShopper.canUnmask).toBe(true);
    expect(financeShopper.customerEmail).toBe('b***@e***.com');
  });
});
