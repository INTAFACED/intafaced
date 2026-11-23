// Records the posts the engine's Postgres tests book (`tests/engine_pg.rs`, `tests/engine_doors_pg.rs`), built by the same
// `@intafaced/ledger-client` recipes with the same arguments the TypeScript tests gave them, into
// `tests/fixtures/engine-posts.golden.json`: each post as the wire carries it (amounts as decimal strings), and each
// account a test reads back. The Rust suites read the same legs the TypeScript tests posted.
//
// It reads only `packages/ledger-client`, so it keeps running after `services/svc-ledger` is gone. From the repository
// root:
//   node --import tsx crates/svc-ledger/scripts/record-engine-posts.mjs          writes the file
//   node --import tsx crates/svc-ledger/scripts/record-engine-posts.mjs --check  fails when the file is stale

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = fileURLToPath(new URL('../tests/fixtures/engine-posts.golden.json', import.meta.url));
const lc = await import(`${ROOT}packages/ledger-client/src/index.ts`);
const { recipes, parseAmount: amt, formatAmount, userAvailable } = lc;

/** `wirePost` of the TypeScript door tests: the request with each amount a decimal string. */
const wire = (r) => ({
  ...r,
  entries: r.entries.map((e) => ({ account: e.account, direction: e.direction, amount: formatAmount(e.amount) })),
});

const posts = {};
const accounts = {};
const post = (name, request) => {
  if (name in posts) throw new Error(`two posts named ${name}`);
  posts[name] = wire(request);
};
const account = (name, ref) => {
  if (name in accounts) throw new Error(`two accounts named ${name}`);
  accounts[name] = ref;
};

// ── ledger/postgres-ledger.test.ts ('svc-ledger — database-level guarantees') ─────────────────────────────────────
{
  const USER = '99999999-9999-4999-8999-999999999999';
  const deposit = (amount, railRef, assetId = 'USDT') =>
    recipes.deposit({ userId: USER, assetId, amount: amt(amount), rail: 'test', railRef });
  const hold = (orderId, amount) => recipes.orderHold({ orderId, userId: USER, assetId: 'USDT', amount: amt(amount) });
  post('pl.neg.deposit', deposit('10', 'neg-1'));
  post('pl.neg.hold', hold('neg-hold', '50'));
  post('pl.precision.deposit', deposit('0.123456789012345678', 'precision-1', 'ETH'));
  post('pl.ba.deposit', deposit('100', 'ba-1'));
  post('pl.ba.hold', hold('ba-o1', '30'));
  post('pl.vol.deposit', deposit('100000', 'vol-1'));
  for (let i = 0; i < 100; i++) {
    post(`pl.vol.hold.${i}`, hold(`vol-${i}`, '10'));
    post(`pl.vol.release.${i}`, recipes.orderHoldRelease({ orderId: `vol-${i}`, userId: USER, assetId: 'USDT', amount: amt('10') }));
  }
  post('pl.conc.deposit', deposit('10000', 'conc-1'));
  for (let i = 0; i < 50; i++) post(`pl.conc.hold.${i}`, hold(`conc-${i}`, '10'));
  post('pl.legacy.first', deposit('7', 'legacy-claim'));
  post('pl.legacy.other', deposit('70', 'legacy-claim'));
  post('pl.detect.first', deposit('7', 'detect-mode'));
  post('pl.detect.other', deposit('70', 'detect-mode'));
  account('pl.usdt', userAvailable(USER, 'USDT'));
  account('pl.eth', userAvailable(USER, 'ETH'));
}

// ── ledger/bank-transfer-reversal.pg.test.ts ─────────────────────────────────────────────────────────────────────
{
  const SENDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const RECIPIENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const from = userAvailable(SENDER, 'USDT');
  const to = userAvailable(RECIPIENT, 'USDT');
  const reversal = (transferId, amount) =>
    recipes.bankTransferReversal({
      originalKeySpace: 'p2p',
      transferId,
      occurrence: 0,
      consentId: `c-${transferId}`,
      originalFrom: from,
      originalTo: to,
      originalAmount: amt(amount),
      amount: amt(amount),
    });
  const send = (transferId, f, t, amount) =>
    recipes.bankTransfer({ transferId, occurrence: 0, from: f, to: t, amount: amt(amount), kind: 'manual', keySpace: 'p2p' });
  post(
    'btr.deposit',
    recipes.deposit({ userId: SENDER, assetId: 'USDT', amount: amt('1000'), rail: 'crypto-native', railRef: 'tx-rev-1' }),
  );
  post('btr.t1', send('t1', from, to, '100'));
  post('btr.reverse.t1', reversal('t1', '100'));
  post('btr.t2', send('t2', from, to, '50'));
  post('btr.t3', send('t3', to, from, '30'));
  post('btr.reverse.t2', reversal('t2', '50'));
  account('btr.from', from);
  account('btr.to', to);
}

// ── ledger/futures-order-margin.pg.test.ts ───────────────────────────────────────────────────────────────────────
{
  const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const hold = (orderId, amount) => recipes.futuresOrderMarginHold({ orderId, userId: USER, assetId: 'USDT', amount: amt(amount) });
  post('fom.deposit', recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1000'), rail: 'crypto-native', railRef: 'tx-om-1' }));
  post('fom.hold.o1', hold('o1', '300'));
  post('fom.hold.o2', hold('o2', '500'));
  post(
    'fom.apply.o1',
    recipes.futuresOrderMarginApply({
      orderId: 'o1',
      userId: USER,
      assetId: 'USDT',
      positionId: 'pos-om-1',
      fillId: 'm1:1:pos-om-1',
      amount: amt('250'),
      releaseAmount: amt('50'),
    }),
  );
  post('fom.release.o2', recipes.futuresOrderMarginRelease({ orderId: 'o2', userId: USER, assetId: 'USDT', amount: amt('501') }));
  post(
    'fom.apply.o2',
    recipes.futuresOrderMarginApply({
      orderId: 'o2',
      userId: USER,
      assetId: 'USDT',
      positionId: 'pos-om-2',
      fillId: 'm1:2:pos-om-2',
      amount: amt('400'),
      releaseAmount: amt('101'),
    }),
  );
  account('fom.available', userAvailable(USER, 'USDT'));
  account('fom.margin.o1', lc.futuresOrderMarginAccount(USER, 'USDT', 'o1'));
  account('fom.margin.o2', lc.futuresOrderMarginAccount(USER, 'USDT', 'o2'));
  account('fom.position.1', lc.positionCollateralAccount(USER, 'USDT', 'pos-om-1'));
  account('fom.position.2', lc.positionCollateralAccount(USER, 'USDT', 'pos-om-2'));
}

// ── ledger/merchant-proceeds.pg.test.ts ──────────────────────────────────────────────────────────────────────────
{
  const MERCHANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  post(
    'mp.capture',
    recipes.paymentCapture({
      paymentId: 'pay-proceeds-pg',
      merchantId: MERCHANT,
      assetId: 'USDT',
      amount: amt('100'),
      rail: 'card-sandbox',
      railRef: 'ch_proceeds_pg',
    }),
  );
  post(
    'mp.settlement',
    recipes.merchantSettlement({
      merchantId: MERCHANT,
      merchantUserId: OWNER,
      window: '2026-10-16',
      assetId: 'USDT',
      gross: amt('100'),
      fee: amt('2.5'),
    }),
  );
  post(
    'mp.payout.overdraft',
    recipes.merchantProceedsPayoutHold({
      merchantId: MERCHANT,
      assetId: 'USDT',
      amount: amt('100'),
      rail: 'crypto-native',
      withdrawalId: 'overdraft:0',
    }),
  );
  account('mp.proceeds', lc.merchantProceeds(MERCHANT, 'USDT'));
}

// ── ledger/pay-received-hold.pg.test.ts ──────────────────────────────────────────────────────────────────────────
{
  const RECIPIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const PAYER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const hold = (holdId, amount) => recipes.payReceivedHold({ holdId, userId: RECIPIENT, assetId: 'USDT', amount: amt(amount) });
  const release = (holdId, amount) =>
    recipes.payReceivedRelease({ holdId, userId: RECIPIENT, assetId: 'USDT', amount: amt(amount), heldAmount: amt(amount) });
  const giveBack = (holdId, amount) =>
    recipes.payReceivedReturn({
      holdId,
      userId: RECIPIENT,
      payerUserId: PAYER,
      assetId: 'USDT',
      amount: amt(amount),
      heldAmount: amt(amount),
    });
  post(
    'prh.deposit',
    recipes.deposit({ userId: RECIPIENT, assetId: 'USDT', amount: amt('1000'), rail: 'crypto-native', railRef: 'tx-rh-1' }),
  );
  post('prh.hold.h1', hold('h1', '300'));
  post('prh.hold.h2', hold('h2', '200'));
  post('prh.release.h1', release('h1', '300'));
  post('prh.return.h1', giveBack('h1', '300'));
  post('prh.release.h2', release('h2', '201'));
  post('prh.return.h2', giveBack('h2', '200'));
  account('prh.recipient', userAvailable(RECIPIENT, 'USDT'));
  account('prh.payer', userAvailable(PAYER, 'USDT'));
  account('prh.held.h1', lc.payReceivedHoldAccount(RECIPIENT, 'USDT', 'h1'));
  account('prh.held.h2', lc.payReceivedHoldAccount(RECIPIENT, 'USDT', 'h2'));
}

// ── ledger/staff-hold.pg.test.ts ─────────────────────────────────────────────────────────────────────────────────
{
  const customer = (userId, holds) => {
    const c = `sh.${userId.slice(0, 1)}`;
    const slug = `held-funds-${userId.slice(0, 1)}`;
    post(
      `${c}.deposit`,
      recipes.deposit({ userId, assetId: 'USD', amount: amt('100'), rail: 'bank-sandbox', railRef: `dep-sh-${userId}` }),
    );
    account(`${c}.available`, userAvailable(userId, 'USD'));
    account(`${c}.confirmed`, lc.staffHoldConfirmAccount(slug, 'USD'));
    for (const [what, holdNo, n, amount] of holds) {
      if (what === 'place') {
        post(`${c}.place.${holdNo}`, recipes.staffHoldPlace({ holdNo, userId, assetId: 'USD', amount: amt(amount) }));
        account(`${c}.held.${holdNo}`, lc.staffHoldAccount(userId, 'USD', holdNo));
      } else if (what === 'release') {
        post(
          `${c}.release.${holdNo}.${n}`,
          recipes.staffHoldRelease({
            holdNo,
            releaseNo: n,
            cause: { kind: 'approval', approvalId: `appr-${holdNo}-${n}` },
            userId,
            assetId: 'USD',
            amount: amt(amount),
          }),
        );
      } else {
        post(
          `${c}.confirm.${holdNo}.${n}`,
          recipes.staffHoldConfirm({
            holdNo,
            attempt: n,
            approvalId: `appr-confirm-${holdNo}`,
            confirmAccount: slug,
            userId,
            assetId: 'USD',
            amount: amt(amount),
            heldRemaining: amt(amount),
          }),
        );
      }
    }
  };
  customer('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', [
    ['place', 1, 0, '40'],
    ['release', 1, 1, '15'],
    ['confirm', 1, 1, '25'],
    ['release', 1, 2, '0.01'],
    ['confirm', 1, 2, '0.01'],
  ]);
  customer('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', [
    ['place', 2, 0, '25'],
    ['release', 2, 1, '25'],
    ['confirm', 2, 1, '25'],
  ]);
  customer('cccccccc-cccc-4ccc-8ccc-cccccccccccc', [
    ['place', 3, 0, '10'],
    ['place', 4, 0, '5'],
    ['release', 3, 1, '15'],
  ]);
}

// ── ledger/tx-hash-bind.test.ts ──────────────────────────────────────────────────────────────────────────────────
{
  const USER = '99999999-9999-4999-8999-999999999999';
  const deposit = (amount, railRef) => recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt(amount), rail: 'test', railRef });
  post('thb.bind-1', deposit('10', 'bind-1'));
  post('thb.bind-short', deposit('10', 'bind-short'));
  post('thb.bind-hist', deposit('10', 'bind-hist'));
  post('thb.bind-meta', deposit('10', 'bind-meta'));
  post('thb.receipt-proof', deposit('1', 'receipt-proof'));
  post('thb.claim-unique', deposit('1', 'claim-unique'));
  account('thb.usdt', userAvailable(USER, 'USDT'));
}

// ── money-spine-tip-reprove.test.ts ──────────────────────────────────────────────────────────────────────────────
{
  const MAKER = '11111111-1111-4111-8111-111111111111';
  const TAKER = '22222222-2222-4222-8222-222222222222';
  post(
    'spine.taker.deposit',
    recipes.deposit({ userId: TAKER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'spine-taker-usdt' }),
  );
  post(
    'spine.maker.deposit',
    recipes.deposit({ userId: MAKER, assetId: 'BTC', amount: amt('2'), rail: 'test', railRef: 'spine-maker-btc' }),
  );
  post('spine.taker.hold', recipes.orderHold({ orderId: 'taker-spine-1', userId: TAKER, assetId: 'USDT', amount: amt('900') }));
  post('spine.maker.hold', recipes.orderHold({ orderId: 'maker-spine-1', userId: MAKER, assetId: 'BTC', amount: amt('1') }));
  post(
    'spine.fill',
    recipes.tradeFill({
      fillId: 'spine-tip-f1',
      makerId: MAKER,
      takerId: TAKER,
      makerOrderId: 'maker-spine-1',
      takerOrderId: 'taker-spine-1',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      qty: amt('1'),
      quoteAmount: amt('900'),
      takerSide: 'buy',
      makerFeeBps: 10,
      takerFeeBps: 20,
    }),
  );
  post('spine.anon', recipes.deposit({ userId: TAKER, assetId: 'USDT', amount: amt('1'), rail: 'test', railRef: 'anon-spine' }));
  account('spine.maker.usdt', userAvailable(MAKER, 'USDT'));
  account('spine.taker.btc', userAvailable(TAKER, 'BTC'));
  account('spine.taker.usdt', userAvailable(TAKER, 'USDT'));
  account('spine.fees.usdt', lc.houseFees('trade', 'USDT'));
  account('spine.fees.btc', lc.houseFees('trade', 'BTC'));
  account('spine.taker.held', lc.orderHoldAccount(TAKER, 'USDT', 'taker-spine-1'));
  account('spine.maker.held', lc.orderHoldAccount(MAKER, 'BTC', 'maker-spine-1'));
}

// ── promise-falsify-public-doors.test.ts (the door flows) ────────────────────────────────────────────────────────
{
  const USER = '11111111-1111-4111-8111-111111111111';
  const deposit = (assetId, amount, railRef) => recipes.deposit({ userId: USER, assetId, amount: amt(amount), rail: 'test', railRef });
  const wd = { withdrawalId: 'withdraw-door-1', userId: USER, assetId: 'USDT', amount: amt('7'), rail: 'test' };
  post('pf.pots.deposit', deposit('USDT', '30', 'purpose-seed'));
  post('pf.pots.order', recipes.orderHold({ orderId: 'order-door-1', userId: USER, assetId: 'USDT', amount: amt('10') }));
  post('pf.pots.withdraw', recipes.withdrawHold(wd));
  post('pf.pots.reverse', recipes.withdrawReverse(wd));
  post('pf.loan.collateral', deposit('BTC', '2', 'loan-collateral'));
  post('pf.loan.cash', deposit('USDT', '1000', 'loan-reserve-cash'));
  post(
    'pf.loan.fee',
    recipes.feeCharge({ chargeId: 'loan-reserve-fee', userId: USER, module: 'bank', mode: 'asset', assetId: 'USDT', amount: amt('1000') }),
  );
  post('pf.loan.fund', recipes.loanReserveFund({ fundingId: 'loan-door-fund', debtAssetId: 'USDT', amount: amt('1000') }));
  post(
    'pf.loan.lock.a',
    recipes.loanCollateralLock({ loanId: 'loan-door-a', userId: USER, collateralAssetId: 'BTC', amount: amt('1'), sequence: 0 }),
  );
  post(
    'pf.loan.lock.b',
    recipes.loanCollateralLock({ loanId: 'loan-door-b', userId: USER, collateralAssetId: 'BTC', amount: amt('1'), sequence: 0 }),
  );
  post('pf.loan.draw.a', recipes.loanDraw({ loanId: 'loan-door-a', userId: USER, debtAssetId: 'USDT', principal: amt('1000') }));
  post(
    'pf.loan.release.a',
    recipes.loanCollateralRelease({ loanId: 'loan-door-a', userId: USER, collateralAssetId: 'BTC', amount: amt('1'), sequence: 1 }),
  );
  post('pf.unfunded.deposit', deposit('USDT', '100', 'loan-draw-unfunded-seed'));
  post('pf.unfunded.draw', recipes.loanDraw({ loanId: 'loan-unfunded-reserve', userId: USER, debtAssetId: 'USDT', principal: amt('50') }));
  account('pf.usdt', userAvailable(USER, 'USDT'));
  account('pf.order', lc.orderHoldAccount(USER, 'USDT', 'order-door-1'));
  account('pf.withdraw', lc.withdrawalHoldAccount(USER, 'USDT', 'withdraw-door-1'));
  account('pf.loan.a', lc.loanCollateralAccount(USER, 'BTC', 'loan-door-a'));
  account('pf.loan.b', lc.loanCollateralAccount(USER, 'BTC', 'loan-door-b'));
  account('pf.reserve', lc.loanReserve('USDT'));
}

// Formatted as the repository's `format:check` reads it.
const PRETTIER = fileURLToPath(new URL('../../../node_modules/.bin/prettier', import.meta.url));
const text = execFileSync(PRETTIER, ['--stdin-filepath', OUT], {
  input: JSON.stringify({ posts, accounts }),
  encoding: 'utf8',
  maxBuffer: 1 << 28,
});
if (process.argv.includes('--check')) {
  let was = '';
  try {
    was = readFileSync(OUT, 'utf8');
  } catch {}
  if (was !== text) {
    console.error('record-engine-posts: tests/fixtures/engine-posts.golden.json is stale; run without --check');
    process.exit(1);
  }
  console.log('record-engine-posts: up to date');
} else {
  writeFileSync(OUT, text);
  console.log(`record-engine-posts: ${Object.keys(posts).length} posts, ${Object.keys(accounts).length} accounts`);
}
