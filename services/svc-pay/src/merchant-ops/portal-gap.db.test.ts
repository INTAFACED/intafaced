import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Context } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { teamAccessPorts } from '../control/access.js';
import { ApprovalService } from '../control/approvals.js';
import { createFounderAuthority } from '../founder-authority.js';
import { MemoryDisputeCaseStore } from '../fraud/dispute-case.js';
import { createMerchantOpsRouter, type MerchantOpsDeps } from './router.js';
import { ExportService } from './exports.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const id = () => randomUUID();
const ADDRESS = '0x000000000000000000000000000000000000dEaD';
const SECRET_MARK = 'founder-only-audit-secret-do-not-show';
const KYB_REASON = 'INTERNAL: sanctions near-miss reviewed by Dana';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('pay_portal_gap')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const principalOf = (userId: string, over: Partial<Principal> = {}): Principal =>
  ({
    userId,
    sub: userId,
    sid: id(),
    scopes: ['pay:read', 'pay:write', 'pay:payout'],
    mfa: true,
    tier: 'full',
    expiresAt: new Date(Date.now() + 600_000),
    ...over,
  }) as Principal;

describe('merchant portal activity, exports, and webhooks (Postgres)', () => {
  let stop = async () => undefined as void;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const userA = id();
  const userB = id();
  const viewerId = id();
  const developerId = id();
  const financeId = id();
  let merchantA = '';
  let merchantB = '';
  let settlementA = '';
  let paymentB = '';
  const disputes = new MemoryDisputeCaseStore();
  const ledger = {
    async balances(ownerType: 'module', ownerId: string) {
      return [
        {
          account: { ownerType, ownerId, assetId: 'USDT', kind: 'available' as const, purpose: undefined },
          accountId: `${ownerId}:USDT`,
          amount: parseAmount(ownerId.includes(':proceeds:') ? '40' : '15'),
        },
      ];
    },
  };

  const founderAuthority = createFounderAuthority({
    identityUrl: 'https://identity.invalid',
    serviceSecret: 's'.repeat(32),
    principalSecret: 'p'.repeat(32),
    fetcher: (async () => new Response('{}', { status: 403 })) as typeof fetch,
  });

  const build = (over: Partial<MerchantOpsDeps> = {}) =>
    createMerchantOpsRouter({
      sql,
      founderAuthority,
      disputes,
      exportKick: () => undefined,
      ledger,
      webhooksAllowLocalHttp: true,
      webhookRetry: { maxPerWindow: 2, windowMs: 60_000 },
      ...over,
    });

  const as = (userId: string, over: Partial<Principal> = {}, deps?: Partial<MerchantOpsDeps>) =>
    build(deps).createCaller({ principal: principalOf(userId, over), service: null, region: 'DE', requestId: id() } satisfies Context);

  async function refusal(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      const err = e as { code: string; message: string; cause?: { code?: string } };
      return { code: err.code, message: err.message, cause: err.cause?.code };
    }
    throw new Error('expected a refusal');
  }

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    merchantA = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${userA}) RETURNING id`)[0]!.id;
    merchantB = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${userB}) RETURNING id`)[0]!.id;
    for (const [user, role] of [
      [viewerId, 'viewer'],
      [developerId, 'developer'],
      [financeId, 'finance'],
    ] as const) {
      await sql`
        INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
        VALUES (${merchantA}, ${user}, ${role}, 'active', ${userA}, now())`;
    }
    const paymentA = (
      await sql<Array<{ id: string }>>`
        INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, rail_ref, status)
        VALUES (${merchantA}, '10', 'USDT', 'crypto', 'crypto-native', ${'ref-' + id()}, 'captured'::pay.payment_status) RETURNING id`
    )[0]!.id;
    await sql`INSERT INTO pay.payment_events (payment_id, event, payload) VALUES (${paymentA}, 'created', ${sql.json({ amount: '10', actorUserId: userA })})`;
    await sql`INSERT INTO pay.payment_events (payment_id, event, payload) VALUES (${paymentA}, 'refunded', ${sql.json({ amount: '1.25' })})`;
    paymentB = (
      await sql<Array<{ id: string }>>`
        INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, rail_ref, status)
        VALUES (${merchantB}, '99', 'USDT', 'crypto', 'crypto-native', ${'ref-' + id()}, 'captured'::pay.payment_status) RETURNING id`
    )[0]!.id;
    await sql`INSERT INTO pay.payment_events (payment_id, event, payload) VALUES (${paymentB}, 'created', ${sql.json({ amount: '99' })})`;
    settlementA = (
      await sql<Array<{ id: string }>>`
        INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status, payout_method, payout_ref)
        VALUES (${merchantA}, '2026-10-01', 'USDT', '10', '1', '9', 'paid_out'::pay.settlement_status, 'crypto-native', ${ADDRESS})
        RETURNING id`
    )[0]!.id;
    await sql`
      INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status)
      VALUES (${merchantB}, '2026-10-01', 'USDT', '99', '1', '98', 'posted'::pay.settlement_status)`;
    await sql`
      INSERT INTO pay.control_payout_approvals (
        merchant_id, settlement_id, asset_code, amount, rail_id, destination_kind, destination_ref, payload_hash,
        founder_required, maker_user_id, expires_at
      ) VALUES (
        ${merchantA}, ${settlementA}, 'USDT', '9', 'crypto-native', 'crypto', ${ADDRESS}, ${'sha256:' + 'ab'.repeat(32)},
        false, ${userA}, ${new Date(Date.now() + 86_400_000)}
      )`;
    await sql`
      INSERT INTO pay.merchant_kyb_events (merchant_id, from_status, to_status, reason, actor_id, actor_scope)
      VALUES (${merchantA}, 'none', 'pending', ${KYB_REASON}, ${userA}, 'pay:write')`;
    await sql`
      INSERT INTO pay.control_audit (scope, scope_id, merchant_id, kind, outcome, actor_id, reason, after)
      VALUES ('merchant', ${merchantA}, ${merchantA}, 'payout.destination_read', 'ok', ${userA}, 'founder read', ${sql.json({ secret: SECRET_MARK })})`;
    disputes.open({ disputeId: 'dp-gap-a', paymentId: paymentA, merchantId: merchantA, amount: '10', assetId: 'USDT', reasonCode: '4853' });
    disputes.open({ disputeId: 'dp-gap-b', paymentId: paymentB, merchantId: merchantB, amount: '99', assetId: 'USDT', reasonCode: '4853' });
    await sql`
      INSERT INTO pay.control_pricing_snapshots (
        subject_kind, subject_id, merchant_id, asset_code, applied_layer, rule_id, rule_chain, base_amount,
        monthly_volume_before, band_from, fee_bps, rounding_beneficiary, rounding_mode, bps_fee, fee_before_clamp, fee, spread
      )
      SELECT 'payment', ${paymentA}, ${merchantA}, 'USDT', 'merchant', r.id, '[]'::jsonb, 10, 0, 0, 250, 'platform', 'ceil', 0.25, 0.25, 0.25, 0.01
        FROM pay.control_pricing_rules r
       LIMIT 0`;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await stop();
  });

  it('activity is merchant-scoped, paged, and hides founder text and full destinations', async () => {
    const page = (await as(userA).merchantOps.activity.list({ limit: 50 })) as unknown as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    const text = JSON.stringify(page);
    expect(page.items.length).toBeGreaterThan(0);
    expect(text).not.toContain(paymentB);
    expect(text).not.toContain(SECRET_MARK);
    expect(text).not.toContain(KYB_REASON);
    expect(text).not.toContain(ADDRESS);
    expect(text).toContain('destinationMasked');
    const narrow = (await as(userA).merchantOps.activity.list({ limit: 1, objectType: 'payment' })) as {
      items: unknown[];
      nextCursor: string | null;
    };
    expect(narrow.items).toHaveLength(1);
    expect(narrow.nextCursor).toEqual(expect.any(String));
    const viewer = await refusal(() => as(viewerId).merchantOps.webhooks.list({ limit: 10 }));
    expect(viewer.cause).toBe('pay.team_role_forbidden');
    const foreign = await as(userB).merchantOps.activity.list({ limit: 50, search: paymentB });
    const ownMiss = await as(userA).merchantOps.activity.list({ limit: 50, search: paymentB });
    expect(ownMiss).toEqual({ items: [], nextCursor: null });
    expect((foreign as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('payout list filters in SQL and masks an account address', async () => {
    const page = (await as(userA).merchantOps.payouts.list({ limit: 10, status: 'paid_out' })) as {
      items: Array<{ id: string; payoutReference: string | null }>;
    };
    expect(page.items.map((row) => row.id)).toEqual([settlementA]);
    expect(page.items[0]!.payoutReference).not.toBe(ADDRESS);
    expect(JSON.stringify(page)).not.toContain(ADDRESS);
    const other = (await as(userB).merchantOps.payouts.list({ limit: 10 })) as { items: Array<{ id: string }> };
    expect(other.items.map((row) => row.id)).not.toContain(settlementA);
  });

  it('dispute and export lists filter on the server', async () => {
    const disputesPage = (await as(userA).merchantOps.disputes.list({ limit: 10, search: 'dp-gap-a' })) as {
      items: Array<{ disputeId: string }>;
    };
    expect(disputesPage.items.map((row) => row.disputeId)).toEqual(['dp-gap-a']);
    const hidden = (await as(userA).merchantOps.disputes.list({ limit: 10, search: 'dp-gap-b' })) as { items: unknown[] };
    expect(hidden.items).toEqual([]);
  });

  it('export kinds carry as-of metadata, refuse an unconfigured ledger, and expire', async () => {
    const owner = as(userA);
    const refunds = (await owner.merchantOps.exports.create({ requestId: id(), kind: 'refunds', filters: {} })) as {
      jobId: string;
      columns: string[];
    };
    expect(refunds.columns).toContain('amount');
    await new ExportService(sql, { ledger, disputes }).process(refunds.jobId);
    const ready = (await owner.merchantOps.exports.get({ jobId: refunds.jobId })) as {
      status: string;
      generatedAt: string | null;
      asOf: string | null;
    };
    expect(ready.status).toBe('ready');
    expect(ready.generatedAt).toEqual(expect.any(String));
    expect(ready.asOf).toEqual(expect.any(String));
    const file = (await owner.merchantOps.exports.download({ jobId: refunds.jobId })) as { content: string };
    expect(file.content).toContain('1.25');
    expect(file.content).not.toContain(paymentB);
    expect(file.content.split('\n').some((line) => line.split(',').includes('99'))).toBe(false);
    const statement = (await owner.merchantOps.exports.create({
      requestId: id(),
      kind: 'ledger_statement',
      filters: { assetId: 'USDT' },
    })) as { jobId: string };
    await new ExportService(sql, { ledger, disputes }).process(statement.jobId);
    const statementFile = (await owner.merchantOps.exports.download({ jobId: statement.jobId })) as { content: string };
    expect(statementFile.content).toContain('clearing');
    expect(statementFile.content).toContain('15');
    expect(statementFile.content).toContain('proceeds');
    expect(statementFile.content).toContain('40');
    const unconfigured = await refusal(() =>
      as(userA, {}, { ledger: undefined }).merchantOps.exports.create({ requestId: id(), kind: 'ledger_statement', filters: {} }),
    );
    expect(unconfigured.cause).toBe('pay.export_ledger_unconfigured');
    const dev = await refusal(() =>
      as(developerId).merchantOps.exports.create({ requestId: id(), kind: 'fees', filters: {}, columns: ['fee', 'fee_bps'] }),
    );
    expect(dev.cause).toBe('pay.export_columns_forbidden');
    const expired = (await owner.merchantOps.exports.expire({ jobId: refunds.jobId })) as { status: string };
    expect(expired.status).toBe('expired');
    const gone = await refusal(() => owner.merchantOps.exports.download({ jobId: refunds.jobId }));
    expect(gone.cause).toBe('pay.export_not_ready');
    const foreign = await refusal(() => as(userB).merchantOps.exports.expire({ jobId: statement.jobId }));
    const missing = await refusal(() => as(userB).merchantOps.exports.expire({ jobId: id() }));
    expect(foreign).toEqual(missing);
  });

  it('webhook mutations need developer or admin step-up, and a retry is idempotent', async () => {
    const dev = as(developerId);
    const created = (await dev.merchantOps.webhooks.create({ url: 'http://localhost:9/gap-hook' })) as {
      endpoint: { id: string };
      secret: string;
    };
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
    const listed = JSON.stringify(await dev.merchantOps.webhooks.list({ limit: 10 }));
    expect(listed).not.toContain(created.secret);
    const key = await refusal(() =>
      as(developerId, { kid: id(), mfa: false }).merchantOps.webhooks.rotateSecret({ endpointId: created.endpoint.id, requestId: id() }),
    );
    expect(key.cause).toBe('pay.webhook_step_up_required');
    const finance = await refusal(() => as(financeId).merchantOps.webhooks.list({ limit: 10 }));
    expect(finance.cause).toBe('pay.team_role_forbidden');
    const requestId = id();
    const rotated = (await dev.merchantOps.webhooks.rotateSecret({ endpointId: created.endpoint.id, requestId })) as {
      secret: string | null;
      rotated: boolean;
    };
    expect(rotated.rotated).toBe(true);
    expect(rotated.secret).toMatch(/^[0-9a-f]{64}$/);
    const again = (await dev.merchantOps.webhooks.rotateSecret({ endpointId: created.endpoint.id, requestId })) as {
      secret: string | null;
      rotated: boolean;
    };
    expect(again).toEqual({ endpoint: expect.anything(), secret: null, rotated: false });
    const delivery = (
      await sql<Array<{ id: string }>>`
        INSERT INTO pay.merchant_webhook_deliveries (id, endpoint_id, merchant_id, event_id, event_type, payload, status, attempts)
        VALUES (${id()}, ${created.endpoint.id}, ${merchantA}, ${'evt-' + id()}, 'payment.captured', ${sql.json({ body: 'hidden-delivery-body' })}, 'failed', 3)
        RETURNING id`
    )[0]!.id;
    const retried = (await dev.merchantOps.webhooks.deliveries.retry({ requestId: id(), deliveryId: delivery })) as {
      retried: boolean;
      delivery: { attempts: number; status: string };
    };
    expect(retried.retried).toBe(true);
    expect(retried.delivery).toMatchObject({ status: 'pending', attempts: 0 });
    const replay = (await dev.merchantOps.webhooks.deliveries.retry({
      requestId: (
        await sql<Array<{ request_id: string }>>`SELECT request_id FROM pay.merchant_webhook_retries WHERE delivery_id = ${delivery}`
      )[0]!.request_id,
      deliveryId: delivery,
    })) as { retried: boolean };
    expect(replay.retried).toBe(false);
    const shown = JSON.stringify(await dev.merchantOps.webhooks.deliveries.list({ limit: 10 }));
    expect(shown).not.toContain('hidden-delivery-body');
    const health = (await dev.merchantOps.webhooks.health({})) as { endpoints: Array<{ endpointId: string }> };
    expect(health.endpoints.map((row) => row.endpointId)).toContain(created.endpoint.id);
    const foreign = await refusal(() => as(userB).merchantOps.webhooks.disable({ endpointId: created.endpoint.id }));
    const ghost = await refusal(() => as(userB).merchantOps.webhooks.disable({ endpointId: id() }));
    expect(foreign).toEqual(ghost);
    const off = await refusal(() =>
      as(developerId, {}, { webhookRetry: undefined }).merchantOps.webhooks.deliveries.retry({ requestId: id(), deliveryId: delivery }),
    );
    expect(off.cause).toBe('pay.webhook_retry_unconfigured');
  });

  it('approval list filters status in the database and pages', async () => {
    const approvals = new ApprovalService(sql, { access: teamAccessPorts(sql) });
    const page = await approvals.list(principalOf(userA), { merchantId: merchantA, limit: 10, status: 'pending', search: settlementA });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.destinationMasked).not.toBe(ADDRESS);
    expect(JSON.stringify(page)).not.toContain(ADDRESS);
    const none = await approvals.list(principalOf(userA), { merchantId: merchantA, limit: 10, status: 'rejected' });
    expect(none.items).toEqual([]);
  });
});
