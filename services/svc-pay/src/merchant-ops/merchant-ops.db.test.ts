import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import { mergeRouters, type Context } from '@intafaced/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createFounderAuthority } from '../founder-authority.js';
import { MemoryDisputeCaseStore } from '../fraud/dispute-case.js';
import { createPayNamespaces, FOUNDER_ONLY_PREFIXES, findUnguardedFounderProcedures } from '../namespaces/index.js';
import { createFounderAdminRouter } from '../namespaces/founder-admin.js';
import { createFounderOpsRouter, createMerchantOpsRouter, type MerchantOpsDeps } from './router.js';
import { recordMerchantNotification, requireMerchantPermission, rolesWithPermission } from './index.js';
import { ExportService, csvText } from './exports.js';

/**
 * W15 merchant operations, against a real Postgres.
 *
 * Isolation rules exercised here (named in the SCREENS-SPEC):
 *   M1  another merchant's id is refused with the SAME answer as an id that does not exist
 *   M2  lists return only the caller's rows
 *   M6  exports contain only the caller's rows
 *   G1-G3  operator notes refuse every principal that is not a live founder
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
    .withDatabase('intafaced_merchant_ops_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const id = () => randomUUID();
const identity = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) };

const principalOf = (userId: string, over: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: id(),
  scopes: ['pay:read', 'pay:write', 'pay:payout'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
  ...over,
});
const ctxOf = (principal: Principal | null, service: string | null = null): Context => ({
  principal,
  service,
  region: 'DE',
  requestId: id(),
  forwardedPrincipal: principal ? { raw: 'test-principal', signature: 'test-signature', region: 'DE' } : undefined,
});

type Fn = (input?: unknown) => Promise<unknown>;
const at = (caller: unknown, path: string): Fn => path.split('.').reduce((n, k) => (n as Record<string, unknown>)[k], caller) as Fn;

/** The shape of a refusal: enough to prove two refusals are indistinguishable. */
async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    const err = e as { code: string; message: string; cause?: { code?: string } };
    return { code: err.code, message: err.message, cause: err.cause?.code };
  }
  throw new Error('expected a refusal');
}

const entitlementFor = (userId: string, status = 'enabled') =>
  new Response(JSON.stringify({ result: { data: { status, userId, version: '1', changedAt: '2026-10-10T00:00:00Z' } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('W15 merchant operations (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;

  const disputes = new MemoryDisputeCaseStore();
  const userA = id();
  const userB = id();
  const founderUser = id();
  let merchantA = '';
  let merchantB = '';
  const paymentsA: string[] = [];
  const paymentsB: string[] = [];
  const settlementsA: string[] = [];
  const settlementsB: string[] = [];

  /** Builds callers; founder fetcher answers per the founder's entitlement. */
  const founderFetcher = vi.fn<typeof fetch>(async () => entitlementFor(founderUser));
  const founderAuthority = createFounderAuthority({ ...identity, fetcher: founderFetcher });
  const noKick = () => undefined;
  /** The same composition the live mount uses: merchantOps.* merged beside founderAdmin.* with ops mounted inside it. */
  const compose = (deps: MerchantOpsDeps) =>
    mergeRouters(createMerchantOpsRouter(deps), createFounderAdminRouter(deps.founderAuthority, { ops: createFounderOpsRouter(deps) }));
  const build = (over: { rowCeiling?: number } = {}) =>
    compose({ sql, founderAuthority, disputes, exportKick: noKick, exports: { ...over } });
  const as = (userId: string, over: Partial<Principal> = {}, router = build()) => router.createCaller(ctxOf(principalOf(userId, over)));

  async function seedPayment(merchantId: string, customerRef: string | null, amount: string, status = 'captured') {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, rail_ref, status)
      VALUES (${merchantId}, ${amount}, 'USDT', 'crypto', 'crypto-native', ${'ref-' + id()}, ${status}::pay.payment_status) RETURNING id`;
    const paymentId = rows[0]!.id;
    await sql`INSERT INTO pay.payment_events (payment_id, event, payload) VALUES (${paymentId}, 'created', ${sql.json({ amount, customerRef } as never)})`;
    if (status === 'captured') {
      await sql`INSERT INTO pay.payment_events (payment_id, event, payload) VALUES (${paymentId}, 'captured', ${sql.json({ amount } as never)})`;
    }
    return paymentId;
  }

  async function seedSettlement(merchantId: string, window: string, gross: string, fees: string, net: string, paidOut = false) {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status, payout_method, payout_ref)
      VALUES (${merchantId}, ${window}, 'USDT', ${gross}, ${fees}, ${net}, ${paidOut ? 'paid_out' : 'posted'}::pay.settlement_status,
              ${paidOut ? 'crypto-native' : null}, ${paidOut ? '0xtx-' + window : null})
      RETURNING id`;
    return rows[0]!.id;
  }

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;

    merchantA = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${userA}) RETURNING id`)[0]!.id;
    merchantB = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${userB}) RETURNING id`)[0]!.id;

    paymentsA.push(await seedPayment(merchantA, 'cust-a1', '10'));
    paymentsA.push(await seedPayment(merchantA, 'cust-a1', '5.5'));
    paymentsA.push(await seedPayment(merchantA, 'shared', '2'));
    paymentsA.push(await seedPayment(merchantA, '=HYPERLINK("x")', '1'));
    paymentsB.push(await seedPayment(merchantB, 'cust-b1', '100'));
    paymentsB.push(await seedPayment(merchantB, 'shared', '987654.321'));
    // A refund on A's first payment: totals must net by asset, not by guess.
    await sql`INSERT INTO pay.payment_events (payment_id, event, payload) VALUES (${paymentsA[0]!}, 'refunded', ${sql.json({ amount: '1.25' } as never)})`;

    settlementsA.push(await seedSettlement(merchantA, '2026-10-01', '100', '2', '98', true));
    settlementsA.push(await seedSettlement(merchantA, '2026-10-02', '50', '1', '49'));
    settlementsB.push(await seedSettlement(merchantB, '2026-10-01', '7777.5', '77.5', '7700', true));

    // KYB: A has a merchant submission and an operator decision with an internal-sounding reason.
    await sql`
      INSERT INTO pay.merchant_kyb_events (merchant_id, from_status, to_status, kyb_ref, reason, actor_id, actor_scope)
      VALUES (${merchantA}, 'none', 'pending', 'dossier-a', 'submitted by us', ${userA}, 'pay:write'),
             (${merchantA}, 'pending', 'approved', 'dossier-a', 'INTERNAL: sanctions near-miss reviewed by Dana', ${founderUser}, 'admin:compliance'),
             (${merchantB}, 'none', 'pending', 'dossier-b', 'b submitted', ${userB}, 'pay:write')`;

    // Disputes: two for A, one for B.
    disputes.open({
      disputeId: 'dp-a1',
      paymentId: paymentsA[0]!,
      merchantId: merchantA,
      amount: '10',
      assetId: 'USDT',
      reasonCode: '4853',
    });
    disputes.open({
      disputeId: 'dp-a2',
      paymentId: paymentsA[1]!,
      merchantId: merchantA,
      amount: '5.5',
      assetId: 'USDT',
      reasonCode: '4837',
    });
    disputes.open({
      disputeId: 'dp-b1',
      paymentId: paymentsB[0]!,
      merchantId: merchantB,
      amount: '100',
      assetId: 'USDT',
      reasonCode: '4853',
    });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  // ── M1 ────────────────────────────────────────────────────────────────────
  describe('M1: another merchant is indistinguishable from nothing', () => {
    it('disputes, customers, exports, notifications and team members answer a foreign id exactly like a missing one', async () => {
      // B owns: a dispute (dp-b1), a customer ref, an export job, a notification, a team member.
      const b = as(userB);
      const bExport = (await b.merchantOps.exports.create({ requestId: id(), kind: 'payments', filters: {} })) as { jobId: string };
      const bNote = (
        await sql<Array<{ id: string }>>`
        INSERT INTO pay.merchant_notifications (merchant_id, kind, title) VALUES (${merchantB}, 'export_ready', 'b only') RETURNING id`
      )[0]!.id;
      const member = id();
      const invited = (await b.merchantOps.team.invite({ userId: member, role: 'viewer' })) as { memberId: string };
      const bInvoice = (await b.merchantOps.invoices.create({ requestId: id(), assetId: 'USDT', amount: '4' })) as { id: string };
      const evidenceBytes = Buffer.from('%PDF');
      const evidenceSha = createHash('sha256').update(evidenceBytes).digest('hex');
      const bEvidence = (
        await sql<Array<{ id: string }>>`
        INSERT INTO pay.merchant_dispute_evidence (merchant_id, dispute_id, kind, file_name, content_type, size_bytes, sha256, added_by)
        VALUES (${merchantB}, 'dp-b1', 'receipt', 'b.pdf', 'application/pdf', ${evidenceBytes.length}, ${evidenceSha}, ${userB})
        RETURNING id`
      )[0]!.id;
      await sql`
        INSERT INTO pay.merchant_dispute_evidence_content (evidence_id, merchant_id, content)
        VALUES (${bEvidence}, ${merchantB}, ${evidenceBytes})`;

      const a = as(userA);
      const cases: Array<[string, (v: string) => unknown, string, string]> = [
        ['disputes.get', (v) => ({ disputeId: v }), 'dp-b1', 'dp-nonexistent'],
        [
          'disputes.addEvidence',
          (v) => ({
            disputeId: v,
            kind: 'receipt',
            fileName: 'r.pdf',
            contentType: 'application/pdf',
            sizeBytes: 1,
            sha256: 'a'.repeat(64),
          }),
          'dp-b1',
          'dp-nonexistent',
        ],
        ['disputes.respond', (v) => ({ requestId: id(), disputeId: v, action: 'accept_liability' }), 'dp-b1', 'dp-nonexistent'],
        [
          'disputes.uploadEvidence',
          (v) => ({
            disputeId: v,
            kind: 'receipt',
            fileName: 'r.pdf',
            contentType: 'application/pdf',
            contentBase64: Buffer.from('%PDF').toString('base64'),
          }),
          'dp-b1',
          'dp-nonexistent',
        ],
        ['disputes.getEvidence', (v) => ({ evidenceId: v }), bEvidence, id()],
        ['invoices.get', (v) => ({ invoiceId: v }), bInvoice.id, id()],
        ['customers.get', (v) => ({ customerRef: v, recentPaymentsLimit: 5 }), 'cust-b1', 'cust-nonexistent'],
        [
          'customers.series',
          (v) => ({ customerRef: v, from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', bucket: 'day', limit: 5 }),
          'cust-b1',
          'cust-nonexistent',
        ],
        ['exports.get', (v) => ({ jobId: v }), bExport.jobId, id()],
        ['exports.download', (v) => ({ jobId: v }), bExport.jobId, id()],
        ['notifications.markRead', (v) => ({ notificationIds: [v] }), bNote, id()],
        ['team.changeRole', (v) => ({ memberId: v, role: 'developer' }), invited.memberId, id()],
        ['team.remove', (v) => ({ memberId: v }), invited.memberId, id()],
      ];
      for (const [path, inputFor, foreign, missing] of cases) {
        const full = `merchantOps.${path}`;
        const f = await refusal(() => at(a, full)(inputFor(foreign)));
        const m = await refusal(() => at(a, full)(inputFor(missing)));
        expect(f, path).toEqual(m);
        expect(f.code, path).toBe('NOT_FOUND');
        expect(f.message, path).not.toContain(foreign);
      }
      // And B's rows were not touched by A's attempts.
      expect(disputes.get('dp-b1')?.status).toBe('open');
      const stillThere = await b.merchantOps.team.list({ limit: 10 });
      expect((stillThere as { items: Array<{ userId: string }> }).items.some((m) => m.userId === member)).toBe(true);
    });

    it('a principal that owns no merchant and is on no team learns nothing, with one refusal for every procedure', async () => {
      const stranger = as(id());
      const paths: Array<[string, unknown]> = [
        ['disputes.list', { limit: 5 }],
        ['invoices.list', { limit: 5 }],
        ['customers.list', { limit: 5 }],
        ['customers.series', { customerRef: 'cust-a1', from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', bucket: 'day', limit: 5 }],
        ['team.list', { limit: 5 }],
        ['kyb.current', {}],
        ['exports.list', { limit: 5 }],
        ['notifications.list', { limit: 5 }],
      ];
      const seen = new Set<string>();
      for (const [p, input] of paths) {
        const r = await refusal(() => at(stranger, `merchantOps.${p}`)(input));
        expect(r.cause).toBe('pay.merchant_ops_not_merchant');
        seen.add(JSON.stringify(r));
      }
      expect(seen.size).toBe(1);
    });
  });

  // ── M2 ────────────────────────────────────────────────────────────────────
  describe("M2: lists return only the caller's rows", () => {
    it('disputes', async () => {
      const a = (await as(userA).merchantOps.disputes.list({ limit: 10 })) as { items: Array<{ disputeId: string }> };
      expect(a.items.map((d) => d.disputeId).sort()).toEqual(['dp-a1', 'dp-a2']);
      const b = (await as(userB).merchantOps.disputes.list({ limit: 10 })) as { items: Array<{ disputeId: string }> };
      expect(b.items.map((d) => d.disputeId)).toEqual(['dp-b1']);
      const s = (await as(userA).merchantOps.disputes.summary({})) as {
        total: number;
        amountAtRisk: Array<{ assetId: string; amount: string }>;
      };
      expect(s.total).toBe(2);
      expect(s.amountAtRisk).toEqual([{ assetId: 'USDT', amount: '15.5' }]);
    });

    it('customers: a ref only the other merchant used is absent, and a shared ref counts only own money', async () => {
      const a = (await as(userA).merchantOps.customers.list({ limit: 50 })) as {
        items: Array<{
          customerRef: string;
          paymentCount: number;
          totals: Array<{ assetId: string; capturedAmount: string; refundedAmount: string; paymentCount: number }>;
        }>;
      };
      const refs = a.items.map((c) => c.customerRef);
      expect(refs).toContain('cust-a1');
      expect(refs).not.toContain('cust-b1');
      const shared = a.items.find((c) => c.customerRef === 'shared')!;
      expect(shared.totals).toEqual([{ assetId: 'USDT', capturedAmount: '2', refundedAmount: '0', paymentCount: 1 }]);
      const a1 = a.items.find((c) => c.customerRef === 'cust-a1')!;
      expect(a1.paymentCount).toBe(2);
      expect(a1.totals).toEqual([{ assetId: 'USDT', capturedAmount: '15.5', refundedAmount: '1.25', paymentCount: 2 }]);
      // Money is a string on the wire, never a JS number.
      expect(typeof a1.totals[0]!.capturedAmount).toBe('string');
      const b = (await as(userB).merchantOps.customers.list({ limit: 50 })) as { items: Array<{ customerRef: string }> };
      expect(b.items.map((c) => c.customerRef).sort()).toEqual(['cust-b1', 'shared']);
    });

    it('customer detail: lifetime totals, recent payments, and subscriptions/mandates feed the directory', async () => {
      const mandate = (
        await sql<Array<{ id: string }>>`
        INSERT INTO pay.subscription_mandates (merchant_id, customer_id, asset_id, amount, cadence, starts_at)
        VALUES (${merchantA}, 'cust-sub', 'USDT', '9', 'monthly', now()) RETURNING id`
      )[0]!.id;
      await sql`
        INSERT INTO pay.subscriptions (mandate_id, merchant_id, customer_id, next_run_at)
        VALUES (${mandate}, ${merchantA}, 'cust-sub', now() + interval '1 day')`;
      const a = as(userA);
      const d = (await a.merchantOps.customers.get({ customerRef: 'cust-a1', recentPaymentsLimit: 1 })) as {
        recentPayments: Array<{ paymentId: string }>;
        totals: Array<{ capturedAmount: string }>;
      };
      expect(d.recentPayments).toHaveLength(1);
      expect(paymentsA).toContain(d.recentPayments[0]!.paymentId);
      const sub = (await a.merchantOps.customers.get({ customerRef: 'cust-sub', recentPaymentsLimit: 1 })) as {
        subscriptionCount: number;
        mandateCount: number;
        paymentCount: number;
      };
      expect(sub.subscriptionCount).toBe(1);
      expect(sub.mandateCount).toBe(1);
      expect(sub.paymentCount).toBe(0);
      const summary = (await a.merchantOps.customers.summary({ activeSince: '2000-01-01T00:00:00Z' })) as {
        customerCount: number;
        repeatCustomerCount: number;
      };
      expect(summary.customerCount).toBe(4); // cust-a1, shared, the formula-looking ref, cust-sub
      expect(summary.repeatCustomerCount).toBe(1); // cust-a1 has two payments
    });

    it('team, exports, notifications and kyb history', async () => {
      const a = as(userA);
      const team = (await a.merchantOps.team.list({ limit: 50 })) as { items: Array<{ userId: string; role: string }> };
      expect(team.items.map((m) => m.userId)).toEqual([userA]);
      expect(team.items[0]!.role).toBe('owner');
      await sql`INSERT INTO pay.merchant_notifications (merchant_id, kind, title) VALUES (${merchantA}, 'dispute_opened', 'A sees this')`;
      const notes = (await a.merchantOps.notifications.list({ limit: 50 })) as { items: Array<{ title: string }> };
      expect(notes.items.map((n) => n.title)).toContain('A sees this');
      expect(notes.items.map((n) => n.title)).not.toContain('b only');
      const kyb = (await a.merchantOps.kyb.history({ limit: 10 })) as { items: Array<{ kybRef: string | null }> };
      expect(kyb.items.map((k) => k.kybRef).every((r) => r === 'dossier-a')).toBe(true);
    });
  });

  // ── KYB ───────────────────────────────────────────────────────────────────
  describe('merchant-scoped KYB view', () => {
    it("shows the transitions, hides the operator and their written reason, keeps the merchant's own reason", async () => {
      const a = as(userA);
      const cur = (await a.merchantOps.kyb.current({})) as { kybStatus: string };
      expect(cur.kybStatus).toBe('none');
      const h = (await a.merchantOps.kyb.history({ limit: 10 })) as {
        items: Array<{ toStatus: string; decidedBy: string; reason: string | null }>;
      };
      expect(h.items.map((i) => i.toStatus)).toEqual(['approved', 'pending']);
      expect(h.items[0]).toMatchObject({ decidedBy: 'intafaced', reason: null });
      expect(h.items[1]).toMatchObject({ decidedBy: 'merchant', reason: 'submitted by us' });
      const text = JSON.stringify(h);
      expect(text).not.toContain('INTERNAL');
      expect(text).not.toContain(founderUser);
    });
  });

  // ── M6 ────────────────────────────────────────────────────────────────────
  describe("M6: exports contain only the caller's rows", () => {
    const runner = () => new ExportService(sql, {});

    async function exportCsv(userId: string, kind: 'payments' | 'settlements' | 'payouts', filters = {}) {
      const caller = as(userId);
      const job = (await caller.merchantOps.exports.create({ requestId: id(), kind, filters })) as { jobId: string; status: string };
      expect(job.status).toBe('queued');
      expect(await runner().process(job.jobId)).toBe(true);
      const got = (await caller.merchantOps.exports.get({ jobId: job.jobId })) as { status: string; rowCount: number };
      expect(got.status).toBe('ready');
      const file = (await caller.merchantOps.exports.download({ jobId: job.jobId })) as {
        content: string;
        rowCount: number;
        contentType: string;
      };
      return { job, file, got };
    }

    it("payments: every A payment, none of B's, money as decimal strings, formulas neutralised", async () => {
      const { file } = await exportCsv(userA, 'payments');
      for (const p of paymentsA) expect(file.content).toContain(p);
      for (const p of paymentsB) expect(file.content).not.toContain(p);
      expect(file.content).not.toContain('cust-b1');
      expect(file.content).not.toContain('987654.321');
      expect(file.rowCount).toBe(paymentsA.length);
      expect(file.contentType).toContain('text/csv');
      const lines = file.content.trim().split('\r\n');
      expect(lines[0]).toBe(
        'payment_id,created_at,status,asset,amount,captured_amount,refunded_amount,method,rail,rail_reference,customer_reference',
      );
      expect(lines).toHaveLength(paymentsA.length + 1);
      expect(file.content).not.toMatch(/risk|profile/i);
      // The cell that begins with "=" is quoted-and-prefixed, not left to run as a formula.
      expect(file.content).toContain(`"'=HYPERLINK(""x"")"`);
      const refunded = lines.find((l) => l.startsWith(paymentsA[0]!))!;
      expect(refunded).toContain(',10,10,1.25,');
    });

    it('settlements and payouts', async () => {
      const s = await exportCsv(userA, 'settlements');
      for (const x of settlementsA) expect(s.file.content).toContain(x);
      for (const x of settlementsB) expect(s.file.content).not.toContain(x);
      expect(s.file.content).not.toContain('7777.5');
      const p = await exportCsv(userA, 'payouts');
      expect(p.file.rowCount).toBe(1);
      expect(p.file.content).toContain(settlementsA[0]!);
      expect(p.file.content).not.toContain(settlementsA[1]!);
      expect(p.file.content).not.toContain(settlementsB[0]!);
      const bOnly = await exportCsv(userB, 'payouts');
      expect(bOnly.file.content).toContain(settlementsB[0]!);
      expect(bOnly.file.content).not.toContain(settlementsA[0]!);
    });

    it('filters narrow the file and a bad filter is a typed refusal', async () => {
      const { file } = await exportCsv(userA, 'payments', { status: 'captured', assetId: 'USDT' });
      expect(file.rowCount).toBe(paymentsA.length);
      const none = await exportCsv(userA, 'payments', { status: 'failed' });
      expect(none.file.rowCount).toBe(0);
      const bad = await refusal(() =>
        as(userA).merchantOps.exports.create({ requestId: id(), kind: 'payments', filters: { status: 'paid_out' } }),
      );
      expect(bad.cause).toBe('pay.export_filter_invalid');
    });

    it("B cannot read or list A's job, and the job ready notification lands on the right merchant only", async () => {
      const { job } = await exportCsv(userA, 'payments');
      const bList = (await as(userB).merchantOps.exports.list({ limit: 50 })) as { items: Array<{ jobId: string }> };
      expect(bList.items.map((j) => j.jobId)).not.toContain(job.jobId);
      const aNotes = (await as(userA).merchantOps.notifications.list({ limit: 100, kind: 'export_ready' })) as {
        items: Array<{ subjectId: string }>;
      };
      expect(aNotes.items.map((n) => n.subjectId)).toContain(job.jobId);
      const bNotes = (await as(userB).merchantOps.notifications.list({ limit: 100, kind: 'export_ready' })) as {
        items: Array<{ subjectId: string }>;
      };
      expect(bNotes.items.map((n) => n.subjectId)).not.toContain(job.jobId);
    });

    it('a retried request id returns the same job; reusing it for something else conflicts', async () => {
      const a = as(userA);
      const requestId = id();
      const first = (await a.merchantOps.exports.create({ requestId, kind: 'settlements', filters: {} })) as { jobId: string };
      const again = (await a.merchantOps.exports.create({ requestId, kind: 'settlements', filters: {} })) as { jobId: string };
      expect(again.jobId).toBe(first.jobId);
      const clash = await refusal(() => a.merchantOps.exports.create({ requestId, kind: 'payments', filters: {} }));
      expect(clash.cause).toBe('pay.request_id_reused');
    });

    it('a file too large for the ceiling fails closed with a named code instead of truncating', async () => {
      const small = build({ rowCeiling: 1 });
      const caller = as(userA, {}, small);
      const job = (await caller.merchantOps.exports.create({ requestId: id(), kind: 'payments', filters: {} })) as { jobId: string };
      await new ExportService(sql, { rowCeiling: 1 }).process(job.jobId);
      const got = (await caller.merchantOps.exports.get({ jobId: job.jobId })) as { status: string; failureCode: string };
      expect(got).toMatchObject({ status: 'failed', failureCode: 'pay.export_too_large' });
      const dl = await refusal(() => caller.merchantOps.exports.download({ jobId: job.jobId }));
      expect(dl.cause).toBe('pay.export_not_ready');
    });

    it('an expired file is not served', async () => {
      const ttl = new ExportService(sql, { ttlMs: 1000, now: () => new Date('2020-01-01T00:00:00Z') });
      const a = as(userA);
      const job = (await a.merchantOps.exports.create({ requestId: id(), kind: 'settlements', filters: {} })) as { jobId: string };
      await ttl.process(job.jobId);
      const dl = await refusal(() => a.merchantOps.exports.download({ jobId: job.jobId }));
      expect(dl.cause).toBe('pay.export_expired');
    });

    it('generation pages through the table in small batches without skipping or repeating a row', async () => {
      const tiny = new ExportService(sql, { batchSize: 2 });
      const a = as(userA);
      const job = (await a.merchantOps.exports.create({ requestId: id(), kind: 'payments', filters: {} })) as { jobId: string };
      await tiny.process(job.jobId);
      const file = (await a.merchantOps.exports.download({ jobId: job.jobId })) as { content: string };
      const ids = file.content
        .trim()
        .split('\r\n')
        .slice(1)
        .map((l) => l.split(',')[0]!);
      expect(ids).toHaveLength(paymentsA.length);
      expect(new Set(ids).size).toBe(paymentsA.length);
      expect([...ids].sort()).toEqual([...paymentsA].sort());
    });

    it('csvText quotes commas and quotes and neutralises = + - @', () => {
      expect(csvText('a,b')).toBe('"a,b"');
      expect(csvText('say "hi"')).toBe('"say ""hi"""');
      for (const lead of ['=', '+', '-', '@']) expect(csvText(`${lead}x`)).toBe(`'${lead}x`);
      expect(csvText(null)).toBe('');
    });
  });

  // ── pagination ────────────────────────────────────────────────────────────
  describe('cursor pagination is stable and complete', () => {
    /** Walk a list with a small page size; the walk must equal the one-page answer, in the same order. */
    async function walk(
      call: (input: { limit: number; cursor?: string }) => Promise<unknown>,
      key: (item: any) => string,
      pageSize: number,
    ) {
      const walked: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (; pages < 50; pages += 1) {
        const page = (await call({ limit: pageSize, ...(cursor ? { cursor } : {}) })) as { items: unknown[]; nextCursor: string | null };
        walked.push(...page.items.map(key));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      const whole = ((await call({ limit: 200 })) as { items: unknown[] }).items.map(key);
      expect(walked).toEqual(whole);
      expect(new Set(walked).size).toBe(walked.length);
      return { walked, pages: pages + 1 };
    }

    it('customers, disputes, kyb history and exports page without skipping or repeating a row', async () => {
      const a = as(userA);
      const c = await walk(
        (i) => a.merchantOps.customers.list(i),
        (x) => x.customerRef,
        1,
      );
      expect(c.walked.length).toBeGreaterThanOrEqual(4);
      expect(c.pages).toBe(c.walked.length);
      await walk(
        (i) => a.merchantOps.disputes.list(i),
        (x) => x.disputeId,
        1,
      );
      await walk(
        (i) => a.merchantOps.kyb.history(i),
        (x) => x.seq,
        1,
      );
      await walk(
        (i) => a.merchantOps.exports.list(i),
        (x) => x.jobId,
        2,
      );
    });

    it('sequence-keyed lists order numerically past 9 rows (text ordering would put 10 before 9)', async () => {
      const owner = id();
      const merchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
      for (let i = 0; i < 12; i += 1) {
        await sql`
          INSERT INTO pay.merchant_kyb_events (merchant_id, from_status, to_status, reason, actor_id, actor_scope)
          VALUES (${merchant}, 'none', 'pending', ${'r' + i}, ${owner}, 'pay:write')`;
      }
      const c = as(owner);
      const walked = await walk(
        (i) => c.merchantOps.kyb.history(i),
        (x) => x.seq,
        5,
      );
      expect(walked.walked).toHaveLength(12);
      expect(walked.walked.map(Number)).toEqual([...walked.walked.map(Number)].sort((x, y) => y - x));
      const f = as(founderUser);
      for (let i = 0; i < 12; i += 1) await f.founderAdmin.ops.notes.add({ merchantId: merchant, body: `n${i}`, tags: [], flagged: false });
      const notes = await walk(
        (i) => f.founderAdmin.ops.notes.list({ merchantId: merchant, ...i }),
        (x) => x.noteId,
        5,
      );
      expect(notes.walked).toHaveLength(12);
      const bodies = (
        (await f.founderAdmin.ops.notes.list({ merchantId: merchant, limit: 200 })) as { items: Array<{ body: string }> }
      ).items.map((n) => n.body);
      expect(bodies).toEqual(Array.from({ length: 12 }, (_, i) => `n${11 - i}`));
    });
  });

  // ── disputes ──────────────────────────────────────────────────────────────
  describe('disputes over the existing case mechanism', () => {
    it('detail shows the case, the linked payment, and no response deadline invented', async () => {
      const d = (await as(userA).merchantOps.disputes.get({ disputeId: 'dp-a1' })) as {
        status: string;
        amount: string;
        responseDueAt: null;
        canRespond: boolean;
        ledgerWire: string;
        payment: { paymentId: string } | null;
      };
      expect(d).toMatchObject({ status: 'open', amount: '10', responseDueAt: null, canRespond: true, ledgerWire: 'refused' });
      expect(d.payment?.paymentId).toBe(paymentsA[0]);
    });

    it('contest needs evidence, records a decision once, and a retried request id replays it', async () => {
      const a = as(userA);
      const requestId = id();
      const noEvidence = await refusal(() => a.merchantOps.disputes.respond({ requestId, disputeId: 'dp-a1', action: 'contest' }));
      expect(noEvidence).toMatchObject({ code: 'PRECONDITION_FAILED', cause: 'pay.dispute_evidence_required' });
      expect(disputes.get('dp-a1')?.status).toBe('open');

      const ev = (await a.merchantOps.disputes.addEvidence({
        disputeId: 'dp-a1',
        kind: 'shipping_proof',
        fileName: 'ups.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1234,
        sha256: 'AB'.repeat(32),
        note: 'tracking',
      })) as { sha256: string; sizeBytes: string };
      expect(ev.sha256).toBe('ab'.repeat(32));
      expect(ev.sizeBytes).toBe('1234');

      const done = (await a.merchantOps.disputes.respond({ requestId, disputeId: 'dp-a1', action: 'contest', note: 'proof attached' })) as {
        status: string;
        evidence: unknown[];
        responses: Array<{ action: string }>;
      };
      expect(done.status).toBe('contested');
      expect(done.evidence).toHaveLength(1);
      expect(done.responses).toHaveLength(1);
      expect(disputes.get('dp-a1')?.status).toBe('contested');

      const replay = (await a.merchantOps.disputes.respond({
        requestId,
        disputeId: 'dp-a1',
        action: 'contest',
        note: 'proof attached',
      })) as { responses: unknown[] };
      expect(replay.responses).toHaveLength(1);
      const reused = await refusal(() => a.merchantOps.disputes.respond({ requestId, disputeId: 'dp-a1', action: 'accept_liability' }));
      expect(reused.cause).toBe('pay.request_id_reused');
      const twice = await refusal(() => a.merchantOps.disputes.respond({ requestId: id(), disputeId: 'dp-a1', action: 'contest' }));
      expect(twice.cause).toBe('pay.dispute_invalid_transition');
    });

    it('accepting liability closes the case, moves no value, and a closed case takes no more evidence', async () => {
      const a = as(userA);
      const done = (await a.merchantOps.disputes.respond({ requestId: id(), disputeId: 'dp-a2', action: 'accept_liability' })) as {
        status: string;
        canRespond: boolean;
        ledgerWire: string;
        closedAt: string | null;
      };
      expect(done).toMatchObject({ status: 'accepted', canRespond: false, ledgerWire: 'refused' });
      expect(done.closedAt).not.toBeNull();
      const late = await refusal(() =>
        a.merchantOps.disputes.addEvidence({
          disputeId: 'dp-a2',
          kind: 'other',
          fileName: 'x.txt',
          contentType: 'text/plain',
          sizeBytes: 1,
          sha256: 'c'.repeat(64),
        }),
      );
      expect(late.cause).toBe('pay.dispute_closed');
    });

    it("the merchant's evidence and decisions cannot be edited or deleted", async () => {
      await expect(sql`UPDATE pay.merchant_dispute_evidence SET note = 'x'`).rejects.toThrow(/append-only/);
      await expect(sql`DELETE FROM pay.merchant_dispute_responses`).rejects.toThrow(/append-only/);
    });
  });

  // ── team and roles ────────────────────────────────────────────────────────
  describe('team roles', () => {
    // Fresh merchant so these tests do not depend on the ones above.
    const owner = id();
    let merchant = '';
    const people = { admin: id(), finance: id(), developer: id(), viewer: id() };
    const memberIds: Record<string, string> = {};

    beforeAll(async () => {
      merchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
    });

    const ownerCaller = () => as(owner);

    it('an invitation grants nothing until the invited account accepts it', async () => {
      const inv = (await ownerCaller().merchantOps.team.invite({ userId: people.admin, role: 'admin', label: 'Ops lead' })) as {
        memberId: string;
        status: string;
      };
      expect(inv.status).toBe('invited');
      memberIds.admin = inv.memberId;
      const before = await refusal(() => as(people.admin).merchantOps.team.list({ limit: 10 }));
      expect(before.cause).toBe('pay.merchant_ops_not_merchant');
      const pending = (await as(people.admin).merchantOps.team.myInvitations({})) as Array<{ memberId: string; merchantId: string }>;
      expect(pending).toEqual([expect.objectContaining({ memberId: inv.memberId, merchantId: merchant })]);
      // Somebody else cannot accept it, and the refusal is the same as for an id that is not an invitation.
      const other = await refusal(() => as(id()).merchantOps.team.acceptInvite({ memberId: inv.memberId }));
      const none = await refusal(() => as(id()).merchantOps.team.acceptInvite({ memberId: id() }));
      expect(other).toEqual(none);
      await as(people.admin).merchantOps.team.acceptInvite({ memberId: inv.memberId });
      const after = (await as(people.admin).merchantOps.team.me({})) as { role: string; merchantId: string };
      expect(after).toMatchObject({ role: 'admin', merchantId: merchant });
    });

    it('only the owner hands out admin; an admin manages the other roles', async () => {
      const admin = as(people.admin);
      const refuse = await refusal(() => admin.merchantOps.team.invite({ userId: id(), role: 'admin' }));
      expect(refuse.cause).toBe('pay.team_role_forbidden');
      for (const role of ['finance', 'developer', 'viewer'] as const) {
        const inv = (await admin.merchantOps.team.invite({ userId: people[role], role })) as { memberId: string };
        memberIds[role] = inv.memberId;
        await as(people[role]).merchantOps.team.acceptInvite({ memberId: inv.memberId });
      }
      const list = (await ownerCaller().merchantOps.team.list({ limit: 50 })) as { items: Array<{ role: string }> };
      expect(list.items.map((m) => m.role).sort()).toEqual(['admin', 'developer', 'finance', 'owner', 'viewer']);
    });

    it('nobody changes their own role; an admin cannot touch another admin; the owner can', async () => {
      const self = await refusal(() => as(people.admin).merchantOps.team.changeRole({ memberId: memberIds.admin!, role: 'viewer' }));
      expect(self.cause).toBe('pay.team_self_change_forbidden');
      const otherAdmin = id();
      const inv = (await ownerCaller().merchantOps.team.invite({ userId: otherAdmin, role: 'admin' })) as { memberId: string };
      await as(otherAdmin).merchantOps.team.acceptInvite({ memberId: inv.memberId });
      const blocked = await refusal(() => as(people.admin).merchantOps.team.remove({ memberId: inv.memberId }));
      expect(blocked.cause).toBe('pay.team_role_forbidden');
      const removed = (await ownerCaller().merchantOps.team.remove({ memberId: inv.memberId })) as { status: string };
      expect(removed.status).toBe('removed');
      const gone = await refusal(() => as(otherAdmin).merchantOps.team.list({ limit: 5 }));
      expect(gone.cause).toBe('pay.merchant_ops_not_merchant');
    });

    it("an invite reveals nothing about an outside account; a merchant owner or another team's member cannot accept", async () => {
      // Inviting the owner of merchant B, or a member of another team, looks exactly like inviting anyone else.
      const otherOwner = (await ownerCaller().merchantOps.team.invite({ userId: userB, role: 'viewer' })) as {
        memberId: string;
        status: string;
      };
      expect(otherOwner.status).toBe('invited');
      const elsewhere = id();
      const otherMerchantOwner = id();
      await sql`INSERT INTO pay.merchants (user_id) VALUES (${otherMerchantOwner})`;
      const theirs = (await as(otherMerchantOwner).merchantOps.team.invite({ userId: elsewhere, role: 'viewer' })) as { memberId: string };
      await as(elsewhere).merchantOps.team.acceptInvite({ memberId: theirs.memberId });
      const busy = (await ownerCaller().merchantOps.team.invite({ userId: elsewhere, role: 'viewer' })) as {
        memberId: string;
        status: string;
      };
      expect(busy.status).toBe('invited');
      // The one-team rule holds where it matters: on accept. One answer for both.
      const a = await refusal(() => as(userB).merchantOps.team.acceptInvite({ memberId: otherOwner.memberId }));
      const b = await refusal(() => as(elsewhere).merchantOps.team.acceptInvite({ memberId: busy.memberId }));
      expect(a).toEqual(b);
      expect(a.cause).toBe('pay.team_member_unavailable');
      // Someone already on THIS team is this merchant's own business.
      const same = await refusal(() => ownerCaller().merchantOps.team.invite({ userId: people.viewer, role: 'viewer' }));
      expect(same.cause).toBe('pay.team_member_unavailable');
      await as(userB).merchantOps.team.declineInvite({ memberId: otherOwner.memberId });
      await as(elsewhere).merchantOps.team.declineInvite({ memberId: busy.memberId });
    });

    it('a removed member can be invited again and the history records every change in order', async () => {
      await as(people.viewer).merchantOps.team.leave({});
      const gone = await refusal(() => as(people.viewer).merchantOps.team.list({ limit: 5 }));
      expect(gone.cause).toBe('pay.merchant_ops_not_merchant');
      const again = (await ownerCaller().merchantOps.team.invite({ userId: people.viewer, role: 'viewer' })) as {
        memberId: string;
        status: string;
      };
      expect(again.status).toBe('invited');
      expect(again.memberId).toBe(memberIds.viewer);
      await as(people.viewer).merchantOps.team.acceptInvite({ memberId: again.memberId });
      const history = (await ownerCaller().merchantOps.team.history({ limit: 100 })) as {
        items: Array<{ action: string; memberUserId: string }>;
      };
      const forViewer = history.items
        .filter((e) => e.memberUserId === people.viewer)
        .map((e) => e.action)
        .reverse();
      expect(forViewer).toEqual(['invited', 'accepted', 'removed', 'invited', 'accepted']);
      await expect(sql`UPDATE pay.merchant_team_events SET actor_id = 'x'`).rejects.toThrow(/append-only/);
    });

    it('the owner cannot leave and an API key cannot change the team', async () => {
      const leave = await refusal(() => ownerCaller().merchantOps.team.leave({}));
      expect(leave.cause).toBe('pay.team_owner_cannot_leave');
      const key = as(owner, { kid: id(), mfa: false, scopes: ['pay:read', 'pay:write'] });
      const invite = await refusal(() => key.merchantOps.team.invite({ userId: id(), role: 'viewer' }));
      expect(invite.cause).toBe('pay.team_interactive_only');
      const remove = await refusal(() => key.merchantOps.team.remove({ memberId: memberIds.developer! }));
      expect(remove.cause).toBe('pay.team_interactive_only');
      // A password-only session or a sub-account cannot hand out roles either (finance carries payout.approve).
      for (const over of [{ mfa: false }, { sub_account: id() }] as Array<Partial<Principal>>) {
        const r = await refusal(() => as(owner, over).merchantOps.team.invite({ userId: id(), role: 'finance' }));
        expect(r.cause).toBe('pay.team_interactive_only');
        const c = await refusal(() => as(owner, over).merchantOps.team.changeRole({ memberId: memberIds.developer!, role: 'finance' }));
        expect(c.cause).toBe('pay.team_interactive_only');
      }
      const invited = id();
      const inv = (await ownerCaller().merchantOps.team.invite({ userId: invited, role: 'viewer' })) as { memberId: string };
      const noMfa = await refusal(() => as(invited, { mfa: false }).merchantOps.team.acceptInvite({ memberId: inv.memberId }));
      expect(noMfa.cause).toBe('pay.team_interactive_only');
      await as(invited).merchantOps.team.declineInvite({ memberId: inv.memberId });
    });

    it('role matrix on the operations APIs: viewer reads only, developer exports, finance answers disputes', async () => {
      disputes.open({ disputeId: 'dp-team', paymentId: id(), merchantId: merchant, amount: '3', assetId: 'USDT' });
      const evidence = {
        disputeId: 'dp-team',
        kind: 'receipt' as const,
        fileName: 'r.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
        sha256: 'd'.repeat(64),
      };
      const viewer = as(people.viewer);
      const dev = as(people.developer);
      const fin = as(people.finance);

      // reads are open to every role
      for (const c of [viewer, dev, fin]) {
        expect(((await c.merchantOps.disputes.list({ limit: 10 })) as { items: unknown[] }).items).toHaveLength(1);
        await c.merchantOps.customers.list({ limit: 5 });
        await c.merchantOps.kyb.current({});
        await c.merchantOps.notifications.list({ limit: 5 });
      }
      // viewer cannot write anything
      expect((await refusal(() => viewer.merchantOps.disputes.addEvidence(evidence))).cause).toBe('pay.team_role_forbidden');
      expect(
        (
          await refusal(() =>
            viewer.merchantOps.disputes.uploadEvidence({
              disputeId: 'dp-team',
              kind: 'receipt',
              fileName: 'r.pdf',
              contentType: 'application/pdf',
              contentBase64: Buffer.from('%PDF').toString('base64'),
            }),
          )
        ).cause,
      ).toBe('pay.team_role_forbidden');
      expect((await refusal(() => viewer.merchantOps.invoices.create({ requestId: id(), assetId: 'USDT', amount: '1' }))).cause).toBe(
        'pay.team_role_forbidden',
      );
      expect((await refusal(() => viewer.merchantOps.exports.create({ requestId: id(), kind: 'payments', filters: {} }))).cause).toBe(
        'pay.team_role_forbidden',
      );
      expect((await refusal(() => viewer.merchantOps.notifications.preferences.set({ kind: 'dispute_due', inApp: false }))).cause).toBe(
        'pay.team_role_forbidden',
      );
      expect((await refusal(() => viewer.merchantOps.team.invite({ userId: id(), role: 'viewer' }))).cause).toBe('pay.team_role_forbidden');
      // developer: exports yes, disputes no
      expect((await refusal(() => dev.merchantOps.disputes.addEvidence(evidence))).cause).toBe('pay.team_role_forbidden');
      expect((await refusal(() => dev.merchantOps.invoices.create({ requestId: id(), assetId: 'USDT', amount: '1' }))).cause).toBe(
        'pay.team_role_forbidden',
      );
      const drafted = (await fin.merchantOps.invoices.create({ requestId: id(), assetId: 'USDT', amount: '3.50' })) as {
        id: string;
        amount: string;
        status: string;
      };
      expect(drafted).toMatchObject({ status: 'draft', amount: '3.5' });
      expect(JSON.stringify(drafted)).not.toMatch(/pricingSnapshot|feeBps/);
      expect(
        (
          await refusal(() =>
            fin.merchantOps.disputes.uploadEvidence({
              disputeId: 'dp-team',
              kind: 'receipt',
              fileName: 'r.pdf',
              contentType: 'application/pdf',
              contentBase64: Buffer.from('%PDF').toString('base64'),
            }),
          )
        ).cause,
      ).toBe('pay.dispute_evidence_upload_off');
      const job = (await dev.merchantOps.exports.create({ requestId: id(), kind: 'payments', filters: {} })) as { jobId: string };
      // ...and sees only their own exports, while the owner sees all
      expect(((await viewer.merchantOps.exports.list({ limit: 10 })) as { items: unknown[] }).items).toHaveLength(0);
      expect((await refusal(() => viewer.merchantOps.exports.get({ jobId: job.jobId }))).code).toBe('NOT_FOUND');
      expect(((await ownerCaller().merchantOps.exports.list({ limit: 10 })) as { items: unknown[] }).items).toHaveLength(1);
      // finance answers disputes
      await fin.merchantOps.disputes.addEvidence(evidence);
      await fin.merchantOps.disputes.respond({ requestId: id(), disputeId: 'dp-team', action: 'contest' });
      expect(disputes.get('dp-team')?.status).toBe('contested');
    });

    it('the reusable gate: payout.approve is held by finance, admin and owner, not developer or viewer', async () => {
      expect(rolesWithPermission('payout.approve').sort()).toEqual(['admin', 'finance', 'owner']);
      const fin = await requireMerchantPermission(sql, { userId: people.finance }, 'payout.approve');
      expect(fin).toMatchObject({ merchantId: merchant, role: 'finance' });
      await expect(requireMerchantPermission(sql, { userId: people.viewer }, 'payout.approve')).rejects.toMatchObject({
        code: 'pay.team_role_forbidden',
      });
      await expect(requireMerchantPermission(sql, { userId: people.developer }, 'payout.approve')).rejects.toMatchObject({
        code: 'pay.team_role_forbidden',
      });
      await expect(requireMerchantPermission(sql, { userId: id() }, 'payout.approve')).rejects.toMatchObject({
        code: 'pay.merchant_ops_not_merchant',
      });
    });
  });

  // ── notifications ─────────────────────────────────────────────────────────
  describe('notifications (in-app only)', () => {
    const owner = id();
    let merchant = '';
    beforeAll(async () => {
      merchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
    });

    it("producers are idempotent on the dedupe key and honour the merchant's preference", async () => {
      const c = as(owner);
      const n = { merchantId: merchant, kind: 'settlement_failed' as const, title: 'Settlement failed', dedupeKey: 's:1' };
      const first = await recordMerchantNotification(sql, n);
      expect(first).not.toBeNull();
      expect(await recordMerchantNotification(sql, n)).toBeNull();
      await c.merchantOps.notifications.preferences.set({ kind: 'payout_failed', inApp: false });
      expect(await recordMerchantNotification(sql, { merchantId: merchant, kind: 'payout_failed', title: 'nope' })).toBeNull();
      const prefs = (await c.merchantOps.notifications.preferences.list({})) as Array<{
        kind: string;
        inApp: boolean;
        threshold: string | null;
      }>;
      expect(prefs.find((p) => p.kind === 'payout_failed')?.inApp).toBe(false);
      expect(prefs.find((p) => p.kind === 'dispute_due')).toMatchObject({ inApp: true, threshold: null });
    });

    it("thresholds are the merchant's own decimal string, only on limit_threshold", async () => {
      const c = as(owner);
      const set = (await c.merchantOps.notifications.preferences.set({ kind: 'limit_threshold', inApp: true, threshold: '80.5' })) as {
        threshold: string;
      };
      expect(set.threshold).toBe('80.5');
      const bad = await refusal(() => c.merchantOps.notifications.preferences.set({ kind: 'dispute_due', inApp: true, threshold: '5' }));
      expect(bad.cause).toBe('pay.notification_threshold_unsupported');
      await expect(
        c.merchantOps.notifications.preferences.set({ kind: 'limit_threshold', inApp: true, threshold: '-1' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('cursor pagination walks every row once, read state works, bad cursors are refused', async () => {
      const c = as(owner);
      for (let i = 0; i < 5; i += 1) {
        await recordMerchantNotification(sql, { merchantId: merchant, kind: 'webhook_failing', title: `w${i}`, dedupeKey: `w:${i}` });
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = (await c.merchantOps.notifications.list({ limit: 2, kind: 'webhook_failing', ...(cursor ? { cursor } : {}) })) as {
          items: Array<{ notificationId: string; title: string }>;
          nextCursor: string | null;
        };
        seen.push(...page.items.map((i) => i.title));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect([...seen].sort()).toEqual(['w0', 'w1', 'w2', 'w3', 'w4']);
      expect(new Set(seen).size).toBe(5);

      const before = (await c.merchantOps.notifications.unreadCount({})) as { unread: number };
      expect(before.unread).toBeGreaterThanOrEqual(5);
      const one = (
        (await c.merchantOps.notifications.list({ limit: 1, kind: 'webhook_failing' })) as { items: Array<{ notificationId: string }> }
      ).items[0]!;
      expect(await c.merchantOps.notifications.markRead({ notificationIds: [one.notificationId] })).toEqual({ marked: 1 });
      expect(await c.merchantOps.notifications.markRead({ notificationIds: [one.notificationId] })).toEqual({ marked: 0 });
      const unread = (await c.merchantOps.notifications.list({ limit: 50, unreadOnly: true })) as {
        items: Array<{ notificationId: string }>;
      };
      expect(unread.items.map((i) => i.notificationId)).not.toContain(one.notificationId);
      await c.merchantOps.notifications.markAllRead({});
      expect(((await c.merchantOps.notifications.unreadCount({})) as { unread: number }).unread).toBe(0);

      expect((await refusal(() => c.merchantOps.notifications.list({ limit: 2, cursor: 'not-a-cursor' }))).cause).toBe(
        'pay.cursor_invalid',
      );
      expect((await refusal(() => c.merchantOps.notifications.list({}))).cause).toBe('pay.merchant_ops_list_limit_unset');
    });
  });

  // ── operator notes ────────────────────────────────────────────────────────
  describe('operator notes (founder only, never visible to merchants)', () => {
    const noteInput = () => ({ merchantId: merchantA, body: 'SECRET-OPERATOR-OPINION', tags: ['watch'], flagged: true });
    const NOTE_PATHS: Array<[string, () => unknown]> = [
      ['founderAdmin.ops.notes.add', noteInput],
      ['founderAdmin.ops.notes.list', () => ({ merchantId: merchantA, limit: 10 })],
      ['founderAdmin.ops.notes.retract', () => ({ noteId: id(), reason: 'because' })],
    ];

    async function refusedEverywhere(principal: Principal | null, fetcher: typeof fetch, codes: string[], service: string | null = null) {
      const router = compose({ sql, founderAuthority: createFounderAuthority({ ...identity, fetcher }), disputes, exportKick: noKick });
      const caller = router.createCaller(ctxOf(principal, service));
      for (const [path, input] of NOTE_PATHS) {
        const r = await refusal(() => at(caller, path)(input()));
        expect(codes, `${path} -> ${r.code}`).toContain(r.code);
      }
    }

    it('G1: a merchant session (MFA, pay scopes, no founder entitlement) is refused', async () => {
      const f = vi.fn<typeof fetch>(async () => new Response('{}', { status: 403 }));
      await refusedEverywhere(principalOf(userA, { scopes: ['pay:read', 'pay:write', 'pay:payout'] }), f, ['FORBIDDEN']);
      await refusedEverywhere(
        principalOf(userA),
        vi.fn<typeof fetch>(async () => entitlementFor(userA, 'revoked')),
        ['FORBIDDEN'],
      );
    });

    it('G2: an API key with admin scopes is refused before identity is asked, even for a real founder', async () => {
      const f = vi.fn<typeof fetch>(async () => entitlementFor(founderUser));
      await refusedEverywhere(principalOf(founderUser, { kid: id(), scopes: ['admin:read', 'admin:write', 'admin:compliance'] }), f, [
        'FORBIDDEN',
      ]);
      expect(f).not.toHaveBeenCalled();
    });

    it('G3: admin scopes without a live founder entitlement, a team admin, and a team member are refused', async () => {
      await refusedEverywhere(
        principalOf(userA, { scopes: ['admin:read', 'admin:write', 'admin:compliance'] }),
        vi.fn<typeof fetch>(async () => entitlementFor(userA, 'revoked')),
        ['FORBIDDEN'],
      );
      // A merchant OWNER's "admin" role is a team role, not founder authority.
      await refusedEverywhere(
        principalOf(userB),
        vi.fn<typeof fetch>(async () => new Response('{}', { status: 403 })),
        ['FORBIDDEN'],
      );
    });

    it('anonymous, service-to-service, sub-account and no-MFA callers are refused; identity down is 503, never an allow', async () => {
      const f = vi.fn<typeof fetch>(async () => entitlementFor(founderUser));
      await refusedEverywhere(null, f, ['UNAUTHORIZED']);
      await refusedEverywhere(null, f, ['UNAUTHORIZED'], 'svc-admin');
      await refusedEverywhere(principalOf(founderUser), f, ['FORBIDDEN'], 'svc-admin');
      await refusedEverywhere(principalOf(founderUser, { sub_account: id() } as Partial<Principal>), f, ['FORBIDDEN']);
      await refusedEverywhere(principalOf(founderUser, { mfa: false }), f, ['FORBIDDEN']);
      expect(f).not.toHaveBeenCalled();
      await refusedEverywhere(
        principalOf(founderUser),
        vi.fn<typeof fetch>(async () => {
          throw new Error('network');
        }),
        ['SERVICE_UNAVAILABLE'],
      );
    });

    it('a live founder adds, lists and retracts; the note is attributed and the text is immutable', async () => {
      const f = as(founderUser, {}, build());
      const added = (await f.founderAdmin.ops.notes.add(noteInput())) as {
        noteId: string;
        authorId: string;
        flagged: boolean;
        tags: string[];
      };
      expect(added).toMatchObject({ authorId: founderUser, flagged: true, tags: ['watch'] });
      const list = (await f.founderAdmin.ops.notes.list({ merchantId: merchantA, limit: 10 })) as { items: Array<{ noteId: string }> };
      expect(list.items.map((n) => n.noteId)).toContain(added.noteId);
      expect(((await f.founderAdmin.ops.notes.list({ merchantId: merchantB, limit: 10 })) as { items: unknown[] }).items).toHaveLength(0);
      await expect(sql`UPDATE pay.operator_merchant_notes SET body = 'edited' WHERE id = ${added.noteId}`).rejects.toThrow(/immutable/);
      await expect(sql`DELETE FROM pay.operator_merchant_notes WHERE id = ${added.noteId}`).rejects.toThrow(/never deleted/);
      const gone = (await f.founderAdmin.ops.notes.retract({ noteId: added.noteId, reason: 'wrong merchant' })) as { retractedBy: string };
      expect(gone.retractedBy).toBe(founderUser);
      expect(((await f.founderAdmin.ops.notes.list({ merchantId: merchantA, limit: 10 })) as { items: unknown[] }).items).toHaveLength(0);
      expect(
        ((await f.founderAdmin.ops.notes.list({ merchantId: merchantA, limit: 10, includeRetracted: true })) as { items: unknown[] }).items,
      ).toHaveLength(1);
      expect((await refusal(() => f.founderAdmin.ops.notes.add({ ...noteInput(), merchantId: id() }))).cause).toBe(
        'pay.merchant_not_found',
      );
    });

    it('no merchant-facing answer ever contains an operator note (behaviour), and no merchantOps source reads the table (static)', async () => {
      const f = as(founderUser, {}, build());
      await f.founderAdmin.ops.notes.add({
        merchantId: merchantA,
        body: 'SECRET-OPERATOR-OPINION-2',
        tags: ['internal-tag'],
        flagged: true,
      });
      const a = as(userA);
      const answers = [
        await a.merchantOps.team.list({ limit: 50 }),
        await a.merchantOps.team.history({ limit: 50 }),
        await a.merchantOps.kyb.current({}),
        await a.merchantOps.kyb.history({ limit: 50 }),
        await a.merchantOps.disputes.list({ limit: 50 }),
        await a.merchantOps.customers.list({ limit: 50 }),
        await a.merchantOps.notifications.list({ limit: 50 }),
        await a.merchantOps.exports.list({ limit: 50 }),
      ];
      const text = JSON.stringify(answers);
      expect(text).not.toContain('SECRET-OPERATOR');
      expect(text).not.toContain('internal-tag');
      const offenders = readdirSync(here)
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'notes.ts' && file !== 'router.ts')
        .filter((file) => readFileSync(join(here, file), 'utf8').includes('operator_merchant_notes'));
      expect(offenders).toEqual([]);
      // In the router the table is reached only through OperatorNotes, which is wired under founderAdmin.ops.
      const routerSrc = readFileSync(join(here, 'router.ts'), 'utf8');
      expect(routerSrc).not.toContain('operator_merchant_notes');
      const merchantOpsBlock = routerSrc.slice(
        routerSrc.indexOf('merchantOps: router({'),
        routerSrc.indexOf('export type MerchantOpsRouter'),
      );
      expect(merchantOpsBlock).not.toMatch(/\.notes\b/);
    });
  });

  // ── mount ─────────────────────────────────────────────────────────────────
  describe('mounted in the pay namespaces', () => {
    const procs = (r: unknown) => Object.keys((r as { _def: { procedures: Record<string, unknown> } })._def.procedures);

    it('every founderAdmin.* procedure, including founderAdmin.ops.*, is behind founder authority (G7)', () => {
      const ns = createPayNamespaces({ founderAuthority, sql });
      const paths = procs(ns);
      expect(paths).toContain('founderAdmin.ops.notes.add');
      expect(paths).toContain('founderAdmin.merchants.list'); // W0 stub still there: the two routers merged, not replaced
      expect(paths).toContain('merchantOps.disputes.list');
      expect(findUnguardedFounderProcedures(ns, FOUNDER_ONLY_PREFIXES)).toEqual([]);
    });

    it('without a database every merchantOps procedure refuses closed, never answers empty', async () => {
      const ns = compose({ founderAuthority });
      const r = await refusal(() => ns.createCaller(ctxOf(principalOf(userA))).merchantOps.disputes.list({ limit: 5 }));
      expect(r).toMatchObject({ code: 'SERVICE_UNAVAILABLE', cause: 'pay.merchant_ops_unavailable' });
    });

    it('a procedure needs its session scope before any role is looked at', async () => {
      const noPay = as(userA, { scopes: ['trade:read'] });
      expect((await refusal(() => noPay.merchantOps.disputes.list({ limit: 5 }))).code).toBe('FORBIDDEN');
      const readOnly = as(userA, { scopes: ['pay:read'] });
      await readOnly.merchantOps.disputes.list({ limit: 5 });
      expect((await refusal(() => readOnly.merchantOps.notifications.markAllRead({}))).code).toBe('FORBIDDEN');
    });
  });
});
