import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryLedger, formatAmount, merchantClearing, parseAmount, railBoundary } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createFounderAuthority } from '../founder-authority.js';
import { refuseChargebackLedgerPost } from '../fraud/chargeback-ledger-socket.js';
import { defaultDisputeCaseStore } from '../fraud/dispute-case.js';
import { PayService } from '../payment-service.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { RailRegistry } from '../rails/registry.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from '../routing/decide.js';
import { recordRailDisputeDeadline } from './dispute-deadlines.js';
import type { DisputeEvidenceGate, DisputeEvidenceScanner } from './dispute-evidence-policy.js';
import type { InvoiceLinkPort } from './invoices.js';
import { createMerchantOpsRouter } from './router.js';

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
    .withDatabase('intafaced_portal_gap_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const nid = () => randomUUID();
const identity = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) };
const principalOf = (userId: string, over: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: nid(),
  scopes: ['pay:read', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
  ...over,
});
const ctxOf = (principal: Principal): Context => ({ principal, service: null, region: 'DE', requestId: nid() });

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    const err = e as { code: string; message: string; cause?: { code?: string } };
    return { code: err.code, message: err.message, cause: err.cause?.code };
  }
  throw new Error('expected a refusal');
}

function linkPort(sql: Sql): InvoiceLinkPort {
  return {
    async createPaymentLink(input) {
      const token = `pl_${nid()}`;
      const rows = await sql<Array<{ id: string; token_prefix: string; expires_at: Date; max_uses: number | null }>>`
        INSERT INTO pay.payment_links (merchant_id, token_hash, token_prefix, label, amount, currency, max_uses, expires_at)
        VALUES (
          ${input.merchantId},
          ${createHash('sha256').update(token).digest('hex')},
          ${token.slice(0, 10)},
          ${input.label},
          ${formatAmount(input.amount ?? 1n)},
          ${input.currency ?? null},
          ${input.maxUses ?? null},
          ${new Date(Date.now() + 86_400_000)}
        )
        RETURNING id, token_prefix, expires_at, max_uses`;
      const row = rows[0]!;
      return {
        id: row.id,
        token,
        prefix: row.token_prefix,
        label: input.label,
        expiresAt: row.expires_at,
        maxUses: row.max_uses,
      };
    },
    async deactivatePaymentLink(merchantId, linkId) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE pay.payment_links SET active = false WHERE id = ${linkId} AND merchant_id = ${merchantId} RETURNING id`;
      return { deactivated: rows.length > 0 };
    },
  };
}

describe('merchant portal gaps: dispute deadlines, evidence, invoices', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = nid();
  const other = nid();
  const viewer = nid();
  const developer = nid();
  const finance = nid();
  let merchant = '';
  let foreign = '';

  const founderAuthority = createFounderAuthority({ ...identity, fetcher: async () => new Response('{}', { status: 404 }) });
  const cleanScanner: DisputeEvidenceScanner = { scan: async () => 'clean' };
  const clean: DisputeEvidenceGate = { uploadEnabled: true, scanEnabled: true, scanner: cleanScanner };
  const routerFor = (gate: DisputeEvidenceGate = clean) =>
    createMerchantOpsRouter({
      sql,
      founderAuthority,
      disputes: defaultDisputeCaseStore,
      exportKick: () => undefined,
      evidence: gate,
      invoiceLinks: linkPort(sql),
    });
  const as = (userId: string, gate: DisputeEvidenceGate = clean) => routerFor(gate).createCaller(ctxOf(principalOf(userId)));

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    merchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
    foreign = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${other}) RETURNING id`)[0]!.id;
    await sql`UPDATE pay.merchants SET status = 'active'::pay.merchant_status WHERE id = ${merchant}`;
    for (const [userId, role] of [
      [viewer, 'viewer'],
      [developer, 'developer'],
      [finance, 'finance'],
    ] as const) {
      await sql`
        INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
        VALUES (${merchant}, ${userId}, ${role}, 'active', ${owner}, now())`;
    }
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  function payAttempt() {
    const rail = new CardSandboxAdapter({ secret: 'svc-pay-test-secret-at-least-32-characters', toleranceSeconds: 300 });
    return new PayService(sql, new MemoryLedger(), new RailRegistry([rail]), {
      checkoutRails: [{ railId: 'card-sandbox', method: 'card' }],
      checkoutRiskBand: 'low',
      publicCheckoutMovement: 'allow-sandbox',
      routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((profile) =>
        profile.railId === 'card-sandbox' ? { ...profile, successRate: '0.88' } : profile,
      ),
    });
  }

  async function payment(status: string, amount = '10', merchantId = merchant) {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, rail_ref, status)
      VALUES (${merchantId}, ${amount}, 'USDT', 'card', 'card-sandbox', ${'ref-' + nid()}, ${status}::pay.payment_status)
      RETURNING id`;
    return rows[0]!.id;
  }

  it('records a rail due date once, leaves a missing date null, and filters on the server', async () => {
    const payId = await payment('captured');
    const withDue = `dp-due-${nid()}`;
    const noDue = `dp-none-${nid()}`;
    const later = `dp-later-${nid()}`;
    const firstDue = new Date('2026-06-01T00:00:00.000Z');
    const secondDue = new Date('2026-08-15T00:00:00.000Z');
    defaultDisputeCaseStore.open({
      disputeId: withDue,
      paymentId: payId,
      merchantId: merchant,
      amount: '10',
      assetId: 'USDT',
      ledgerPost: { txId: 'tx-open-1' },
    });
    defaultDisputeCaseStore.open({
      disputeId: noDue,
      paymentId: payId,
      merchantId: merchant,
      amount: '10',
      assetId: 'USDT',
      ledgerRefuse: {
        ...refuseChargebackLedgerPost({ disputeId: noDue, paymentId: payId }),
        code: 'pay.chargeback_uncovered',
      },
    });
    defaultDisputeCaseStore.open({ disputeId: later, paymentId: payId, merchantId: merchant, amount: '10', assetId: 'USDT' });
    await recordRailDisputeDeadline(sql, { merchantId: merchant, disputeId: withDue, evidenceDueBy: firstDue, railEventId: 'rail:1' });
    await recordRailDisputeDeadline(sql, {
      merchantId: merchant,
      disputeId: withDue,
      evidenceDueBy: new Date('2026-12-01T00:00:00.000Z'),
      railEventId: 'rail:2',
    });
    await recordRailDisputeDeadline(sql, { merchantId: merchant, disputeId: noDue, evidenceDueBy: null, railEventId: 'rail:3' });
    await recordRailDisputeDeadline(sql, { merchantId: merchant, disputeId: later, evidenceDueBy: null, railEventId: 'rail:4' });
    await recordRailDisputeDeadline(sql, { merchantId: merchant, disputeId: later, evidenceDueBy: secondDue, railEventId: 'rail:5' });

    const caller = as(owner);
    const posted = (await caller.merchantOps.disputes.get({ disputeId: withDue })) as {
      responseDueAt: string | null;
      responseDueSource: string | null;
      openingLedger: { wire: string; txId: string | null; refuseCode: string | null; refuseSocket: string | null };
      evidence: unknown[];
    };
    expect(posted.responseDueAt).toBe(firstDue.toISOString());
    expect(posted.responseDueSource).toBe('rail_event');
    expect(posted.openingLedger).toEqual({ wire: 'posted', txId: 'tx-open-1', refuseCode: null, refuseSocket: null });
    expect(JSON.stringify(posted)).not.toContain('contentBase64');

    const refused = (await caller.merchantOps.disputes.get({ disputeId: noDue })) as {
      responseDueAt: string | null;
      responseDueSource: string | null;
      openingLedger: { wire: string; txId: string | null; refuseCode: string | null; refuseSocket: string | null };
    };
    expect(refused.responseDueAt).toBeNull();
    expect(refused.responseDueSource).toBeNull();
    expect(refused.openingLedger).toEqual({
      wire: 'refused',
      txId: null,
      refuseCode: 'pay.chargeback_uncovered',
      refuseSocket: 'socket.pay-chargeback-ledger-wire',
    });
    expect(JSON.stringify(refused)).not.toContain('no value moved');

    const filled = (await caller.merchantOps.disputes.get({ disputeId: later })) as { responseDueAt: string | null };
    expect(filled.responseDueAt).toBe(secondDue.toISOString());

    const set = (await caller.merchantOps.disputes.list({ limit: 50, deadline: 'set' })) as { items: Array<{ disputeId: string }> };
    expect(set.items.map((i) => i.disputeId)).toEqual(expect.arrayContaining([withDue, later]));
    expect(set.items.map((i) => i.disputeId)).not.toContain(noDue);
    const unset = (await caller.merchantOps.disputes.list({ limit: 50, deadline: 'unset' })) as { items: Array<{ disputeId: string }> };
    expect(unset.items.map((i) => i.disputeId)).toContain(noDue);
    expect(unset.items.map((i) => i.disputeId)).not.toContain(withDue);
    const window = (await caller.merchantOps.disputes.list({
      limit: 50,
      dueAfter: '2026-07-01T00:00:00.000Z',
      dueBefore: '2026-09-01T00:00:00.000Z',
    })) as { items: Array<{ disputeId: string }> };
    expect(window.items.map((i) => i.disputeId)).toEqual([later]);
    expect(
      (await refusal(() => caller.merchantOps.disputes.list({ limit: 50, deadline: 'unset', dueAfter: '2026-01-01T00:00:00.000Z' }))).cause,
    ).toBe('pay.dispute_deadline_filter_invalid');

    const stranger = as(other);
    const missing = await refusal(() => stranger.merchantOps.disputes.get({ disputeId: 'dp-missing' }));
    const foreignGet = await refusal(() => stranger.merchantOps.disputes.get({ disputeId: withDue }));
    expect(foreignGet).toEqual(missing);
  });

  it('stores evidence only when upload and a clean scan are configured, and never serves another merchant', async () => {
    const payId = await payment('captured');
    const disputeId = `dp-ev-${nid()}`;
    defaultDisputeCaseStore.open({ disputeId, paymentId: payId, merchantId: merchant, amount: '10', assetId: 'USDT' });
    const bytes = Buffer.from('%PDF-evidence');
    const body = {
      disputeId,
      kind: 'receipt' as const,
      fileName: 'receipt.pdf',
      contentType: 'application/pdf',
      contentBase64: bytes.toString('base64'),
    };
    const off = as(owner, { uploadEnabled: false, scanEnabled: true, scanner: cleanScanner });
    expect((await refusal(() => off.merchantOps.disputes.uploadEvidence(body))).cause).toBe('pay.dispute_evidence_upload_off');
    const unscanned = as(owner, { uploadEnabled: true, scanEnabled: false });
    expect((await refusal(() => unscanned.merchantOps.disputes.uploadEvidence(body))).cause).toBe('pay.dispute_evidence_scan_unconfigured');
    const rejecting = as(owner, { uploadEnabled: true, scanEnabled: true, scanner: { scan: async () => 'rejected' } });
    expect((await refusal(() => rejecting.merchantOps.disputes.uploadEvidence(body))).cause).toBe('pay.dispute_evidence_rejected');
    const failing = as(owner, {
      uploadEnabled: true,
      scanEnabled: true,
      scanner: {
        scan: async () => {
          throw new Error('scanner down');
        },
      },
    });
    expect((await refusal(() => failing.merchantOps.disputes.uploadEvidence(body))).cause).toBe('pay.dispute_evidence_scan_failed');
    const stored = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.merchant_dispute_evidence WHERE dispute_id = ${disputeId}`;
    expect(stored[0]!.n).toBe(0);

    const ownerCaller = as(owner);
    const uploaded = (await ownerCaller.merchantOps.disputes.uploadEvidence(body)) as {
      evidenceId: string;
      sha256: string;
      hasContent: boolean;
    };
    expect(uploaded.hasContent).toBe(true);
    const got = (await ownerCaller.merchantOps.disputes.getEvidence({ evidenceId: uploaded.evidenceId })) as {
      contentBase64: string;
      sha256: string;
    };
    expect(Buffer.from(got.contentBase64, 'base64').equals(bytes)).toBe(true);
    expect(got.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await refusal(() => as(viewer).merchantOps.disputes.getEvidence({ evidenceId: uploaded.evidenceId }))).cause).toBe(
      'pay.team_role_forbidden',
    );
    expect((await refusal(() => as(developer).merchantOps.disputes.getEvidence({ evidenceId: uploaded.evidenceId }))).cause).toBe(
      'pay.team_role_forbidden',
    );
    const apiKey = routerFor().createCaller(ctxOf(principalOf(owner, { kid: nid(), mfa: false })));
    expect((await refusal(() => apiKey.merchantOps.disputes.getEvidence({ evidenceId: uploaded.evidenceId }))).cause).toBe(
      'pay.dispute_evidence_interactive_only',
    );
    const financeBytes = (await as(finance).merchantOps.disputes.getEvidence({ evidenceId: uploaded.evidenceId })) as {
      contentBase64: string;
    };
    expect(Buffer.from(financeBytes.contentBase64, 'base64').equals(bytes)).toBe(true);
    const detail = await ownerCaller.merchantOps.disputes.get({ disputeId });
    expect(JSON.stringify(detail)).not.toContain(body.contentBase64);
    expect(JSON.stringify(detail)).toContain('"hasContent":true');

    expect((await refusal(() => ownerCaller.merchantOps.disputes.uploadEvidence({ ...body, contentType: 'application/zip' }))).cause).toBe(
      'pay.dispute_evidence_content_type',
    );
    expect((await refusal(() => ownerCaller.merchantOps.disputes.uploadEvidence({ ...body, sha256: 'ab'.repeat(32) }))).cause).toBe(
      'pay.dispute_evidence_hash_mismatch',
    );
    expect((await refusal(() => ownerCaller.merchantOps.disputes.uploadEvidence({ ...body, contentBase64: '   ' }))).cause).toBe(
      'pay.dispute_evidence_empty',
    );
    const huge = Buffer.alloc(1_048_577, 2).toString('base64');
    expect((await refusal(() => ownerCaller.merchantOps.disputes.uploadEvidence({ ...body, contentBase64: huge }))).cause).toBe(
      'pay.dispute_evidence_too_large',
    );

    const foreignDispute = `dp-foreign-${nid()}`;
    defaultDisputeCaseStore.open({ disputeId: foreignDispute, paymentId: payId, merchantId: foreign, amount: '10', assetId: 'USDT' });
    const missing = await refusal(() => ownerCaller.merchantOps.disputes.uploadEvidence({ ...body, disputeId: 'dp-absent' }));
    const aimed = await refusal(() => ownerCaller.merchantOps.disputes.uploadEvidence({ ...body, disputeId: foreignDispute }));
    expect(aimed).toEqual(missing);
    expect(aimed.cause).toBe('pay.dispute_not_found');
    const missingFile = await refusal(() => ownerCaller.merchantOps.disputes.getEvidence({ evidenceId: nid() }));
    const otherCaller = as(other);
    const foreignFile = await refusal(() => otherCaller.merchantOps.disputes.getEvidence({ evidenceId: uploaded.evidenceId }));
    expect(foreignFile).toEqual(missingFile);

    expect((await refusal(() => as(viewer).merchantOps.disputes.uploadEvidence(body))).cause).toBe('pay.team_role_forbidden');
    expect((await refusal(() => as(developer).merchantOps.disputes.uploadEvidence(body))).cause).toBe('pay.team_role_forbidden');
    const financeUpload = (await as(finance).merchantOps.disputes.uploadEvidence({ ...body, fileName: 'finance.pdf' })) as {
      evidenceId: string;
    };
    expect(financeUpload.evidenceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('creates, lists, sends, voids, and marks an invoice paid without a new ledger path', async () => {
    const ownerCaller = as(owner);
    const bare = createMerchantOpsRouter({
      sql,
      founderAuthority,
      disputes: defaultDisputeCaseStore,
      exportKick: () => undefined,
    }).createCaller(ctxOf(principalOf(owner)));
    expect((await refusal(() => ownerCaller.merchantOps.invoices.list({}))).cause).toBe('pay.merchant_ops_list_limit_unset');

    const requestA = nid();
    const draft = (await ownerCaller.merchantOps.invoices.create({
      requestId: requestA,
      assetId: 'USDT',
      amount: '10.00',
      customerRef: 'cust-gap',
      description: 'June invoice',
    })) as { id: string; status: string; amount: string };
    expect(draft).toMatchObject({ status: 'draft', amount: '10' });
    const replay = (await ownerCaller.merchantOps.invoices.create({
      requestId: requestA,
      assetId: 'USDT',
      amount: '10.00',
      customerRef: 'cust-gap',
      description: 'June invoice',
    })) as { id: string };
    expect(replay.id).toBe(draft.id);
    expect(
      (
        await refusal(() =>
          ownerCaller.merchantOps.invoices.create({
            requestId: requestA,
            assetId: 'USDT',
            amount: '11',
            customerRef: 'cust-gap',
            description: 'June invoice',
          }),
        )
      ).cause,
    ).toBe('pay.request_id_reused');

    const otherDraft = (await ownerCaller.merchantOps.invoices.create({
      requestId: nid(),
      assetId: 'BTC',
      amount: '0.5',
      customerRef: 'other',
    })) as { id: string };
    const page = (await ownerCaller.merchantOps.invoices.list({ limit: 1, status: 'draft', assetId: 'USDT', search: 'cust-gap' })) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page.items.map((i) => i.id)).toEqual([draft.id]);
    expect(page.nextCursor).toBeNull();
    const missing = await refusal(() => ownerCaller.merchantOps.invoices.get({ invoiceId: nid() }));
    const foreignCaller = as(other);
    expect(await refusal(() => foreignCaller.merchantOps.invoices.get({ invoiceId: draft.id }))).toEqual(missing);

    const unwired = (await bare.merchantOps.invoices.create({ requestId: nid(), assetId: 'USDT', amount: '1' })) as { id: string };
    expect((await refusal(() => bare.merchantOps.invoices.send({ requestId: nid(), invoiceId: unwired.id }))).cause).toBe(
      'pay.invoice_payment_link_unwired',
    );

    await sql`UPDATE pay.merchants SET status = 'pending'::pay.merchant_status WHERE id = ${merchant}`;
    expect((await refusal(() => ownerCaller.merchantOps.invoices.send({ requestId: nid(), invoiceId: draft.id }))).cause).toBe(
      'pay.merchant_inactive',
    );
    await sql`UPDATE pay.merchants SET status = 'active'::pay.merchant_status WHERE id = ${merchant}`;

    const sendId = nid();
    const sent = (await ownerCaller.merchantOps.invoices.send({ requestId: sendId, invoiceId: draft.id })) as {
      invoice: { status: string; paymentLinkId: string | null };
      paymentLink: { token: string | null; alreadyIssued: boolean; maxUses: number | null };
    };
    expect(sent.invoice.status).toBe('sent');
    expect(sent.paymentLink.token).toMatch(/^pl_/);
    expect(sent.paymentLink.alreadyIssued).toBe(false);
    expect(sent.paymentLink.maxUses).toBe(1);
    const again = (await ownerCaller.merchantOps.invoices.send({ requestId: sendId, invoiceId: draft.id })) as {
      paymentLink: { token: string | null; alreadyIssued: boolean };
    };
    expect(again.paymentLink.token).toBeNull();
    expect(again.paymentLink.alreadyIssued).toBe(true);
    const links = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.merchant_invoices WHERE id = ${draft.id} AND payment_link_id IS NOT NULL`;
    expect(links[0]!.n).toBe(1);
    const got = await ownerCaller.merchantOps.invoices.get({ invoiceId: draft.id });
    expect(JSON.stringify(got)).not.toContain(sent.paymentLink.token!);

    const payable = (await ownerCaller.merchantOps.invoices.create({
      requestId: nid(),
      assetId: 'USDT',
      amount: '0.5',
    })) as { id: string };
    const createdOnly = await payment('created', '0.5');
    expect(
      (
        await refusal(() =>
          ownerCaller.merchantOps.invoices.markPaidByPayment({ requestId: nid(), invoiceId: payable.id, paymentId: createdOnly }),
        )
      ).cause,
    ).toBe('pay.invoice_payment_not_paid');
    const wrongAmount = await payment('captured', '9');
    expect(
      (
        await refusal(() =>
          ownerCaller.merchantOps.invoices.markPaidByPayment({ requestId: nid(), invoiceId: payable.id, paymentId: wrongAmount }),
        )
      ).cause,
    ).toBe('pay.invoice_payment_mismatch');
    const foreignPay = await payment('captured', '0.5', foreign);
    const missingPay = await refusal(() =>
      ownerCaller.merchantOps.invoices.markPaidByPayment({ requestId: nid(), invoiceId: payable.id, paymentId: nid() }),
    );
    const aimedPay = await refusal(() =>
      ownerCaller.merchantOps.invoices.markPaidByPayment({ requestId: nid(), invoiceId: payable.id, paymentId: foreignPay }),
    );
    expect(aimedPay).toEqual(missingPay);
    expect(aimedPay.cause).toBe('pay.invoice_payment_not_found');

    const matching = await payment('settled', '0.5');
    const paid = (await ownerCaller.merchantOps.invoices.markPaidByPayment({
      requestId: nid(),
      invoiceId: payable.id,
      paymentId: matching,
    })) as { status: string; paymentId: string | null };
    expect(paid).toMatchObject({ status: 'paid', paymentId: matching });
    expect((await refusal(() => ownerCaller.merchantOps.invoices.void({ requestId: nid(), invoiceId: payable.id }))).cause).toBe(
      'pay.invoice_paid',
    );

    const live = await payAttempt();
    expect((await live.resolvePaymentLink(sent.paymentLink.token!)).id).toBe(sent.invoice.paymentLinkId);
    const voided = (await ownerCaller.merchantOps.invoices.void({ requestId: nid(), invoiceId: draft.id })) as { status: string };
    expect(voided.status).toBe('void');
    const linkRow = await sql<Array<{ active: boolean }>>`SELECT active FROM pay.payment_links WHERE id = ${sent.invoice.paymentLinkId}`;
    expect(linkRow[0]!.active).toBe(false);
    await expect(live.resolvePaymentLink(sent.paymentLink.token!)).rejects.toMatchObject({ code: 'pay.link_not_found' });
    await expect(live.openCheckoutSession({ linkToken: sent.paymentLink.token!, geoCountry: 'DE', method: 'card' })).rejects.toMatchObject({
      code: 'pay.link_not_found',
    });
    const sessions = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.checkout_sessions WHERE link_id = ${sent.invoice.paymentLinkId}`;
    expect(sessions[0]!.n).toBe(0);

    expect((await refusal(() => as(viewer).merchantOps.invoices.create({ requestId: nid(), assetId: 'USDT', amount: '1' }))).cause).toBe(
      'pay.team_role_forbidden',
    );
    expect((await refusal(() => as(developer).merchantOps.invoices.create({ requestId: nid(), assetId: 'USDT', amount: '1' }))).cause).toBe(
      'pay.team_role_forbidden',
    );
    const financeDraft = (await as(finance).merchantOps.invoices.create({ requestId: nid(), assetId: 'USDT', amount: '2' })) as {
      status: string;
    };
    expect(financeDraft.status).toBe('draft');
    const foreignInvoice = (await foreignCaller.merchantOps.invoices.create({ requestId: nid(), assetId: 'USDT', amount: '3' })) as {
      id: string;
    };
    const visible = (await as(viewer).merchantOps.invoices.list({ limit: 20 })) as { items: Array<{ id: string }> };
    expect(visible.items.map((i) => i.id)).toContain(draft.id);
    expect(visible.items.map((i) => i.id)).not.toContain(foreignInvoice.id);
  });

  it('stores a due date, a customer email and line items whose total is the header amount', async () => {
    const ownerCaller = as(owner);
    const bare = await ownerCaller.merchantOps.invoices.create({
      requestId: nid(),
      assetId: 'USDT',
      amount: '10',
    });
    expect(bare).toMatchObject({ dueAt: null, customerEmail: null, lineItems: [] });

    const dueAt = '2026-11-01T00:00:00.000Z';
    const created = await ownerCaller.merchantOps.invoices.create({
      requestId: nid(),
      assetId: 'USDT',
      amount: '3.25',
      customerEmail: 'buyer@example.com',
      dueAt,
      lineItems: [
        { description: 'Widget', quantity: '2', unitAmount: '1.25' },
        { description: 'Seal', quantity: '1.5', unitAmount: '0.50' },
      ],
    });
    expect(created.amount).toBe('3.25');
    expect(created.customerEmail).toBe('b***@e***.com');
    expect(created.dueAt).toBe(dueAt);
    expect(created.lineItems).toEqual([
      { kind: 'charge', description: 'Widget', quantity: '2', unitAmount: '1.25', amount: '2.5' },
      { kind: 'charge', description: 'Seal', quantity: '1.5', unitAmount: '0.5', amount: '0.75' },
    ]);
    const got = await ownerCaller.merchantOps.invoices.get({ invoiceId: created.id });
    expect(got).toMatchObject({
      customerEmail: 'buyer@example.com',
      dueAt,
      lineItems: created.lineItems,
    });
    const found = await ownerCaller.merchantOps.invoices.list({ limit: 20, search: 'buyer@example.com' });
    expect(found.items.map((item) => item.id)).not.toContain(created.id);
    const listed = await ownerCaller.merchantOps.invoices.list({ limit: 20 });
    expect(listed.items.find((item) => item.id === created.id)?.customerEmail).toBe('b***@e***.com');
    expect(JSON.stringify(listed)).not.toContain('buyer@example.com');

    expect(
      (
        await refusal(() =>
          ownerCaller.merchantOps.invoices.create({
            requestId: nid(),
            assetId: 'USDT',
            amount: '3',
            lineItems: [
              { description: 'Widget', quantity: '2', unitAmount: '1.25' },
              { description: 'Seal', quantity: '1.5', unitAmount: '0.50' },
            ],
          }),
        )
      ).cause,
    ).toBe('pay.invoice_total_mismatch');
    expect(
      (
        await refusal(() =>
          ownerCaller.merchantOps.invoices.create({
            requestId: nid(),
            assetId: 'USDT',
            amount: '1',
            lineItems: [{ description: 'Dust', quantity: '0.0000000001', unitAmount: '0.0000000001' }],
          }),
        )
      ).cause,
    ).toBe('pay.invoice_line_not_exact');
    expect(
      (
        await refusal(() =>
          ownerCaller.merchantOps.invoices.create({
            requestId: nid(),
            assetId: 'USDT',
            amount: '1',
            customerEmail: 'not-an-email',
          }),
        )
      ).cause,
    ).toBe('pay.invoice_email_invalid');

    const requestId = nid();
    const first = await ownerCaller.merchantOps.invoices.create({
      requestId,
      assetId: 'USDT',
      amount: '2',
      lineItems: [{ description: 'One', quantity: '1', unitAmount: '2' }],
    });
    const replay = await ownerCaller.merchantOps.invoices.create({
      requestId,
      assetId: 'USDT',
      amount: '2',
      lineItems: [{ description: 'One', quantity: '1.0', unitAmount: '2.00' }],
    });
    expect(replay.id).toBe(first.id);
    expect(replay.lineItems).toEqual([{ kind: 'charge', description: 'One', quantity: '1', unitAmount: '2', amount: '2' }]);
    expect(
      (
        await refusal(() =>
          ownerCaller.merchantOps.invoices.create({
            requestId,
            assetId: 'USDT',
            amount: '4',
            lineItems: [{ description: 'One', quantity: '2', unitAmount: '2' }],
          }),
        )
      ).cause,
    ).toBe('pay.request_id_reused');
  });

  it('negates credits, refuses an all-free total, masks the email except on an owner get, and logs that read', async () => {
    const admin = nid();
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchant}, ${admin}, 'admin', 'active', ${owner}, now())`;
    const ownerCaller = as(owner);
    const mixed = await ownerCaller.merchantOps.invoices.create({
      requestId: nid(),
      assetId: 'USDT',
      amount: '7.5',
      customerEmail: 'buyer@example.com',
      lineItems: [
        { description: 'Work', quantity: '2', unitAmount: '5' },
        { description: 'Rebate', kind: 'credit', quantity: '1', unitAmount: '2.5' },
        { description: 'Sample', kind: 'charge', quantity: '1', unitAmount: '0' },
      ],
    });
    expect(mixed.lineItems).toEqual([
      { kind: 'charge', description: 'Work', quantity: '2', unitAmount: '5', amount: '10' },
      { kind: 'credit', description: 'Rebate', quantity: '1', unitAmount: '2.5', amount: '-2.5' },
      { kind: 'charge', description: 'Sample', quantity: '1', unitAmount: '0', amount: '0' },
    ]);
    expect(mixed.customerEmail).toBe('b***@e***.com');
    expect(
      (
        await refusal(() =>
          ownerCaller.merchantOps.invoices.create({
            requestId: nid(),
            assetId: 'USDT',
            amount: '1',
            lineItems: [{ description: 'Free', quantity: '1', unitAmount: '0' }],
          }),
        )
      ).cause,
    ).toBe('pay.invoice_total_not_positive');
    expect(
      (
        await refusal(() =>
          ownerCaller.merchantOps.invoices.create({
            requestId: nid(),
            assetId: 'USDT',
            amount: '1',
            lineItems: [
              { description: 'Work', quantity: '1', unitAmount: '5' },
              { description: 'Rebate', kind: 'credit', quantity: '1', unitAmount: '5' },
            ],
          }),
        )
      ).cause,
    ).toBe('pay.invoice_total_not_positive');

    const same = nid();
    const charged = await ownerCaller.merchantOps.invoices.create({
      requestId: same,
      assetId: 'USDT',
      amount: '2',
      lineItems: [{ description: 'One', quantity: '1', unitAmount: '2' }],
    });
    const replayed = await ownerCaller.merchantOps.invoices.create({
      requestId: same,
      assetId: 'USDT',
      amount: '2',
      lineItems: [{ description: 'One', quantity: '1', unitAmount: '2', kind: 'charge' }],
    });
    expect(replayed.id).toBe(charged.id);
    expect(
      (
        await refusal(() =>
          ownerCaller.merchantOps.invoices.create({
            requestId: same,
            assetId: 'USDT',
            amount: '2',
            lineItems: [
              { description: 'One', kind: 'charge', quantity: '1', unitAmount: '4' },
              { description: 'Rebate', kind: 'credit', quantity: '1', unitAmount: '2' },
            ],
          }),
        )
      ).cause,
    ).toBe('pay.request_id_reused');

    await expect(
      sql.begin(async (tx) => {
        await tx`
          UPDATE pay.merchant_invoice_lines
             SET unit_amount = 0, line_amount = 0
           WHERE invoice_id = ${mixed.id} AND kind = 'charge'`;
      }),
    ).rejects.toThrow(/pay.invoice_total_not_positive/);
    await expect(
      sql`
        UPDATE pay.merchant_invoice_lines
           SET line_amount = -1
         WHERE invoice_id = ${mixed.id} AND kind = 'charge'`,
    ).rejects.toThrow(/check|sign_ck|violates/);

    const roles = [
      ['admin', as(admin)],
      ['finance', as(finance)],
      ['developer', as(developer)],
      ['viewer', as(viewer)],
      ['api-key', routerFor().createCaller(ctxOf(principalOf(owner, { kid: nid(), mfa: false })))],
      ['owner-without-mfa', routerFor().createCaller(ctxOf(principalOf(owner, { mfa: false })))],
    ] as const;
    for (const [, caller] of roles) {
      const page = await caller.merchantOps.invoices.list({ limit: 20 });
      expect(page.items.find((item) => item.id === mixed.id)?.customerEmail).toBe('b***@e***.com');
      expect(JSON.stringify(page)).not.toContain('buyer@example.com');
      const detail = await caller.merchantOps.invoices.get({ invoiceId: mixed.id });
      expect(detail.customerEmail).toBe('b***@e***.com');
    }
    const before = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.control_audit
       WHERE kind = 'invoice.customer_email_read' AND scope_id = ${mixed.id}`;
    expect(before[0]!.n).toBe(0);
    expect((await ownerCaller.merchantOps.invoices.get({ invoiceId: mixed.id })).customerEmail).toBe('buyer@example.com');
    expect((await ownerCaller.merchantOps.invoices.get({ invoiceId: mixed.id })).customerEmail).toBe('buyer@example.com');
    const reads = await sql<Array<{ reason: string; after: { invoiceId?: string } | null }>>`
      SELECT reason, after FROM pay.control_audit
       WHERE kind = 'invoice.customer_email_read' AND scope_id = ${mixed.id}
       ORDER BY seq`;
    expect(reads).toHaveLength(2);
    expect(reads.every((row) => row.reason.length > 0)).toBe(true);
    expect(JSON.stringify(reads)).not.toContain('buyer@example.com');
    const ownerList = await ownerCaller.merchantOps.invoices.list({ limit: 20 });
    expect(ownerList.items.find((item) => item.id === mixed.id)?.customerEmail).toBe('b***@e***.com');
  });

  it('reissues a sent invoice link once per request and refuses a void whose link cannot be deactivated', async () => {
    const ownerCaller = as(owner);
    const created = (await ownerCaller.merchantOps.invoices.create({
      requestId: nid(),
      assetId: 'USDT',
      amount: '4',
      description: 'Reissue me',
    })) as { id: string };
    const sent = (await ownerCaller.merchantOps.invoices.send({ requestId: nid(), invoiceId: created.id })) as {
      invoice: { paymentLinkId: string | null };
      paymentLink: { token: string | null };
    };
    const oldToken = sent.paymentLink.token!;
    const checkout = payAttempt();
    expect((await checkout.resolvePaymentLink(oldToken)).id).toBe(sent.invoice.paymentLinkId);

    const requestId = nid();
    const reissued = (await ownerCaller.merchantOps.invoices.reissueLink({ requestId, invoiceId: created.id })) as {
      invoice: { status: string; paymentLinkId: string | null };
      paymentLink: { token: string | null; alreadyIssued: boolean; maxUses: number | null; id: string };
    };
    expect(reissued.invoice.status).toBe('sent');
    expect(reissued.paymentLink.token).toMatch(/^pl_/);
    expect(reissued.paymentLink.alreadyIssued).toBe(false);
    expect(reissued.paymentLink.maxUses).toBe(1);
    expect(reissued.invoice.paymentLinkId).not.toBe(sent.invoice.paymentLinkId);
    const oldActive = await sql<Array<{ active: boolean }>>`SELECT active FROM pay.payment_links WHERE id = ${sent.invoice.paymentLinkId}`;
    expect(oldActive[0]!.active).toBe(false);
    await expect(checkout.resolvePaymentLink(oldToken)).rejects.toMatchObject({ code: 'pay.link_not_found' });
    expect((await checkout.resolvePaymentLink(reissued.paymentLink.token!)).id).toBe(reissued.invoice.paymentLinkId);

    const lost = (await ownerCaller.merchantOps.invoices.reissueLink({ requestId, invoiceId: created.id })) as {
      invoice: { paymentLinkId: string | null };
      paymentLink: { token: string | null; alreadyIssued: boolean };
    };
    expect(lost.invoice.paymentLinkId).toBe(reissued.invoice.paymentLinkId);
    expect(lost.paymentLink.token).toBeNull();
    expect(lost.paymentLink.alreadyIssued).toBe(true);
    const links = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.merchant_invoices WHERE id = ${created.id}`;
    expect(links[0]!.n).toBe(1);
    const activeLinks = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.payment_links
       WHERE merchant_id = ${merchant} AND id IN (${sent.invoice.paymentLinkId}, ${reissued.invoice.paymentLinkId}) AND active = true`;
    expect(activeLinks[0]!.n).toBe(1);

    expect((await refusal(() => as(viewer).merchantOps.invoices.reissueLink({ requestId: nid(), invoiceId: created.id }))).cause).toBe(
      'pay.team_role_forbidden',
    );
    expect((await refusal(() => as(developer).merchantOps.invoices.reissueLink({ requestId: nid(), invoiceId: created.id }))).cause).toBe(
      'pay.team_role_forbidden',
    );
    const financeSent = (await as(finance).merchantOps.invoices.create({ requestId: nid(), assetId: 'USDT', amount: '1' })) as {
      id: string;
    };
    await as(finance).merchantOps.invoices.send({ requestId: nid(), invoiceId: financeSent.id });
    const financeReissue = (await as(finance).merchantOps.invoices.reissueLink({ requestId: nid(), invoiceId: financeSent.id })) as {
      paymentLink: { token: string | null };
    };
    expect(financeReissue.paymentLink.token).toMatch(/^pl_/);

    const stuck = (await ownerCaller.merchantOps.invoices.create({ requestId: nid(), assetId: 'USDT', amount: '6' })) as { id: string };
    const stuckSent = (await ownerCaller.merchantOps.invoices.send({ requestId: nid(), invoiceId: stuck.id })) as {
      invoice: { paymentLinkId: string | null; status: string };
      paymentLink: { token: string | null };
    };
    const foreignLink = await sql<Array<{ id: string }>>`
      INSERT INTO pay.payment_links (merchant_id, token_hash, token_prefix, label, amount, currency, max_uses, expires_at)
      VALUES (
        ${foreign},
        ${createHash('sha256').update(`pl_${nid()}`).digest('hex')},
        ${'pl_foreign'},
        ${'foreign'},
        ${'6'},
        ${'USDT'},
        ${1},
        ${new Date(Date.now() + 86_400_000)}
      )
      RETURNING id`;
    await sql`UPDATE pay.merchant_invoices SET payment_link_id = ${foreignLink[0]!.id} WHERE id = ${stuck.id}`;
    expect((await refusal(() => ownerCaller.merchantOps.invoices.void({ requestId: nid(), invoiceId: stuck.id }))).cause).toBe(
      'pay.invoice_link_deactivate_failed',
    );
    const still = (await ownerCaller.merchantOps.invoices.get({ invoiceId: stuck.id })) as { status: string; paymentLinkId: string | null };
    expect(still.status).toBe('sent');
    expect(still.paymentLinkId).toBe(foreignLink[0]!.id);
    const foreignActive = await sql<Array<{ active: boolean }>>`SELECT active FROM pay.payment_links WHERE id = ${foreignLink[0]!.id}`;
    expect(foreignActive[0]!.active).toBe(true);
    expect((await checkout.resolvePaymentLink(stuckSent.paymentLink.token!)).id).toBe(stuckSent.invoice.paymentLinkId);
  });

  it('records the webhook due date on the dispute the rail named', async () => {
    const railRef = `ch_${nid()}`;
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, rail_ref, status)
      VALUES (${merchant}, '10', 'USDT', 'card', 'card-sandbox', ${railRef}, 'captured'::pay.payment_status)
      RETURNING id`;
    const paymentId = rows[0]!.id;
    const rail = new CardSandboxAdapter({ secret: 'svc-pay-test-secret-at-least-32-characters', toleranceSeconds: 300 });
    const ledger = new MemoryLedger();
    await ledger.post({
      idempotencyKey: `test.clearing:${nid()}`,
      module: 'pay',
      reason: 'test.capture.seed',
      entries: [
        { account: railBoundary('card-sandbox', 'USDT'), direction: 'credit', amount: parseAmount('10') },
        { account: merchantClearing(merchant, 'USDT'), direction: 'debit', amount: parseAmount('10') },
      ],
    });
    const pay = new PayService(sql, ledger, new RailRegistry([rail]));
    const due = '2026-11-01T15:04:05.000Z';
    const disputeId = `dp-hook-${nid()}`;
    await pay.handleWebhook(
      'card-sandbox',
      rail.signWebhook({
        id: `evt-${nid()}`,
        type: 'dispute.opened',
        ref: railRef,
        amount: '10',
        assetId: 'USDT',
        disputeId,
        evidenceDueBy: due,
      }),
    );
    const detail = (await as(owner).merchantOps.disputes.get({ disputeId })) as {
      responseDueAt: string | null;
      openingLedger: { wire: string; refuseCode: string | null };
      paymentId: string;
    };
    expect(detail.paymentId).toBe(paymentId);
    expect(detail.responseDueAt).toBe(due);
    expect(detail.openingLedger.wire).toBe('posted');
    expect(detail.openingLedger.refuseCode).toBeNull();
    await pay.handleWebhook(
      'card-sandbox',
      rail.signWebhook({
        id: `evt-${nid()}`,
        type: 'dispute.opened',
        ref: railRef,
        amount: '10',
        assetId: 'USDT',
        disputeId,
        evidenceDueBy: '2027-01-01T00:00:00.000Z',
      }),
    );
    const still = (await as(owner).merchantOps.disputes.get({ disputeId })) as { responseDueAt: string | null };
    expect(still.responseDueAt).toBe(due);
  });
});
