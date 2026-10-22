import { randomUUID } from 'node:crypto';
import type { InvoiceView } from './invoices.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createFounderAuthority } from '../founder-authority.js';
import { defaultDisputeCaseStore } from '../fraud/dispute-case.js';
import { createMerchantOpsRouter } from './router.js';

/** M-bill-07 duplicate row (billing-tax-028): a draft copied into a new draft, on real Postgres. */
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
    .withDatabase('intafaced_invoice_duplicate_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const nid = () => randomUUID();
const identity = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) };
const principalOf = (userId: string): Principal => ({
  userId,
  sub: userId,
  sid: nid(),
  scopes: ['pay:read', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
});
const ctxOf = (principal: Principal): Context => ({ principal, service: null, region: 'DE', requestId: nid() });

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    const err = e as { code: string; cause?: { code?: string } };
    return { code: err.code, cause: err.cause?.code };
  }
  throw new Error('expected a refusal');
}

type InvoiceOut = InvoiceView;

describe('M-bill-07 invoice duplicate (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = nid();
  const other = nid();
  const viewer = nid();
  let merchant = '';

  const founderAuthority = createFounderAuthority({ ...identity, fetcher: async () => new Response('{}', { status: 404 }) });
  const as = (userId: string) =>
    createMerchantOpsRouter({ sql, founderAuthority, disputes: defaultDisputeCaseStore, exportKick: () => undefined }).createCaller(
      ctxOf(principalOf(userId)),
    );

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    merchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
    await sql`INSERT INTO pay.merchants (user_id) VALUES (${other})`;
    await sql`UPDATE pay.merchants SET status = 'active'::pay.merchant_status WHERE id = ${merchant}`;
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchant}, ${viewer}, 'viewer', 'active', ${owner}, now())`;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  async function draft(): Promise<InvoiceOut> {
    return (await as(owner).merchantOps.invoices.create({
      requestId: nid(),
      assetId: 'USDT',
      amount: '25.50',
      customerRef: 'cust-dup',
      customerEmail: 'payer@example.com',
      description: 'October retainer',
      dueAt: '2026-12-01T00:00:00.000Z',
      lineItems: [
        { description: 'Design', quantity: '2', unitAmount: '10.25' },
        { description: 'Hosting', quantity: '1', unitAmount: '5' },
      ],
    })) as InvoiceOut;
  }

  it('copies a draft into a new draft with the same lines, no link and no payer email', async () => {
    const source = await draft();
    const requestId = nid();
    const copy = (await as(owner).merchantOps.invoices.duplicate({ requestId, invoiceId: source.id })) as InvoiceOut;
    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      status: 'draft',
      amount: source.amount,
      customerRef: 'cust-dup',
      customerEmail: null,
      description: 'October retainer',
      dueAt: source.dueAt,
      paymentLinkId: null,
    });
    expect(copy.lineItems).toEqual(source.lineItems);
    const stored = await sql<Array<{ customer_email: string | null }>>`
      SELECT customer_email FROM pay.merchant_invoices WHERE id = ${copy.id}`;
    expect(stored[0]!.customer_email).toBeNull();

    const replay = (await as(owner).merchantOps.invoices.duplicate({ requestId, invoiceId: source.id })) as InvoiceOut;
    expect(replay.id).toBe(copy.id);
    const count = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM pay.merchant_invoices WHERE merchant_id = ${merchant} AND description = 'October retainer'`;
    expect(count[0]!.n).toBe('2');
  });

  it('a reused request id for another source refuses pay.request_id_reused', async () => {
    const a = await draft();
    const b = await draft();
    const requestId = nid();
    await as(owner).merchantOps.invoices.duplicate({ requestId, invoiceId: a.id });
    expect((await refusal(() => as(owner).merchantOps.invoices.duplicate({ requestId, invoiceId: b.id }))).cause).toBe(
      'pay.request_id_reused',
    );
  });

  it('a non-draft refuses with its own status code and writes nothing', async () => {
    const source = await draft();
    await as(owner).merchantOps.invoices.void({ requestId: nid(), invoiceId: source.id });
    const before = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.merchant_invoices WHERE merchant_id = ${merchant}`;
    expect((await refusal(() => as(owner).merchantOps.invoices.duplicate({ requestId: nid(), invoiceId: source.id }))).cause).toBe(
      'pay.invoice_void',
    );
    const after = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.merchant_invoices WHERE merchant_id = ${merchant}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("another merchant's draft reads as not found", async () => {
    const source = await draft();
    expect((await refusal(() => as(other).merchantOps.invoices.duplicate({ requestId: nid(), invoiceId: source.id }))).cause).toBe(
      'pay.invoice_not_found',
    );
  });

  it('a viewer cannot duplicate (no invoices.write)', async () => {
    const source = await draft();
    const r = await refusal(() => as(viewer).merchantOps.invoices.duplicate({ requestId: nid(), invoiceId: source.id }));
    expect(r.code).toBe('FORBIDDEN');
  });
});
