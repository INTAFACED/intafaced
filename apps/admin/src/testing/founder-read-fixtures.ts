/**
 * TEST DATA for the founder reads added in #4870. Every value here is made up for tests and local previews: the merchant
 * names say so, the ids are fixed placeholders, and the amounts are round numbers that exercise the display rules (decimal
 * strings beyond float precision, two assets that must never be added together). Nothing in this file is a real balance.
 *
 * Shapes follow `packages/contracts/src/founder-admin.ts`; `founder-read-fixtures.test.ts` parses every fixture with the
 * contract's own schema, so a contract change that this file misses fails a test instead of a page.
 */

export const TEST_MERCHANT = '22222222-2222-4222-8222-222222222222';
export const TEST_OTHER_MERCHANT = '55555555-5555-4555-8555-555555555555';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const BIG = '9007199254740993.000000000000000001';
const T = '2026-10-15T10:00:00.000Z';
const T2 = '2026-10-16T08:30:00.000Z';

const pricing = {
  fee: '1.250000000000000000',
  assetCode: 'USDT',
  appliedLayer: 'merchant' as const,
  ruleId: U(900),
  recordedAt: T,
};

const rows = {
  payments: [
    {
      id: U(1),
      merchantId: TEST_MERCHANT,
      assetId: 'USDT',
      amount: BIG,
      capturedAmount: BIG,
      refundedAmount: '0',
      method: 'card',
      railAdapter: 'sim-card',
      railRef: 'rail-ref-TEST-0001',
      status: 'captured' as const,
      createdAt: T,
      failureCode: null,
      pricing,
    },
    {
      id: U(2),
      merchantId: TEST_MERCHANT,
      assetId: 'EUR',
      amount: '12.50',
      capturedAmount: '0',
      refundedAmount: '0',
      method: 'sepa',
      railAdapter: 'sim-sepa',
      railRef: null,
      status: 'failed' as const,
      createdAt: T2,
      failureCode: 'rail.declined',
      pricing: null,
    },
  ],
  refunds: [
    {
      id: U(11),
      refundId: 'refund-TEST-1',
      paymentId: U(1),
      merchantId: TEST_MERCHANT,
      amount: '5.00',
      assetId: 'USDT',
      reason: 'Customer asked (TEST DATA)',
      actor: U(100),
      status: 'posted' as const,
      createdAt: T,
      settledAt: null,
      source: 'clearing' as const,
      ledgerEffect: { recorded: true, pot: 'clearing' as const, ledgerTxId: U(500), direction: 'debit' as const },
      payment: { paymentId: U(1), status: 'refunded' as const },
    },
  ],
  disputes: [
    {
      merchantId: TEST_MERCHANT,
      disputeId: 'dispute-TEST-1',
      paymentId: U(1),
      amount: '40.00',
      assetId: 'USDT',
      reasonCode: 'fraudulent',
      status: 'open' as const,
      openedAt: T,
      contestedAt: null,
      closedAt: null,
      responseDueAt: '2026-10-20T00:00:00.000Z',
      responseDueSource: 'rail_event' as const,
      ledgerWire: 'refused' as const,
      ledgerRefuseCode: 'ledger.chargeback_unbuilt',
    },
    {
      merchantId: TEST_MERCHANT,
      disputeId: 'dispute-TEST-2',
      paymentId: U(2),
      amount: '3.10',
      assetId: 'EUR',
      reasonCode: null,
      status: 'won' as const,
      openedAt: T,
      contestedAt: T2,
      closedAt: T2,
      responseDueAt: null,
      responseDueSource: null,
      ledgerWire: 'posted' as const,
      ledgerRefuseCode: null,
    },
  ],
  settlements: [
    {
      id: U(21),
      merchantId: TEST_MERCHANT,
      window: '2026-10-14',
      assetId: 'USDT',
      gross: '700.00',
      fees: '7.00',
      net: '693.00',
      status: 'paid_out' as const,
      payoutMethod: 'bank',
      payoutReference: 'PAYOUT-REF-TEST',
      createdAt: T,
      sentAt: T,
      settledAt: T2,
      failedAt: null,
      failureCode: null,
      pricing,
    },
  ],
  payouts: [
    {
      id: U(21),
      merchantId: TEST_MERCHANT,
      window: '2026-10-14',
      assetId: 'USDT',
      gross: '700.00',
      fees: '7.00',
      net: '693.00',
      status: 'paid_out' as const,
      payoutMethod: 'bank',
      payoutReference: 'PAYOUT-REF-TEST',
      createdAt: T,
    },
    {
      id: U(22),
      merchantId: TEST_OTHER_MERCHANT,
      window: '2026-10-15',
      assetId: 'EUR',
      gross: '100.00',
      fees: '1.00',
      net: '99.00',
      status: 'failed' as const,
      payoutMethod: null,
      payoutReference: null,
      createdAt: T2,
    },
  ],
  destinations: [
    {
      id: U(31),
      merchantId: TEST_MERCHANT,
      railId: 'sim-bank',
      kind: 'bank_account',
      destinationMasked: '••••4821',
      screeningState: 'not_recorded' as const,
      defaultFlag: 'unset' as const,
      createdAt: T,
      lastUsedAt: null,
    },
  ],
  customers: [
    {
      customerRef: 'cust-TEST-0001',
      paymentCount: 3,
      subscriptionCount: 1,
      mandateCount: 1,
      firstSeenAt: T,
      lastSeenAt: T2,
      totals: [
        { assetId: 'USDT', capturedAmount: '120.50', refundedAmount: '5.00', paymentCount: 2 },
        { assetId: 'EUR', capturedAmount: '10.00', refundedAmount: '0', paymentCount: 1 },
      ],
    },
  ],
  links: [
    {
      id: U(41),
      prefix: 'plink_TEST',
      label: 'Test checkout link',
      amount: '25.00',
      currency: 'USDT',
      active: true,
      expiresAt: null,
      maxUses: 10,
      uses: 3,
      createdAt: T,
    },
    {
      id: U(42),
      prefix: 'plink_OPEN',
      label: '',
      amount: null,
      currency: null,
      active: false,
      expiresAt: '2026-12-01T00:00:00.000Z',
      maxUses: null,
      uses: 0,
      createdAt: T2,
    },
  ],
  invoices: [
    {
      id: U(51),
      status: 'sent' as const,
      assetId: 'USDT',
      amount: '300.00',
      customerRef: 'cust-TEST-0001',
      description: 'October services (TEST DATA)',
      paymentLinkId: U(41),
      paymentId: null,
      sentAt: T,
      voidedAt: null,
      paidAt: null,
      createdAt: T,
    },
  ],
  subscriptions: [
    {
      id: U(61),
      mandateId: U(62),
      merchantId: TEST_MERCHANT,
      customerId: 'cust-TEST-0001',
      status: 'active' as const,
      path: 'card',
      nextRunAt: '2026-11-01T00:00:00.000Z',
      createdAt: T,
      cancelledAt: null,
      pausedAt: null,
      stallReason: 'rail.unavailable',
    },
  ],
  team: [
    {
      memberId: U(71),
      userId: U(100),
      role: 'owner' as const,
      status: 'active' as const,
      label: 'Test owner',
      invitedBy: null,
      createdAt: T,
      activatedAt: T,
      removedAt: null,
    },
    {
      memberId: null,
      userId: U(101),
      role: 'finance' as const,
      status: 'invited' as const,
      label: null,
      invitedBy: U(100),
      createdAt: T2,
      activatedAt: null,
      removedAt: null,
    },
  ],
  webhooks: [
    {
      id: U(81),
      url: 'https://merchant.example.test/hooks',
      status: 'disabled' as const,
      disabledReason: 'too_many_failures',
      consecutiveFailures: 7,
      createdAt: T,
      updatedAt: T2,
    },
  ],
  deliveries: [
    {
      id: U(91),
      endpointId: U(81),
      eventType: 'payment.captured',
      status: 'dead' as const,
      attempts: 8,
      lastStatusCode: 503,
      createdAt: T,
      deliveredAt: null,
    },
  ],
  activity: [
    {
      id: 'act-TEST-1',
      occurredAt: T,
      actorId: U(100),
      action: 'team.invite',
      objectType: 'team' as const,
      objectId: U(101),
      detail: { role: 'finance' },
    },
  ],
  exports: [
    {
      jobId: U(95),
      kind: 'ledger_statement' as const,
      status: 'ready' as const,
      failureCode: null,
      fileName: 'statement-TEST.csv',
      sizeBytes: '20480',
      rowCount: 120,
      requestedBy: U(100),
      createdAt: T,
      completedAt: T2,
    },
  ],
};

const profile = {
  section: 'profile' as const,
  current: {
    merchantId: TEST_MERCHANT,
    displayName: 'TEST DATA Merchant',
    legalName: 'TEST DATA Merchant Ltd',
    status: 'active' as const,
    mode: 'psp' as const,
    kybStatus: 'approved' as const,
    kybRef: 'KYB-TEST-1',
    feeBps: null,
    starterFee: null,
  },
  items: [
    {
      seq: '2',
      fromStatus: 'pending' as const,
      toStatus: 'approved' as const,
      kybRef: 'KYB-TEST-1',
      decidedBy: 'intafaced' as const,
      reason: 'Documents checked (TEST DATA)',
      at: T2,
    },
    {
      seq: '1',
      fromStatus: 'none' as const,
      toStatus: 'pending' as const,
      kybRef: 'KYB-TEST-1',
      decidedBy: 'merchant' as const,
      reason: null,
      at: T,
    },
  ],
  nextCursor: null,
};

/** TEST DATA: payouts waiting for two founders, as `founderAdmin.approvals.list` returns them (masked destination only). */
export const APPROVAL_ID = U(300);
export const APPROVAL_FIRST_FOUNDER = U(104);
export const approvalsFixture = {
  approvals: [
    {
      approvalId: APPROVAL_ID,
      merchantId: TEST_MERCHANT,
      settlementId: U(21),
      amount: BIG,
      assetCode: 'USDT',
      payloadHash: `sha256:${'a'.repeat(64)}`,
      status: 'pending' as const,
      makerUserId: U(101),
      checkerUserId: U(102),
      createdAt: T,
      decidedAt: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
      railId: 'bank-test',
      destinationKind: 'bank',
      destinationMasked: '••••4821',
      founderFirstUserId: null,
    },
    {
      approvalId: U(301),
      merchantId: TEST_OTHER_MERCHANT,
      settlementId: U(22),
      amount: '100.00',
      assetCode: 'EUR',
      payloadHash: `sha256:${'b'.repeat(64)}`,
      status: 'pending' as const,
      makerUserId: U(101),
      checkerUserId: U(103),
      createdAt: T2,
      decidedAt: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
      railId: 'bank-test',
      destinationKind: 'bank',
      destinationMasked: '••••9917',
      founderFirstUserId: APPROVAL_FIRST_FOUNDER,
    },
  ],
  nextCursor: null,
};

/** TEST DATA: two tiers. The service returns `merchants` per tier, so the page shows a real count. */
export const tiersFixture = [
  {
    id: 'standard_test',
    name: 'TEST DATA Standard',
    archetype: 'standard',
    caps: [
      { kind: 'per_payment', assetCode: 'USDT', limit: BIG },
      { kind: 'daily_payout', assetCode: 'USDT', limit: '50000.00' },
      { kind: 'beneficiaries_per_day', limit: 20 },
    ],
    reserve: { rollingReserveBps: 500, holdDays: 7 },
    approvalThresholds: [{ assetCode: 'USDT', amount: '1000.00' }],
    founderThresholds: [{ assetCode: 'USDT', amount: '10000.00' }],
    approvalTtlSeconds: 86_400,
    merchantVisible: false,
    version: '3',
    merchants: 12,
  },
  {
    id: 'broker_test',
    name: 'TEST DATA Broker',
    archetype: 'broker',
    caps: [{ kind: 'monthly_intake', assetCode: 'EUR', limit: '1000000.00' }],
    reserve: null,
    approvalThresholds: [{ assetCode: 'EUR', amount: '5000.00' }],
    founderThresholds: [{ assetCode: 'EUR', amount: '25000.00' }],
    approvalTtlSeconds: 3600,
    merchantVisible: true,
    version: '1',
    merchants: 0,
  },
];

/** TEST DATA: open limit-increase asks. The second has caps the service could no longer read. */
export const limitRequestsFixture = {
  requests: [
    {
      requestId: U(400),
      merchantId: TEST_MERCHANT,
      caps: [
        { kind: 'daily_payout', assetCode: 'USDT', limit: BIG },
        { kind: 'beneficiaries_per_day', limit: 40 },
      ],
      reason: 'TEST DATA: seasonal volume',
      status: 'pending' as const,
      requestedBy: U(110),
      createdAt: T,
    },
    {
      requestId: U(401),
      merchantId: TEST_OTHER_MERCHANT,
      caps: { raw: { legacy: true }, capsReadable: false as const },
      reason: 'TEST DATA: unreadable caps',
      status: 'pending' as const,
      requestedBy: U(111),
      createdAt: T2,
    },
  ],
  nextCursor: '402',
};

/** TEST DATA: control audit rows, newest first. The first has a second approver and a money before/after. */
export const auditFixture = {
  entries: [
    {
      id: U(500),
      seq: '9007199254740993',
      scope: 'merchant' as const,
      scopeId: TEST_MERCHANT,
      merchantId: TEST_MERCHANT,
      kind: 'set_caps',
      outcome: 'changed',
      actorId: U(101),
      secondActorId: U(102),
      requestId: U(600),
      reason: 'TEST DATA: raise payout cap',
      before: { caps: [{ kind: 'daily_payout', assetCode: 'USDT', limit: '1000.00' }] },
      after: { caps: [{ kind: 'daily_payout', assetCode: 'USDT', limit: BIG }], destinationRef: 'DE00SECRETIBAN' },
      createdAt: T2,
    },
    {
      id: U(501),
      seq: '9007199254740992',
      scope: 'approval' as const,
      scopeId: APPROVAL_ID,
      merchantId: null,
      kind: 'payout.approval_voided',
      outcome: 'voided',
      actorId: 'system:payout_guard',
      secondActorId: null,
      requestId: null,
      reason: 'TEST DATA: amount, rail or destination changed after the request',
      before: null,
      after: null,
      createdAt: T,
    },
  ],
  nextCursor: '9007199254740992',
};

export type SectionFixtureName = keyof typeof rows | 'apiKeys' | 'profile';

/** One section page as the service returns it. `nextCursor` is null unless a test asks for a second page. */
export function sectionFixture(
  section: SectionFixtureName,
  over: { nextCursor?: string | null; items?: unknown[] } = {},
): Record<string, unknown> {
  if (section === 'apiKeys') return { section, catalog: 'not_configured', items: [], nextCursor: null };
  if (section === 'profile') return { ...profile, ...(over.nextCursor !== undefined ? { nextCursor: over.nextCursor } : {}) };
  return { section, items: over.items ?? rows[section], nextCursor: over.nextCursor ?? null };
}

export const recentFixture = {
  items: [
    {
      merchantId: TEST_MERCHANT,
      displayName: 'TEST DATA Merchant',
      legalName: 'TEST DATA Merchant Ltd',
      status: 'active',
      kybStatus: 'approved',
      createdAt: T,
    },
    { merchantId: TEST_OTHER_MERCHANT, displayName: null, legalName: null, status: 'pending', kybStatus: 'none', createdAt: T2 },
  ],
  nextCursor: null,
};

export const payoutsFixture = { items: rows.payouts, nextCursor: 'cursor-payouts-2' };
export const disputesFixture = { items: rows.disputes, nextCursor: null };

export const liveFixture = {
  asOf: '2026-10-17T07:00:00.000Z',
  h1: {
    payments: [
      { status: 'captured', count: 12 },
      { status: 'failed', count: 2 },
    ],
    payouts: [],
    refunds: [{ status: 'posted', count: 1 }],
  },
  h24: {
    payments: [
      { status: 'captured', count: 240 },
      { status: 'failed', count: 9 },
    ],
    payouts: [{ status: 'pending', count: 4 }],
    refunds: [],
  },
  queues: {
    oldestPendingApprovalAt: '2026-10-17T05:00:00.000Z',
    oldestPendingApprovalAgeSeconds: 7200,
    oldestPendingPayoutAt: null,
    oldestPendingPayoutAgeSeconds: null,
    earliestDisputeDeadlineAt: '2026-10-20T00:00:00.000Z',
  },
};

export const riskFixture = {
  window: null,
  projectedThrough: '2026-10-16',
  concentration: [
    {
      assetCode: 'USDT',
      totalCaptured: '1000.000000000000000001',
      topShare: '0.75',
      merchants: [
        { merchantId: TEST_MERCHANT, captured: '600.00', share: '0.6' },
        { merchantId: TEST_OTHER_MERCHANT, captured: '150.00', share: '0.15' },
      ],
    },
  ],
  failedWorkflows: {
    paymentsFailed: 9,
    payoutsFailed: 1,
    refundsReversed: 0,
    webhookDeliveriesFailed: 3,
    webhookDeliveriesDead: 2,
    exportsFailed: 0,
  },
};

export const pendingClearsFixture = {
  proposals: [
    {
      requestId: U(600),
      scope: 'payout',
      target: { level: 'global' },
      expectedVersion: '4',
      reason: 'Rail repaired, retesting (TEST DATA)',
      requestedByUserId: U(100),
      requestedAt: T,
    },
  ],
  nextCursor: null,
};

export const notesFixture = {
  items: [
    {
      noteId: U(701),
      merchantId: TEST_MERCHANT,
      body: 'Asked for a higher cap; hold until KYB refresh (TEST DATA)',
      tags: ['cap', 'watch'],
      flagged: true,
      authorId: U(100),
      createdAt: T,
      retractedAt: null,
      retractedBy: null,
      retractReason: null,
    },
    {
      noteId: U(702),
      merchantId: TEST_MERCHANT,
      body: 'Wrong merchant (TEST DATA)',
      tags: [],
      flagged: false,
      authorId: U(100),
      createdAt: T2,
      retractedAt: T2,
      retractedBy: U(100),
      retractReason: 'Written on the wrong merchant',
    },
  ],
  nextCursor: null,
};

/** The full set of sections, for tests that walk every one. */
export const ALL_SECTIONS = [
  'payments',
  'refunds',
  'disputes',
  'settlements',
  'payouts',
  'destinations',
  'customers',
  'links',
  'invoices',
  'subscriptions',
  'team',
  'apiKeys',
  'webhooks',
  'deliveries',
  'activity',
  'exports',
  'profile',
] as const satisfies readonly SectionFixtureName[];

type Handler = unknown | ((input: Record<string, unknown>) => unknown);

/**
 * A stand-in for svc-edge that answers the founder reads with the fixtures above. Pass overrides keyed by procedure name; a
 * function receives the parsed `input` and may return a `Response` to simulate an error.
 */
export function founderReadService(overrides: Record<string, Handler> = {}) {
  const seen: Array<{ procedure: string; input: Record<string, unknown> }> = [];
  const ok = (data: unknown) => Response.json({ result: { data } });
  const fetchImpl = async (url: string) => {
    const proc = decodeURIComponent(url.split('/trpc/')[1] ?? '').split('?')[0]!;
    const raw = new URL(url).searchParams.get('input');
    const input = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (proc === 'accountControls.operatorStatus') return ok({ status: 'enabled', userId: U(100), version: '1', changedAt: T });
    seen.push({ procedure: proc, input });
    const handler = proc in overrides ? overrides[proc] : undefined;
    if (handler !== undefined) {
      const value = typeof handler === 'function' ? (handler as (i: Record<string, unknown>) => unknown)(input) : handler;
      return value instanceof Response ? value : ok(value);
    }
    switch (proc) {
      case 'founderAdmin.merchants.section':
        return ok(sectionFixture(input.section as SectionFixtureName));
      case 'founderAdmin.merchants.recent':
        return ok(recentFixture);
      case 'founderAdmin.payouts.list':
        return ok(payoutsFixture);
      case 'founderAdmin.disputes.list':
        return ok(disputesFixture);
      case 'founderAdmin.live.summary':
        return ok(liveFixture);
      case 'founderAdmin.risk.summary':
        return ok(riskFixture);
      case 'payHalts.pendingClears':
        return ok(pendingClearsFixture);
      case 'founderAdmin.ops.notes.list':
        return ok(notesFixture);
      case 'founderAdmin.approvals.list':
        return ok(approvalsFixture);
      case 'founderAdmin.control.tiers.list':
        return ok(tiersFixture);
      case 'founderAdmin.control.limitRequests.list':
        return ok(limitRequestsFixture);
      case 'founderAdmin.control.audit.list':
        return ok(auditFixture);
      default:
        return Response.json(
          {
            error: {
              message: `pay.not_built: ${proc}`,
              data: { code: 'NOT_IMPLEMENTED', httpStatus: 501, cause: { code: 'pay.not_built' } },
            },
          },
          { status: 501 },
        );
    }
  };
  return { fetchImpl, seen };
}
