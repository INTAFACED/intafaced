/**
 * THE TABLES. Adding a procedure to an isolation suite is one entry here.
 *
 *   FOUNDER_INPUTS   founder-only procedures (G suites), each a function of the world
 *                    (so an input can name a seeded merchant). A founder-only procedure
 *                    with no entry still gets every G test, called with `{}`:
 *                    authority runs before input parsing, so `{}` is enough to
 *                    prove refusal. Add an entry only to prove the founder PASSES.
 *   FOUNDER_EXTRA    operator surfaces that are NOT under `founderAdmin.` / `payHalts.`
 *                    but are founder-only in effect. They guard themselves, so the
 *                    G7 static inventory cannot see them; the G1-G5 tables do.
 *   COMPLIANCE_PROCS operator procedures on `admin:compliance` (not founder-only,
 *                    not a merchant pay:write door). Same class as
 *                    `merchant.decideKyb`, `kyb.decide`, and `kyb.decisionBinding`.
 *   MERCHANT_PROCS   every merchant-scoped tRPC procedure that takes an id (M1).
 *   LIST_PROCS       every list endpoint (M2).
 *   REST_ROUTES      the same for the public REST door (M1/M2).
 *   TREE_PROCS       procedures probed across the PayFac tree (M3).
 */
import { randomUUID } from 'node:crypto';
import { ISOLATION_TIER } from './control-seed.js';
import {
  EVM_DESTINATION,
  MERCHANT_KEY_SCOPES,
  REGISTRY_NETWORK_ID,
  REGISTRY_VENUE_ID,
  type Entity,
  type RestCall,
  type World,
} from './fixture.js';

const hash = `sha256:${'a'.repeat(64)}`;
const window = { kind: 'preset', preset: 'today' } as const;
/** An explicit range must sit on UTC midnights. */
const series = { from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', bucket: 'day' } as const;
/** Statement reads refuse without a window. Seven days sits inside the 92-day technical cap. */
function statementWindow(): { from: string; to: string } {
  const to = Date.now() + 24 * 60 * 60 * 1000;
  return { from: new Date(to - 7 * 24 * 60 * 60 * 1000).toISOString(), to: new Date(to).toISOString() };
}
export const ghost = (): string => randomUUID();

// ── G: founder-only ─────────────────────────────────────────────────────────

/**
 * Compliance procedures. Not founder-guarded and not in MERCHANT_PROCS: a pay:write
 * session is refused by scope, the same way `merchant.decideKyb` and `kyb.decide` are.
 * `kyb.decisionBinding` is the read a compliance proposer uses to file that approval.
 */
export const COMPLIANCE_PROCS = [
  'merchant.decideKyb',
  'kyb.decide',
  'kyb.decisionBinding',
  'merchant.businessProfile.review',
  'kyb.documents.reviewView',
  'kyb.documents.review',
  'kyb.documents.file',
  'kyb.requests.reviewList',
  'kyb.requests.create',
  'kyb.requests.close',
  'kyb.requests.file',
] as const;

export const FOUNDER_EXTRA = [
  'accountControls.change',
  'accountControls.getState',
  'accountControls.history',
  'merchantState.set',
  'merchantState.history',
] as const;

/** Prefixes whose procedures must be founder-guarded (mirror of FOUNDER_ONLY_PREFIXES, restated so a change there is noticed). */
export const FOUNDER_PREFIXES = [
  'founderAdmin.',
  'payHalts.set',
  'payHalts.history',
  'payHalts.operatorStatus',
  'payHalts.pendingClears',
  'b2bRamp.founderStatus',
] as const;

/**
 * Live-founder verdicts that are past the guard. While pay.b2b_ramp is off,
 * founderStatus refuses with this cause; that is not an authority refusal.
 */
export const FOUNDER_FLAG_OFF: Readonly<Record<string, string>> = {
  'b2bRamp.founderStatus': 'pay.b2b_ramp_off',
};

/** A merchant id nobody owns: the control-write targets it, so even a broken guard mutates nothing real. */
const NOBODY = ghost();
const control = (over: Record<string, unknown> = {}) => ({
  requestId: randomUUID(),
  target: { area: 'merchant', merchantId: NOBODY },
  action: 'restrict',
  reason: 'isolation drill',
  expectedVersion: '0',
  ...over,
});

/**
 * Registry saves create real rows. Venue ids are a closed list (a venue adapter must exist), and a wallet
 * route needs a network the fixture seeded, so these two are fixed; a network id is free, so it is fresh.
 */
const fresh = (): string => `iso-${randomUUID().slice(0, 8)}`;
const registryReason = 'isolation drill';
const venueChange = () => ({
  venueId: REGISTRY_VENUE_ID,
  displayName: 'Isolation drill venue',
  mode: 'disabled',
  priority: 1,
  enabled: false,
  minOrder: null,
  maxOrder: null,
  supportedPairs: [],
  expectedVersion: null,
  reason: registryReason,
});

const networkChange = () => ({
  networkId: fresh(),
  displayName: 'Isolation drill network',
  assetCodes: ['USDT'],
  confirmationsRequired: null,
  enabled: false,
  feeEstimateSource: null,
  feeEstimateAmount: null,
  expectedVersion: null,
  reason: registryReason,
});

export const FOUNDER_INPUTS: Record<string, (w: World) => unknown> = {
  // A real halt write, but on the one scope nothing in this world runs (conversion), and the fixture wires no
  // guards. Repeats answer `conflict` (version moved), which is still a founder PASS.
  'payHalts.set': () => ({
    requestId: randomUUID(),
    scope: 'conversion',
    target: { level: 'global' },
    halted: true,
    reason: 'isolation drill',
    expectedVersion: '0',
  }),
  'payHalts.history': () => ({ limit: 10 }),
  'payHalts.pendingClears': () => ({ limit: 10 }),
  // Takes no input (`{}` is what the sweep sends by default); listed so the entry is explicit.
  'payHalts.operatorStatus': () => undefined,
  'founderAdmin.merchants.list': () => ({ limit: 10 }),
  'founderAdmin.merchants.drilldown': (w) => ({ merchantId: w.e.A.merchantId, window }),
  'founderAdmin.merchants.section': (w) => ({ merchantId: w.e.A.merchantId, section: 'profile', limit: 10 }),
  'founderAdmin.merchants.recent': () => ({ limit: 10 }),
  'founderAdmin.payouts.list': () => ({ limit: 10 }),
  'founderAdmin.disputes.list': () => ({ limit: 10 }),
  'founderAdmin.live.summary': () => ({}),
  'founderAdmin.risk.summary': () => ({ topN: 5 }),
  'founderAdmin.metrics.global': () => ({ window }),
  // A real merchant: founder authority replaces ownership, so the founder gets A's figures.
  'founderAdmin.metrics.merchant': (w) => ({ merchantId: w.e.A.merchantId, window }),
  'founderAdmin.metrics.merchantSeries': (w) => ({ merchantId: w.e.A.merchantId, ...series }),
  'founderAdmin.registries.venues.list': () => ({}),
  'founderAdmin.registries.venues.save': () => venueChange(),
  'founderAdmin.registries.networks.list': () => ({}),
  'founderAdmin.registries.networks.save': () => networkChange(),
  'founderAdmin.registries.walletRoutes.list': () => ({}),
  'founderAdmin.registries.walletRoutes.save': () => ({
    assetCode: 'USDT',
    networkId: REGISTRY_NETWORK_ID,
    payoutAllowed: false,
    merchantAllow: [],
    merchantDeny: [],
    maxSinglePayout: null,
    expectedVersion: null,
    reason: registryReason,
  }),
  'founderAdmin.registries.preview': () => ({ registry: 'network', change: networkChange() }),
  'founderAdmin.registries.history': () => ({ registry: 'venue', limit: 10 }),
  // W1 control room. The two `confirm` procedures and `control.approvals.decide` are one-shot: each aims at a request
  // another founder opened (or an approval whose merchant-side checker is done) in control-seed.ts, so the positive
  // control signs a real row. A repeat would answer a business refusal, which is why the sweep runs it once.
  'founderAdmin.changes.submit': (w) => ({
    requestId: randomUUID(),
    merchantId: w.control.changeMerchantId,
    change: { kind: 'set_tier', tierId: ISOLATION_TIER.id, archetypeId: 'psp' },
    reason: 'isolation drill',
    expectedVersion: w.control.changeMerchantVersion,
  }),
  'founderAdmin.changes.confirm': (w) => ({
    requestId: w.control.pendingMerchantChangeId,
    decision: 'confirm',
    reason: 'second founder agrees',
    expectedChangeHash: w.control.pendingMerchantChangeHash,
  }),
  'founderAdmin.approvals.list': () => ({ limit: 10 }),
  'founderAdmin.approvals.destination': (w) => ({ approvalId: w.control.founderApprovalId }),
  'founderAdmin.changes.pending': () => ({ limit: 10 }),
  'founderAdmin.control.audit.list': () => ({ limit: 10 }),
  'founderAdmin.control.tiers.list': () => ({}),
  'founderAdmin.control.pricing.rules': () => ({ layer: 'global' }),
  'founderAdmin.control.merchant.get': (w) => ({ merchantId: w.e.A.merchantId }),
  'founderAdmin.control.merchant.usage': (w) => ({ merchantId: w.e.A.merchantId }),
  'founderAdmin.control.configure.submit': () => ({
    requestId: randomUUID(),
    change: { kind: 'upsert_tier', tier: { ...ISOLATION_TIER, id: `iso-${randomUUID().slice(0, 8)}`, name: 'TEST VALUE drill tier' } },
    reason: 'isolation drill',
    expectedVersion: '0',
  }),
  'founderAdmin.control.configure.confirm': (w) => ({
    requestId: w.control.pendingConfigureId,
    decision: 'confirm',
    reason: 'second founder agrees',
    expectedChangeHash: w.control.pendingConfigureHash,
  }),
  'founderAdmin.control.approvals.decide': (w) => ({
    approvalId: w.control.founderApprovalId,
    decision: 'approve',
    expectedPayloadHash: w.control.founderApprovalHash,
    reason: 'isolation drill',
  }),
  'founderAdmin.control.limitRequests.list': () => ({ limit: 10 }),
  'founderAdmin.control.limitRequests.close': (w) => ({
    requestId: w.control.pendingLimitRequestId,
    reason: 'isolation drill close',
  }),
  'founderAdmin.treasury.exposure': () => ({}),
  'founderAdmin.conversion.resolve.propose': () => ({
    requestId: randomUUID(),
    conversionId: ghost(),
    reason: 'isolation drill',
  }),
  'founderAdmin.conversion.resolve.confirm': () => ({
    requestId: randomUUID(),
    decision: 'reject' as const,
    reason: 'isolation drill',
    expectedChangeHash: hash,
  }),
  'founderAdmin.conversion.holds.sweep': () => ({}),
  'founderAdmin.conversion.lateFill.propose': () => ({
    requestId: randomUUID(),
    auditId: ghost(),
    settlement: 'reviewed outside the book',
    reason: 'isolation drill',
  }),
  'founderAdmin.conversion.lateFill.confirm': () => ({
    requestId: randomUUID(),
    decision: 'reject' as const,
    reason: 'isolation drill',
    expectedChangeHash: hash,
  }),
  'founderAdmin.conversion.lateFill.sweep': () => ({}),
  'founderAdmin.conversion.lateFill.book.propose': () => ({
    requestId: randomUUID(),
    auditId: ghost(),
    reason: 'isolation drill',
  }),
  'founderAdmin.conversion.lateFill.book.confirm': () => ({
    requestId: randomUUID(),
    decision: 'reject' as const,
    reason: 'isolation drill',
    expectedChangeHash: hash,
  }),
  // W15 operator notes: A is a real merchant, and the seeded note is live exactly until the positive control retracts it.
  'founderAdmin.ops.notes.add': (w) => ({ merchantId: w.e.A.merchantId, body: 'isolation drill', tags: ['drill'], flagged: false }),
  'founderAdmin.ops.notes.list': (w) => ({ merchantId: w.e.A.merchantId, limit: 10 }),
  'founderAdmin.ops.notes.retract': (w) => ({ noteId: w.operatorNoteId, reason: 'isolation drill' }),
  'founderAdmin.ops.receiptTemplate.save': () => ({
    requestId: '00000000-0000-4000-8000-00000000007a',
    logoRef: 'ops-logo',
    accent: '#112233',
    footer: 'Ops footer',
    language: 'en',
  }),
  'accountControls.change': () => control(),
  'merchantState.set': () => control(),
  'accountControls.getState': () => ({ target: { area: 'merchant', merchantId: NOBODY } }),
  'accountControls.history': () => ({ target: { area: 'merchant', merchantId: NOBODY }, limit: 5 }),
  'merchantState.history': () => ({ target: { area: 'merchant', merchantId: NOBODY }, limit: 5 }),
};

// ── M: merchant-scoped ──────────────────────────────────────────────────────

/** The ids a probe puts on the wire. `merchantId` is what the caller names; the rest are resource ids. */
export interface ProbeIds {
  merchantId: string;
  paymentId: string;
  settlementId: string;
  linkId: string;
  endpointId: string;
  spareEndpointId: string;
  deliveryId: string;
  /** W15 merchant operations ids. */
  disputeId: string;
  customerRef: string;
  exportJobId: string;
  notificationId: string;
  memberId: string;
  inviteId: string;
  /** W1: a pending payout approval (the owner of that merchant is its maker). */
  approvalId: string;
  /** `refund.posted` event id for payment.refunds.get. */
  refundEventId: string;
  invoiceId: string;
  evidenceId: string;
}

export const idsOfEntity = (e: Entity): ProbeIds => ({
  merchantId: e.merchantId,
  paymentId: e.paymentId,
  settlementId: e.settlementId,
  linkId: e.linkId,
  endpointId: e.endpointId,
  spareEndpointId: e.spareEndpointId,
  deliveryId: e.deliveryId,
  disputeId: e.disputeId,
  customerRef: e.customerRef,
  exportJobId: e.exportJobId,
  notificationId: e.notificationId,
  memberId: e.memberId,
  inviteId: e.inviteId,
  approvalId: e.approvalId,
  refundEventId: e.refundEventId,
  invoiceId: e.invoiceId,
  evidenceId: e.evidenceId,
});
export const ghostIds = (): ProbeIds => ({
  merchantId: ghost(),
  paymentId: ghost(),
  settlementId: ghost(),
  linkId: ghost(),
  endpointId: ghost(),
  spareEndpointId: ghost(),
  deliveryId: ghost(),
  disputeId: `dp-${ghost()}`,
  customerRef: `cust-${ghost()}`,
  exportJobId: ghost(),
  notificationId: ghost(),
  memberId: ghost(),
  inviteId: ghost(),
  approvalId: ghost(),
  refundEventId: ghost(),
  invoiceId: ghost(),
  evidenceId: ghost(),
});

export interface MerchantProc {
  path: string;
  scope: string;
  input: (ids: ProbeIds) => unknown;
  /** Also probe "my merchantId + their child resource id" (the id is B's, the merchant is A's own). */
  mixed?: boolean;
  /**
   * `ok`: the owner's call succeeds (a read).
   * `service`: the owner's call gets past the isolation fence; the service may still refuse on state.
   */
  own: 'ok' | 'service';
  /**
   * The owner can only do this from an interactive, MFA'd session: an `ifc_` key is refused by design
   * (team changes), so there is no key positive control. The refusal itself is not weakened: a key still
   * cannot call it, and the session case still proves the foreign id is refused like a missing one.
   */
  sessionOnly?: boolean;
  /**
   * The owner's own call is refused BY DESIGN with this typed cause (a maker deciding their own payout). The positive
   * control then asserts exactly that cause: the owner reached the row and was refused for the right reason, which a
   * foreign or missing id never is. The refusal is not weakened; B's id must still equal a ghost's.
   */
  ownCause?: string;
  /** The body is a `pay.not_built` stub. Remove the flag when the workstream lands: strict assertions then apply. */
  stub?: boolean;
}

const paymentBody = (ids: ProbeIds) => ({
  merchantId: ids.merchantId,
  amount: '1',
  assetId: 'USDT',
  method: 'card',
  railAdapter: 'card-sandbox',
  instrument: { kind: 'card', token: 'tok_ok' },
});

export const MERCHANT_PROCS: MerchantProc[] = [
  // merchant.*
  {
    path: 'merchant.setPayoutDestination',
    scope: 'pay:write',
    own: 'service',
    sessionOnly: true,
    ownCause: 'pay.destination_step_up_required',
    input: (i) => ({ merchantId: i.merchantId, railId: 'crypto-native', kind: 'crypto', ref: EVM_DESTINATION }),
  },
  {
    path: 'merchant.payoutDestinations.change',
    scope: 'pay:write',
    own: 'service',
    sessionOnly: true,
    ownCause: 'pay.destination_step_up_required',
    input: (i) => ({ merchantId: i.merchantId, railId: 'crypto-native', kind: 'crypto', ref: EVM_DESTINATION }),
  },
  { path: 'merchant.submitKyb', scope: 'pay:onboard', own: 'service', input: (i) => ({ merchantId: i.merchantId, kybRef: 'dossier-1' }) },
  {
    path: 'merchant.decideKybStub',
    scope: 'pay:write',
    own: 'service',
    input: (i) => ({ merchantId: i.merchantId, decision: 'approved' }),
  },
  { path: 'merchant.profile', scope: 'pay:write', own: 'ok', input: (i) => ({ merchantId: i.merchantId }) },
  { path: 'merchant.checkoutSettings.get', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId }) },
  { path: 'merchant.createLink', scope: 'pay:write', own: 'ok', input: (i) => ({ merchantId: i.merchantId, label: 'probe' }) },
  { path: 'merchant.listLinks', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId, limit: 50 }) },
  {
    path: 'merchant.getLink',
    scope: 'pay:read',
    own: 'ok',
    mixed: true,
    input: (i) => ({ merchantId: i.merchantId, linkId: i.linkId }),
  },
  {
    path: 'merchant.deactivateLink',
    scope: 'pay:write',
    own: 'service',
    mixed: true,
    input: (i) => ({ merchantId: i.merchantId, linkId: i.linkId }),
  },
  { path: 'merchant.balances', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId, assetId: 'USDT' }) },
  { path: 'merchant.businessProfile.get', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId }) },
  { path: 'merchant.businessProfile.history', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId, limit: 20 }) },
  {
    path: 'merchant.businessProfile.submit',
    scope: 'pay:write',
    own: 'ok',
    sessionOnly: true,
    input: (i) => ({ merchantId: i.merchantId, reason: 'isolation drill', displayName: 'Isolation Name', expectedVersion: '0' }),
  },
  {
    path: 'merchant.businessProfile.setSecondApproval',
    scope: 'pay:write',
    own: 'ok',
    sessionOnly: true,
    input: (i) => ({ merchantId: i.merchantId, enabled: false }),
  },
  {
    path: 'merchant.businessProfile.confirm',
    scope: 'pay:write',
    own: 'service',
    ownCause: 'pay.profile_change_not_found',
    sessionOnly: true,
    input: (i) => ({
      merchantId: i.merchantId,
      requestId: ghost(),
      decision: 'confirm',
      expectedChangeHash: hash,
      reason: 'isolation drill',
    }),
  },
  { path: 'merchant.onboarding.progress', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId }) },
  {
    path: 'merchantAnalytics.volume',
    scope: 'pay:read',
    own: 'ok',
    input: (i) => ({ merchantId: i.merchantId, ...series, limit: 20 }),
  },
  {
    path: 'merchantAnalytics.fees',
    scope: 'pay:read',
    own: 'ok',
    input: (i) => ({ merchantId: i.merchantId, ...series, limit: 20 }),
  },
  {
    path: 'merchant.payoutDestinations.list',
    scope: 'pay:read',
    own: 'ok',
    input: (i) => ({ merchantId: i.merchantId, limit: 50 }),
  },
  {
    path: 'merchant.payoutDestinations.setDefault',
    scope: 'pay:write',
    own: 'service',
    ownCause: 'pay.payout_destination_not_found',
    input: (i) => ({ merchantId: i.merchantId, destinationId: ghost() }),
  },
  {
    path: 'merchant.payoutDestinations.remove',
    scope: 'pay:write',
    own: 'service',
    ownCause: 'pay.payout_destination_not_found',
    input: (i) => ({ merchantId: i.merchantId, destinationId: ghost() }),
  },
  {
    path: 'merchant.statement.list',
    scope: 'pay:read',
    own: 'ok',
    input: (i) => ({ merchantId: i.merchantId, limit: 50, ...statementWindow() }),
  },
  // W5: the merchant-readable halt status for a named merchant (merchant-safe shape; an unnamed read is the global switch only).
  { path: 'payHalts.status', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId }) },
  // payment.*
  { path: 'payment.create', scope: 'pay:write', own: 'service', input: (i) => paymentBody(i) },
  { path: 'payment.authorize', scope: 'pay:write', own: 'service', input: (i) => ({ paymentId: i.paymentId }) },
  { path: 'payment.capture', scope: 'pay:write', own: 'service', input: (i) => ({ paymentId: i.paymentId }) },
  {
    path: 'payment.refund',
    scope: 'pay:refund',
    own: 'service',
    input: (i) => ({ paymentId: i.paymentId, amount: '1', refundId: `w14-${randomUUID()}` }),
  },
  { path: 'payment.get', scope: 'pay:read', own: 'ok', input: (i) => ({ paymentId: i.paymentId }) },
  { path: 'payment.list', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId, limit: 50 }) },
  { path: 'payment.history', scope: 'pay:read', own: 'ok', input: (i) => ({ paymentId: i.paymentId, limit: 50 }) },
  { path: 'payment.refunds.list', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId, limit: 50 }) },
  { path: 'payment.refunds.get', scope: 'pay:read', own: 'ok', input: (i) => ({ refundEventId: i.refundEventId }) },
  // settlement.*
  {
    path: 'settlement.run',
    scope: 'pay:write',
    own: 'service',
    input: (i) => ({ merchantId: i.merchantId, window: `w14-${randomUUID().slice(0, 8)}`, assetId: 'USDT' }),
  },
  {
    path: 'settlement.payout',
    scope: 'pay:payout',
    own: 'service',
    input: (i) => ({ settlementId: i.settlementId, railId: 'crypto-native' }),
  },
  { path: 'settlement.get', scope: 'pay:read', own: 'ok', input: (i) => ({ settlementId: i.settlementId }) },
  { path: 'settlement.lifecycle', scope: 'pay:read', own: 'ok', input: (i) => ({ settlementId: i.settlementId }) },
  { path: 'settlement.list', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId, limit: 50 }) },
  { path: 'settlement.release', scope: 'pay:write', own: 'service', input: (i) => ({ settlementId: i.settlementId, reason: 'probe' }) },
  // kyb.*
  { path: 'kyb.submit', scope: 'pay:onboard', own: 'service', input: (i) => ({ merchantId: i.merchantId, kybRef: 'dossier-2' }) },
  { path: 'fraud.getDispute', scope: 'pay:read', own: 'ok', input: (i) => ({ disputeId: i.disputeId }) },
  {
    path: 'fraud.enqueueReview',
    scope: 'pay:write',
    own: 'ok',
    input: (i) => ({
      id: `rev-${i.merchantId}`,
      merchantId: i.merchantId,
      amount: '99',
      assetId: 'USDT',
      recentPaymentCount: 50,
      thresholds: { maxPaymentsInWindow: 5, velocityCountAction: 'review' },
    }),
  },
  // sub-merchant tree, probed from outside the tree (inside-tree cases are the M3 table)
  { path: 'submerchant.get', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId }) },
  { path: 'submerchant.list', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId, limit: 50 }) },
  { path: 'submerchantPermission.list', scope: 'pay:read', own: 'ok', input: (i) => ({ subjectMerchantId: i.merchantId, limit: 50 }) },
  { path: 'submerchantPermission.history', scope: 'pay:read', own: 'ok', input: (i) => ({ subjectMerchantId: i.merchantId, limit: 50 }) },
  // W1 merchant control room. Reads first; the actions that consume the owner's approval (decide, cancel) come last.
  { path: 'merchantControl.get', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId }) },
  { path: 'merchantControl.usage', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId }) },
  { path: 'merchantControl.reserve', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId }) },
  // M-money-out-02: no top-up rail is wired, so the owner reaches the business and is refused for exactly that reason.
  {
    path: 'merchantControl.topUp.options',
    scope: 'pay:read',
    own: 'service',
    ownCause: 'pay.topup_unconfigured',
    input: (i) => ({ merchantId: i.merchantId }),
  },
  {
    path: 'merchantControl.pricing.preview',
    scope: 'pay:read',
    own: 'ok',
    input: (i) => ({ merchantId: i.merchantId, assetCode: 'USDT', amount: '10' }),
  },
  { path: 'merchantControl.approvals.list', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId, limit: 10 }) },
  { path: 'merchantControl.tiers.list', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId }) },
  { path: 'merchantControl.pricing.history', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId, limit: 20 }) },
  { path: 'merchantControl.limits.open', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId }) },
  {
    path: 'merchantControl.limits.requestIncrease',
    scope: 'pay:write',
    own: 'ok',
    sessionOnly: true,
    input: (i) => ({
      merchantId: i.merchantId,
      requestId: randomUUID(),
      caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '10' }],
      reason: 'isolation drill',
    }),
  },
  {
    path: 'merchantControl.limits.withdraw',
    scope: 'pay:write',
    own: 'service',
    sessionOnly: true,
    ownCause: 'pay.limit_request_not_found',
    input: (i) => ({ merchantId: i.merchantId, requestId: randomUUID(), reason: 'isolation drill' }),
  },
  // The default isolation key does not carry pay:payout (D-145), so there is no key case. "My merchant + their settlement" must look like a missing settlement.
  {
    path: 'merchantControl.approvals.request',
    scope: 'pay:payout',
    own: 'service',
    mixed: true,
    sessionOnly: true,
    input: (i) => ({ merchantId: i.merchantId, settlementId: i.settlementId, railId: 'crypto-native' }),
  },
  // A maker cannot approve their own payout: the owner's call is refused as self-approval, B's id as "no such approval".
  {
    path: 'merchantControl.approvals.decide',
    scope: 'pay:write',
    own: 'service',
    sessionOnly: true,
    ownCause: 'pay.approval_self_approval',
    input: (i) => ({ approvalId: i.approvalId, decision: 'approve', expectedPayloadHash: hash, reason: 'checked' }),
  },
  {
    path: 'merchantControl.approvals.cancel',
    scope: 'pay:payout',
    own: 'ok',
    sessionOnly: true,
    input: (i) => ({ approvalId: i.approvalId, reason: 'isolation drill' }),
  },
  // W2 landed: the metrics runtime is mounted, so these answer for real and the strict assertions apply.
  { path: 'merchantMetrics.snapshot', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId, window }) },
  {
    path: 'merchantMetrics.series',
    scope: 'pay:read',
    own: 'ok',
    input: (i) => ({ merchantId: i.merchantId, ...series }),
  },
  {
    path: 'merchantMetrics.settlementAssets',
    scope: 'pay:read',
    own: 'ok',
    input: (i) => ({ merchantId: i.merchantId }),
  },
  {
    path: 'conversion.quote',
    scope: 'pay:write',
    own: 'service',
    input: (i) => ({ merchantId: i.merchantId, settlementId: i.settlementId, fromAsset: 'USD', toAsset: 'USDT', fromAmount: '10' }),
  },
  { path: 'conversion.execute', scope: 'pay:payout', own: 'service', input: () => ({ requestId: ghost(), quoteId: ghost() }) },
  { path: 'conversion.get', scope: 'pay:read', own: 'service', input: () => ({ conversionId: ghost() }) },
  { path: 'conversion.list', scope: 'pay:read', own: 'ok', input: (i) => ({ merchantId: i.merchantId, limit: 10 }) },
  // W15 merchantOps.*: every procedure that takes a resource id. (The caller's merchant comes from the principal,
  // never the body, so there is no `mixed` case: the id is the only thing a caller can aim at someone else.)
  // Order matters for the positive controls: an action that consumes the row (remove, decline, respond) comes after its siblings.
  {
    path: 'merchantOps.disputes.get',
    scope: 'pay:read',
    own: 'ok',
    input: (i) => ({ disputeId: i.disputeId }),
  },
  {
    path: 'merchantOps.disputes.getEvidence',
    scope: 'pay:read',
    own: 'ok',
    // Evidence bytes are an interactive respond action. An API key is refused even for the owner.
    sessionOnly: true,
    input: (i) => ({ evidenceId: i.evidenceId }),
  },
  {
    path: 'merchantOps.disputes.uploadEvidence',
    scope: 'pay:write',
    own: 'service',
    ownCause: 'pay.dispute_evidence_upload_off',
    input: (i) => ({
      disputeId: i.disputeId,
      kind: 'receipt',
      fileName: 'receipt.pdf',
      contentType: 'application/pdf',
      contentBase64: Buffer.from('%PDF').toString('base64'),
    }),
  },
  {
    path: 'merchantOps.invoices.get',
    scope: 'pay:read',
    own: 'ok',
    input: (i) => ({ invoiceId: i.invoiceId }),
  },
  {
    path: 'merchantOps.invoices.send',
    scope: 'pay:write',
    own: 'service',
    input: (i) => ({ requestId: ghost(), invoiceId: i.invoiceId }),
  },
  {
    path: 'merchantOps.invoices.markPaidByPayment',
    scope: 'pay:write',
    own: 'service',
    input: (i) => ({ requestId: ghost(), invoiceId: i.invoiceId, paymentId: i.paymentId }),
  },
  {
    path: 'merchantOps.invoices.void',
    scope: 'pay:write',
    own: 'service',
    ownCause: 'pay.invoice_paid',
    input: (i) => ({ requestId: ghost(), invoiceId: i.invoiceId }),
  },
  {
    path: 'merchantOps.invoices.reissueLink',
    scope: 'pay:write',
    own: 'service',
    input: (i) => ({ requestId: ghost(), invoiceId: i.invoiceId }),
  },
  {
    path: 'merchantOps.disputes.addEvidence',
    scope: 'pay:write',
    own: 'ok',
    input: (i) => ({
      disputeId: i.disputeId,
      kind: 'receipt',
      fileName: 'receipt.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
    }),
  },
  {
    path: 'merchantOps.disputes.respond',
    scope: 'pay:write',
    own: 'service',
    input: (i) => ({ requestId: ghost(), disputeId: i.disputeId, action: 'accept_liability' }),
  },
  {
    path: 'merchantOps.customers.get',
    scope: 'pay:read',
    own: 'ok',
    input: (i) => ({ customerRef: i.customerRef, recentPaymentsLimit: 5 }),
  },
  {
    path: 'merchantOps.customers.series',
    scope: 'pay:read',
    own: 'ok',
    input: (i) => ({ customerRef: i.customerRef, ...series, limit: 20 }),
  },
  { path: 'merchantOps.exports.get', scope: 'pay:read', own: 'ok', input: (i) => ({ jobId: i.exportJobId }) },
  { path: 'merchantOps.exports.download', scope: 'pay:read', own: 'ok', input: (i) => ({ jobId: i.exportJobId }) },
  {
    path: 'merchantOps.notifications.markRead',
    scope: 'pay:write',
    own: 'ok',
    input: (i) => ({ notificationIds: [i.notificationId] }),
  },
  {
    path: 'merchantOps.team.changeRole',
    scope: 'pay:write',
    own: 'ok',
    sessionOnly: true,
    input: (i) => ({ memberId: i.memberId, role: 'developer' }),
  },
  { path: 'merchantOps.team.remove', scope: 'pay:write', own: 'ok', sessionOnly: true, input: (i) => ({ memberId: i.memberId }) },
  // The invited account answers its own invitation; here the invitation names the owner's own account, so the owner can.
  // Accepting is refused as a conflict (an owner cannot join a team), which is past the fence.
  {
    path: 'merchantOps.team.acceptInvite',
    scope: 'pay:write',
    own: 'service',
    sessionOnly: true,
    input: (i) => ({ memberId: i.inviteId }),
  },
  { path: 'merchantOps.team.declineInvite', scope: 'pay:write', own: 'ok', sessionOnly: true, input: (i) => ({ memberId: i.inviteId }) },
  { path: 'merchantOps.exports.expire', scope: 'pay:write', own: 'ok', input: (i) => ({ jobId: i.exportJobId }) },
  {
    path: 'merchantOps.webhooks.update',
    scope: 'pay:write',
    own: 'ok',
    sessionOnly: true,
    input: (i) => ({ endpointId: i.endpointId, url: `http://localhost:9/hook-updated-${i.endpointId.slice(0, 8)}` }),
  },
  {
    path: 'merchantOps.webhooks.disable',
    scope: 'pay:write',
    own: 'ok',
    sessionOnly: true,
    input: (i) => ({ endpointId: i.spareEndpointId }),
  },
  {
    path: 'merchantOps.webhooks.rotateSecret',
    scope: 'pay:write',
    own: 'ok',
    sessionOnly: true,
    input: (i) => ({ endpointId: i.endpointId, requestId: randomUUID() }),
  },
  {
    path: 'merchantOps.webhooks.deliveries.retry',
    scope: 'pay:write',
    own: 'ok',
    sessionOnly: true,
    input: (i) => ({ deliveryId: i.deliveryId, requestId: randomUUID() }),
  },
  // W10: while pay.b2b_ramp is off, the owner and a stranger get the same refusal. The flag check runs before any merchant lookup.
  {
    path: 'b2bRamp.status',
    scope: 'pay:read',
    own: 'service',
    ownCause: 'pay.b2b_ramp_off',
    input: (i) => ({ merchantId: i.merchantId }),
  },
  {
    path: 'b2bRamp.credit',
    scope: 'pay:write',
    own: 'service',
    ownCause: 'pay.b2b_ramp_off',
    input: (i) => ({
      merchantId: i.merchantId,
      bankLineId: 'bank-line-1',
      amount: '10.00',
      asset: 'USD',
      clientSettledAmount: '999999.00',
    }),
  },
  {
    path: 'b2bRamp.get',
    scope: 'pay:read',
    own: 'service',
    ownCause: 'pay.b2b_ramp_off',
    input: (i) => ({ creditId: i.paymentId }),
  },
];

export const keyCanCall = (p: MerchantProc): boolean => !p.sessionOnly && MERCHANT_KEY_SCOPES.includes(p.scope);

// ── M2: list endpoints ──────────────────────────────────────────────────────

export interface ListProc {
  name: string;
  /** How to ask for `e`'s rows. */
  call: { via: 'trpc'; path: string; input: (e: Entity) => unknown } | { via: 'rest'; req: (e: Entity) => RestCall };
  /** Reduce the success value to the rows. */
  rows: (value: unknown) => Array<Record<string, unknown>>;
  /** The ids the owner must see, exactly. `undefined`: check `merchantId` on every row instead. */
  expectedIds?: (e: Entity) => string[];
}

const arr = (v: unknown) => v as Array<Record<string, unknown>>;
export function pageRows(v: unknown): Array<Record<string, unknown>> {
  if (
    v !== null &&
    typeof v === 'object' &&
    'items' in v &&
    Array.isArray((v as { items: unknown }).items) &&
    'nextCursor' in v &&
    ((v as { nextCursor: unknown }).nextCursor === null || typeof (v as { nextCursor: unknown }).nextCursor === 'string')
  ) {
    return (v as { items: Array<Record<string, unknown>> }).items;
  }
  throw new Error('list page is not { items, nextCursor }');
}

export const LIST_PROCS: ListProc[] = [
  {
    name: 'trpc payment.list',
    call: { via: 'trpc', path: 'payment.list', input: (e) => ({ merchantId: e.merchantId, limit: 200 }) },
    rows: pageRows,
    expectedIds: (e) => [e.paymentId, e.paymentId2],
  },
  {
    name: 'trpc settlement.list',
    call: { via: 'trpc', path: 'settlement.list', input: (e) => ({ merchantId: e.merchantId, limit: 200 }) },
    rows: pageRows,
    expectedIds: (e) => [e.settlementId],
  },
  {
    name: 'trpc merchant.payoutDestinations.list',
    call: { via: 'trpc', path: 'merchant.payoutDestinations.list', input: (e) => ({ merchantId: e.merchantId, limit: 200 }) },
    rows: pageRows,
  },
  {
    name: 'trpc payment.refunds.list',
    call: { via: 'trpc', path: 'payment.refunds.list', input: (e) => ({ merchantId: e.merchantId, limit: 200 }) },
    rows: pageRows,
    expectedIds: (e) => [e.refundEventId],
  },
  {
    name: 'trpc merchant.statement.list',
    call: { via: 'trpc', path: 'merchant.statement.list', input: (e) => ({ merchantId: e.merchantId, limit: 200, ...statementWindow() }) },
    rows: pageRows,
  },
  {
    name: 'trpc merchantOps.invoices.list',
    call: { via: 'trpc', path: 'merchantOps.invoices.list', input: () => ({ limit: 200 }) },
    rows: pageRows,
    expectedIds: (e) => [e.invoiceId],
  },
  {
    name: 'trpc merchant.listLinks',
    call: { via: 'trpc', path: 'merchant.listLinks', input: (e) => ({ merchantId: e.merchantId, limit: 200 }) },
    rows: pageRows,
    expectedIds: (e) => [e.linkId],
  },
  {
    name: 'rest GET /v1/payments',
    call: { via: 'rest', req: (e) => ({ method: 'GET', url: `/v1/payments?merchantId=${e.merchantId}&limit=200` }) },
    rows: pageRows,
    expectedIds: (e) => [e.paymentId, e.paymentId2],
  },
  {
    name: 'rest GET /v1/payment-links',
    call: { via: 'rest', req: (e) => ({ method: 'GET', url: `/v1/payment-links?merchantId=${e.merchantId}&limit=200` }) },
    rows: pageRows,
    expectedIds: (e) => [e.linkId],
  },
  {
    name: 'rest GET /v1/webhook-endpoints',
    call: { via: 'rest', req: (e) => ({ method: 'GET', url: `/v1/webhook-endpoints?merchantId=${e.merchantId}&limit=200` }) },
    rows: arr,
    expectedIds: (e) => [e.endpointId, e.spareEndpointId],
  },
  {
    name: 'rest GET /v1/webhook-deliveries',
    call: { via: 'rest', req: (e) => ({ method: 'GET', url: `/v1/webhook-deliveries?merchantId=${e.merchantId}&limit=200` }) },
    rows: arr,
  },
  {
    name: 'trpc merchantOps.team.list',
    call: { via: 'trpc', path: 'merchantOps.team.list', input: () => ({ limit: 200 }) },
    rows: (v) => pageRows(v).flatMap((r) => (typeof r.memberId === 'string' ? [{ id: r.memberId }] : [])),
    expectedIds: (e) => [e.memberId, e.inviteId],
  },
  {
    name: 'trpc merchantOps.activity.list',
    call: { via: 'trpc', path: 'merchantOps.activity.list', input: () => ({ limit: 200 }) },
    rows: pageRows,
  },
  {
    name: 'trpc merchantOps.payouts.list',
    call: { via: 'trpc', path: 'merchantOps.payouts.list', input: () => ({ limit: 200 }) },
    rows: pageRows,
    expectedIds: (e) => [e.settlementId],
  },
  {
    name: 'trpc merchantOps.webhooks.list',
    call: { via: 'trpc', path: 'merchantOps.webhooks.list', input: () => ({ limit: 200 }) },
    rows: pageRows,
    expectedIds: (e) => [e.endpointId, e.spareEndpointId],
  },
  {
    name: 'trpc merchantOps.webhooks.health',
    call: { via: 'trpc', path: 'merchantOps.webhooks.health', input: () => ({}) },
    rows: (v) => {
      const endpoints = (v as { endpoints?: Array<{ endpointId: string }> }).endpoints ?? [];
      return endpoints.map((row) => ({ id: row.endpointId }));
    },
    expectedIds: (e) => [e.endpointId, e.spareEndpointId],
  },
  {
    name: 'trpc merchantOps.webhooks.deliveries.list',
    call: { via: 'trpc', path: 'merchantOps.webhooks.deliveries.list', input: () => ({ limit: 200 }) },
    rows: pageRows,
    expectedIds: (e) => [e.deliveryId],
  },
  {
    name: 'trpc merchantOps.exports.list',
    call: { via: 'trpc', path: 'merchantOps.exports.list', input: () => ({ limit: 200 }) },
    rows: (v) => pageRows(v).map((r) => ({ ...r, id: String(r.jobId) })),
    expectedIds: (e) => [e.exportJobId],
  },
  {
    name: 'trpc merchantOps.disputes.list',
    call: { via: 'trpc', path: 'merchantOps.disputes.list', input: () => ({ limit: 200 }) },
    rows: (v) => pageRows(v).map((r) => ({ ...r, id: String(r.disputeId) })),
    expectedIds: (e) => [e.disputeId],
  },
  {
    name: 'trpc merchantControl.approvals.list',
    call: { via: 'trpc', path: 'merchantControl.approvals.list', input: (e) => ({ merchantId: e.merchantId, limit: 200 }) },
    rows: (v) => pageRows(v).map((r) => ({ ...r, id: String(r.approvalId) })),
    expectedIds: (e) => [e.approvalId],
  },
];

// ── REST ────────────────────────────────────────────────────────────────────

export interface RestRoute {
  name: string;
  scope: string;
  req: (i: ProbeIds) => RestCall;
  mixed?: boolean;
  own: 'ok' | 'service';
}

export const REST_ROUTES: RestRoute[] = [
  { name: 'GET /v1/payments/:id', scope: 'pay:read', own: 'ok', req: (i) => ({ method: 'GET', url: `/v1/payments/${i.paymentId}` }) },
  {
    name: 'GET /v1/payments',
    scope: 'pay:read',
    own: 'ok',
    req: (i) => ({ method: 'GET', url: `/v1/payments?merchantId=${i.merchantId}&limit=10` }),
  },
  {
    name: 'GET /v1/balances',
    scope: 'pay:read',
    own: 'ok',
    req: (i) => ({ method: 'GET', url: `/v1/balances?merchantId=${i.merchantId}&assetId=USDT` }),
  },
  {
    name: 'POST /v1/payments',
    scope: 'pay:write',
    own: 'service',
    req: (i) => ({ method: 'POST', url: '/v1/payments', body: paymentBody(i) }),
  },
  {
    name: 'POST /v1/payments/:id/authorize',
    scope: 'pay:write',
    own: 'service',
    req: (i) => ({ method: 'POST', url: `/v1/payments/${i.paymentId}/authorize`, body: {} }),
  },
  {
    name: 'POST /v1/payments/:id/capture',
    scope: 'pay:write',
    own: 'service',
    req: (i) => ({ method: 'POST', url: `/v1/payments/${i.paymentId}/capture`, body: {} }),
  },
  {
    name: 'POST /v1/payments/:id/refund',
    scope: 'pay:refund',
    own: 'service',
    req: (i) => ({ method: 'POST', url: `/v1/payments/${i.paymentId}/refund`, body: { amount: '1', refundId: `w14-${randomUUID()}` } }),
  },
  {
    name: 'POST /v1/payment-links',
    scope: 'pay:write',
    own: 'ok',
    req: (i) => ({ method: 'POST', url: '/v1/payment-links', body: { merchantId: i.merchantId, label: 'probe' } }),
  },
  {
    name: 'GET /v1/payment-links',
    scope: 'pay:read',
    own: 'ok',
    req: (i) => ({ method: 'GET', url: `/v1/payment-links?merchantId=${i.merchantId}&limit=10` }),
  },
  {
    name: 'GET /v1/payment-links/:id',
    scope: 'pay:read',
    own: 'ok',
    mixed: true,
    req: (i) => ({ method: 'GET', url: `/v1/payment-links/${i.linkId}?merchantId=${i.merchantId}` }),
  },
  {
    name: 'DELETE /v1/payment-links/:id',
    scope: 'pay:write',
    own: 'service',
    mixed: true,
    req: (i) => ({ method: 'DELETE', url: `/v1/payment-links/${i.linkId}?merchantId=${i.merchantId}` }),
  },
  {
    name: 'POST /v1/webhook-endpoints',
    scope: 'pay:write',
    own: 'ok',
    req: (i) => ({ method: 'POST', url: '/v1/webhook-endpoints', body: { merchantId: i.merchantId, url: 'http://localhost:9/probe' } }),
  },
  {
    name: 'GET /v1/webhook-endpoints',
    scope: 'pay:read',
    own: 'ok',
    req: (i) => ({ method: 'GET', url: `/v1/webhook-endpoints?merchantId=${i.merchantId}&limit=10` }),
  },
  {
    name: 'DELETE /v1/webhook-endpoints/:id',
    scope: 'pay:write',
    own: 'service',
    mixed: true,
    req: (i) => ({ method: 'DELETE', url: `/v1/webhook-endpoints/${i.endpointId}?merchantId=${i.merchantId}` }),
  },
  {
    name: 'POST /v1/webhook-endpoints/:id/enable',
    scope: 'pay:write',
    own: 'service',
    mixed: true,
    req: (i) => ({ method: 'POST', url: `/v1/webhook-endpoints/${i.endpointId}/enable?merchantId=${i.merchantId}`, body: {} }),
  },
  {
    name: 'GET /v1/webhook-deliveries',
    scope: 'pay:read',
    own: 'ok',
    req: (i) => ({ method: 'GET', url: `/v1/webhook-deliveries?merchantId=${i.merchantId}&limit=10` }),
  },
  {
    name: 'GET /v1/submerchant-permissions',
    scope: 'pay:read',
    own: 'ok',
    req: (i) => ({ method: 'GET', url: `/v1/submerchant-permissions?subjectMerchantId=${i.merchantId}&limit=10` }),
  },
  {
    name: 'GET /v1/submerchant-permissions/history',
    scope: 'pay:read',
    own: 'ok',
    req: (i) => ({ method: 'GET', url: `/v1/submerchant-permissions/history?subjectMerchantId=${i.merchantId}&limit=10` }),
  },
];

// ── M3: the PayFac tree ─────────────────────────────────────────────────────

/** Tree 1: P -> { C1 -> { G1 }, C2 }.  Tree 2: Q -> { D1 }.  A and B are standalone. */
export const PARENT: Readonly<Record<string, string | undefined>> = { C1: 'P', G1: 'C1', C2: 'P', D1: 'Q' };

export type Relation = 'self' | 'root-over' | 'intermediate-over' | 'hidden';

export function relationOf(actor: string, subject: string): Relation {
  if (actor === subject) return 'self';
  const chain: string[] = [];
  for (let n: string | undefined = subject; n; n = PARENT[n]) chain.push(n);
  const idx = chain.indexOf(actor);
  if (idx < 0) return 'hidden';
  return idx === chain.length - 1 ? 'root-over' : 'intermediate-over';
}

export interface TreeProc {
  path: string;
  /** The permission area it needs over the subject. */
  area: string;
  input: (i: ProbeIds) => unknown;
}

export const TREE_PROCS: TreeProc[] = [
  { path: 'submerchant.get', area: 'merchant.profile', input: (i) => ({ merchantId: i.merchantId }) },
  { path: 'submerchant.list', area: 'submerchant', input: (i) => ({ merchantId: i.merchantId, limit: 50 }) },
  { path: 'merchant.balances', area: 'merchant.profile', input: (i) => ({ merchantId: i.merchantId, assetId: 'USDT' }) },
  { path: 'merchant.listLinks', area: 'payment.link', input: (i) => ({ merchantId: i.merchantId, limit: 50 }) },
  { path: 'merchant.getLink', area: 'payment.link', input: (i) => ({ merchantId: i.merchantId, linkId: i.linkId }) },
  { path: 'payment.get', area: 'payment', input: (i) => ({ paymentId: i.paymentId }) },
  { path: 'payment.list', area: 'payment', input: (i) => ({ merchantId: i.merchantId, limit: 50 }) },
  { path: 'settlement.list', area: 'settlement', input: (i) => ({ merchantId: i.merchantId, limit: 50 }) },
  { path: 'settlement.get', area: 'settlement', input: (i) => ({ settlementId: i.settlementId }) },
  { path: 'settlement.lifecycle', area: 'settlement', input: (i) => ({ settlementId: i.settlementId }) },
  { path: 'merchant.payoutDestinations.list', area: 'settlement.payout', input: (i) => ({ merchantId: i.merchantId, limit: 50 }) },
  { path: 'payment.refunds.list', area: 'payment', input: (i) => ({ merchantId: i.merchantId, limit: 50 }) },
  { path: 'payment.refunds.get', area: 'payment', input: (i) => ({ refundEventId: i.refundEventId }) },
  { path: 'merchant.statement.list', area: 'payment', input: (i) => ({ merchantId: i.merchantId, limit: 50, ...statementWindow() }) },
  // The merchant metrics need BOTH `payment` and `settlement` over the subject; neither is a default grant, so one name stands for the pair.
  { path: 'merchantMetrics.snapshot', area: 'payment', input: (i) => ({ merchantId: i.merchantId, window }) },
  { path: 'merchantMetrics.series', area: 'payment', input: (i) => ({ merchantId: i.merchantId, ...series }) },
  { path: 'merchantMetrics.settlementAssets', area: 'payment', input: (i) => ({ merchantId: i.merchantId }) },
  {
    path: 'submerchant.summary',
    area: 'merchant.profile',
    input: (i) => ({ merchantId: i.merchantId, recentPaymentsLimit: 5, grantsLimit: 20 }),
  },
  {
    path: 'merchantAnalytics.volume',
    area: 'payment',
    input: (i) => ({ merchantId: i.merchantId, ...series, limit: 20 }),
  },
  {
    path: 'merchantAnalytics.fees',
    area: 'settlement',
    input: (i) => ({ merchantId: i.merchantId, ...series, limit: 20 }),
  },
  { path: 'merchant.businessProfile.get', area: 'merchant.profile', input: (i) => ({ merchantId: i.merchantId }) },
  { path: 'merchant.checkoutSettings.get', area: 'checkout.profile', input: (i) => ({ merchantId: i.merchantId }) },
  { path: 'merchant.businessProfile.history', area: 'merchant.profile', input: (i) => ({ merchantId: i.merchantId, limit: 20 }) },
  { path: 'merchant.onboarding.progress', area: 'merchant.profile', input: (i) => ({ merchantId: i.merchantId }) },
];

/** Default grants every sub-merchant gets from its parent (submerchants.ts DEFAULT_GRANTED_AREAS). */
export const DEFAULT_AREAS = ['merchant.profile', 'submerchant'] as const;
