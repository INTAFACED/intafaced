// World: book, restart
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { ROOT, api, fromUnits, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import { ageRecord } from './test-age.mjs';
import { CHAIN_ID, connectWhenAsked, fundOnTestChain, testChain } from './dex.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  sameDecimal,
  testDeposit,
  testVenue,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';
import { STACK_PORTS } from '../../../../tooling/scripts/local-test-facts.mjs';

// J-bank-31, in the running app (docs/roadmap/journeys.json): I pay myself from my trading. One test per step, titled
// "J-bank-31 #<n>", run in order on one TEST account, on the launch model (OWNER 226): the venue holds the trading money,
// the stack's TEST partner bank holds the bank money (`testPartner.set({ custody: 'off' })`), and the ledger posts nothing.
//
// TEST setup in #1, the journey's start: one verified TEST person with one TEST browser wallet funded on the stack's TEST
// chain (TEST ETH and 100 TEST USD), TEST 3000 USDC in their account on the TEST venue (its deposit control), our builder
// fee approved and 10x isolated leverage set there through our door (signed by the person's own key), a TEST long on
// XAU-PERP left open (its margin locked), and a TEST long of 0.1 on BTC-PERP that #2 closes in profit. Their partner
// account holds TEST 50 USDC and a TEST card in USDC. The TEST venue pays a withdrawal out on chain from its TEST deposit
// address, so #1 funds that address with TEST USD; the TEST partner credits a USDC transfer to the person's TEST pay-in
// address after 2 confirmations (svc-bank `pay-yourself/test-pay-in.ts`), so #4 and #6 mine blocks on the TEST chain.
//
// Every figure is read from its own source and compared: the venue's record (`/balances`, `/fills`, `/withdrawal`,
// `/withdrawal-terms`), the partner's own book on loopback (`/test-partner/moves`), the card partner's figure and the
// chain. BTC-PERP's TEST ladder and mark are moved by #2 and #7 and put back after each step and after the file.
const J = 'J-bank-31';
const BTC = 'BTC-PERP';
const GOLD = 'XAU-PERP';
const MID = '60000';
const LEVERAGE = '10';
const VENUE_USDC = '3000';
const PARTNER_USDC = '50';
const PARTNER_BANK = 'TEST partner bank';
const PARTNER_RECORD = `http://127.0.0.1:${STACK_PORTS.bank}/test-partner`;
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
test.afterAll(async () => {
  await putBack().catch(() => undefined);
  await testVenue('/test/switches', { withdrawalArrivalSeconds: 60 }).catch(() => undefined);
});

function state() {
  const s = run.read();
  if (!s.who || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}

// ---- the person's sign-in: from #3 on they have an authenticator, so every sign-in takes a fresh code ----

/** The next authenticator code once #3 has set one up, keeping its step so no code is used twice; none before. */
async function codeFor() {
  const s = run.read();
  if (!s.secret) return undefined;
  const { code, step } = await nextCode(totp, s.secret, s.step);
  run.write({ step });
  return code;
}

/** Signs in in the browser, with the next authenticator code once there is one. */
async function signInNow(page, who) {
  if (!run.read().secret) return signIn(page, who);
  const totpCode = await codeFor();
  await page.goto('/login');
  await page.fill('input[name=totp]', totpCode);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

let session;
test.beforeEach(() => {
  session = undefined;
});
/** The person's own API through Edge, one sign-in per step (a code each, once they have an authenticator). */
const door = () =>
  (session ??= (async () => {
    const totpCode = await codeFor();
    return api(state().who, totpCode ? { totpCode } : {});
  })());

async function bankGet(procedure, input) {
  const d = await door();
  const q = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await d.get(`/api/bank/trpc/${procedure}${q}`);
  expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  return res.body.result.data;
}
async function bankPost(procedure, input) {
  const res = await (await door()).post(`/api/bank/trpc/${procedure}`, input);
  expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  return res.body.result.data;
}

let jobCtx;
/** One signed call to svc-bank's pay yourself job door, as the stack's scheduler makes it. */
async function runDue() {
  jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} }));
  const ctx = await jobCtx;
  const raw = JSON.stringify({ limit: 500 });
  const res = await fetch(`${ctx.url('bank')}/internal/jobs/pay-yourself/run-due`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null);
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body;
}

// ---- the venue, signed by the person's own key through our door (setup and #7's trade) ----

async function signAndSend(intent, actionKey) {
  const { owner, walletKey } = state();
  const d = await door();
  const key = privateKeyToAccount(walletKey);
  const prep = await d.post('/api/v1/venue/prepare', {
    venueId: (await venueInfo()).id,
    owner,
    signer: { role: 'owner', address: owner },
    intent,
    actionKey,
  });
  expect(prep.status, JSON.stringify(prep.body).slice(0, 300)).toBe(200);
  const t = prep.body.prepared.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await d.post('/api/v1/venue/submit', {
    actionKey: prep.body.actionKey,
    signature: { digest: prep.body.prepared.digest, signature, signedBy: owner },
  });
  expect(sent.body.outcome, JSON.stringify(sent.body).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  return sent.body;
}

const bestAsk = async (symbol) => (await testVenue('/book', { symbol, depth: 1 })).body.value.asks[0];
const positionOf = async (owner, symbol) => (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === symbol) ?? null;
const since = () => new Date(Date.now() - 6 * 3_600_000).toISOString();
const closingFills = async (owner) => (await venueRecord(owner, '/fills', { since: since() })).value.filter((f) => f.realisedPnl !== null);
const realisedOf = (fills) => fromUnits(fills.reduce((sum, f) => sum + toUnits(f.realisedPnl), 0n));

async function builderFee() {
  const b = (await (await door()).get('/api/v1/venue/status')).body.builder;
  return { builder: b.address, feeBps: b.feeBps };
}

/** A TEST market long of `size` at the venue's best ask (slippage limit 200 above it). */
async function openLong(symbol, size, name) {
  const { owner } = state();
  const ask = await bestAsk(symbol);
  await signAndSend(
    {
      kind: 'place_order',
      symbol,
      side: 'buy',
      type: 'market',
      amount: size,
      price: fromUnits(toUnits(ask.price) + toUnits('200')),
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: `order:${owner}:${J}:${name}`,
      builderFee: await builderFee(),
    },
    `order:${owner}:${J}:${name}`,
  );
  await expect.poll(async () => (await positionOf(owner, symbol))?.size ?? '0', { timeout: 15_000 }).not.toBe('0');
}

/** BTC-PERP's TEST makers rested so its best bid is `gain` per BTC above the position's entry, with the mark there. */
async function bidAbove(entry, gain) {
  const bid = toUnits(entry) + toUnits(gain);
  const mid = fromUnits(bid + toUnits('10'));
  for (const route of ['/test/ladder-mid', '/test/set-mark']) {
    const moved = await testVenue(route, { symbol: BTC, price: route === '/test/set-mark' ? fromUnits(bid) : mid });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  }
}
async function putBack() {
  await testVenue('/test/ladder-mid', { symbol: BTC, price: MID });
  await testVenue('/test/set-mark', { symbol: BTC, price: MID });
}

/** One block mined on the stack's TEST chain, so a transfer gains a confirmation. */
async function mine() {
  const res = await fetch(testChain().gateUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }),
  });
  expect(res.status).toBe(200);
}

/** Every move on the person's record at the TEST partner, oldest first, as its own book lists it. */
const partnerMoves = async (userId) => (await venueRecord(userId, '/moves', {}, PARTNER_RECORD, null)).value;
const payIns = (moves) => moves.filter((m) => m.key.startsWith('bank.pay-in:'));

/** A decimal as the app writes it: thousands grouped in the whole part only. */
const grouped = (value) => {
  const [whole, frac] = value.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
};

/**
 * The rule's day comes: its next run aged until it is a second behind, as the wait to that day would have. The TEST age
 * door ages a record by at most a day a call, so a run days away is aged in day-long calls.
 */
async function ruleDayComes(id, nextRunAt) {
  const DAY = 86_400_000;
  for (let left = Date.parse(nextRunAt) - Date.now() + 1_000; left > 0; left -= DAY)
    await ageRecord('bank', 'pay-yourself-rule', id, Math.min(left, DAY));
}

// ---- Home ----

/** The TEST wallet on the TEST chain installed in this page, then signed in (unless `signedIn`). */
async function walletAndSignIn(page, { signedIn = false } = {}) {
  const { who, walletKey } = state();
  const wallet = await installTestWallet(page, { chainId: CHAIN_ID, privateKey: walletKey, rpcUrl: testChain().gateUrl });
  if (!signedIn) await signInNow(page, who);
  return wallet;
}

/** Home with the wallet connected, balances shown and Pay yourself loaded. */
async function toHome(page) {
  await page.goto('/');
  const standing = page.getByTestId('home-standing');
  await connectWhenAsked(page, standing);
  const show = page.getByRole('button', { name: 'Show balances', exact: true }).first();
  if (await show.isVisible().catch(() => false)) await show.click();
  await expect(page.getByTestId('pay-yourself-home')).toBeVisible({ timeout: 30_000 });
}

async function openHome(page) {
  const wallet = await walletAndSignIn(page);
  await toHome(page);
  return wallet;
}
const part = (page, id) => page.getByTestId('spendable-now').locator(`li[data-spendable="${id}"]`);
const amountOf = async (locator) => (await locator.innerText()).replace(/,/g, '').replace(/ USDC?$/, '');
const review = (page, line) => page.getByTestId('pay-review').locator(`dd[data-review="${line}"]`);
const track = (page, line) => page.getByTestId('pay-tracker').locator(`dd[data-track="${line}"]`);

/** Review → Continue → a fresh authenticator code → the wallet's sheet → the one signature. */
async function approveAndSign(page, wallet) {
  await page.getByTestId('pay-review').getByRole('button', { name: 'Continue', exact: true }).click();
  const confirm = page.getByTestId('step-up-confirm');
  await expect(confirm.getByLabel('Authenticator code', { exact: true })).toBeEnabled({ timeout: 15_000 });
  await confirm.getByLabel('Authenticator code', { exact: true }).fill(await codeFor());
  const before = wallet.requests.length;
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await continueInWallet(page);
  await expect(page.getByTestId('pay-review')).toHaveCount(0, { timeout: 15_000 });
  // oxlint-disable-next-line garden/no-wait-for-timeout -- proving no second signature is asked after the first
  await page.waitForTimeout(1_500);
  expect(wallet.requests.length - before, 'the wallet signs once').toBe(1);
}

test(`${J} #1 opens Home: Spendable now is the partner balance, the venue's withdrawable figure and wallet stablecoins, each with its source and as-of time; Locked in trades apart, from the venue`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  run.reset({});
  const who = await signUp(page, 'jb31');
  await verify(page, who);
  const walletKey = testWalletKey();
  const owner = privateKeyToAccount(walletKey).address.toLowerCase();
  run.write({ who, walletKey });

  // The partner holds the person's bank money: TEST 50 USDC, and a TEST card in USDC.
  await bankPost('testPartner.set', { custody: 'off' });
  await bankPost('testPartner.fund', { fundId: `${J}-${who.email}`.slice(0, 64), assetId: 'USDC', amount: PARTNER_USDC });
  const card = await bankPost('cards.issue', { cardId: randomUUID(), assetId: 'USDC', perAuthorizationLimit: '50' });
  const held = await bankGet('cards.partnerHeld', { cardId: card.id, limit: 1 });
  expect(held.heldBy).toBe('partner');
  const ledger = await (await door()).balances();
  run.write({ cardId: card.id, cardBefore: held.figures.available, ledger, userId: (await door()).userId });

  // The venue: TEST USDC, our builder fee approved, 10x isolated, a gold long left open and a BTC long #2 closes.
  fundOnTestChain(owner, 'venue');
  const { chainId, id: venueId } = await venueInfo();
  await testDeposit(owner, 'USDC', VENUE_USDC, `${chainId}:0x${randomBytes(32).toString('hex')}:0`);
  const deposit = (await testVenue('/venue')).body.deposit;
  expect(deposit?.address, 'the TEST venue publishes its TEST deposit address').toBeTruthy();
  for (let i = 0; i < 4; i += 1) fundOnTestChain(deposit.address, 'venue');
  const fee = await builderFee();
  await signAndSend(
    { kind: 'approve_builder_fee', builder: fee.builder, maxFeeBps: fee.feeBps },
    `builder-approval:${owner}:${venueId}:${fee.builder}:${fee.feeBps}`,
  );
  for (const symbol of [BTC, GOLD])
    await signAndSend(
      { kind: 'update_leverage', symbol, leverageBps: Number(LEVERAGE) * 10_000, marginMode: 'isolated' },
      `leverage:${owner}:${symbol}:isolated:${LEVERAGE}:${J}`,
    );
  await openLong(GOLD, '1', 'gold');
  await openLong(BTC, '0.1', 'btc-1');

  await openHome(page);
  const spendable = page.getByTestId('spendable-now');
  await expect(spendable.getByRole('heading', { name: 'Spendable now', exact: true })).toBeVisible();
  // Each part: its own source's figure, named, with that source's time.
  const venue = await venueBalance(owner, 'USDC');
  const expected = { partner: PARTNER_USDC, venue: venue.free, wallet: '100' };
  const names = {
    partner: `At ${PARTNER_BANK}`,
    venue: `Withdrawable on ${(await venueInfo()).displayName}`,
    wallet: 'Stablecoins in your wallet',
  };
  const sources = { partner: 'the partner’s own figure', venue: 'the venue’s own figure', wallet: 'read from the chain' };
  for (const id of ['partner', 'venue', 'wallet']) {
    const row = part(page, id);
    await expect(row.locator('[data-part-name]')).toHaveText(names[id]);
    await expect
      .poll(async () => sameDecimal(await amountOf(row.locator('[data-part-amount]')), expected[id]), { timeout: 30_000 })
      .toBe(true);
    await expect(row.locator('[data-part-source]')).toContainText(`${sources[id]}, as of`);
    await expect(row.locator('[data-part-source] time')).toHaveAttribute('dateTime', /^\d{4}-\d\d-\d\dT/);
  }
  const total = fromUnits(toUnits(PARTNER_USDC) + toUnits(venue.free) + toUnits('100'));
  await expect
    .poll(async () => sameDecimal((await page.getByTestId('spendable-total').innerText()).replace(/,/g, '').replace(' USD', ''), total))
    .toBe(true);
  // Locked in trades: the venue's own locked figure (both positions' margin), never in Spendable now.
  expect(toUnits(venue.locked) > 0n, 'the open positions lock margin on the venue').toBe(true);
  const locked = page.getByTestId('locked-in-trades');
  await expect(locked.getByRole('heading', { name: 'Locked in trades', exact: true })).toBeVisible();
  expect(sameDecimal(await amountOf(locked.locator('[data-locked-amount]')), venue.locked)).toBe(true);
  await expect(locked).toContainText('the venue’s own figure, as of');
});

test(`${J} #2 closes a winning TEST trade: the realised profit as the venue reports it, and "Pay yourself 300.00"`, async ({ page }) => {
  test.setTimeout(240_000);
  const { who, walletKey, owner } = state();
  const position = await positionOf(owner, BTC);
  expect(position).toMatchObject({ side: 'long', size: '0.1' });
  try {
    // The TEST market moves 3000 above the entry: closing 0.1 there realises TEST 300.
    await bidAbove(position.entryPrice, '3000');
    await openVenueDesk(page, who, `/trade/futures?symbol=${BTC}`, walletKey);
    const row = page.getByTestId('venue-positions').locator(`tr[data-symbol="${BTC}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    const close = row.getByTestId('venue-close');
    await close.getByRole('textbox').fill('100');
    await close.getByRole('button', { name: 'Close 100%', exact: true }).click();
    await continueInWallet(page);
    await expect.poll(async () => await positionOf(owner, BTC), { timeout: 20_000 }).toBeNull();
  } finally {
    await putBack();
  }
  const fills = await closingFills(owner);
  expect(realisedOf(fills), 'the venue reports TEST 300 realised on the close').toBe('300');

  await toHome(page);
  const pay = page.getByTestId('pay-yourself');
  await expect(pay.getByTestId('realised-profit')).toContainText('Realised from your trading: 300 USDC, as the venue reports it', {
    timeout: 30_000,
  });
  await expect(pay.getByTestId('realised-profit').locator('time')).toHaveAttribute('dateTime', /^\d{4}-/);
  await expect(pay.getByRole('button', { name: 'Pay yourself 300.00', exact: true })).toBeVisible();
});

test(`${J} #3 presses Pay yourself, with step-up: a review with the amount, the venue's withdrawal fee, the partner's fee or "not known", and the arrival time the venue publishes or "not published"; the wallet signs once`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const wallet = await walletAndSignIn(page);
  const { secret, step } = await addAuthenticator(page, totp);
  run.write({ secret, step });
  await toHome(page);
  const terms = (await testVenue('/withdrawal-terms', { asset: 'USDC' })).body.value;
  expect(terms.fee.known && terms.networkFee.known && terms.arrivalSeconds !== null).toBe(true);
  const pay = page.getByRole('button', { name: 'Pay yourself 300.00', exact: true });

  // With the partner's fee not known and no arrival time published: both said so, never a figure.
  await bankPost('testPartner.set', { custody: 'off', fee: 'unknown' });
  expect((await testVenue('/test/switches', { withdrawalArrivalSeconds: null })).status).toBe(200);
  try {
    await pay.click();
    await expect(review(page, 'partner-fee')).toHaveText('not known', { timeout: 15_000 });
    await expect(review(page, 'arrival')).toHaveText('not published');
    await page.getByTestId('pay-review').getByRole('button', { name: 'Cancel', exact: true }).click();
  } finally {
    await bankPost('testPartner.set', { custody: 'off', fee: 'known' });
    await testVenue('/test/switches', { withdrawalArrivalSeconds: terms.arrivalSeconds });
  }

  await pay.click();
  await expect(review(page, 'amount')).toHaveText('300 USDC');
  await expect(review(page, 'to')).toHaveText(`Your own account at ${PARTNER_BANK}`);
  await expect(review(page, 'venue-fee')).toHaveText(`${terms.fee.value} USDC`);
  await expect(review(page, 'network-fee')).toHaveText(`${terms.networkFee.value} USDC`);
  await expect(review(page, 'partner-fee')).toHaveText('0 USDC', { timeout: 15_000 });
  await expect(review(page, 'arrival')).toHaveText(`within ${terms.arrivalSeconds} seconds, as the venue publishes it`);
  const free = (await venueBalance(state().owner, 'USDC')).free;
  await approveAndSign(page, wallet);
  // One move recorded, sent, under the venue's nonce; the venue took one withdrawal of 300 to the pay-in address.
  const summary = await bankGet('payYourself.summary');
  const sent = summary.moves.filter((m) => m.status === 'sent');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ source: 'manual', amount: '300', owner: state().owner });
  const w = (await venueRecord(state().owner, '/withdrawal', { nonce: sent[0].venueNonce })).value;
  expect(w).toMatchObject({ asset: 'USDC', amount: '300', destination: summary.payIn.address.toLowerCase() });
  // The venue's fee comes out of the same free balance.
  expect(fromUnits(toUnits(free) - toUnits((await venueBalance(state().owner, 'USDC')).free))).toBe(
    fromUnits(toUnits('300') + toUnits(terms.fee.value)),
  );
  run.write({ nonce: sent[0].venueNonce, networkFee: terms.networkFee.value });
});

test(`${J} #4 watches it arrive: the venue withdrawal pending then done, the partner credit pending then available, each with its time; the card shows the money available, from the partner`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner, nonce, networkFee, userId, cardId, cardBefore, ledger } = state();
  await openHome(page);
  // The venue's withdrawal: taken (pending), then paid out on chain (done), each at its own time.
  await expect(track(page, 'venue').locator('[data-track-state]')).toHaveText('Done', { timeout: 60_000 });
  const pendingAt = await track(page, 'venue').locator('[data-track-pending-at] time').getAttribute('dateTime');
  const doneAt = await track(page, 'venue').locator('[data-track-done-at] time').getAttribute('dateTime');
  expect(Date.parse(pendingAt) <= Date.parse(doneAt)).toBe(true);
  const w = (await venueRecord(owner, '/withdrawal', { nonce })).value;
  expect(w.status).toBe('done');
  expect(w.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  const arrives = fromUnits(toUnits(w.amount) - toUnits(networkFee));

  // The partner's credit: seen pending, then available after its confirmations.
  await expect(track(page, 'partner')).toContainText(`${arrives} USDC`, { timeout: 30_000 });
  for (let i = 0; i < 3; i += 1) await mine();
  await expect(track(page, 'partner').locator('[data-track-state]')).toHaveText('Available', { timeout: 30_000 });
  const seenAt = await track(page, 'partner').locator('[data-track-pending-at] time').getAttribute('dateTime');
  const availableAt = await track(page, 'partner').locator('[data-track-available-at] time').getAttribute('dateTime');
  expect(Date.parse(seenAt) <= Date.parse(availableAt)).toBe(true);
  // Credited once, by the transfer's own key, on the partner's own book.
  const credited = payIns(await partnerMoves(userId));
  expect(credited).toHaveLength(1);
  expect(credited[0].key).toBe(`bank.pay-in:usdc:${CHAIN_ID}:${w.txHash}:0`);
  expect(sameDecimal(credited[0].amount, arrives)).toBe(true);

  // The card: the partner's available figure, now with the pay-in.
  const card = await bankGet('cards.partnerHeld', { cardId, limit: 1 });
  expect(card.figures.available).toBe(fromUnits(toUnits(cardBefore) + toUnits(arrives)));
  await expect(track(page, 'card')).toHaveText(`${card.figures.available} USDC available, from ${PARTNER_BANK}`, { timeout: 15_000 });
  // Spendable now counts it at the partner only once the partner has credited it.
  await expect
    .poll(
      async () =>
        sameDecimal(
          await amountOf(part(page, 'partner').locator('[data-part-amount]')),
          fromUnits(toUnits(PARTNER_USDC) + toUnits(arrives)),
        ),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
  // The ledger posts nothing.
  expect(await (await door()).balances()).toEqual(ledger);
});

test(`${J} #5 asks for more than the venue reports withdrawable: refused naming the venue's figure; nothing signed`, async ({ page }) => {
  test.setTimeout(180_000);
  const { owner } = state();
  const wallet = await openHome(page);
  const free = (await venueBalance(owner, 'USDC')).free;
  const before = (await bankGet('payYourself.summary')).moves.length;
  await expect(part(page, 'venue').locator('[data-part-amount]')).toBeVisible({ timeout: 30_000 });
  await page
    .getByTestId('pay-yourself')
    .getByLabel('Amount (USDC)', { exact: true })
    .fill(fromUnits(toUnits(free) + toUnits('1')));
  const signed = wallet.requests.length;
  await page
    .getByTestId('pay-yourself')
    .getByRole('button', { name: /^Pay yourself / })
    .click();
  const refusal = page.getByTestId('pay-refusal');
  await expect(refusal).toContainText(`The venue reports ${grouped(free)} USDC withdrawable`, {
    timeout: 15_000,
  });
  await expect(refusal).toContainText('Nothing was signed.');
  await expect(refusal.locator('code')).toHaveText('bank.above_withdrawable');
  await expect(page.getByTestId('pay-review')).toHaveCount(0);
  // oxlint-disable-next-line garden/no-wait-for-timeout -- proving nothing is signed after a refusal
  await page.waitForTimeout(1_500);
  expect(wallet.requests.length).toBe(signed);
  expect((await bankGet('payYourself.summary')).moves.length).toBe(before);
  expect((await venueBalance(owner, 'USDC')).free).toBe(free);
});

test(`${J} #6 the partner's answer is held (TEST switch): "On its way", with where the money was as the last source reported; not counted in Spendable now`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { userId, networkFee } = state();
  const wallet = await openHome(page);
  await expect.poll(async () => (await part(page, 'partner').locator('[data-part-amount]').count()) > 0, { timeout: 30_000 }).toBe(true);
  const partnerBefore = await amountOf(part(page, 'partner').locator('[data-part-amount]'));
  const creditedBefore = payIns(await partnerMoves(userId)).length;
  await bankPost('testPartner.set', { custody: 'off', payIn: 'held' });
  try {
    await page.getByTestId('pay-yourself').getByLabel('Amount (USDC)', { exact: true }).fill('10');
    await page.getByTestId('pay-yourself').getByRole('button', { name: 'Pay yourself 10.00', exact: true }).click();
    await expect(review(page, 'amount')).toHaveText('10 USDC');
    await approveAndSign(page, wallet);
    await expect(track(page, 'venue').locator('[data-track-state]')).toHaveText('Done', { timeout: 60_000 });
    for (let i = 0; i < 3; i += 1) await mine();
    const arrives = fromUnits(toUnits('10') - toUnits(networkFee));
    const way = page.getByTestId('on-its-way');
    await expect(way).toContainText(
      `${arrives} USDC: the venue sent it, and ${PARTNER_BANK} is holding its answer, so it is not in your balance.`,
      {
        timeout: 30_000,
      },
    );
    await expect(way).toContainText('Not counted in Spendable now until the partner credits it.');
    await expect(way.locator('time')).toHaveAttribute('dateTime', /^\d{4}-/);
    await expect(track(page, 'venue').locator('[data-track-state]')).toHaveText('Done');
    await expect(track(page, 'partner').locator('[data-track-state]')).toHaveText('On its way');
    // Not counted: the partner's figure is what it was, and the partner has credited nothing.
    // oxlint-disable-next-line garden/no-wait-for-timeout -- proving the held pay-in is not counted over a few reads
    await page.waitForTimeout(3_000);
    expect(sameDecimal(await amountOf(part(page, 'partner').locator('[data-part-amount]')), partnerBefore)).toBe(true);
    expect(payIns(await partnerMoves(userId)).length).toBe(creditedBefore);
  } finally {
    await bankPost('testPartner.set', { custody: 'off', payIn: 'answered' });
  }
  // The partner answers again: credited once.
  await expect.poll(async () => payIns(await partnerMoves(userId)).length, { timeout: 30_000 }).toBe(creditedBefore + 1);
  await expect(page.getByTestId('on-its-way')).toHaveCount(0, { timeout: 30_000 });
});

test(`${J} #7 sets "every Friday, the week's realised profit, up to TEST 500": on Friday a prepared move waiting for one signature; without the signature nothing moves; a week with no profit prepares nothing`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { owner, userId } = state();
  const wallet = await openHome(page);
  const rule = page.getByTestId('pay-rule');
  await rule.getByLabel('Day', { exact: true }).selectOption('friday');
  await rule.getByLabel('Up to (USDC)', { exact: true }).fill('500');
  await rule.getByRole('button', { name: 'Save rule', exact: true }).click();
  await expect(rule.getByRole('status')).toHaveText('Saved.');
  const saved = (await bankGet('payYourself.summary')).rule;
  expect(saved).toMatchObject({ weekday: 'friday', cap: '500', lastRunAt: null });
  const next = new Date(saved.nextRunAt);
  expect([next.getUTCDay(), next.getUTCHours(), next.getUTCMinutes()]).toEqual([5, 0, 0]);
  await expect(rule.locator('[data-rule-now]')).toHaveText(
    `Every Friday, the week’s realised profit, up to 500 USDC. Next: ${next.toUTCString()}.`,
    {
      timeout: 15_000,
    },
  );

  // This week's trading realises TEST 600, more than the cap.
  await openLong(BTC, '0.2', 'btc-2');
  const position = await positionOf(owner, BTC);
  try {
    await bidAbove(position.entryPrice, '3000');
    await signAndSend(
      {
        kind: 'place_order',
        symbol: BTC,
        side: 'sell',
        type: 'market',
        amount: position.size,
        price: '1000',
        timeInForce: 'IOC',
        reduceOnly: true,
        clientOrderKey: `order:${owner}:${J}:btc-2-close`,
        builderFee: await builderFee(),
      },
      `order:${owner}:${J}:btc-2-close`,
    );
    await expect.poll(async () => await positionOf(owner, BTC), { timeout: 20_000 }).toBeNull();
  } finally {
    await putBack();
  }
  const venueBefore = await venueBalance(owner, 'USDC');
  const partnerBefore = (await partnerMoves(userId)).length;
  const signed = wallet.requests.length;

  // Friday comes (the rule's TEST age door): one move prepared, of the cap, waiting for the person's signature.
  await ruleDayComes(saved.id, saved.nextRunAt);
  await runDue();
  const ruled = (await bankGet('payYourself.summary')).moves.filter((m) => m.source === 'rule');
  expect(ruled).toHaveLength(1);
  expect(ruled[0]).toMatchObject({ status: 'prepared', amount: '500', assetId: 'USDC', venueNonce: null, sentAt: null });
  const prepared = page.getByTestId('prepared-move');
  await expect(prepared).toHaveCount(1, { timeout: 15_000 });
  await expect(prepared).toContainText('500 USDC, the profit realised from');
  await expect(prepared).toContainText('Nothing moves until you sign.');
  await expect(prepared.getByRole('button', { name: 'Sign and send 500.00', exact: true })).toBeVisible();
  // Without the signature nothing moves: no signature asked, the venue and the partner unchanged.
  // oxlint-disable-next-line garden/no-wait-for-timeout -- proving nothing moves without the signature
  await page.waitForTimeout(5_000);
  expect(wallet.requests.length).toBe(signed);
  expect(await venueBalance(owner, 'USDC')).toEqual(venueBefore);
  expect((await partnerMoves(userId)).length).toBe(partnerBefore);

  // The next Friday, with no profit realised since: nothing prepared.
  const after = (await bankGet('payYourself.summary')).rule;
  expect(after.lastRunAt).not.toBeNull();
  await ruleDayComes(saved.id, after.nextRunAt);
  await runDue();
  const later = await bankGet('payYourself.summary');
  expect(later.moves.filter((m) => m.source === 'rule')).toHaveLength(1);
  expect(Date.parse(later.rule.lastRunAt) > Date.parse(after.lastRunAt)).toBe(true);
  expect(await venueBalance(owner, 'USDC')).toEqual(venueBefore);
});
