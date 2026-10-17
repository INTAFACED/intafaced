// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
import { NOT_MINE, DAY, MERCHANT_ID, USER_ID, iso, ok, page, refuse } from './shared.mjs';

const PERMISSIONS = [
  'team.read',
  'team.manage',
  'disputes.read',
  'disputes.respond',
  'invoices.read',
  'invoices.write',
  'customers.read',
  'kyb.read',
  'profile.read',
  'profile.manage',
  'exports.create',
  'exports.read',
  'notifications.read',
  'notifications.manage',
  'payments.read',
  'settlements.read',
  'halts.read',
  'payout.request',
  'payout.approve',
];
const READS = [
  'team.read',
  'disputes.read',
  'invoices.read',
  'customers.read',
  'kyb.read',
  'exports.read',
  'notifications.read',
  'payments.read',
  'settlements.read',
  'halts.read',
  'profile.read',
];
const HELD = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  finance: [...READS, 'disputes.respond', 'invoices.write', 'exports.create', 'notifications.manage', 'payout.request', 'payout.approve'],
  developer: [...READS, 'exports.create'],
  viewer: READS,
};
/** One flag per permission, as the service sends them. */
const capabilitiesFor = (role) => Object.fromEntries(PERMISSIONS.map((key) => [key, HELD[role].includes(key)]));

/** The account itself: who is signed in, the headline numbers, the halts, and the in-app notifications. */
export function createCoreMock(ctx) {
  const { scenario, now, state, activity, halted } = ctx;
  Object.assign(state, {
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
    role: ctx.role,
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
  });
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
      settlements: [
        { assetCode: 'USDT', gross: `${2400 * k}.5`, fees: `${36 * k}`, net: `${2364 * k}.5` },
        { assetCode: 'USD', gross: `${300 * k}`, fees: `${5 * k}`, net: `${295 * k}` },
      ],
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

  return {
    /** Returns NOT_MINE for a procedure this part does not own. */
    async handle(procedure, input, route) {
      switch (procedure) {
        case 'payHalts.status':
          return ok(route, {
            readable: true,
            states: halted
              ? [
                  {
                    scope: 'payout',
                    target: { level: 'merchant', merchantId: MERCHANT_ID },
                    halted: true,
                    changedAt: iso(now - 2 * 3600_000),
                  },
                ]
              : [],
          });
        case 'merchant.me':
          // Only the owner has a record of their own; a team member's read is empty.
          return ok(route, ctx.role === 'owner' ? state.merchant : null);
        case 'merchant.myAccess': {
          if (ctx.myAccess === 'off') return NOT_MINE;
          if (!state.merchant) return ok(route, { memberships: [] });
          const role = ctx.myAccess === 'payfac' ? 'owner' : ctx.myAccess === 'owner' ? 'owner' : ctx.myAccess;
          return ok(route, {
            memberships: [
              {
                merchantId: MERCHANT_ID,
                role,
                status: state.merchant.status,
                kybStatus: state.merchant.kybStatus,
                verified: state.merchant.kybStatus === 'approved',
                identityChangePending: false,
                sessionInteractive: true,
                mode: ctx.myAccess === 'payfac' ? 'payfac' : state.merchant.mode,
                displayName: 'TEST Coffee Co',
                legalName: 'TEST Coffee Company Ltd',
                capabilities: capabilitiesFor(role),
                pricingVisibility: role === 'viewer' || role === 'developer' ? 'fee_only' : 'full',
              },
            ],
          });
        }
        case 'railHealth':
          return ok(route, [
            { id: 'crypto-native', capabilities: ['authorize', 'payout'], mode: 'sandbox', usable: true, healthy: true, latencyMs: 14 },
            { id: 'card-sandbox', capabilities: ['authorize'], mode: 'sandbox', usable: true, healthy: true, latencyMs: 9 },
          ]);
        case 'merchantMetrics.snapshot':
          return ok(route, snapshot(input.window?.preset ?? 'today'));
        case 'merchantMetrics.series':
          return ok(route, series());
        case 'merchantOps.team.me':
          return scenario === 'new'
            ? refuse(route, 403, 'pay.merchant_ops_not_merchant')
            : ok(route, { merchantId: MERCHANT_ID, userId: USER_ID, role: state.role });
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
          return NOT_MINE;
      }
    },
  };
}
