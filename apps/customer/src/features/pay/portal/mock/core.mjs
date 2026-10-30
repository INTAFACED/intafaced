// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
import { NOT_MINE, DAY, MERCHANT_ID, TEAM, USER_ID, iso, ok, page, refuse, startOfDay } from './shared.mjs';
import { fromU, isTaken, toU } from './world.mjs';

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
  'activity.read',
  'payouts.read',
  'webhooks.read',
  'webhooks.manage',
  'products.read',
  'products.manage',
  'payments.unmask',
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
  'activity.read',
  'payouts.read',
  'products.read',
];
const HELD = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  finance: [
    ...READS,
    'disputes.respond',
    'invoices.write',
    'exports.create',
    'notifications.manage',
    'payout.request',
    'payout.approve',
    'payments.unmask',
  ],
  developer: [...READS, 'exports.create', 'webhooks.read', 'webhooks.manage', 'products.manage'],
  viewer: READS,
};
/** One flag per permission, as the service sends them. */
const capabilitiesFor = (role) => Object.fromEntries(PERMISSIONS.map((key) => [key, HELD[role].includes(key)]));

/** The service's permission catalogue (svc-pay merchant-plat-org-permission-catalogue.ts), rebuilt from the table above. */
const AREA_OF = {
  team: 'team',
  disputes: 'risk',
  invoices: 'payments',
  customers: 'payments',
  payments: 'payments',
  kyb: 'account',
  profile: 'account',
  notifications: 'account',
  exports: 'reports',
  activity: 'reports',
  settlements: 'money_out',
  halts: 'money_out',
  payout: 'money_out',
  payouts: 'money_out',
  webhooks: 'developer',
  products: 'payments',
};
const AREAS = ['payments', 'money_out', 'team', 'developer', 'reports', 'risk', 'account'];
const REQUIRES = {
  'team.manage': ['team.read'],
  'disputes.respond': ['disputes.read'],
  'invoices.write': ['invoices.read'],
  'profile.manage': ['profile.read'],
  'exports.create': ['exports.read'],
  'notifications.manage': ['notifications.read'],
  'payout.request': ['payouts.read'],
  'payout.approve': ['payouts.read'],
  'webhooks.manage': ['webhooks.read'],
  'products.manage': ['products.read'],
  'payments.unmask': ['payments.read'],
};
const ROLE_DESCRIPTION = {
  owner: 'TEST stand-in. The person who opened the merchant account. Can do everything.',
  admin: 'TEST stand-in. Can do everything the owner can, including managing the team.',
  finance: 'TEST stand-in. Reads, disputes, invoices, exports, notification settings and payouts.',
  developer: 'TEST stand-in. Reads, exports, webhooks and products.',
  viewer: 'TEST stand-in. Reads only.',
};
const isRead = (key) => key.endsWith('.read');
const areaOf = (key) => {
  const area = AREA_OF[key.split('.')[0]];
  if (!area) throw new Error(`stand-in catalogue: no area for ${key}`);
  return area;
};
export function catalogue() {
  const roles = Object.keys(HELD).map((role) => ({
    role,
    builtIn: true,
    editable: false,
    description: ROLE_DESCRIPTION[role],
    grants: PERMISSIONS.filter((key) => HELD[role].includes(key)),
  }));
  const areas = AREAS.map((area) => ({
    area,
    permissions: PERMISSIONS.filter((key) => areaOf(key) === area).map((key) => {
      const heldBy = roles.filter((r) => r.grants.includes(key)).map((r) => r.role);
      return { key, area, kind: isRead(key) ? 'read' : 'write', requires: REQUIRES[key] ?? [], heldBy, unheld: heldBy.length === 0 };
    }),
  })).filter((group) => group.permissions.length > 0);
  return { roles, areas };
}

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
            // The server marks the account's starting rate as a local TEST value (svc-pay starter-fee.ts).
            starterFee: scenario === 'quiet' ? null : { bps: 150, source: 'local_test' },
          },
    role: ctx.role,
    notifications: [
      {
        notificationId: 'n0000001-0000-4000-8000-000000000001',
        kind: 'dispute_opened',
        title: 'A customer challenged a payment',
        body: ctx.world.disputes[0] ? `TEST dispute for ${ctx.world.disputes[0].amount} ${ctx.world.disputes[0].assetId}` : null,
        subjectType: 'dispute',
        subjectId: 'd0000001-0000-4000-8000-000000000001',
        createdAt: ctx.world.disputes[0]?.openedAt ?? iso(now - 3 * DAY),
        readAt: null,
      },
      {
        notificationId: 'n0000002-0000-4000-8000-000000000002',
        kind: 'export_ready',
        title: 'Your payments export is ready',
        body: null,
        subjectType: 'export',
        subjectId: 'f1000000-0000-4000-8000-000000000001',
        createdAt: iso(now - 3600_000),
        readAt: null,
      },
      {
        notificationId: 'n0000003-0000-4000-8000-000000000003',
        kind: 'team_change',
        // named the way the Team page names them
        title: `${TEAM.developer.label} joined your team`,
        body: null,
        subjectType: null,
        subjectId: null,
        createdAt: iso(now - 20 * DAY),
        readAt: iso(now - 19 * DAY),
      },
    ],
    prefs: new Map(),
    prefChanges: [],
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
    'payout_destination',
  ];
  // Four seconds behind the moment it is asked, every time: a clock frozen at start-up would read hours behind later.
  const fresh = {
    get asOf() {
      return iso(Date.now() - 4000);
    },
    lagSeconds: 4,
  };
  const world = ctx.world;
  // The pages say "days are UTC days", and Analytics counts whole UTC days, so a window starts at midnight UTC: today is
  // since midnight, 7 days is today and the six before, 30 days is today and the 29 before. Paid in on Payments, Captured
  // on Home and Gross on Analytics are then the same figure for the same label.
  const WINDOW_START = {
    today: startOfDay(now),
    rolling_7d: startOfDay(now) - 6 * DAY,
    rolling_30d: startOfDay(now) - 29 * DAY,
  };
  /** Every figure on Home and in the metrics reads is worked out from the world's payments in the window. */
  const snapshot = (preset) => {
    const empty = {
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
    if (!activity) return empty;
    const f = world.figures(WINDOW_START[preset] ?? WINDOW_START.rolling_30d);
    return {
      merchantId: MERCHANT_ID,
      freshness: fresh,
      balances: world.assets.map((assetCode) => {
        const held = world.balance(assetCode);
        return { assetCode, clearing: fromU(held.clearing), available: fromU(held.proceeds) };
      }),
      paymentCount: f.count,
      statusMix: f.statusMix,
      captured: f.captured,
      refunded: f.refunded,
      net: f.net,
      settlements: f.settled,
      averagePayment: f.average,
      largestPayment: f.largest,
      linkUsage: f.links,
      feeRevenue: f.fees,
      conversionVolume: null,
    };
  };
  const series = (input) => {
    if (!activity) return { merchantId: MERCHANT_ID, freshness: fresh, points: [] };
    const from = input?.from ? Date.parse(input.from) : now - 30 * DAY;
    const to = input?.to ? Date.parse(input.to) : now;
    const byDay = new Map();
    for (const p of world.payments) {
      const at = Date.parse(p.createdAt);
      if (!isTaken(p.status) || at < from || at >= to) continue;
      const key = `${world.day(at)}|${p.assetId}`;
      const row = byDay.get(key) ?? { day: world.day(at), assetCode: p.assetId, volume: 0n, feeRevenue: 0n };
      row.volume += toU(p.capturedAmount);
      row.feeRevenue += toU(p.fee);
      byDay.set(key, row);
    }
    return {
      merchantId: MERCHANT_ID,
      freshness: fresh,
      points: [...byDay.values()]
        .sort((x, y) => x.day.localeCompare(y.day) || x.assetCode.localeCompare(y.assetCode))
        .map((r) => ({ day: r.day, assetCode: r.assetCode, volume: fromU(r.volume), feeRevenue: fromU(r.feeRevenue) })),
    };
  };

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
        case 'merchant.starterFee':
          // No fee has been published for new accounts, so none is invented.
          return ok(route, { starterFee: null });
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
                displayName: 'TEST Shop',
                legalName: 'TEST Shop Ltd',
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
          return ok(route, series(input));
        case 'merchantOps.team.me':
          return scenario === 'new'
            ? refuse(route, 403, 'pay.merchant_ops_not_merchant')
            : ok(route, { merchantId: MERCHANT_ID, userId: USER_ID, role: state.role });
        case 'merchantOps.permissions.catalogue':
          return scenario === 'new' ? refuse(route, 403, 'pay.merchant_ops_not_merchant') : ok(route, catalogue());
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
              updatedBy: state.prefs.get(kind)?.updatedBy ?? null,
              updatedAt: state.prefs.get(kind)?.updatedAt ?? null,
            })),
          );
        case 'merchantOps.notifications.preferences.set': {
          const saved = { inApp: input.inApp, threshold: input.threshold ?? null, updatedBy: USER_ID, updatedAt: iso(Date.now()) };
          state.prefs.set(input.kind, saved);
          state.prefChanges.unshift({
            seq: String(state.prefChanges.length + 1),
            kind: input.kind,
            inApp: saved.inApp,
            threshold: saved.threshold,
            actorId: USER_ID,
            createdAt: saved.updatedAt,
          });
          return ok(route, { kind: input.kind, ...saved });
        }
        case 'merchantOps.notifications.preferences.history':
          return ok(route, page(state.prefChanges, input));
        default:
          return NOT_MINE;
      }
    },
  };
}
