// Browser mock of the pay service for the merchant portal's Playwright run and screenshots.
// EVERYTHING HERE IS TEST DATA. No real merchant, customer, amount or id. Refs are prefixed TEST so they cannot be mistaken for real ones.

const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
export const USER_ID = '22222222-2222-4222-8222-222222222222';
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

const refuse = (route, status, code, message = code) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { message, data: { cause: { code } } } }) });
const ok = (route, data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data } }) });

function page(items, input) {
  const start = input.cursor ? Number(Buffer.from(input.cursor, 'base64url').toString('utf8')) : 0;
  const limit = input.limit ?? 25;
  const slice = items.slice(start, start + limit);
  const next = start + limit < items.length ? Buffer.from(String(start + limit)).toString('base64url') : null;
  return { items: slice, nextCursor: next };
}

/**
 * scenario: 'active' (verified merchant with activity), 'new' (no merchant), 'quiet' (merchant, no activity yet),
 * 'soon' (operations service not switched on), 'down' (service unreachable).
 */
export function createPortalMock(scenario = 'active', { now = Date.now() } = {}) {
  const calls = [];
  const state = {
    merchant:
      scenario === 'new'
        ? null
        : {
            id: MERCHANT_ID,
            userId: USER_ID,
            mode: 'gateway',
            status: scenario === 'quiet' ? 'pending' : 'active',
            kybStatus: scenario === 'quiet' ? 'none' : 'approved',
            kybRef: scenario === 'quiet' ? null : 'TEST-dossier-001',
            feeBps: scenario === 'quiet' ? null : 150,
          },
    role: 'owner',
    members: [
      {
        memberId: null,
        userId: USER_ID,
        role: 'owner',
        status: 'active',
        label: null,
        invitedBy: null,
        createdAt: iso(now - 90 * DAY),
        activatedAt: iso(now - 90 * DAY),
        removedAt: null,
        cursor: null,
      },
      {
        memberId: 'a1111111-1111-4111-8111-111111111111',
        userId: 'TEST-user-finance',
        role: 'finance',
        status: 'active',
        label: 'TEST Accounts',
        invitedBy: USER_ID,
        createdAt: iso(now - 40 * DAY),
        activatedAt: iso(now - 39 * DAY),
        removedAt: null,
        cursor: 'c1',
      },
      {
        memberId: 'a2222222-2222-4222-8222-222222222222',
        userId: 'TEST-user-dev',
        role: 'developer',
        status: 'active',
        label: 'TEST Dev',
        invitedBy: USER_ID,
        createdAt: iso(now - 20 * DAY),
        activatedAt: iso(now - 20 * DAY),
        removedAt: null,
        cursor: 'c2',
      },
      {
        memberId: 'a3333333-3333-4333-8333-333333333333',
        userId: 'TEST-user-pending',
        role: 'viewer',
        status: 'invited',
        label: null,
        invitedBy: USER_ID,
        createdAt: iso(now - 1 * DAY),
        activatedAt: null,
        removedAt: null,
        cursor: 'c3',
      },
    ],
    teamHistory: [
      {
        seq: '3',
        memberUserId: 'TEST-user-pending',
        action: 'invited',
        fromRole: null,
        toRole: 'viewer',
        actorId: USER_ID,
        createdAt: iso(now - 1 * DAY),
      },
      {
        seq: '2',
        memberUserId: 'TEST-user-dev',
        action: 'accepted',
        fromRole: null,
        toRole: 'developer',
        actorId: 'TEST-user-dev',
        createdAt: iso(now - 20 * DAY),
      },
      {
        seq: '1',
        memberUserId: 'TEST-user-finance',
        action: 'role_changed',
        fromRole: 'viewer',
        toRole: 'finance',
        actorId: USER_ID,
        createdAt: iso(now - 38 * DAY),
      },
    ],
    invitations:
      scenario === 'new'
        ? [
            {
              memberId: 'b1111111-1111-4111-8111-111111111111',
              merchantId: '99999999-9999-4999-8999-999999999999',
              role: 'developer',
              invitedAt: iso(now - 2 * DAY),
            },
          ]
        : [],
    kyb: {
      kybStatus: scenario === 'quiet' ? 'none' : 'approved',
      kybRef: scenario === 'quiet' ? null : 'TEST-dossier-001',
      mode: 'gateway',
    },
    kybHistory:
      scenario === 'quiet'
        ? []
        : [
            {
              seq: '2',
              fromStatus: 'pending',
              toStatus: 'approved',
              kybRef: 'TEST-dossier-001',
              decidedBy: 'intafaced',
              reason: null,
              at: iso(now - 80 * DAY),
            },
            {
              seq: '1',
              fromStatus: 'none',
              toStatus: 'pending',
              kybRef: 'TEST-dossier-001',
              decidedBy: 'merchant',
              reason: null,
              at: iso(now - 85 * DAY),
            },
          ],
    disputes: [
      {
        disputeId: 'd0000001-0000-4000-8000-000000000001',
        paymentId: 'p0000001-0000-4000-8000-000000000001',
        amount: '49.99',
        assetId: 'USDT',
        reasonCode: 'fraudulent',
        status: 'open',
        openedAt: iso(now - 3 * DAY),
        contestedAt: null,
        closedAt: null,
        responseDueAt: null,
        ledgerWire: 'refused',
        ledgerRefuseCode: 'pay.chargeback_wire_absent',
      },
      {
        disputeId: 'd0000002-0000-4000-8000-000000000002',
        paymentId: 'p0000002-0000-4000-8000-000000000002',
        amount: '120',
        assetId: 'USDT',
        reasonCode: 'product_not_received',
        status: 'contested',
        openedAt: iso(now - 9 * DAY),
        contestedAt: iso(now - 7 * DAY),
        closedAt: null,
        responseDueAt: null,
        ledgerWire: 'refused',
        ledgerRefuseCode: 'pay.chargeback_wire_absent',
      },
      {
        disputeId: 'd0000003-0000-4000-8000-000000000003',
        paymentId: 'p0000003-0000-4000-8000-000000000003',
        amount: '15.5',
        assetId: 'USDT',
        reasonCode: null,
        status: 'won',
        openedAt: iso(now - 30 * DAY),
        contestedAt: iso(now - 28 * DAY),
        closedAt: iso(now - 20 * DAY),
        responseDueAt: null,
        ledgerWire: 'refused',
        ledgerRefuseCode: 'pay.chargeback_wire_absent',
      },
    ],
    evidence: {
      'd0000002-0000-4000-8000-000000000002': [
        {
          evidenceId: 'e1',
          kind: 'shipping_proof',
          fileName: 'TEST-tracking.pdf',
          contentType: 'application/pdf',
          sizeBytes: '48213',
          sha256: 'ab'.repeat(32),
          note: 'TEST tracking page',
          addedBy: USER_ID,
          createdAt: iso(now - 8 * DAY),
        },
      ],
    },
    responses: {
      'd0000002-0000-4000-8000-000000000002': [
        {
          responseId: 'r1',
          action: 'contest',
          note: null,
          resultingStatus: 'contested',
          evidenceCount: 1,
          respondedBy: USER_ID,
          createdAt: iso(now - 7 * DAY),
        },
      ],
    },
    customers: Array.from({ length: 30 }, (_, i) => ({
      customerRef: `TEST-cust-${String(30 - i).padStart(3, '0')}`,
      paymentCount: 1 + (i % 5),
      subscriptionCount: i % 7 === 0 ? 1 : 0,
      mandateCount: 0,
      firstSeenAt: iso(now - (60 - i) * DAY),
      lastSeenAt: iso(now - i * DAY),
      totals: [
        { assetId: 'USDT', capturedAmount: `${100 + i * 12}.5`, refundedAmount: i % 6 === 0 ? '10' : '0', paymentCount: 1 + (i % 5) },
      ],
    })),
    exports: [
      {
        jobId: 'f0000001-0000-4000-8000-000000000001',
        kind: 'payments',
        filters: { from: iso(now - 30 * DAY).slice(0, 10) + 'T00:00:00.000Z', status: 'captured' },
        status: 'ready',
        failureCode: null,
        fileName: 'payments.csv',
        sizeBytes: '20480',
        rowCount: 312,
        sha256: 'cd'.repeat(32),
        requestedBy: USER_ID,
        asOf: iso(now - 3600_000),
        expiresAt: null,
        createdAt: iso(now - 3600_000),
        completedAt: iso(now - 3590_000),
      },
      {
        jobId: 'f0000002-0000-4000-8000-000000000002',
        kind: 'settlements',
        filters: {},
        status: 'failed',
        failureCode: 'pay.export_failed',
        fileName: null,
        sizeBytes: null,
        rowCount: null,
        sha256: null,
        requestedBy: USER_ID,
        asOf: null,
        expiresAt: null,
        createdAt: iso(now - 2 * DAY),
        completedAt: iso(now - 2 * DAY),
      },
    ],
    notifications: [
      {
        notificationId: 'n0000001-0000-4000-8000-000000000001',
        kind: 'dispute_opened',
        title: 'A customer challenged a payment',
        body: 'TEST dispute for 49.99 USDT',
        subjectType: 'dispute',
        subjectId: 'd0000001-0000-4000-8000-000000000001',
        createdAt: iso(now - 3 * DAY),
        readAt: null,
      },
      {
        notificationId: 'n0000002-0000-4000-8000-000000000002',
        kind: 'export_ready',
        title: 'Your payments export is ready',
        body: null,
        subjectType: 'export',
        subjectId: 'f0000001-0000-4000-8000-000000000001',
        createdAt: iso(now - 3600_000),
        readAt: null,
      },
      {
        notificationId: 'n0000003-0000-4000-8000-000000000003',
        kind: 'team_change',
        title: 'TEST-user-dev joined your team',
        body: null,
        subjectType: null,
        subjectId: null,
        createdAt: iso(now - 20 * DAY),
        readAt: iso(now - 19 * DAY),
      },
    ],
    prefs: new Map(),
    destination: null,
  };
  const KINDS = [
    'payout_awaiting_approval',
    'settlement_failed',
    'payout_failed',
    'limit_threshold',
    'dispute_opened',
    'dispute_due',
    'webhook_failing',
    'operator_pause',
    'export_ready',
    'team_change',
  ];
  const fresh = { asOf: iso(now - 4000), lagSeconds: 4 };
  const activity = scenario === 'active';
  const snapshot = (preset) => {
    const k = preset === 'today' ? 1 : preset === 'rolling_7d' ? 6 : 24;
    if (!activity)
      return {
        merchantId: MERCHANT_ID,
        freshness: fresh,
        balances: [],
        paymentCount: 0,
        statusMix: [],
        captured: [],
        refunded: [],
        net: [],
        settlements: [],
        averagePayment: [],
        largestPayment: [],
        linkUsage: { linksUsed: 0, paymentsViaLinks: 0 },
        feeRevenue: [],
        conversionVolume: null,
      };
    return {
      merchantId: MERCHANT_ID,
      freshness: fresh,
      balances: [
        { assetCode: 'USDT', clearing: '240.75', available: '8123.456789' },
        { assetCode: 'USD', clearing: '0', available: '512.4' },
      ],
      paymentCount: 9 * k,
      statusMix: [
        { status: 'captured', count: 7 * k },
        { status: 'settled', count: 4 * k },
        { status: 'refunded', count: k },
        { status: 'disputed', count: 1 },
        { status: 'failed', count: k },
      ],
      captured: [
        { assetCode: 'USDT', amount: `${1250 * k}.75` },
        { assetCode: 'USD', amount: `${80 * k}` },
      ],
      refunded: [{ assetCode: 'USDT', amount: `${20 * k}` }],
      net: [
        { assetCode: 'USDT', amount: `${1230 * k}.75` },
        { assetCode: 'USD', amount: `${80 * k}` },
      ],
      settlements: [],
      averagePayment: [
        { assetCode: 'USDT', amount: '138.97' },
        { assetCode: 'USD', amount: '26.5' },
      ],
      largestPayment: [
        { assetCode: 'USDT', amount: '900' },
        { assetCode: 'USD', amount: '75' },
      ],
      linkUsage: { linksUsed: 3, paymentsViaLinks: 4 * k },
      feeRevenue: [{ assetCode: 'USDT', amount: `${18.75 * k}`.replace(/(\.\d{0,2}).*/, '$1') }],
      conversionVolume: null,
    };
  };
  const series = () => ({
    merchantId: MERCHANT_ID,
    freshness: fresh,
    points: activity
      ? Array.from({ length: 30 }, (_, i) => {
          const day = new Date(now - (29 - i) * DAY).toISOString().slice(0, 10);
          return {
            day,
            assetCode: 'USDT',
            volume: i % 9 === 4 ? '0' : `${300 + ((i * 137) % 900)}.${(i * 7) % 100}`.replace(/\.(\d)$/, '.0$1'),
            feeRevenue: '3.1',
          };
        })
      : [],
  });

  async function handle(route) {
    const url = new URL(route.request().url());
    const procedure = decodeURIComponent(url.pathname.split('/trpc/')[1] ?? '');
    const method = route.request().method();
    const input = method === 'GET' ? (JSON.parse(url.searchParams.get('input') ?? 'null') ?? {}) : (route.request().postDataJSON() ?? {});
    calls.push({ procedure, method, input });
    if (scenario === 'down') return refuse(route, 503, '', 'Service unavailable');
    if (scenario === 'soon' && (procedure.startsWith('merchantOps.') || procedure.startsWith('merchantMetrics.')))
      return refuse(route, 501, 'pay.not_built', 'pay.not_built: not built yet');
    const mine = state.members;
    switch (procedure) {
      case 'merchant.me':
        return ok(route, state.merchant);
      case 'railHealth':
        return ok(route, [
          { id: 'crypto-native', capabilities: ['authorize', 'payout'], mode: 'sandbox', usable: true, healthy: true, latencyMs: 14 },
          { id: 'card-sandbox', capabilities: ['authorize'], mode: 'sandbox', usable: true, healthy: true, latencyMs: 9 },
        ]);
      case 'merchantMetrics.snapshot':
        return ok(route, snapshot(input.window?.preset ?? 'today'));
      case 'merchantMetrics.series':
        return ok(route, series());
      case 'merchant.create':
        state.merchant = {
          id: MERCHANT_ID,
          userId: USER_ID,
          mode: 'gateway',
          status: 'pending',
          kybStatus: 'none',
          kybRef: null,
          feeBps: input.pricing.feeBps,
        };
        state.kyb = { kybStatus: 'none', kybRef: null, mode: 'gateway' };
        return ok(route, { id: MERCHANT_ID, userId: USER_ID, mode: 'gateway', feeBps: input.pricing.feeBps });
      case 'merchant.submitKyb':
        state.merchant = { ...state.merchant, kybStatus: 'pending', kybRef: input.kybRef };
        state.kyb = { kybStatus: 'pending', kybRef: input.kybRef, mode: 'gateway' };
        state.kybHistory.unshift({
          seq: String(state.kybHistory.length + 1),
          fromStatus: 'none',
          toStatus: 'pending',
          kybRef: input.kybRef,
          decidedBy: 'merchant',
          reason: null,
          at: iso(Date.now()),
        });
        return ok(route, { id: MERCHANT_ID, kybStatus: 'pending', kybRef: input.kybRef });
      case 'merchant.setPayoutDestination':
        state.destination = { kind: input.kind, ref: input.ref, railId: input.railId };
        return ok(route, state.destination);
      case 'merchantOps.kyb.current':
        return ok(route, state.kyb);
      case 'merchantOps.kyb.history':
        return ok(route, page(state.kybHistory, input));
      case 'merchantOps.team.me':
        return scenario === 'new'
          ? refuse(route, 403, 'pay.merchant_ops_not_merchant')
          : ok(route, { merchantId: MERCHANT_ID, userId: USER_ID, role: state.role });
      case 'merchantOps.team.list':
        return ok(route, page(input.status ? mine.filter((m) => m.status === input.status) : mine, input));
      case 'merchantOps.team.history':
        return ok(route, page(state.teamHistory, input));
      case 'merchantOps.team.myInvitations':
        return ok(route, state.invitations);
      case 'merchantOps.team.invite': {
        const row = {
          memberId: `c${mine.length}000000-0000-4000-8000-000000000000`,
          userId: input.userId,
          role: input.role,
          status: 'invited',
          label: input.label ?? null,
          invitedBy: USER_ID,
          createdAt: iso(Date.now()),
          activatedAt: null,
          removedAt: null,
          cursor: `c${mine.length}`,
        };
        mine.push(row);
        state.teamHistory.unshift({
          seq: String(state.teamHistory.length + 1),
          memberUserId: input.userId,
          action: 'invited',
          fromRole: null,
          toRole: input.role,
          actorId: USER_ID,
          createdAt: row.createdAt,
        });
        return ok(route, row);
      }
      case 'merchantOps.team.changeRole': {
        const row = mine.find((m) => m.memberId === input.memberId);
        if (!row) return refuse(route, 404, 'pay.team_member_not_found');
        state.teamHistory.unshift({
          seq: String(state.teamHistory.length + 1),
          memberUserId: row.userId,
          action: 'role_changed',
          fromRole: row.role,
          toRole: input.role,
          actorId: USER_ID,
          createdAt: iso(Date.now()),
        });
        row.role = input.role;
        return ok(route, row);
      }
      case 'merchantOps.team.remove': {
        const row = mine.find((m) => m.memberId === input.memberId);
        if (!row) return refuse(route, 404, 'pay.team_member_not_found');
        row.status = 'removed';
        return ok(route, row);
      }
      case 'merchantOps.team.acceptInvite':
        state.invitations = [];
        return ok(route, { ...mine[1], status: 'active' });
      case 'merchantOps.team.declineInvite':
        state.invitations = [];
        return ok(route, { declined: true });
      case 'merchantOps.disputes.summary': {
        const by = { open: 0, contested: 0, accepted: 0, won: 0, lost: 0 };
        for (const d of state.disputes) by[d.status] += 1;
        return ok(route, { total: state.disputes.length, byStatus: by, amountAtRisk: [{ assetId: 'USDT', amount: '169.99' }] });
      }
      case 'merchantOps.disputes.list':
        return ok(route, page(input.status ? state.disputes.filter((d) => d.status === input.status) : state.disputes, input));
      case 'merchantOps.disputes.get': {
        const d = state.disputes.find((x) => x.disputeId === input.disputeId);
        if (!d) return refuse(route, 404, 'pay.dispute_not_found');
        return ok(route, {
          ...d,
          canRespond: d.status === 'open' || d.status === 'contested',
          evidence: state.evidence[d.disputeId] ?? [],
          responses: state.responses[d.disputeId] ?? [],
          payment: { paymentId: d.paymentId, status: 'disputed', assetId: d.assetId, amount: d.amount, createdAt: iso(now - 12 * DAY) },
        });
      }
      case 'merchantOps.disputes.addEvidence': {
        const row = {
          evidenceId: `e${Date.now()}`,
          kind: input.kind,
          fileName: input.fileName,
          contentType: input.contentType,
          sizeBytes: String(input.sizeBytes),
          sha256: input.sha256,
          note: input.note ?? null,
          addedBy: USER_ID,
          createdAt: iso(Date.now()),
        };
        (state.evidence[input.disputeId] ??= []).push(row);
        return ok(route, row);
      }
      case 'merchantOps.disputes.respond': {
        const d = state.disputes.find((x) => x.disputeId === input.disputeId);
        if (input.action === 'contest' && !(state.evidence[input.disputeId] ?? []).length)
          return refuse(route, 412, 'pay.dispute_evidence_required');
        d.status = input.action === 'contest' ? 'contested' : 'accepted';
        (state.responses[input.disputeId] ??= []).push({
          responseId: `r${Date.now()}`,
          action: input.action,
          note: input.note ?? null,
          resultingStatus: d.status,
          evidenceCount: (state.evidence[input.disputeId] ?? []).length,
          respondedBy: USER_ID,
          createdAt: iso(Date.now()),
        });
        return ok(route, {
          ...d,
          canRespond: d.status === 'contested',
          evidence: state.evidence[input.disputeId] ?? [],
          responses: state.responses[input.disputeId],
          payment: null,
        });
      }
      case 'merchantOps.customers.summary':
        return ok(route, {
          customerCount: state.customers.length,
          activeSinceCount: 18,
          repeatCustomerCount: 22,
          activeSince: input.activeSince,
        });
      case 'merchantOps.customers.list': {
        const rows = input.search
          ? state.customers.filter((c) => c.customerRef.toLowerCase().startsWith(input.search.toLowerCase()))
          : state.customers;
        return ok(route, page(rows, input));
      }
      case 'merchantOps.customers.get': {
        const c = state.customers.find((x) => x.customerRef === input.customerRef);
        if (!c) return refuse(route, 404, 'pay.customer_not_found');
        return ok(route, {
          ...c,
          recentPayments: Array.from({ length: 5 }, (_, i) => ({
            paymentId: `${i}0000000-aaaa-4bbb-8ccc-dddddddddddd`,
            status: i === 1 ? 'refunded' : 'captured',
            assetId: 'USDT',
            amount: `${40 + i * 15}.25`,
            createdAt: iso(now - (i + 1) * 3 * DAY),
          })),
        });
      }
      case 'merchantOps.exports.list':
        return ok(
          route,
          page(
            state.exports.filter((e) => (!input.kind || e.kind === input.kind) && (!input.status || e.status === input.status)),
            input,
          ),
        );
      case 'merchantOps.exports.create': {
        const job = {
          jobId: `f${state.exports.length}000000-0000-4000-8000-000000000000`,
          kind: input.kind,
          filters: input.filters ?? {},
          status: 'queued',
          failureCode: null,
          fileName: null,
          sizeBytes: null,
          rowCount: null,
          sha256: null,
          requestedBy: USER_ID,
          asOf: null,
          expiresAt: null,
          createdAt: iso(Date.now()),
          completedAt: null,
        };
        state.exports.unshift(job);
        setTimeout(
          () =>
            Object.assign(job, {
              status: 'ready',
              fileName: `${input.kind}.csv`,
              sizeBytes: '1024',
              rowCount: 12,
              sha256: 'ef'.repeat(32),
              asOf: iso(Date.now()),
              completedAt: iso(Date.now()),
            }),
          1500,
        );
        return ok(route, job);
      }
      case 'merchantOps.exports.download':
        return ok(route, {
          fileName: 'payments.csv',
          contentType: 'text/csv; charset=utf-8',
          content: 'id,amount,asset\nTEST-1,10.5,USDT\n',
          sha256: 'cd'.repeat(32),
          rowCount: 1,
        });
      case 'merchantOps.notifications.list':
        return ok(
          route,
          page(
            state.notifications.filter((n) => (!input.unreadOnly || !n.readAt) && (!input.kind || n.kind === input.kind)),
            input,
          ),
        );
      case 'merchantOps.notifications.unreadCount':
        return ok(route, { unread: state.notifications.filter((n) => !n.readAt).length });
      case 'merchantOps.notifications.markRead':
        for (const n of state.notifications) if (input.notificationIds.includes(n.notificationId)) n.readAt = iso(Date.now());
        return ok(route, { marked: input.notificationIds.length });
      case 'merchantOps.notifications.markAllRead': {
        const n = state.notifications.filter((x) => !x.readAt);
        for (const x of n) x.readAt = iso(Date.now());
        return ok(route, { marked: n.length });
      }
      case 'merchantOps.notifications.preferences.list':
        return ok(
          route,
          KINDS.map((kind) => ({
            kind,
            inApp: state.prefs.get(kind)?.inApp ?? true,
            threshold: state.prefs.get(kind)?.threshold ?? null,
            updatedAt: null,
          })),
        );
      case 'merchantOps.notifications.preferences.set':
        state.prefs.set(input.kind, { inApp: input.inApp, threshold: input.threshold ?? null });
        return ok(route, { kind: input.kind, inApp: input.inApp, threshold: input.threshold ?? null, updatedAt: iso(Date.now()) });
      default:
        return refuse(route, 404, '', `No procedure ${procedure}`);
    }
  }
  return {
    calls,
    state,
    async install(page) {
      await page.route('**/api/pay/trpc/**', handle);
    },
  };
}
