// TEST DATA ONLY. Nothing here is a real merchant, customer, amount or id.
//
// ONE coherent fixture world for the whole stand-in. Every page's numbers are worked out from the same list of
// payments, so the headline figures, the lists, the statements, the fees, the customers and the refunds can never
// disagree. Nothing in a page's own mock invents a total: it asks the world.
//
// The rules the world follows (`world.test.mjs` checks them, and fails the day one of them stops being true):
//   - The fee on a payment is 1.5% plus 0.30, rounded up to the asset's smallest unit (USDT 6 places, USD 2).
//   - A settlement is exactly the payments that say they were settled in it: gross, fees and net are sums of those.
//   - A refund is a refunded payment: the payment, the refund list, the headline "refunded" and the fees page agree.
//   - A customer's lifetime totals are the sum of that customer's payments, so a lifetime figure is never smaller
//     than the same customer's last-30-days figure.
//   - A payout line appears in the statement only when its settlement was actually paid out.
//   - There is one list of payout destinations, and every page that names a destination names one of them.
import { DAY, MERCHANT_ID, USER_ID, hex, iso } from './ids.mjs';

// ---- exact decimal arithmetic: amounts are whole micro-units (6 places), never floats ------------------------------
const U = 1_000_000n;
export const SCALE = { USDT: 6, USD: 2 };
export const RULE = { feeBps: 150, flatFee: '0.30' };

export const toU = (value) => {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole || '0') * U + BigInt(fraction.padEnd(6, '0').slice(0, 6));
};
/** Back to a decimal string with at least `min` places and no more than six: "47.13", "1.00695", "120.00". */
export const fromU = (units, min = 2) => {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  let fraction = (abs % U).toString().padStart(6, '0').replace(/0+$/, '');
  while (fraction.length < min) fraction += '0';
  return `${negative ? '-' : ''}${abs / U}${fraction ? `.${fraction}` : ''}`;
};
const unitOf = (asset) => 10n ** BigInt(6 - (SCALE[asset] ?? 6));
const ceilTo = (value, unit) => ((value + unit - 1n) / unit) * unit;
/** The fee rule, in micro-units: 1.5% rounded up to the asset's smallest unit, plus 0.30. */
export const feeUnits = (amount, asset) =>
  ceilTo((toU(amount) * BigInt(RULE.feeBps) + 9_999n) / 10_000n, unitOf(asset)) + toU(RULE.flatFee);
export const feeFor = (amount, asset) => fromU(feeUnits(amount, asset));
export const sum = (values) => values.reduce((total, value) => total + value, 0n);

export const PAYMENT_COUNT = 135;
const SPACING = 8 * 3600_000;
const TAKEN = ['captured', 'settled', 'refunded', 'disputed'];
export const isTaken = (status) => TAKEN.includes(status);

const BASE_STATUS = ['captured', 'settled', 'captured', 'refunded', 'failed', 'settled', 'authorized', 'captured', 'disputed', 'created'];
/** Which payments get the rarer outcomes. Everything else that would be refunded or disputed is a plain capture. */
const REFUNDED = new Set([3, 13]);
const REVERSED_REFUND = 23;
const DISPUTED = new Map([
  [8, 'open'],
  [18, 'contested'],
  [28, 'won'],
]);
/** The first charge of each of the four subscriptions is a real payment: payment 120 + i belongs to customer i + 1. */
const SUBSCRIPTION_CHARGE = (n) => (n >= 120 && n <= 123 ? n - 120 : -1);
const statusFor = (n) => {
  if (SUBSCRIPTION_CHARGE(n) >= 0) return 'captured';
  if (DISPUTED.has(n)) return DISPUTED.get(n) === 'won' ? 'settled' : 'disputed';
  const base = BASE_STATUS[n % 10];
  if (base === 'refunded') return REFUNDED.has(n) ? 'refunded' : 'captured';
  if (base === 'disputed') return 'captured';
  return base;
};

// Settlements, newest first: [short id, window label, asset, status]. Oldest group of payments goes to the oldest one.
const SETTLEMENTS = [
  ['bb000006', 'TEST-2026-W41', 'USDT', 'posted'],
  ['bb000005', 'TEST-2026-W40b', 'USD', 'failed'],
  ['bb000004', 'TEST-2026-W41b', 'USDT', 'posted'],
  ['bb000003', 'TEST-2026-W40a', 'USDT', 'posted'],
  ['bb000002', 'TEST-2026-W40', 'USDT', 'paid_out'],
  ['bb000001', 'TEST-2026-W39', 'USDT', 'paid_out'],
];
/** Hours after a statement is finalised that a paid-out settlement was sent (the approval rounds happen in between). */
export const PAYOUT_SENT_AFTER = 21 * 3600_000;
const USDT_GROUP_SIZES = { bb000001: 5, bb000002: 5, bb000003: 5, bb000004: 5, bb000006: 3 };

export const DESTINATIONS = [
  {
    id: 'dd100001-0000-4000-8000-000000000001',
    railId: 'crypto-native',
    kind: 'crypto',
    destinationMasked: '0x7a3f…4421',
    ageDays: 30,
    usedDaysAgo: 9,
  },
  {
    id: 'dd100002-0000-4000-8000-000000000002',
    railId: 'card-sandbox',
    kind: 'bank',
    destinationMasked: '••••8821',
    ageDays: 12,
    usedDaysAgo: null,
  },
];

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Builds the world for one stand-in. `activity` is false for a new or quiet account: every list is then empty. */
export function buildWorld(ctx) {
  const { now, activity } = ctx;
  const world = {
    now,
    rule: RULE,
    destinations: [],
    payments: [],
    settlements: [],
    refunds: [],
    disputes: [],
    customers: [],
    links: [],
    mandates: [],
    subscriptions: [],
    assets: ['USDT', 'USD'],
    day,
  };
  world.paymentById = () => undefined;
  world.settlementById = (id) => world.settlements.find((s) => s.id === id);
  world.customerByRef = (ref) => world.customers.find((c) => c.customerRef === ref);
  world.executionsOf = () => [];
  world.cyclesOf = () => [];
  world.destinations = DESTINATIONS.map((d) => ({
    id: d.id,
    merchantId: MERCHANT_ID,
    railId: d.railId,
    kind: d.kind,
    destinationMasked: d.destinationMasked,
    screeningState: 'not_recorded',
    defaultFlag: 'unset',
    createdAt: iso(now - d.ageDays * DAY),
    lastUsedAt: d.usedDaysAgo === null ? null : iso(now - d.usedDaysAgo * DAY),
    // Verified long ago: active (J-merchant-02 #5).
    state: 'active',
    activatesAt: null,
  }));
  if (activity) populate(world, now);
  attachAggregates(world, now);
  return world;
}

function populate(world, now) {
  // ---- links: eight, two kinds (fixed 25.00 USDT, or any amount); the payments below say which one they came through
  world.links = Array.from({ length: 8 }, (_, i) => ({
    id: hex('1c', i + 1),
    prefix: `TESTl${i + 1}`,
    label: `TEST link ${i + 1}`,
    amount: i % 2 ? '25.00' : null,
    currency: i % 2 ? 'USDT' : null,
    active: i !== 3,
    expiresAt: iso(now + (i === 5 ? -2 : 20) * DAY),
    maxUses: i % 3 === 0 ? 10 : null,
    uses: 0,
    createdAt: iso(now - (50 + i) * DAY),
    // The address the link takes a payer to. The real service will hand this back to the owner; the portal shows it
    // when the field is present.
    checkoutUrl: `/api/pay/checkout?token=TEST-token-TESTl${i + 1}`,
  }));
  const openLinks = [0, 2, 4, 6];
  const fixedLinks = [1, 3, 5, 7];

  // ---- payments, newest first ---------------------------------------------------------------------------------------
  world.payments = Array.from({ length: PAYMENT_COUNT }, (_, i) => {
    const n = i + 1;
    const charge = SUBSCRIPTION_CHARGE(n);
    const fixedLink = n % 12 === 0 && charge < 0;
    const asset = charge >= 0 || fixedLink ? 'USDT' : n % 7 === 0 ? 'USD' : 'USDT';
    const amount = charge >= 0 ? '19.00' : fixedLink ? '25.00' : `${40 + n * 7}.${String((n * 13) % 100).padStart(2, '0')}`;
    const status = statusFor(n);
    const taken = isTaken(status);
    // half an hour newer than a whole number of 8-hour steps, so a 24-hour, 7-day or 30-day window never has a payment on its edge
    const createdAt = now - n * SPACING + 1_800_000;
    const linkIndex = charge >= 0 ? null : fixedLink ? fixedLinks[(n / 12 - 1) % 4] : n % 4 === 0 ? openLinks[(n / 4 - 1) % 4] : null;
    const fee = taken ? feeFor(amount, asset) : null;
    return {
      n,
      id: hex('aa', n),
      merchantId: MERCHANT_ID,
      profileId: null,
      customerRef: `TEST-cust-${String(charge >= 0 ? charge + 1 : ((n - 1) % 30) + 1).padStart(3, '0')}`,
      description: charge >= 0 ? 'TEST subscription charge' : `TEST order ${1000 + n}`,
      amount,
      assetId: asset,
      method: n % 2 ? 'TEST-crypto-transfer' : 'TEST-card-sandbox',
      railAdapter: n % 2 ? 'crypto-native' : 'card-sandbox',
      // a reference a person can read out: the same number as the order it paid for ("TEST order 1008")
      railRef: status === 'created' ? null : `TEST-${1000 + n}`,
      status,
      capturedAmount: taken ? amount : '0',
      refundedAmount: status === 'refunded' ? amount : '0',
      createdAt: iso(createdAt),
      linkId: linkIndex === null ? null : world.links[linkIndex].id,
      fee,
      settlementId: null,
      disputeId: null,
      refundId: null,
      pricingSnapshot: taken
        ? {
            fee,
            assetCode: asset,
            appliedLayer: 'tier',
            ruleId: hex('ab', 1),
            feeBps: RULE.feeBps,
            flatFee: RULE.flatFee,
            spreadBps: null,
            roundingBeneficiary: 'platform',
            roundingMode: 'ceil',
            bookedFee: null,
            reserveAmount: null,
            recordedAt: iso(createdAt),
          }
        : null,
      failure: status === 'failed' ? { code: 'card_declined', message: 'The card was declined.' } : null,
    };
  });
  const byId = new Map(world.payments.map((p) => [p.id, p]));
  world.paymentById = (id) => byId.get(id);
  for (const link of world.links) link.uses = world.payments.filter((p) => p.linkId === link.id && isTaken(p.status)).length;
  for (const link of world.links) if (link.maxUses !== null && link.uses > link.maxUses) link.maxUses = link.uses + 5;

  // ---- settlements: the settled payments, grouped; oldest group goes to the oldest settlement ------------------------
  const settledPayments = world.payments.filter((p) => p.status === 'settled').reverse(); // oldest first
  const usdt = settledPayments.filter((p) => p.assetId === 'USDT');
  const usd = settledPayments.filter((p) => p.assetId === 'USD');
  const groups = new Map();
  let cursor = 0;
  for (const short of ['bb000001', 'bb000002', 'bb000003', 'bb000004', 'bb000006']) {
    groups.set(short, usdt.slice(cursor, cursor + USDT_GROUP_SIZES[short]));
    cursor += USDT_GROUP_SIZES[short];
  }
  groups.set('bb000005', usd);
  world.settlements = SETTLEMENTS.map(([short, window, assetId, status], index) => {
    const members = groups.get(short);
    const gross = sum(members.map((p) => toU(p.amount)));
    const fees = sum(members.map((p) => toU(p.fee)));
    const newest = Math.max(...members.map((p) => Date.parse(p.createdAt)));
    // a settlement opens with its oldest payment and is finalised two hours after its newest one
    const openedAt = Math.min(...members.map((p) => Date.parse(p.createdAt)));
    const createdAt = newest + 2 * 3600_000;
    const id = `${short}-0000-4000-8000-00000000000${6 - index}`;
    for (const p of members) p.settlementId = id;
    const paid = status === 'paid_out';
    return {
      id,
      short,
      merchantId: MERCHANT_ID,
      window,
      assetId,
      gross: fromU(gross),
      fees: fromU(fees),
      net: fromU(gross - fees),
      payoutMethod: paid ? 'crypto-native' : null,
      payoutRef: paid ? (short === 'bb000002' ? 'TEST-tx-0xabc123' : 'TEST-tx-0xdef456') : null,
      status,
      openedAt: iso(openedAt),
      createdAt: iso(createdAt),
      // a payout waits for its approval, so it leaves the morning after the statement is finalised
      sentAt: paid ? iso(createdAt + PAYOUT_SENT_AFTER) : null,
      settledAt: paid ? iso(createdAt + PAYOUT_SENT_AFTER + 3600_000) : null,
      failedAt: status === 'failed' ? iso(createdAt + 3600_000) : null,
      failure: status === 'failed' ? { code: 'pay.rail_declined', message: 'The payment network declined this payout.' } : null,
      // The first (newest) settlement carries the fee as it was worked out; the others predate that record.
      pricingSnapshot:
        index === 0
          ? {
              fee: fromU(fees),
              assetCode: assetId,
              appliedLayer: 'tier',
              ruleId: 'dd000001-0000-4000-8000-000000000001',
              feeBps: RULE.feeBps,
              flatFee: RULE.flatFee,
              spreadBps: null,
              roundingBeneficiary: 'platform',
              roundingMode: 'ceil',
              bookedFee: fromU(fees),
              reserveAmount: null,
              recordedAt: iso(createdAt),
            }
          : null,
      members: members.map((p) => p.id),
    };
  });
  // a settlement's creation must follow its newest payment, and the list is newest first
  world.settlements.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  world.settlementById = (id) => world.settlements.find((s) => s.id === id);

  // ---- refunds: refunded payments, a part refund of a settled one, and one refund the network turned back -------------
  // A refund the service confirmed is "settled": the payment says refunded (or part refunded) from that moment. A refund is
  // taken from the pot the money is in: still being settled (clearing) until its payment is in a settlement, then proceeds.
  const settledAfter = (paymentRow) => {
    const settlement = world.settlements.find((x) => x.id === paymentRow.settlementId);
    return settlement ? Date.parse(settlement.createdAt) + 21 * 3600_000 : null;
  };
  // [payment, status, part amount or null for all of it]; the part refund is on a payment that is already in a settlement
  const partlyRefunded = world.payments.find(
    (p) => p.status === 'settled' && p.settlementId === world.settlements.find((x) => x.short === 'bb000004')?.id,
  );
  const refundRows = [
    [world.payments[2], 'settled', null],
    [world.payments[12], 'settled', null],
    [world.payments[REVERSED_REFUND - 1], 'reversed', null],
    ...(partlyRefunded ? [[partlyRefunded, 'settled', '25.00']] : []),
  ];
  world.refundsOf = (paymentId) => world.refunds.filter((r) => r.paymentId === paymentId);
  world.refunds = refundRows.map(([p, status, part], i) => {
    const amount = part ?? p.amount;
    const createdAt = settledAfter(p) ?? Date.parse(p.createdAt) + 6 * 3600_000;
    const fromSettled = p.settlementId !== null;
    p.refundId = `TEST-refund-${i + 1}`;
    if (part) p.refundedAmount = part; // a fully refunded payment already says so
    return {
      id: `cc10000${i + 1}-0000-4000-8000-00000000010${i + 1}`,
      refundId: `TEST-refund-${i + 1}`,
      paymentId: p.id,
      merchantId: MERCHANT_ID,
      amount,
      assetId: p.assetId,
      reason: null,
      actor: null,
      status,
      createdAt: iso(createdAt),
      settledAt: status === 'settled' ? iso(createdAt + 60_000) : null,
      source: fromSettled ? 'settled' : 'clearing',
      ledgerEffect: {
        recorded: true,
        pot: fromSettled ? 'merchantProceeds' : 'clearing',
        ledgerTxId: `cc2000${i}1-0000-4000-8000-000000000001`,
        direction: 'credit',
      },
      payment: { paymentId: p.id, status: p.status },
    };
  });
  world.refunds.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // ---- disputes: the disputed payments, and one that was won ----------------------------------------------------------
  const disputeRows = [
    [8, 'open', 'fraudulent', 1.5, null, null],
    [18, 'contested', 'product_not_received', 5, 3, null],
    [28, 'won', null, 8, 6, 2],
  ];
  world.disputes = disputeRows.map(([n, status, reasonCode, openedDaysAgo, contestedDaysAgo, closedDaysAgo], i) => {
    const p = world.payments[n - 1];
    p.disputeId = `d000000${i + 1}-0000-4000-8000-00000000000${i + 1}`;
    return {
      disputeId: p.disputeId,
      paymentId: p.id,
      amount: p.amount,
      assetId: p.assetId,
      reasonCode,
      status,
      openedAt: iso(now - openedDaysAgo * DAY),
      contestedAt: contestedDaysAgo === null ? null : iso(now - contestedDaysAgo * DAY),
      closedAt: closedDaysAgo === null ? null : iso(now - closedDaysAgo * DAY),
      // an answer is due a week after it opened, until it has been answered
      responseDueAt: status === 'open' ? iso(now + (7 - openedDaysAgo) * DAY) : null,
      ledgerWire: 'refused',
      ledgerRefuseCode: 'pay.chargeback_wire_absent',
    };
  });

  // ---- customers: thirty, each the sum of their own payments --------------------------------------------------------
  world.customers = Array.from({ length: 30 }, (_, i) => {
    const ref = `TEST-cust-${String(30 - i).padStart(3, '0')}`;
    const theirs = world.payments.filter((p) => p.customerRef === ref); // newest first
    const assets = [...new Set(theirs.map((p) => p.assetId))].sort();
    return {
      customerRef: ref,
      paymentCount: theirs.length,
      subscriptionCount: 0,
      mandateCount: 0,
      firstSeenAt: theirs[theirs.length - 1].createdAt,
      lastSeenAt: theirs[0].createdAt,
      totals: assets.map((assetId) => {
        const mine = theirs.filter((p) => p.assetId === assetId);
        return {
          assetId,
          capturedAmount: fromU(sum(mine.map((p) => toU(p.capturedAmount)))),
          refundedAmount: fromU(sum(mine.map((p) => toU(p.refundedAmount)))),
          paymentCount: mine.length,
        };
      }),
    };
  });
  world.customerByRef = (ref) => world.customers.find((c) => c.customerRef === ref);

  // ---- mandates, subscriptions, and what each has billed ------------------------------------------------------------
  world.mandates = Array.from({ length: 4 }, (_, i) => ({
    id: hex('1d', i + 1),
    merchantId: MERCHANT_ID,
    customerId: `TEST-cust-${String(i + 1).padStart(3, '0')}`,
    assetId: 'USDT',
    amount: '19.00',
    ceiling: i % 2 ? '25.00' : null,
    cadence: 'monthly',
    startsAt: iso(now - 40 * DAY),
    endsAt: null,
    railAdapter: 'crypto-native',
    railMandateRef: null,
    status: i === 3 ? 'cancelled' : 'active',
    cancelledAt: i === 3 ? iso(now - DAY) : null,
    createdAt: iso(now - 40 * DAY),
  }));
  world.subscriptions = world.mandates.map((m, i) => ({
    id: hex('1e', i + 1),
    mandateId: m.id,
    merchantId: MERCHANT_ID,
    customerId: m.customerId,
    nextRunAt: iso(now + (i + 1) * DAY),
    status: ['active', 'active', 'paused', 'cancelled'][i],
    cancelledAt: i === 3 ? iso(now - DAY) : null,
    path: 'crypto_invoice',
    createdAt: iso(now - 40 * DAY),
    anchorAt: iso(now - 40 * DAY),
    anchorOccurrence: 1,
    pausedAt: i === 2 ? iso(now - 2 * DAY) : null,
    resumedAt: null,
    stalledAt: i === 2 ? iso(now - 2 * DAY) : null,
    stallReason: i === 2 ? 'arrears' : null,
  }));
  /** Seeded subscription id -> the first charge that subscription billed. Any id not here (made since boot) has no history. */
  const chargeBySubscription = new Map(world.subscriptions.map((s, i) => [s.id, { i, charge: world.payments[119 + i] }]));
  for (const customer of world.customers) {
    customer.mandateCount = world.mandates.filter((m) => m.customerId === customer.customerRef).length;
    customer.subscriptionCount = world.subscriptions.filter((s) => s.customerId === customer.customerRef).length;
  }
  /** Billing runs for one subscription: the page's "cycles" and "executions" views are both drawn from this one list. */
  world.executionsOf = (subscriptionId) => {
    // Only the four seeded subscriptions have billing history; a subscription made since boot has none yet,
    // and a new one is added at the top of the list, so list position can never be used to look history up.
    const seeded = chargeBySubscription.get(subscriptionId);
    if (!seeded?.charge) return [];
    const { i, charge } = seeded;
    const first = Date.parse(charge.createdAt);
    return [
      {
        occurrence: 1,
        id: hex('1f', i * 2 + 1),
        subscriptionId,
        amount: charge.amount,
        status: 'settled',
        paymentId: charge.id,
        rejectionCode: null,
        attemptedAt: iso(first),
        settledAt: iso(first + 300_000),
        createdAt: iso(first),
        notifyStatus: null,
        notifyCode: null,
      },
      {
        occurrence: 2,
        id: hex('1f', i * 2 + 2),
        subscriptionId,
        amount: charge.amount,
        status: 'rejected',
        paymentId: null,
        rejectionCode: 'pay.insufficient_funds',
        attemptedAt: iso(first + 30 * DAY),
        settledAt: null,
        createdAt: iso(first + 30 * DAY),
        notifyStatus: null,
        notifyCode: null,
      },
    ];
  };
  world.cyclesOf = (subscriptionId) =>
    world.executionsOf(subscriptionId).map((e) => ({
      occurrence: e.occurrence,
      amount: e.amount,
      status: e.status,
      idempotencyKey: `TEST-${subscriptionId.slice(0, 8)}:${e.occurrence}`,
      attemptCount: e.status === 'rejected' ? 2 : 1,
      rejectionCode: e.rejectionCode,
      paymentId: e.paymentId,
      exhausted: false,
      settledAt: e.settledAt,
      notifyStatus: e.notifyStatus,
      notifyCode: e.notifyCode,
    }));
}

function attachAggregates(world, now) {
  // ---- aggregates every page uses -------------------------------------------------------------------------------------
  const inWindow = (p, from, to) => {
    const at = Date.parse(p.createdAt);
    return at >= from && at < to;
  };
  /** Figures for payments created in [from, to): the one place a headline total is worked out. */
  world.figures = (from, to = now + 1) => {
    const mine = world.payments.filter((p) => inWindow(p, from, to));
    const assets = [...new Set(world.payments.map((p) => p.assetId))].sort((a, b) =>
      a === 'USDT' ? -1 : b === 'USDT' ? 1 : a.localeCompare(b),
    );
    const perAsset = (pick) =>
      assets
        .map((assetCode) => ({ assetCode, value: pick(mine.filter((p) => p.assetId === assetCode)) }))
        .filter((row) => row.value !== null);
    const taken = (list) => list.filter((p) => isTaken(p.status));
    // everything given back on a payment that took money, a part refund included
    const refundedOf = (list) => sum(taken(list).map((p) => toU(p.refundedAmount)));
    const capturedOf = (list) => sum(taken(list).map((p) => toU(p.capturedAmount)));
    const settlementsIn = world.settlements.filter((s) => {
      const at = Date.parse(s.createdAt);
      return at >= from && at < to && s.status !== 'failed';
    });
    return {
      payments: mine,
      count: mine.length,
      statusMix: ['captured', 'settled', 'refunded', 'disputed', 'failed', 'authorized', 'created']
        .map((status) => ({ status, count: mine.filter((p) => p.status === status).length }))
        .filter((row) => row.count > 0),
      captured: perAsset((l) => (taken(l).length ? fromU(capturedOf(l)) : null)).map((r) => ({ assetCode: r.assetCode, amount: r.value })),
      refunded: perAsset((l) => (refundedOf(l) > 0n ? fromU(refundedOf(l)) : null)).map((r) => ({
        assetCode: r.assetCode,
        amount: r.value,
      })),
      net: perAsset((l) => (taken(l).length ? fromU(capturedOf(l) - refundedOf(l)) : null)).map((r) => ({
        assetCode: r.assetCode,
        amount: r.value,
      })),
      fees: perAsset((l) => (taken(l).length ? fromU(sum(taken(l).map((p) => toU(p.fee)))) : null)).map((r) => ({
        assetCode: r.assetCode,
        amount: r.value,
      })),
      average: perAsset((l) => (taken(l).length ? fromU(capturedOf(l) / BigInt(taken(l).length)) : null)).map((r) => ({
        assetCode: r.assetCode,
        amount: r.value,
      })),
      largest: perAsset((l) =>
        taken(l).length ? fromU(taken(l).reduce((max, p) => (toU(p.capturedAmount) > max ? toU(p.capturedAmount) : max), 0n)) : null,
      ).map((r) => ({ assetCode: r.assetCode, amount: r.value })),
      settled: assets
        .map((assetCode) => {
          const rows = settlementsIn.filter((s) => s.assetId === assetCode);
          if (!rows.length) return null;
          return {
            assetCode,
            gross: fromU(sum(rows.map((s) => toU(s.gross)))),
            fees: fromU(sum(rows.map((s) => toU(s.fees)))),
            net: fromU(sum(rows.map((s) => toU(s.net)))),
          };
        })
        .filter(Boolean),
      links: {
        linksUsed: new Set(
          taken(mine)
            .filter((p) => p.linkId)
            .map((p) => p.linkId),
        ).size,
        paymentsViaLinks: taken(mine).filter((p) => p.linkId).length,
      },
    };
  };

  // ---- the ledger: what each account held, line by line ---------------------------------------------------------------
  // clearing holds captured money until it is settled; proceeds hold settled net until it is paid out or refunded.
  // An unapproved payout is not a ledger event: only a settlement that was paid out produces a payout line.
  world.ledgerLines = (assetId) => {
    const lines = [];
    const add = (at, kind, amount, account, direction, extra = {}) =>
      lines.push({ at: Date.parse(at), kind, amount, account, direction, ...extra });
    for (const p of world.payments.filter((x) => x.assetId === assetId && isTaken(x.status))) {
      add(p.createdAt, 'payment_captured', p.capturedAmount, 'clearing', 'debit', { clearing: toU(p.capturedAmount), paymentId: p.id });
    }
    for (const s of world.settlements.filter((x) => x.assetId === assetId && (x.status === 'posted' || x.status === 'paid_out'))) {
      add(s.createdAt, 'fee', s.fees, 'houseFees', 'credit', { settlementId: s.id });
      add(s.createdAt, 'settlement', s.net, 'proceeds', 'debit', { clearing: -toU(s.gross), proceeds: toU(s.net), settlementId: s.id });
      if (s.status === 'paid_out') add(s.sentAt, 'payout', s.net, 'proceeds', 'credit', { proceeds: -toU(s.net), settlementId: s.id });
    }
    for (const r of world.refunds.filter((x) => x.assetId === assetId && (x.status === 'posted' || x.status === 'settled'))) {
      // the refund comes out of the pot its money is in: still being settled, or already settled to the merchant
      const fromProceeds = r.source === 'settled';
      add(r.createdAt, 'refund', r.amount, fromProceeds ? 'proceeds' : 'clearing', 'credit', {
        [fromProceeds ? 'proceeds' : 'clearing']: -toU(r.amount),
        paymentId: r.paymentId,
      });
    }
    lines.sort((a, b) => a.at - b.at);
    let clearing = 0n;
    let proceeds = 0n;
    return lines.map((line, i) => {
      clearing += line.clearing ?? 0n;
      proceeds += line.proceeds ?? 0n;
      return { ...line, index: i + 1, runningClearing: clearing, runningProceeds: proceeds };
    });
  };
  /** What each account holds right now, per asset. The balances on Home, the statement's tie-out and the ledger agree. */
  world.balance = (assetId) => {
    const lines = world.ledgerLines(assetId);
    const last = lines[lines.length - 1];
    return { clearing: last?.runningClearing ?? 0n, proceeds: last?.runningProceeds ?? 0n };
  };
}

export { USER_ID };
