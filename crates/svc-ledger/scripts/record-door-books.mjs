// Records the posts the door's Postgres tests send, made by the TypeScript recipes with the same arguments as the
// TypeScript tests they port, so the Rust tests book the same bodies:
//
// - `tests/fixtures/door-books.golden.json`: per ported file, its setup posts, the bodies its cases send (forged ones
//   made by the same edits the TypeScript test makes), the accounts it reads, and the property run of
//   `post-recipe-door.test.ts` (fast-check, its own seed and run count) with the post each call builds.
//
// It reads only `packages/ledger-client`, which outlives the TypeScript service, so `--check` keeps working after it.
//   node --import tsx crates/svc-ledger/scripts/record-door-books.mjs          writes the file
//   node --import tsx crates/svc-ledger/scripts/record-door-books.mjs --check  fails when it is stale

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const CHECK = process.argv.includes('--check');
const lc = await import(`${ROOT}packages/ledger-client/src/index.ts`);
const { recipes, formatAmount, parseAmount: amt, ledgerPostWire } = lc;
const { userAvailable, houseFees, rewardsEngine, campaignLockAccount, withdrawalHoldAccount, railBoundary } = lc;
const fc = (await import(pathToFileURL(createRequire(`${ROOT}packages/ledger-client/package.json`).resolve('fast-check')).href)).default;

/** The tests' own `toWire`: amounts as decimal strings, meta only when the post has one. */
const toWire = (post) => ({
  idempotencyKey: post.idempotencyKey,
  module: post.module,
  reason: post.reason,
  ...(post.meta ? { meta: post.meta } : {}),
  entries: post.entries.map((e) => ({ account: e.account, direction: e.direction, amount: formatAmount(e.amount) })),
});
const deposit = (userId, assetId, value, railRef, rail = 'test') =>
  toWire(recipes.deposit({ userId, assetId, amount: amt(value), rail, railRef }));
const reKey = (wire, key) => Object.assign({ ...wire }, { idempotencyKey: key });

// ── campaign-lock-binding.pg.test.ts ─────────────────────────────────────────────────────────────────────────────────
const campaignLock = (() => {
  const CUSTOMER = '11111111-1111-4111-8111-111111111111';
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const PAYER = '44444444-4444-4444-8444-444444444444';
  const keyOf = (n, user = CUSTOMER) => `task:55555555-5555-4555-8555-55555555555${n}:${user}:once`;
  const reward = (n, amount = '100', userId = CUSTOMER) => ({ rewardKey: keyOf(n, userId), userId, assetId: 'USDT', amount: amt(amount) });
  const lock = (i) => toWire(recipes.campaignRewardLock(i));
  const unlock = (i) => toWire(recipes.campaignRewardUnlock(i));
  const forfeit = (i) => toWire(recipes.campaignRewardForfeit(i));
  const r3wire = unlock(reward('3'));
  const r5wire = unlock(reward('5'));
  const r6forfeit = forfeit(reward('6'));
  return {
    // beforeAll: a rewards engine funded the way production funds it, then another reward's pot locked with 500.
    setup: [
      deposit(PAYER, 'USDT', '5000', 'pot'),
      toWire(
        recipes.feeCharge({ chargeId: 'pot', userId: PAYER, module: 'campaigns', mode: 'asset', assetId: 'USDT', amount: amt('5000') }),
      ),
      toWire(recipes.sweepFeesToRewards({ windowId: 'pot', sourceModule: 'campaigns', assetId: 'USDT', amount: amt('5000') })),
    ],
    lock0: lock(reward('0', '500')),
    lock1: lock(reward('1')),
    unlock1: unlock(reward('1')),
    forfeit1: forfeit(reward('1')),
    lock2: lock(reward('2')),
    forfeit2: forfeit(reward('2')),
    unlock2: unlock(reward('2')),
    unlock3: r3wire,
    unlock3FromOtherPot: {
      ...r3wire,
      entries: r3wire.entries.map((e) =>
        e.account.ownerType === 'module' ? { ...e, account: campaignLockAccount(keyOf('0'), 'USDT') } : e,
      ),
    },
    lock4: lock(reward('4', '300')),
    unlock4Part: unlock({ ...reward('4', '300'), amount: amt('100') }),
    forfeit4Part: forfeit({ ...reward('4', '300'), amount: amt('200') }),
    lock5: lock(reward('5')),
    unlock5ToOther: unlock({ ...reward('5'), userId: OTHER }),
    unlock5ToOtherLeg: {
      ...r5wire,
      entries: r5wire.entries.map((e) => (e.account.ownerType === 'user' ? { ...e, account: userAvailable(OTHER, 'USDT') } : e)),
    },
    lock6: lock(reward('6')),
    forfeit6KeyOf0: reKey(r6forfeit, `campaigns:forfeit:${keyOf('0')}`),
    forfeit6MetaOf0: { ...r6forfeit, meta: { ...r6forfeit.meta, rewardKey: keyOf('0') } },
    lock7KeyOf8: reKey(lock(reward('7')), `campaigns:lock:${keyOf('8')}`),
    rewardPay9: toWire(
      recipes.rewardPay({
        rewardId: reward('9').rewardKey,
        userId: CUSTOMER,
        assetId: 'USDT',
        amount: amt('100'),
        reason: 'campaigns.task.reward',
      }),
    ),
    lock9: lock(reward('9')),
    accounts: {
      customer: userAvailable(CUSTOMER, 'USDT'),
      other: userAvailable(OTHER, 'USDT'),
      engine: rewardsEngine('USDT'),
      pot0: campaignLockAccount(keyOf('0'), 'USDT'),
      pot1: campaignLockAccount(keyOf('1'), 'USDT'),
      pot4: campaignLockAccount(keyOf('4'), 'USDT'),
    },
    keys: { forfeit1: `campaigns:forfeit:${keyOf('1')}`, lock9: `campaigns:lock:${keyOf('9')}` },
  };
})();

// ── maker-rebate-binding.pg.test.ts ──────────────────────────────────────────────────────────────────────────────────
const makerRebate = (() => {
  const TAKER = '11111111-1111-4111-8111-111111111111';
  const MAKER = '22222222-2222-4222-8222-222222222222';
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const fill = (fillId, over = {}) => ({
    fillId,
    makerId: MAKER,
    takerId: TAKER,
    makerOrderId: `maker-${fillId}`,
    takerOrderId: `taker-${fillId}`,
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: amt('1'),
    quoteAmount: amt('900'),
    takerSide: 'buy',
    makerFeeBps: 0,
    takerFeeBps: 10,
    makerRebateBps: 5,
    ...over,
  });
  /** `postFill`: both sides funded and held, then the fill. */
  const postFill = (input) => [
    deposit(TAKER, 'USDT', '900', `t-${input.fillId}`),
    deposit(MAKER, 'BTC', '1', `m-${input.fillId}`),
    toWire(recipes.orderHold({ orderId: input.takerOrderId, userId: TAKER, assetId: 'USDT', amount: amt('900') })),
    toWire(recipes.orderHold({ orderId: input.makerOrderId, userId: MAKER, assetId: 'BTC', amount: amt('1') })),
    toWire(recipes.tradeFill(input)),
  ];
  const rebate = (input) => toWire(recipes.tradeFillMakerRebate(input));
  const f7 = fill('f7', { takerSide: 'sell' });
  return {
    // beforeAll: other fills' fees already in house trade fees, 1 BTC.
    setup: [
      deposit(OTHER, 'BTC', '1', 'pool-btc'),
      toWire({
        idempotencyKey: 'test.pool:btc',
        module: 'trade',
        reason: 'test.pool',
        entries: [
          { account: userAvailable(OTHER, 'BTC'), direction: 'credit', amount: amt('1') },
          { account: houseFees('trade', 'BTC'), direction: 'debit', amount: amt('1') },
        ],
      }),
    ],
    fillF1: postFill(fill('f1')),
    rebateF1: rebate(fill('f1')),
    rebateNone: rebate(fill('f-none')),
    fillF2: postFill(fill('f2')),
    rebateF2Larger: { ...rebate(fill('f2')), entries: rebate(fill('f2')).entries.map((e) => ({ ...e, amount: '0.0009' })) },
    fillF3: postFill(fill('f3')),
    rebateF3ToOther: {
      ...rebate(fill('f3')),
      entries: rebate(fill('f3')).entries.map((e) => (e.account.ownerType === 'user' ? { ...e, account: userAvailable(OTHER, 'BTC') } : e)),
    },
    fillF4: postFill(fill('f4')),
    rebateF4Rate: {
      ...rebate(fill('f4')),
      meta: { ...rebate(fill('f4')).meta, makerRebateBps: 10 },
      entries: rebate(fill('f4')).entries.map((e) => ({ ...e, amount: '0.001' })),
    },
    fillF5: postFill(fill('f5', { makerFeeBps: 2 })),
    rebateF5: rebate({ ...fill('f5', { makerFeeBps: 2 }), makerFeeBps: 0 }),
    fillF6: postFill(fill('f6')),
    rebateF6KeyF1: reKey(rebate(fill('f6')), 'trade.fill.rebate:f1'),
    rebateF6OrderF1: { ...rebate(fill('f6')), meta: { ...rebate(fill('f6')).meta, makerOrderId: 'maker-f1' } },
    fillF7: [
      deposit(TAKER, 'BTC', '1', 't-f7'),
      deposit(MAKER, 'USDT', '900', 'm-f7'),
      toWire(recipes.orderHold({ orderId: f7.takerOrderId, userId: TAKER, assetId: 'BTC', amount: amt('1') })),
      toWire(recipes.orderHold({ orderId: f7.makerOrderId, userId: MAKER, assetId: 'USDT', amount: amt('900') })),
      toWire(recipes.tradeFill(f7)),
    ],
    rebateF7: rebate(f7),
    accounts: {
      makerBtc: userAvailable(MAKER, 'BTC'),
      makerUsdt: userAvailable(MAKER, 'USDT'),
      houseBtc: houseFees('trade', 'BTC'),
    },
  };
})();

// ── withdraw-fee-binding.pg.test.ts ──────────────────────────────────────────────────────────────────────────────────
const withdrawFee = (() => {
  const USER = '66666666-6666-4666-8666-666666666666';
  const RAIL = 'crypto-native';
  const w = (withdrawalId) => ({ userId: USER, assetId: 'USDT', amount: amt('25'), fee: amt('1.5'), rail: RAIL, withdrawalId });
  const funded = (withdrawalId) => deposit(USER, 'USDT', '100', `in-${withdrawalId}`, RAIL);
  const hold = (i) => toWire(recipes.withdrawHold(i));
  const settle = (i) => toWire(recipes.withdrawSettle(i));
  const reverse = (i) => toWire(recipes.withdrawReverse(i));
  const f5settle = settle(w('f5:0'));
  const f8settle = settle(w('f8:0'));
  const f9hold = withdrawalHoldAccount(USER, 'USDT', 'f9:0');
  const f10settle = settle({ ...w('f10:0'), fee: undefined });
  const f12reverse = reverse(w('f12:0'));
  const plain = { ...w('f7:0'), fee: undefined, amount: amt('10') };
  const ids = ['f1:0', 'f2:0', 'f3:0', 'f4:0', 'f5:0', 'f6:0', 'f7:0', 'f8:0', 'f9:0', 'f10:0', 'f12:0', 'f13:0', 'f14:0'];
  return {
    funded: Object.fromEntries(ids.map((id) => [id, funded(id)])),
    holdF1: hold(w('f1:0')),
    settleF1: settle(w('f1:0')),
    holdF2: hold(w('f2:0')),
    wrongF2: [{ fee: undefined }, { fee: amt('1') }].map((wrong) => [
      settle({ ...w('f2:0'), ...wrong }),
      reverse({ ...w('f2:0'), ...wrong }),
    ]),
    reverseF2: reverse(w('f2:0')),
    holdF3NoFee: hold({ ...w('f3:0'), fee: undefined }),
    settleF3Fee: settle({ ...w('f3:0'), amount: amt('23.5') }),
    holdF4: hold(w('f4:0')),
    settleF4Part: settle({ ...w('f4:0'), amount: amt('20') }),
    holdF5: hold(w('f5:0')),
    settleF5Skewed: {
      ...f5settle,
      entries: f5settle.entries.map((e) =>
        e.account.ownerType === 'house' ? { ...e, amount: '2' } : e.account.ownerType === 'treasury' ? { ...e, amount: '24.5' } : e,
      ),
    },
    holdF6: hold(w('f6:0')),
    holdF8: hold(w('f8:0')),
    holdF9: hold(w('f9:0')),
    settleF8DrawsF9: { ...f8settle, entries: f8settle.entries.map((e) => (e.account.kind === 'hold' ? { ...e, account: f9hold } : e)) },
    settleF8KeyF9: reKey(f8settle, 'withdraw.settle:f9:0'),
    holdF10: hold(w('f10:0')),
    settleF10MetaF11: { ...f10settle, meta: { ...f10settle.meta, withdrawalId: 'f11:0' } },
    holdF12: hold(w('f12:0')),
    reverseF12ToOther: {
      ...f12reverse,
      entries: f12reverse.entries.map((e) =>
        e.account.kind === 'available' ? { ...e, account: userAvailable('77777777-7777-4777-8777-777777777777', 'USDT') } : e,
      ),
    },
    settleF12Sepa: settle({ ...w('f12:0'), rail: 'bank-sepa' }),
    holdF13Plain: hold({ ...w('f13:0'), amount: amt('26.5'), fee: undefined }),
    holdF13Fee: hold(w('f13:0')),
    holdF13Sepa: hold({ ...w('f13:0'), amount: amt('26.5'), fee: undefined, rail: 'bank-sepa' }),
    holdF14Fee: hold(w('f14:0')),
    holdF14Plain: hold({ ...w('f14:0'), amount: amt('26.5'), fee: undefined }),
    holdF7: hold(plain),
    settleF7Part: settle({ ...plain, amount: amt('6') }),
    reverseF7Part: reverse({ ...plain, amount: amt('4') }),
    accounts: {
      fees: houseFees('pay', 'USDT'),
      ...Object.fromEntries(ids.map((id) => [id, withdrawalHoldAccount(USER, 'USDT', id)])),
    },
  };
})();

// ── withdraw-return-binding.pg.test.ts ───────────────────────────────────────────────────────────────────────────────
const withdrawReturn = (() => {
  const USER = '44444444-4444-4444-8444-444444444444';
  const OTHER = '55555555-5555-4555-8555-555555555555';
  const RAIL = 'crypto-native';
  const withdrawal = (withdrawalId, over = {}) => ({ userId: USER, assetId: 'USDT', amount: amt('40'), rail: RAIL, withdrawalId, ...over });
  const settled = (w) => [
    deposit(w.userId, w.assetId, '100', `in-${w.withdrawalId}`, RAIL),
    toWire(recipes.withdrawHold(w)),
    toWire(recipes.withdrawSettle(w)),
  ];
  const returned = (w) => toWire(recipes.withdrawReturned(w));
  const w5 = withdrawal('w5:0');
  const w5wire = returned(w5);
  const w6wire = returned(withdrawal('w6:0'));
  const wFee = withdrawal('w-fee:0', { amount: amt('25'), fee: amt('1.5') });
  const held = withdrawal('w3:0');
  return {
    setup: [deposit(OTHER, 'USDT', '1000', 'other-in', RAIL)],
    settledW1: settled(withdrawal('w1:0')),
    returnW1: returned(withdrawal('w1:0')),
    settledW2: settled(withdrawal('w2:0')),
    returnW2More: returned({ ...withdrawal('w2:0'), amount: amt('40.000001') }),
    returnW2Part: returned({ ...withdrawal('w2:0'), amount: amt('15') }),
    settledFee: settled(wFee),
    returnFeeWhole: returned({ ...wFee, fee: undefined, amount: amt('26.5') }),
    returnFeeRail: returned({ ...wFee, fee: undefined, amount: amt('25') }),
    w3Deposit: deposit(USER, 'USDT', '100', 'in-w3', RAIL),
    w3Hold: toWire(recipes.withdrawHold(held)),
    w3Reverse: toWire(recipes.withdrawReverse(held)),
    returnW3: returned(held),
    returnNone: returned(withdrawal('w-none:0')),
    settledW4: settled(withdrawal('w4:0')),
    returnW4ToOther: returned({ ...withdrawal('w4:0'), userId: OTHER }),
    settledW5: settled(w5),
    otherUsdc: deposit(OTHER, 'USDC', '100', 'other-usdc', RAIL),
    returnW5Usdc: returned({ ...w5, assetId: 'USDC' }),
    returnW5Card: returned({ ...w5, rail: 'card-sandbox' }),
    returnW5Boundary: {
      ...w5wire,
      entries: w5wire.entries.map((e) =>
        e.account.ownerType === 'treasury' ? { ...e, account: railBoundary('card-sandbox', 'USDT') } : e,
      ),
    },
    settledW6: settled(withdrawal('w6:0')),
    returnW6KeyW1: reKey(w6wire, 'withdraw.returned:w1:0'),
    returnW6MetaW1: { ...w6wire, meta: { ...w6wire.meta, withdrawalId: 'w1:0' } },
    accounts: { user: userAvailable(USER, 'USDT'), other: userAvailable(OTHER, 'USDT') },
  };
})();

// ── post-recipe-door.pg.test.ts and post-recipe-door.test.ts ─────────────────────────────────────────────────────────
const postRecipe = (() => {
  const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const WALLET = '0x00000000000000000000000000000000000000aa';
  const PURCHASE = {
    course: 'perps-101',
    userId: USER,
    n: '1',
    assetId: 'USDC',
    amount: '2.5',
    to: { kind: 'treasury-wallet', walletId: WALLET },
    paymentId: `0x${'ab'.repeat(32)}`,
  };
  const { to, ...rest } = PURCHASE;
  return {
    purchase: { recipe: 'academyPurchase', input: PURCHASE },
    purchaseOther: { recipe: 'academyPurchase', input: { ...PURCHASE, amount: '3' } },
    purchaseNumber: { recipe: 'academyPurchase', input: { ...PURCHASE, amount: 2.5 } },
    // The .pg test's refund and the in-memory test's (`refundInput()`): the same call.
    refund: { recipe: 'academyPurchaseRefund', input: { ...rest, from: to, paymentId: `0x${'cd'.repeat(32)}` } },
    viaPost: ledgerPostWire(recipes.academyPurchase({ ...PURCHASE, n: 1n, amount: amt('2.5') })),
    revenue: houseFees('academy', 'USDC'),
  };
})();

const hex = (len) => fc.stringMatching(new RegExp(`^[0-9a-f]{${len}}$`));
const validCall = fc.record({
  course: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,63}$/),
  userId: fc.uuid({ version: 4 }).map((u) => u.toLowerCase()),
  n: fc.bigInt({ min: 1n, max: 10n ** 12n }),
  assetId: fc.constantFrom('USDC', 'USDT', 'IFC', 'ETH'),
  amount: fc.bigInt({ min: 1n, max: 10n ** 30n }),
  place: fc.oneof(
    { arbitrary: hex(40).map((h) => ({ kind: 'treasury-wallet', walletId: `0x${h}` })), weight: 4 },
    hex(40).map((h) => ({ kind: 'treasury-wallet', walletId: `0x${h}` })),
    fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,20}$/).map((id) => ({ kind: 'venue-builder-account', venueId: id })),
    fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,20}$/).map((id) => ({ kind: 'partner-reserve', partnerId: id })),
  ),
  pay: hex(64).map((h) => `0x${h}`),
  refundPay: hex(64).map((h) => `0x${h}`),
});
// The property's runs, as fast-check draws them for its seed: each purchase and refund, sent to postRecipe as the test
// sends them (`wire`), and the post `recipes[name](input)` builds for /trpc/post.
const property = [];
fc.assert(
  fc.property(validCall, (c) => {
    const purchase = { course: c.course, userId: c.userId, n: c.n, assetId: c.assetId, amount: c.amount, to: c.place, paymentId: c.pay };
    const refund = { ...purchase, to: undefined, from: c.place, paymentId: c.refundPay };
    delete refund.to;
    const wire = (input) => ({ ...input, n: String(input.n), amount: formatAmount(input.amount) });
    property.push({
      amount: formatAmount(c.amount),
      purchase: { recipe: 'academyPurchase', input: wire(purchase) },
      refund: { recipe: 'academyPurchaseRefund', input: wire(refund) },
      purchasePost: ledgerPostWire(recipes.academyPurchase(purchase)),
      refundPost: ledgerPostWire(recipes.academyPurchaseRefund(refund)),
    });
  }),
  { seed: 3343, numRuns: 60 },
);

// ── buyback-grant.test.ts and caller-binding.test.ts's buyback bodies (TEST amounts only) ───────────────────────────
const buybackBodies = (orderId, fillId, ask, makerId) => ({
  buybackOrderHold: toWire(recipes.buybackOrderHold({ orderId, quoteAsset: 'USDT', amount: amt('10') })),
  buybackOrderHoldRelease: toWire(recipes.buybackOrderHoldRelease({ orderId, quoteAsset: 'USDT', amount: amt('10'), sequence: 0 })),
  buybackTakerFill: toWire(
    recipes.buybackTakerFill({
      fillId,
      makerId,
      makerOrderId: ask,
      takerOrderId: orderId,
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      qty: amt('1'),
      quoteAmount: amt('10'),
      makerFeeBps: 0,
    }),
  ),
});
/** What a buyback body needs on the book first: a funded rewards engine, then the order's hold or the maker's ask. */
const buybackBook = (orderId, ask, makerId) => {
  const PAYER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  return {
    funded: [
      deposit(PAYER, 'USDT', '10', `${orderId}-fee`),
      toWire(
        recipes.feeCharge({
          chargeId: `${orderId}-fee`,
          userId: PAYER,
          module: 'trade',
          mode: 'asset',
          assetId: 'USDT',
          amount: amt('10'),
        }),
      ),
      toWire(recipes.sweepFeesToRewards({ windowId: `buyback:${orderId}`, sourceModule: 'trade', assetId: 'USDT', amount: amt('10') })),
    ],
    held: toWire(recipes.buybackOrderHold({ orderId, quoteAsset: 'USDT', amount: amt('10') })),
    ask: [
      deposit(makerId, 'BTC', '1', `${ask}-btc`),
      toWire(recipes.orderHold({ orderId: ask, userId: makerId, assetId: 'BTC', amount: amt('1') })),
    ],
  };
};
const GRANT_MAKER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const buyback = {
  grant: {
    bodies: buybackBodies('bb-grant', 'bb-grant-fill', 'bb-grant-ask', GRANT_MAKER),
    book: buybackBook('bb-grant', 'bb-grant-ask', GRANT_MAKER),
  },
  bind: {
    bodies: buybackBodies('bb-bind', 'bb-bind-fill', 'bb-bind-ask', GRANT_MAKER),
    book: buybackBook('bb-bind', 'bb-bind-ask', GRANT_MAKER),
  },
};

// ── staff-hold-grant.test.ts ─────────────────────────────────────────────────────────────────────────────────────────
const staffHold = (() => {
  const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  return {
    funded: deposit(USER, 'USD', '40', 'ops-funds', 'bank-sandbox'),
    place: toWire(recipes.staffHoldPlace({ holdNo: '7', userId: USER, assetId: 'USD', amount: amt('40') })),
    deposit: toWire(recipes.deposit({ userId: USER, assetId: 'USD', amount: amt('1'), rail: 'bank-sandbox', railRef: 'ops-1' })),
    read: { ownerType: 'user', ownerId: USER, assetId: 'USD' },
  };
})();

// ── caller-binding.test.ts, "POST /trpc/post caller binding" ────────────────────────────────────────────────────────
const callerBinding = (() => {
  const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const feeCharge = (module) =>
    toWire(
      recipes.feeCharge({
        chargeId: 'charge-bind',
        userId: USER,
        module,
        mode: 'asset',
        assetId: 'USDT',
        amount: amt('1'),
        reason: 'agents.usage.metered',
      }),
    );
  return {
    funded: deposit(USER, 'USDT', '100', 'bind-funds'),
    orderHold: toWire(recipes.orderHold({ orderId: 'order-bind', userId: USER, assetId: 'USDT', amount: amt('10') })),
    interestOnlyRepay: toWire(
      recipes.loanRepay({ loanId: 'ln-bind', userId: USER, debtAssetId: 'USDT', principal: 0n, interest: amt('1'), sequence: 1 }),
    ),
    feeChargeTrade: feeCharge('trade'),
    feeChargeAgents: feeCharge('agents'),
  };
})();

const text = `${JSON.stringify({ campaignLock, makerRebate, withdrawFee, withdrawReturn, postRecipe, property, buyback, staffHold, callerBinding })}
`;
const file = `${CRATE}tests/fixtures/door-books.golden.json`;
const PRETTIER = fileURLToPath(new URL('../../../node_modules/.bin/prettier', import.meta.url));
const formatted = execFileSync(PRETTIER, ['--stdin-filepath', file], { input: text, encoding: 'utf8', maxBuffer: 1 << 28 });
if (CHECK) {
  let was = '';
  try {
    was = readFileSync(file, 'utf8');
  } catch {}
  if (was !== formatted) {
    console.error('record-door-books: tests/fixtures/door-books.golden.json is stale; run without --check');
    process.exit(1);
  }
  console.log('record-door-books: up to date');
} else {
  writeFileSync(file, formatted);
  console.log(`record-door-books: wrote ${file} (${property.length} property runs)`);
}
