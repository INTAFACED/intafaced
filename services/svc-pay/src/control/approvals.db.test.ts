import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { PayService } from '../payment-service.js';
import { MerchantPayoutDestinationStore } from '../merchant-payout-destination.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter, SANDBOX_FUNDS_HELD_TOKEN } from '../rails/card-sandbox.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from '../rails/bank-payout.js';
import { MemoryChain } from '../rails/chain-port.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from '../routing/decide.js';
import postgres from 'postgres';
import { composeGuards, FRESH, settleGuardRefusal } from '../seams/guards.js';
import { teamAccessPorts, type ControlAccessPorts } from './access.js';
import { ApprovalService, setBeforePayoutApprovalRequestLock, toContractApproval } from './approvals.js';
import { maskDestination } from './mask-destination.js';
import { ChangeService } from './changes.js';
import { createControlGuards } from './guards.js';
import {
  applyChange,
  DEST_A,
  DEST_B,
  FINANCE,
  FOUNDER_1,
  FOUNDER_2,
  MAKER,
  migrations,
  openAdmin,
  OWNER_A,
  OWNER_B,
  principal,
  resetControl,
  SECRET,
  TEST_GLOBAL_RULE,
  TEST_TIER,
} from './control.testkit.js';

/**
 * Maker-checker on payouts, through the real payout path.
 * TEST VALUES: approval from 50 USDT, founders from 150 USDT.
 */
describe('payout maker-checker', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let rails: RailRegistry;
  let changes!: ChangeService;
  let pay!: PayService;
  let merchantId = '';
  let otherMerchantId = '';
  let clock = new Date();

  /** A team: the owner and the finance user may approve; the maker and the finance user may see the merchant. */
  const team = (mid: () => string): ControlAccessPorts => ({
    canViewMerchant: async (p: Principal, m: string) =>
      (m === mid() && [OWNER_A, MAKER, FINANCE].includes(p.userId)) || (m === otherMerchantId && p.userId === OWNER_B),
    canApprovePayout: async (p: Principal, m: string) =>
      (m === mid() && [OWNER_A, FINANCE].includes(p.userId)) || (m === otherMerchantId && p.userId === OWNER_B),
  });
  let approvals!: ApprovalService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    changes = new ChangeService(sql);
  }, 120_000);

  beforeEach(async () => {
    await resetControl(sql);
    ledger = new MemoryLedger();
    chain = new MemoryChain();
    rails = new RailRegistry([
      new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 }),
      new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 }),
      new BankPayoutAbsentAdapter(),
    ]);
    clock = new Date();
    setBeforePayoutApprovalRequestLock(undefined);
    pay = new PayService(sql, ledger, rails, {
      payoutDestinations: new MerchantPayoutDestinationStore(sql),
      guards: composeGuards(createControlGuards({ sql, mode: 'required' })),
      checkoutRiskBand: 'low',
      routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) => ({ ...p })),
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
    });
    const a = await pay.createMerchant({ userId: OWNER_A, pricing: { feeBps: 0 } });
    const b = await pay.createMerchant({ userId: OWNER_B, pricing: { feeBps: 0 } });
    merchantId = a.id;
    otherMerchantId = b.id;
    await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier: TEST_TIER } });
    await applyChange(changes, sql, {
      scope: 'pricing',
      change: { kind: 'set_pricing_layer', layer: 'global', scopeId: null, rules: [TEST_GLOBAL_RULE] },
    });
    for (const id of [merchantId, otherMerchantId]) {
      await applyChange(changes, sql, {
        scope: 'merchant',
        merchantId: id,
        change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null },
      });
      // TEST_TIER stores a rolling reserve. payoutSettlement refuses that until a
      // ledger recipe exists, so these maker-checker cases clear it first.
      await applyChange(changes, sql, {
        scope: 'merchant',
        merchantId: id,
        change: { kind: 'set_reserve', reserve: { rollingReserveBps: null, holdDays: null } },
      });
      await sql`INSERT INTO pay.merchant_payout_destinations (merchant_id, rail_id, kind, ref, verified, verified_at) VALUES (${id}, 'crypto-native', ${DEST_A.kind}, ${DEST_A.ref}, true, now())`;
    }
    approvals = new ApprovalService(sql, { access: team(() => merchantId), now: () => clock });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  /** Captured payments of `amounts` for the merchant, settled in one window. */
  async function settled(mid: string, amounts: string[], window: string) {
    for (const amount of amounts) {
      const created = await pay.createPayment({
        requestId: randomUUID(),
        merchantId: mid,
        amount: amt(amount),
        assetId: 'USDT',
        method: 'crypto',
        railAdapter: 'crypto-native',
      });
      const address = await chain.acceptanceAddress(created.id, 'USDT');
      chain.credit({ address, assetId: 'USDT', amount: amt(amount), from: '0xbuyer', confirmations: 12 });
      await pay.authorize(created.id);
      await pay.capture(created.id);
    }
    return pay.settleWindow({
      merchantId: mid,
      window,
      assetId: 'USDT',
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
    });
  }
  const payout = (settlementId: string) => pay.payoutSettlement({ settlementId, railId: 'crypto-native' });
  const maker = () => principal(MAKER);
  const finance = () => principal(FINANCE);
  const decideInput = (a: { approvalId: string; payloadHash: string }, decision: 'approve' | 'reject' = 'approve') => ({
    approvalId: a.approvalId,
    decision,
    expectedPayloadHash: a.payloadHash,
    reason: 'checked the invoice',
  });
  const auditKinds = async (id: string) =>
    (await sql<Array<{ kind: string }>>`SELECT kind FROM pay.control_audit WHERE scope_id = ${id} ORDER BY seq`).map((r) => r.kind);

  it('below the threshold needs no approval and the request itself is refused as unnecessary', async () => {
    const s = await settled(merchantId, ['40'], 'w-small');
    await expect(approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' })).rejects.toMatchObject({
      code: 'pay.approval_not_required',
    });
    expect((await payout(s.id)).status).toBe('paid_out');
  });

  it('at or above the threshold a payout is refused until a different team member approves; then it goes through once', async () => {
    const s = await settled(merchantId, ['50'], 'w-gate');
    await expect(payout(s.id)).rejects.toMatchObject({ code: 'pay.approval_required' });
    const req = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
    expect(req.status).toBe('pending');
    expect(req.makerUserId).toBe(MAKER);
    // Asking again for the same payload returns the same request.
    expect((await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' })).approvalId).toBe(req.approvalId);
    await expect(payout(s.id)).rejects.toMatchObject({ code: 'pay.approval_required' });

    const done = await approvals.decide(finance(), decideInput(req));
    expect(done.status).toBe('approved');
    expect(done.checkerUserId).toBe(FINANCE);
    const paid = await payout(s.id);
    expect(paid.status).toBe('paid_out');
    const [row] = await sql`SELECT status, consumed_attempt FROM pay.control_payout_approvals WHERE id = ${req.approvalId}`;
    expect(row!.status).toBe('consumed');
    expect(await auditKinds(req.approvalId)).toEqual(['payout.approval_requested', 'payout.approval_decided', 'payout.approval_consumed']);
  });

  it('required: no approval admits nothing; a consumed approval admitted one payout and cannot admit another', async () => {
    const s1 = await settled(merchantId, ['70'], 'w-once-1');
    await expect(payout(s1.id)).rejects.toMatchObject({ code: 'pay.approval_required' });
    expect(await sql`SELECT 1 FROM pay.payout_admissions WHERE settlement_id = ${s1.id}`).toHaveLength(0);
    expect(
      await sql`SELECT 1 FROM pay.control_audit WHERE kind = 'payout.approval_consumed' AND after->>'settlementId' = ${s1.id}`,
    ).toHaveLength(0);

    const req = await approvals.request(maker(), { merchantId, settlementId: s1.id, railId: 'crypto-native' });
    expect((await approvals.decide(finance(), decideInput(req))).status).toBe('approved');
    expect((await payout(s1.id)).status).toBe('paid_out');
    expect(await sql`SELECT 1 FROM pay.payout_admissions WHERE settlement_id = ${s1.id}`).toHaveLength(1);
    expect(
      await sql`SELECT 1 FROM pay.control_audit WHERE kind = 'payout.approval_consumed' AND scope_id = ${req.approvalId}`,
    ).toHaveLength(1);

    // The same amount to the same destination in a new window is a new settlement: the old approval does not cover it.
    const s2 = await settled(merchantId, ['70'], 'w-once-2');
    await expect(payout(s2.id)).rejects.toMatchObject({ code: 'pay.approval_required' });
    expect(await sql`SELECT 1 FROM pay.payout_admissions WHERE settlement_id = ${s2.id}`).toHaveLength(0);
    expect((await sql`SELECT status FROM pay.control_payout_approvals WHERE id = ${req.approvalId}`)[0]!.status).toBe('consumed');
  });

  it('the maker cannot approve their own request (application and database both refuse)', async () => {
    const s = await settled(merchantId, ['60'], 'w-self');
    const owner = principal(OWNER_A);
    const req = await approvals.request(owner, { merchantId, settlementId: s.id, railId: 'crypto-native' });
    await expect(approvals.decide(owner, decideInput(req))).rejects.toMatchObject({ code: 'pay.approval_self_approval' });
    await expect(sql`UPDATE pay.control_payout_approvals SET checker_user_id = maker_user_id WHERE id = ${req.approvalId}`).rejects.toThrow(
      /maker_not_checker/,
    );
    expect((await sql`SELECT status FROM pay.control_payout_approvals WHERE id = ${req.approvalId}`)[0]!.status).toBe('pending');
  });

  it('a member of another merchant cannot approve: same answer as an id that does not exist', async () => {
    const s = await settled(merchantId, ['60'], 'w-cross');
    const req = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
    const stranger = principal(OWNER_B);
    const real = await approvals.decide(stranger, decideInput(req)).catch((e: Error) => e);
    const missing = await approvals.decide(stranger, { ...decideInput(req), approvalId: randomUUID() }).catch((e: Error) => e);
    expect(real).toMatchObject({ code: 'pay.approval_not_found' });
    expect(missing).toMatchObject({ code: 'pay.approval_not_found', message: (real as Error).message });
    // Nor can they see or request against it.
    await expect(approvals.list(stranger, { merchantId, limit: 10 })).rejects.toMatchObject({ code: 'pay.merchant_not_found' });
    await expect(approvals.request(stranger, { merchantId, settlementId: s.id, railId: 'crypto-native' })).rejects.toMatchObject({
      code: 'pay.merchant_not_found',
    });
    expect((await sql`SELECT status FROM pay.control_payout_approvals WHERE id = ${req.approvalId}`)[0]!.status).toBe('pending');
  });

  it('a viewer who may not approve is forbidden; an API key or a session without MFA cannot decide', async () => {
    const s = await settled(merchantId, ['60'], 'w-role');
    const req = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
    const otherViewer = principal(MAKER, { sub: MAKER });
    // The maker can see the merchant but is not in the approver set.
    await expect(approvals.decide({ ...otherViewer, userId: MAKER } as Principal, decideInput(req))).rejects.toMatchObject({
      code: 'pay.approval_forbidden',
    });
    await expect(approvals.decide(principal(FINANCE, { mfa: false }), decideInput(req))).rejects.toMatchObject({
      code: 'pay.approval_mfa_required',
    });
    await expect(approvals.decide(principal(FINANCE, { kid: 'ifc_key' } as never), decideInput(req))).rejects.toMatchObject({
      code: 'pay.approval_mfa_required',
    });
  });

  it('a decision must carry the exact payload hash the checker reviewed', async () => {
    const s = await settled(merchantId, ['60'], 'w-hash');
    const req = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
    await expect(
      approvals.decide(finance(), { ...decideInput(req), expectedPayloadHash: `sha256:${'0'.repeat(64)}` }),
    ).rejects.toMatchObject({
      code: 'pay.approval_payload_mismatch',
    });
  });

  it('the approval is void if the destination changes after the request: deciding returns voided, and a payout to the new one is refused', async () => {
    const s = await settled(merchantId, ['60'], 'w-void');
    const req = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
    await sql`UPDATE pay.merchant_payout_destinations SET ref = ${DEST_B.ref} WHERE merchant_id = ${merchantId}`;
    const decided = await approvals.decide(finance(), decideInput(req));
    expect(decided.status).toBe('voided');
    expect(await auditKinds(req.approvalId)).toContain('payout.approval_voided');
    await expect(payout(s.id)).rejects.toMatchObject({ code: 'pay.approval_required' });
  });

  it('naming a destination on payout is refused and does not void the approval of the stored destination', async () => {
    const s = await settled(merchantId, ['60'], 'w-void2');
    const req = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
    expect((await approvals.decide(finance(), decideInput(req))).status).toBe('approved');
    await expect(pay.payoutSettlement({ settlementId: s.id, railId: 'crypto-native', destination: DEST_B })).rejects.toMatchObject({
      code: 'pay.payout_destination_not_allowed',
    });
    expect((await sql`SELECT status FROM pay.control_payout_approvals WHERE id = ${req.approvalId}`)[0]!.status).toBe('approved');
    expect(
      (await sql`SELECT ref FROM pay.merchant_payout_destinations WHERE merchant_id = ${merchantId} AND rail_id = 'crypto-native'`)[0]!.ref,
    ).toBe(DEST_A.ref);
    expect((await sql`SELECT 1 FROM pay.payout_admissions`).length).toBe(0);
    expect((await payout(s.id)).status).toBe('paid_out');
  });

  it('rejected, cancelled and expired approvals do not let a payout through', async () => {
    const s = await settled(merchantId, ['60'], 'w-nogo');
    const r1 = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
    expect((await approvals.decide(finance(), decideInput(r1, 'reject'))).status).toBe('rejected');
    await expect(payout(s.id)).rejects.toMatchObject({ code: 'pay.approval_required' });

    const r2 = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
    expect(r2.approvalId).not.toBe(r1.approvalId);
    expect((await approvals.cancel(maker(), { approvalId: r2.approvalId, reason: 'sent by mistake' })).status).toBe('voided');
    await expect(approvals.cancel(finance(), { approvalId: r2.approvalId, reason: 'not mine' })).rejects.toMatchObject({
      code: 'pay.approval_forbidden',
    });

    const r3 = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
    expect((await approvals.decide(finance(), decideInput(r3))).status).toBe('approved');
    clock = new Date(Date.now() + (TEST_TIER.approvalTtlSeconds + 5) * 1000);
    const late = new PayService(sql, ledger, rails, {
      payoutDestinations: new MerchantPayoutDestinationStore(sql),
      guards: composeGuards(createControlGuards({ sql, mode: 'required', now: () => clock })),
      checkoutRiskBand: 'low',
      routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) => ({ ...p })),
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
    });
    await expect(late.payoutSettlement({ settlementId: s.id, railId: 'crypto-native' })).rejects.toMatchObject({
      code: 'pay.approval_required',
    });
    expect((await approvals.list(maker(), { merchantId, limit: 10, status: 'expired' })).items.map((a) => a.approvalId)).toContain(
      r3.approvalId,
    );
  });

  it('above the founder threshold the merchant checker is not enough: two distinct founders must also sign', async () => {
    const s = await settled(merchantId, ['80', '80'], 'w-founder');
    await expect(payout(s.id)).rejects.toMatchObject({ code: 'pay.approval_required' });
    const req = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
    const afterChecker = await approvals.decide(finance(), decideInput(req));
    expect(afterChecker.status).toBe('pending');
    expect(afterChecker.checkerUserId).toBe(FINANCE);
    await expect(payout(s.id)).rejects.toMatchObject({ code: 'pay.approval_required' });

    // The founder queue shows it; founders cannot be the maker or the checker.
    expect((await approvals.founderQueue({ limit: 10 })).approvals.map((a) => a.approvalId)).toEqual([req.approvalId]);
    await expect(approvals.founderDecide(MAKER, decideInput(req))).rejects.toMatchObject({ code: 'pay.approval_self_approval' });
    await expect(approvals.founderDecide(FINANCE, decideInput(req))).rejects.toMatchObject({ code: 'pay.approval_self_approval' });

    const first = await approvals.founderDecide(FOUNDER_1, decideInput(req));
    expect(first.status).toBe('pending');
    expect(first.founderApprovals).toBe(1);
    await expect(payout(s.id)).rejects.toMatchObject({ code: 'pay.approval_required' });
    // The same founder twice is not two founders.
    await expect(approvals.founderDecide(FOUNDER_1, decideInput(req))).rejects.toMatchObject({ code: 'pay.dual_control_required' });

    const second = await approvals.founderDecide(FOUNDER_2, decideInput(req));
    expect(second.status).toBe('approved');
    expect((await payout(s.id)).status).toBe('paid_out');
    expect(await auditKinds(req.approvalId)).toEqual([
      'payout.approval_requested',
      'payout.approval_decided',
      'payout.founder_decided',
      'payout.founder_decided',
      'payout.approval_consumed',
    ]);
  });

  it('lists a masked destination and rail, never the full destination, and names the first founder only on the founder queue', async () => {
    const iban = 'DE89370400440532013000';
    // A verified destination: an unverified one is refused before any request (J-merchant-02 #5, tested below).
    await sql`INSERT INTO pay.merchant_payout_destinations (merchant_id, rail_id, kind, ref, verified, verified_at) VALUES (${merchantId}, 'card-sandbox', 'bank', ${iban}, true, now())`;
    const bankSettlement = await settled(merchantId, ['60'], 'w-mask-bank');
    const bank = toContractApproval(
      await approvals.request(maker(), { merchantId, settlementId: bankSettlement.id, railId: 'card-sandbox' }),
    );
    expect(bank).toMatchObject({ railId: 'card-sandbox', destinationKind: 'bank', destinationMasked: '••••3000' });
    expect(JSON.stringify(bank)).not.toContain(iban);
    expect(bank).not.toHaveProperty('founderFirstUserId');

    const cryptoSettlement = await settled(merchantId, ['80', '80'], 'w-mask-founder');
    const req = await approvals.request(maker(), { merchantId, settlementId: cryptoSettlement.id, railId: 'crypto-native' });
    await approvals.decide(finance(), decideInput(req));
    const queued = (await approvals.founderQueue({ limit: 50 })).approvals.find((a) => a.approvalId === req.approvalId);
    expect(queued).toMatchObject({
      railId: 'crypto-native',
      destinationKind: 'crypto',
      destinationMasked: maskDestination('crypto', DEST_A.ref),
      founderFirstUserId: null,
    });
    expect(JSON.stringify(queued)).not.toContain(DEST_A.ref);

    const first = toContractApproval(await approvals.founderDecide(FOUNDER_1, decideInput(req)));
    expect(first).not.toHaveProperty('founderFirstUserId');
    expect(JSON.stringify(first)).not.toContain(DEST_A.ref);
    const after = (await approvals.founderQueue({ limit: 50 })).approvals.find((a) => a.approvalId === req.approvalId);
    expect(after?.founderFirstUserId).toBe(FOUNDER_1);

    const listed = (await approvals.list(maker(), { merchantId, limit: 50 })).items.find((a) => a.approvalId === req.approvalId)!;
    const merchantWire = toContractApproval(listed);
    expect(merchantWire).not.toHaveProperty('founderFirstUserId');
    expect(JSON.stringify(merchantWire)).not.toContain(DEST_A.ref);
    expect(merchantWire.destinationMasked).toBe(maskDestination('crypto', DEST_A.ref));
    expect(merchantWire).not.toHaveProperty('destinationRef');
  });

  it('a founder can read the full destination of one queue approval, and each read is audited', async () => {
    const cryptoSettlement = await settled(merchantId, ['80', '80'], 'w-reveal');
    const req = await approvals.request(maker(), { merchantId, settlementId: cryptoSettlement.id, railId: 'crypto-native' });
    await expect(approvals.founderDestination(FOUNDER_1, req.approvalId)).rejects.toMatchObject({ code: 'pay.approval_not_found' });
    await approvals.decide(finance(), decideInput(req));

    const revealed = await approvals.founderDestination(FOUNDER_1, req.approvalId);
    expect(revealed).toEqual({
      approvalId: req.approvalId,
      railId: 'crypto-native',
      destinationKind: 'crypto',
      destinationRef: DEST_A.ref,
    });
    const again = await approvals.founderDestination(FOUNDER_2, req.approvalId);
    expect(again.destinationRef).toBe(DEST_A.ref);
    const reads = await sql<Array<{ actor_id: string; outcome: string; after: { payloadHash?: string } | null }>>`
      SELECT actor_id, outcome, after FROM pay.control_audit
       WHERE scope_id = ${req.approvalId} AND kind = 'payout.destination_read' ORDER BY seq
    `;
    expect(reads.map((row) => row.actor_id)).toEqual([FOUNDER_1, FOUNDER_2]);
    expect(reads.every((row) => row.outcome === 'read' && row.after?.payloadHash === req.payloadHash)).toBe(true);
    expect(JSON.stringify(reads)).not.toContain(DEST_A.ref);

    const queued = (await approvals.founderQueue({ limit: 50 })).approvals.find((a) => a.approvalId === req.approvalId);
    expect(JSON.stringify(queued)).not.toContain(DEST_A.ref);
    expect(queued).not.toHaveProperty('destinationRef');

    const below = await settled(merchantId, ['60'], 'w-reveal-below');
    const merchantOnly = await approvals.request(maker(), { merchantId, settlementId: below.id, railId: 'crypto-native' });
    await approvals.decide(finance(), decideInput(merchantOnly));
    const missing = randomUUID();
    const offQueue = await approvals.founderDestination(FOUNDER_1, merchantOnly.approvalId).catch((e: Error) => e);
    const absent = await approvals.founderDestination(FOUNDER_1, missing).catch((e: Error) => e);
    expect(offQueue).toMatchObject({ code: 'pay.approval_not_found' });
    expect(absent).toMatchObject({ code: 'pay.approval_not_found', message: (offQueue as Error).message });
    expect(
      (
        await sql`SELECT 1 FROM pay.control_audit WHERE kind = 'payout.destination_read' AND scope_id IN (${merchantOnly.approvalId}, ${missing})`
      ).length,
    ).toBe(0);
  });

  it('an expired founder-queue approval is not revealed and writes no destination audit', async () => {
    const cryptoSettlement = await settled(merchantId, ['80', '80'], 'w-reveal-expired');
    const req = await approvals.request(maker(), { merchantId, settlementId: cryptoSettlement.id, railId: 'crypto-native' });
    await approvals.decide(finance(), decideInput(req));
    await sql`UPDATE pay.control_payout_approvals SET expires_at = now() - interval '1 second' WHERE id = ${req.approvalId}`;

    await expect(approvals.founderDestination(FOUNDER_1, req.approvalId)).rejects.toMatchObject({ code: 'pay.approval_not_found' });
    expect(
      (await sql`SELECT 1 FROM pay.control_audit WHERE kind = 'payout.destination_read' AND scope_id = ${req.approvalId}`).length,
    ).toBe(0);

    await sql`UPDATE pay.control_payout_approvals SET expires_at = now() + interval '1 hour' WHERE id = ${req.approvalId}`;
    const revealed = await approvals.founderDestination(FOUNDER_1, req.approvalId);
    expect(revealed.destinationRef).toBe(DEST_A.ref);
    expect(
      (await sql`SELECT 1 FROM pay.control_audit WHERE kind = 'payout.destination_read' AND scope_id = ${req.approvalId}`).length,
    ).toBe(1);
  });

  it('the database refuses an approved founder-required row without two founders', async () => {
    const s = await settled(merchantId, ['80', '80'], 'w-db');
    const req = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
    await approvals.decide(finance(), decideInput(req));
    await expect(sql`UPDATE pay.control_payout_approvals SET status = 'approved' WHERE id = ${req.approvalId}`).rejects.toThrow(
      /approved_complete/,
    );
    await expect(
      sql`UPDATE pay.control_payout_approvals SET founder_first_user_id = ${FOUNDER_1}, founder_second_user_id = ${FOUNDER_1} WHERE id = ${req.approvalId}`,
    ).rejects.toThrow(/founders_distinct/);
  });

  describe('asking again after a same-payload request expires', () => {
    const ask = (settlementId: string) => approvals.request(maker(), { merchantId, settlementId, railId: 'crypto-native' });
    const advancePastTtl = () => {
      clock = new Date(clock.getTime() + (TEST_TIER.approvalTtlSeconds + 5) * 1000);
    };
    const rowsFor = (settlementId: string) =>
      sql<Array<{ id: string; status: string }>>`
        SELECT id, status FROM pay.control_payout_approvals WHERE settlement_id = ${settlementId} ORDER BY seq
      `;

    it('an expired pending request is settled and a fresh pending row is stored', async () => {
      const s = await settled(merchantId, ['60'], 'w-reask');
      const first = await ask(s.id);
      advancePastTtl();
      const again = await ask(s.id);
      expect(again.approvalId).not.toBe(first.approvalId);
      expect(again.status).toBe('pending');
      expect((await ask(s.id)).approvalId).toBe(again.approvalId);
      expect(await rowsFor(s.id)).toEqual([
        { id: first.approvalId, status: 'expired' },
        { id: again.approvalId, status: 'pending' },
      ]);
      const listed = (await approvals.list(maker(), { merchantId, limit: 20, status: 'expired' })).items.find(
        (item) => item.approvalId === first.approvalId,
      );
      expect(listed?.status).toBe('expired');
      expect(await auditKinds(first.approvalId)).toContain('payout.approval_expired');
      expect((await approvals.decide(finance(), decideInput(again))).status).toBe('approved');
      expect((await payout(s.id)).status).toBe('paid_out');
    });

    it('a live pending request returns the same row', async () => {
      const s = await settled(merchantId, ['60'], 'w-reask-live');
      const first = await ask(s.id);
      const again = await ask(s.id);
      expect(again.approvalId).toBe(first.approvalId);
      expect(again.status).toBe('pending');
      expect(await rowsFor(s.id)).toEqual([{ id: first.approvalId, status: 'pending' }]);
    });

    it('an approved request that has not expired returns the same row', async () => {
      const s = await settled(merchantId, ['60'], 'w-reask-approved');
      const first = await ask(s.id);
      expect((await approvals.decide(finance(), decideInput(first))).status).toBe('approved');
      const again = await ask(s.id);
      expect(again.approvalId).toBe(first.approvalId);
      expect(again.status).toBe('approved');
      expect(await rowsFor(s.id)).toEqual([{ id: first.approvalId, status: 'approved' }]);
    });

    it('an approved request that has expired is settled and a fresh pending row is stored', async () => {
      const s = await settled(merchantId, ['60'], 'w-reask-approved-expired');
      const first = await ask(s.id);
      expect((await approvals.decide(finance(), decideInput(first))).status).toBe('approved');
      advancePastTtl();
      const again = await ask(s.id);
      expect(again.approvalId).not.toBe(first.approvalId);
      expect(again.status).toBe('pending');
      expect(await rowsFor(s.id)).toEqual([
        { id: first.approvalId, status: 'expired' },
        { id: again.approvalId, status: 'pending' },
      ]);
    });

    it('two asks after expiry store one new pending row', async () => {
      const s = await settled(merchantId, ['60'], 'w-reask-race');
      const first = await ask(s.id);
      advancePastTtl();
      let arrived = 0;
      let open!: () => void;
      const bothArrived = new Promise<void>((resolve) => {
        open = resolve;
      });
      setBeforePayoutApprovalRequestLock(async () => {
        arrived += 1;
        if (arrived === 2) open();
        await bothArrived;
      });
      try {
        const [a, b] = await Promise.all([ask(s.id), ask(s.id)]);
        expect(arrived).toBe(2);
        expect(a.status).toBe('pending');
        expect(b.status).toBe('pending');
        expect(a.approvalId).toBe(b.approvalId);
        expect(a.approvalId).not.toBe(first.approvalId);
        expect(await rowsFor(s.id)).toEqual([
          { id: first.approvalId, status: 'expired' },
          { id: a.approvalId, status: 'pending' },
        ]);
      } finally {
        setBeforePayoutApprovalRequestLock(undefined);
      }
    }, 30_000);
  });

  it('without a configured threshold or destination the request is refused, not defaulted', async () => {
    const s = await settled(merchantId, ['60'], 'w-cfg');
    await sql`DELETE FROM pay.merchant_payout_destinations WHERE merchant_id = ${merchantId}`;
    await expect(approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' })).rejects.toMatchObject({
      code: 'pay.payout_destination_missing',
    });
    await expect(approvals.request(maker(), { merchantId, settlementId: randomUUID(), railId: 'crypto-native' })).rejects.toMatchObject({
      code: 'pay.settlement_not_payable',
    });
  });
  it('J-merchant-02 #5: a request to an unverified or held destination is refused with its code and records no approval', async () => {
    const s = await settled(merchantId, ['60'], 'w-dest-state');
    await sql`UPDATE pay.merchant_payout_destinations SET verified = false, verified_at = NULL WHERE merchant_id = ${merchantId}`;
    await expect(approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' })).rejects.toMatchObject({
      code: 'pay.payout_destination_unverified',
    });
    await sql`
      UPDATE pay.merchant_payout_destinations
         SET verified = true, verified_at = now(), activates_at = now() + interval '1 hour'
       WHERE merchant_id = ${merchantId}
    `;
    await expect(approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' })).rejects.toMatchObject({
      code: 'pay.payout_destination_held',
    });
    expect(await sql`SELECT id FROM pay.control_payout_approvals WHERE settlement_id = ${s.id}`).toHaveLength(0);
    // Past its end it is active and the request goes through.
    await sql`UPDATE pay.merchant_payout_destinations SET activates_at = now() - interval '1 second' WHERE merchant_id = ${merchantId}`;
    expect((await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' })).status).toBe('pending');
  });
  it('a payout request for a window the rail still holds is refused pay.payout_clearing_pending, and records no approval', async () => {
    const created = await pay.createPayment({
      requestId: randomUUID(),
      merchantId,
      amount: amt('60'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: SANDBOX_FUNDS_HELD_TOKEN },
    });
    await pay.authorize(created.id);
    await pay.capture(created.id);
    const s = await pay.settleWindow({
      merchantId,
      window: 'w-held',
      assetId: 'USDT',
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
    });
    expect(s.status).toBe('pending');
    await expect(approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' })).rejects.toMatchObject({
      code: 'pay.payout_clearing_pending',
      message: expect.stringContaining('60 USDT'),
    });
    expect(await sql`SELECT id FROM pay.control_payout_approvals WHERE settlement_id = ${s.id}`).toHaveLength(0);
  });
  describe('the finance role approves (W15 payout.approve), through the real team table', () => {
    const ADMIN = '55555555-5555-4555-8555-555555555555';
    const DEV = '66666666-6666-4666-8666-666666666666';
    const team2 = () => new ApprovalService(sql, { access: teamAccessPorts(sql), now: () => clock });
    const join = (mid: string, userId: string, role: string, status = 'active') =>
      sql`INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
          VALUES (${mid}, ${userId}, ${role}, ${status}, ${OWNER_A}, ${status === 'active' ? new Date() : null})`;

    it('an owner who asks cannot also approve, so a finance team member is the one who can; an owner-only wiring could never approve', async () => {
      const s = await settled(merchantId, ['60'], 'w-team');
      const svc = team2();
      const req = await svc.request(principal(OWNER_A), { merchantId, settlementId: s.id, railId: 'crypto-native' });
      await expect(svc.decide(principal(OWNER_A), decideInput(req))).rejects.toMatchObject({ code: 'pay.approval_self_approval' });
      // Before the finance member joins nobody else can approve.
      await expect(svc.decide(principal(FINANCE), decideInput(req))).rejects.toMatchObject({ code: 'pay.approval_not_found' });
      await join(merchantId, FINANCE, 'finance');
      const done = await svc.decide(principal(FINANCE), decideInput(req));
      expect(done.status).toBe('approved');
      expect(done.checkerUserId).toBe(FINANCE);
      expect((await payout(s.id)).status).toBe('paid_out');
    });

    it("admin may approve; developer, viewer, an invited or removed finance member, and another merchant's finance member may not", async () => {
      const s = await settled(merchantId, ['60'], 'w-roles');
      const svc = team2();
      const req = await svc.request(principal(OWNER_A), { merchantId, settlementId: s.id, railId: 'crypto-native' });
      await join(merchantId, DEV, 'developer');
      await join(merchantId, MAKER, 'viewer');
      await join(merchantId, ADMIN, 'admin');
      // Cannot even see the merchant's control room: same answer as an id that does not exist.
      await expect(svc.decide(principal(DEV), decideInput(req))).rejects.toMatchObject({ code: 'pay.approval_not_found' });
      await expect(svc.decide(principal(MAKER), decideInput(req))).rejects.toMatchObject({ code: 'pay.approval_not_found' });
      await expect(svc.list(principal(DEV), { merchantId, limit: 5 })).rejects.toMatchObject({ code: 'pay.merchant_not_found' });
      // A finance member of ANOTHER merchant.
      await join(otherMerchantId, FINANCE, 'finance');
      await expect(svc.decide(principal(FINANCE), decideInput(req))).rejects.toMatchObject({ code: 'pay.approval_not_found' });
      // Removed or only invited finance members hold nothing.
      await sql`UPDATE pay.merchant_team_members SET status = 'removed', removed_at = now() WHERE user_id = ${FINANCE}`;
      await expect(svc.decide(principal(FINANCE), decideInput(req))).rejects.toMatchObject({ code: 'pay.approval_not_found' });
      const INVITED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      await join(merchantId, INVITED, 'finance', 'invited');
      await expect(svc.decide(principal(INVITED), decideInput(req))).rejects.toMatchObject({ code: 'pay.approval_not_found' });
      expect((await svc.decide(principal(ADMIN), decideInput(req))).status).toBe('approved');
    });

    it('a finance member may ask too (payout.request), so the maker and checker can both be team members', async () => {
      const s = await settled(merchantId, ['60'], 'w-finreq');
      const svc = team2();
      await join(merchantId, FINANCE, 'finance');
      await join(merchantId, ADMIN, 'admin');
      const req = await svc.request(principal(FINANCE), { merchantId, settlementId: s.id, railId: 'crypto-native' });
      await expect(svc.decide(principal(FINANCE), decideInput(req))).rejects.toMatchObject({ code: 'pay.approval_self_approval' });
      expect((await svc.decide(principal(ADMIN), decideInput(req))).status).toBe('approved');
    });
  });

  describe('a payout retry needs its own approval, and the stale-approval void runs after the transaction', () => {
    const guards = () => composeGuards(createControlGuards({ sql, mode: 'required' }));
    const admitCtx = (tx: unknown, settlementId: string, attempt: number, destination = DEST_A) => ({
      tx: tx as never,
      settlementId,
      merchantId,
      assetId: 'USDT',
      amount: amt('60'),
      railId: 'crypto-native',
      destination,
      attempt,
      replay: FRESH,
    });
    const usedPayout = async () =>
      (
        await sql<
          Array<{ used: string }>
        >`SELECT used FROM pay.control_cap_usage WHERE merchant_id = ${merchantId} AND cap_kind = 'daily_payout'`
      )[0]?.used;

    it('attempt 0 consumes the approval and counts 60 once; attempt 1 is refused until a new approval exists, and still counts nothing more', async () => {
      const s = await settled(merchantId, ['60'], 'w-retry');
      const req = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
      await approvals.decide(finance(), decideInput(req));
      const g = guards();
      await sql.begin((tx) => g.beforePayoutAdmit(admitCtx(tx, s.id, 0)));
      expect(Number(await usedPayout())).toBe(60);
      await expect(sql.begin((tx) => g.beforePayoutAdmit(admitCtx(tx, s.id, 1)))).rejects.toMatchObject({ code: 'pay.approval_required' });
      expect(Number(await usedPayout())).toBe(60);
      const again = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
      await approvals.decide(finance(), decideInput(again));
      await sql.begin((tx) => g.beforePayoutAdmit(admitCtx(tx, s.id, 1)));
      expect(Number(await usedPayout())).toBe(60);
    });

    it('the void is a follow-up of the refusal: it does not run inside the transaction, and runs on a pool of ONE connection once the transaction is over', async () => {
      const s = await settled(merchantId, ['60'], 'w-void-late');
      const req = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
      await approvals.decide(finance(), decideInput(req));
      // A pool with a single connection. The admission transaction holds it, so any code that asked the pool for
      // another connection while the transaction was open would wait forever (this test would hit its timeout).
      const single = postgres(db.url, { max: 1, onnotice: () => undefined });
      try {
        const g = composeGuards(createControlGuards({ sql: single, mode: 'required' }));
        const refusal = await single
          .begin((tx) => g.beforePayoutAdmit(admitCtx(tx, s.id, 0, DEST_B)))
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(refusal).toMatchObject({ code: 'pay.approval_required' });
        // Nothing was voided inside the transaction, and nothing waited on a connection.
        expect((await sql`SELECT status FROM pay.control_payout_approvals WHERE id = ${req.approvalId}`)[0]!.status).toBe('approved');
        // Transaction over, locks released: the caller runs the follow-up and the stale approval is voided.
        await settleGuardRefusal(refusal);
        expect((await sql`SELECT status FROM pay.control_payout_approvals WHERE id = ${req.approvalId}`)[0]!.status).toBe('voided');
        expect(await auditKinds(req.approvalId)).toContain('payout.approval_voided');
        // Running it again changes nothing and never throws.
        await settleGuardRefusal(refusal);
      } finally {
        await single.end({ timeout: 5 });
      }
    }, 20_000);

    it('a follow-up that fails changes nothing about the refusal', async () => {
      const dead = postgres(db.url, { max: 1, onnotice: () => undefined });
      const s = await settled(merchantId, ['60'], 'w-void-dead');
      const req = await approvals.request(maker(), { merchantId, settlementId: s.id, railId: 'crypto-native' });
      await approvals.decide(finance(), decideInput(req));
      const g = composeGuards(createControlGuards({ sql: dead, mode: 'required' }));
      const refusal = await sql
        .begin((tx) => g.beforePayoutAdmit(admitCtx(tx, s.id, 0, DEST_B)))
        .then(
          () => null,
          (e: unknown) => e,
        );
      await dead.end({ timeout: 5 });
      expect(refusal).toMatchObject({ code: 'pay.approval_required' });
      await expect(settleGuardRefusal(refusal)).resolves.toBeUndefined();
    });
  });
});
