// World: book, restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { testWalletKey, installTestWallet } from './test-wallet.mjs';
import { continueInWallet, otherTraderKey, otherTraderRun, testDeposit, venueBalance, venueForThisFile, venueInfo } from './venue.mjs';
import { ownSpotMarket } from './own-market.mjs';
import { signedOnVenue, venueNow } from './venue-door.mjs';
import { venueStatus } from './venue-reads.mjs';
import { connectWhenAsked } from './dex.mjs';
import { ageRecord } from './test-age.mjs';

// J-copy-bots-otc-16, in the running app (docs/roadmap/journeys.json): set up a recurring buy of a basket and keep it
// running. One test per step, titled "J-copy-bots-otc-16 #<n>". #3 (savings routing) is not built: it fails quickly at its
// first missing part, the Manage dialog's "Send what I buy to" choice (UNBUILT).
// The rule trades on the person's own account at the stack's TEST venue simulator, with svc-trade's user-venue door on for
// this file: INTAFACED holds and moves nothing. The person is a TEST account, verified, with a TEST wallet holding TEST
// USDC on its venue account. The basket is three TEST spot markets of this file's own (ownSpotMarket), each with this
// file's TEST maker resting asks at 10 and bids at 9.9, so a slot's buys fill at 10 and each coin's mark is 9.95. A slot
// comes due through svc-trade's TEST age door (the rule's next slot moved a day earlier), as a day going by would.
const J = 'J-copy-bots-otc-16';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const DAY = 86_400_000;
const MAKER = 'jrb-maker';
const RULES = '/api/trade/trpc/bots.recurring';
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
test.use({ actionTimeout: 15_000 });

// The file's rules are ended once its steps are done, so no slot of theirs runs in a later file.
test.afterAll(async () => {
  test.setTimeout(120_000);
  const { who } = run.read() ?? {};
  if (!who) return;
  for (const rule of await rules(who)) {
    if (rule.status === 'terminated') continue;
    const ended = await (await api(who)).post(`${RULES}.terminate`, { ruleId: rule.ruleId });
    expect(ended.status, JSON.stringify(ended.body).slice(0, 300)).toBe(200);
  }
});
// Declared after the end above, so the door is still on when the file's rules are ended (hooks run in declared order).
venueForThisFile(test);

const read = (route, input) => `${route}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
async function rules(who) {
  const { status, body } = await (await api(who)).get(read(`${RULES}.list`, {}));
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}
async function rule(who, ruleId) {
  const { status, body } = await (await api(who)).get(read(`${RULES}.get`, { ruleId }));
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}
function state(key) {
  const value = run.read()?.[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

/** This file's maker rests a side of one own market: `side` buy at 9.9 or sell at 10, 1000 of the base. */
const rest = (symbol, side, tag) =>
  otherTraderRun(MAKER, {
    kind: 'place_order',
    symbol,
    side,
    type: 'limit',
    amount: '1000',
    price: side === 'buy' ? '9.9' : '10',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${MAKER}:${symbol}:${side}:${tag}`,
    builderFee: null,
  });

async function openCoin(page) {
  const { chainId } = await venueInfo();
  await installTestWallet(page, { chainId, privateKey: state('walletKey') });
  await signIn(page, state('who'));
  await page.goto('/coin/BTC');
  await page.getByRole('button', { name: 'Recurring buy', exact: true }).click();
  const box = page.getByRole('dialog', { name: 'Recurring buy' });
  await expect(box).toBeVisible();
  await connectWhenAsked(page, box.getByTestId('venue-wallet-address'), box);
  return box;
}

/** The Manage dialog of the rule with this file's basket; `newest` picks the newest of several (#8 makes a second one). */
async function openManage(page, { newest = false } = {}) {
  const { chainId } = await venueInfo();
  await installTestWallet(page, { chainId, privateKey: state('walletKey') });
  await signIn(page, state('who'));
  await page.goto('/trade/bots/dca');
  const row = page
    .getByRole('table', { name: 'My recurring buys' })
    .getByRole('row')
    .filter({ hasText: state('basketLine') });
  if (!newest) await expect(row).toHaveCount(1);
  await (newest ? row.first() : row).getByRole('button', { name: 'Manage', exact: true }).click();
  const box = page.getByRole('dialog', { name: 'Manage recurring buy' });
  await expect(box).toBeVisible();
  return box;
}

/** A day goes by for the rule: its next slot is due, and the tick runs it. Waits until the rule has `slots` slots. */
async function nextSlot(ruleId, slots) {
  await ageRecord('trade', 'recurring-buy', ruleId, DAY);
  await expect
    .poll(async () => (await rule(state('who'), ruleId)).slots.filter((s) => s.outcome !== 'pending').length, { timeout: 30_000 })
    .toBe(slots);
  return rule(state('who'), ruleId);
}

test(`${J} starts: signed in, verified, a TEST wallet with TEST USDC in its own venue account`, async ({ page }) => {
  test.setTimeout(240_000);
  // Nothing on our own ledger: the rule trades only on the venue account.
  const who = await signUp(page, 'jrb');
  await verify(page, who);
  const walletKey = testWalletKey();
  const key = privateKeyToAccount(walletKey);
  const owner = key.address.toLowerCase();
  const venue = await venueNow();
  await testDeposit(owner, 'USDC', '100', `${venue.chainId}:0x${randomBytes(32).toString('hex')}:0`);
  expect(toUnits((await venueBalance(owner, 'USDC')).free)).toBe(toUnits('100'));
  // Ending a rule sells on the venue, and every sell carries our builder fee: the wallet approves it once on its own
  // account, signed on the venue itself (setup: the step words start from an account that trades there).
  const { builder } = await venueStatus(who);
  expect(builder, 'the stack publishes our TEST builder fee').toBeTruthy();
  await signedOnVenue(venue, key, { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps });
  // Three markets of this file's own, each with the maker's asks at 10 and bids at 9.9.
  const maker = otherTraderKey(MAKER).address.toLowerCase();
  const markets = [];
  for (const tag of ['A', 'B', 'C']) {
    const m = await ownSpotMarket(J, 'JRB', tag);
    await testDeposit(maker, m.base, '5000', `${venue.chainId}:0x${randomBytes(32).toString('hex')}:0`);
    await testDeposit(maker, 'USDC', '50000', `${venue.chainId}:0x${randomBytes(32).toString('hex')}:0`);
    await rest(m.symbol, 'sell', 'start');
    await rest(m.symbol, 'buy', 'start');
    markets.push(m);
  }
  run.reset({ who, walletKey, owner, markets, basketLine: markets.map((m, i) => `${m.base} ${['50', '30', '20'][i]}%`).join(', ') });
});

test(`${J} #1 opens the recurring buy form from a coin page: a basket editor with weights, frequency and price range`, async ({ page }) => {
  const box = await openCoin(page);
  // The page's coin is the basket's first row.
  await expect(box.getByLabel('Coin 1', { exact: true })).toHaveValue('BTC-USDC');
  await expect(box.getByLabel('Weight 1, %', { exact: true })).toHaveValue('100');
  await expect(box.getByLabel('How often', { exact: true })).toBeVisible();
  await expect(box.getByLabel('Lowest price 1', { exact: true })).toBeVisible();
  await expect(box.getByLabel('Highest price 1', { exact: true })).toBeVisible();
  await expect(box.getByRole('button', { name: 'Add a coin', exact: true })).toBeVisible();
  await expect(box.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});

test(`${J} #2 enters weights that total 90 and a price range with min above max: each refused naming the problem; a 50, 30, 20 basket saves`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const who = state('who');
  const markets = state('markets');
  const box = await openCoin(page);
  for (const [i, m] of markets.entries()) {
    if (i > 0) await box.getByRole('button', { name: 'Add a coin', exact: true }).click();
    await box.getByLabel(`Coin ${i + 1}`, { exact: true }).selectOption(m.symbol);
    await box.getByLabel(`Weight ${i + 1}, %`, { exact: true }).fill(['50', '30', '10'][i]);
  }
  await box.getByLabel('Amount each time (USDC)', { exact: true }).fill('10');
  await box.getByLabel('How often', { exact: true }).selectOption('daily');
  const save = box.getByRole('button', { name: 'Save', exact: true });

  // Weights that total 90: refused, naming the total; nothing saved.
  const weights = page.waitForResponse((r) => r.url().includes('bots.recurring.create'));
  await save.click();
  expect((await (await weights).json()).error?.data?.cause?.code).toBe('trade.recurring_weights_not_100');
  await expect(box.getByText('The weights add up to 90%. They must add up to 100%.', { exact: true })).toBeVisible();
  await expect(box.getByText('The weights must add up to 100%', { exact: true })).toBeVisible();
  expect(await rules(who)).toEqual([]);

  // A range with its lowest price above its highest: refused, naming the row; nothing saved.
  await box.getByLabel('Weight 3, %', { exact: true }).fill('20');
  await box.getByLabel('Lowest price 1', { exact: true }).fill('20');
  await box.getByLabel('Highest price 1', { exact: true }).fill('10');
  const range = page.waitForResponse((r) => r.url().includes('bots.recurring.create'));
  await save.click();
  expect((await (await range).json()).error?.data?.cause?.code).toBe('trade.recurring_price_range_inverted');
  await expect(box.getByText('Coin 1: the lowest price must be below the highest price.', { exact: true })).toBeVisible();
  expect(await rules(who)).toEqual([]);

  // 50, 30, 20 with no range: saved; the wallet signs the recurring-buy permission once, and the first slot buys at once.
  await box.getByLabel('Lowest price 1', { exact: true }).fill('');
  await box.getByLabel('Highest price 1', { exact: true }).fill('');
  await save.click();
  await continueInWallet(page);
  await expect(box.getByRole('status')).toContainText('Saved.');
  const [made] = await rules(who);
  expect(made.basket.map((b) => [b.symbol, b.weightPct])).toEqual(markets.map((m, i) => [m.symbol, ['50', '30', '20'][i]]));
  expect(made).toMatchObject({ amount: '10', frequency: 'daily', maxInvestment: null, funding: 'venue' });
  await expect.poll(async () => (await rule(who, made.ruleId)).status).toBe('active');
  const first = await nextSlotOrNow(made.ruleId);
  // One venue order per coin, under the slot's own key, each for its weight of 10: 5, 3 and 2 at 10.
  expect(first.slots[0].orders.map((o) => [o.orderKey, o.status, o.filled, o.spent])).toEqual(
    markets.map((m, i) => [`recurring:${made.ruleId}:0:${m.symbol}`, 'filled', ['0.5', '0.3', '0.2'][i], ['5', '3', '2'][i]]),
  );
  expect(toUnits((await venueBalance(state('owner'), 'USDC')).free)).toBe(toUnits('90'));
  run.write({ ruleId: made.ruleId });
});

/** The first slot runs as the rule becomes active: waits for it. */
async function nextSlotOrNow(ruleId) {
  await expect.poll(async () => (await rule(state('who'), ruleId)).slots.filter((s) => s.outcome === 'bought').length).toBe(1);
  return rule(state('who'), ruleId);
}

test(`${J} #4 chooses card funding: the notice that card funding needs the card processor and is off in this build, and nothing is saved`, async ({
  page,
}) => {
  const before = (await rules(state('who'))).map((r) => r.ruleId);
  const box = await openCoin(page);
  await box.getByRole('radio', { name: 'Card', exact: true }).check();
  await expect(
    box.getByText('Card funding needs the card processor, which is switched off in this build. Nothing is saved with a card.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(box.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  // The service refuses the path too, by its code, and saves nothing.
  const sent = await (
    await api(state('who'))
  ).post(`${RULES}.create`, {
    clientRequestId: `${J}-card-${Date.now().toString(36)}`,
    owner: state('owner'),
    funding: 'card',
    basket: [{ symbol: state('markets')[0].symbol, weightPct: '100' }],
    amount: '10',
    frequency: 'daily',
  });
  expect(sent.body?.error?.data?.cause?.code).toBe('trade.recurring_card_funding_off');
  expect((await rules(state('who'))).map((r) => r.ruleId)).toEqual(before);
});

test(`${J} #5 changes the amount from 10 to 20: the next slot buys 20 and earlier slots are unchanged`, async ({ page }) => {
  test.setTimeout(120_000);
  const ruleId = state('ruleId');
  const box = await openManage(page);
  await box.getByLabel('Amount each time (USDC)', { exact: true }).fill('20');
  await box.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(box.getByRole('status')).toHaveText('Saved. The next buy spends 20 USDC; earlier buys are unchanged.');
  const earlier = (await rule(state('who'), ruleId)).slots;
  expect(earlier.map((s) => [s.amount, s.spent])).toEqual([['10', '10']]);
  const after = await nextSlot(ruleId, 2);
  expect(after.slots[0]).toEqual(earlier[0]);
  expect([after.slots[1].amount, after.slots[1].spent, after.slots[1].outcome]).toEqual(['20', '20', 'bought']);
  expect(toUnits((await venueBalance(state('owner'), 'USDC')).free)).toBe(toUnits('70'));
});

test(`${J} #6 runs out of funds for a slot, then adds funds: suspended for insufficient funds with one notice; funds arriving resume it once`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = state('who');
  const ruleId = state('ruleId');
  const owner = state('owner');
  const venue = await venueNow();
  // The person's own buy, resting far under the market, holds 60 of the 70 USDC: 10 free, less than the 20 a slot spends.
  await signedOnVenue(venue, privateKeyToAccount(state('walletKey')), {
    kind: 'place_order',
    symbol: state('markets')[0].symbol,
    side: 'buy',
    type: 'limit',
    amount: '12',
    price: '5',
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${J}:hold:${Date.now().toString(36)}`,
    builderFee: null,
  });
  expect(toUnits((await venueBalance(owner, 'USDC')).free)).toBe(toUnits('10'));
  const short = await nextSlot(ruleId, 3);
  expect(short.status).toBe('suspended_insufficient_funds');
  expect(short.slots[2].outcome).toBe('skipped_insufficient_funds');
  expect(toUnits((await venueBalance(owner, 'USDC')).free)).toBe(toUnits('10'));

  // One notice, in the inbox, however often the rule is looked at while it stays short.
  await signIn(page, who);
  await page.goto('/notifications');
  const notice = page.getByTestId('nf-row').filter({ hasText: 'Recurring buy paused: not enough USDC' });
  await expect(notice).toHaveCount(1, { timeout: 30_000 });
  await expect(notice).not.toContainText(/trade\.[a-z_]+|notify\.[a-z_]+/);
  await page.goto('/trade/bots/dca');
  const row = page
    .getByRole('table', { name: 'My recurring buys' })
    .getByRole('row')
    .filter({ hasText: state('basketLine') });
  await expect(row).toContainText('Suspended: not enough funds');

  // Funds arrive: the rule resumes, once, and buys nothing until its next slot.
  await testDeposit(owner, 'USDC', '100', `${venue.chainId}:0x${randomBytes(32).toString('hex')}:0`);
  await expect.poll(async () => (await rule(who, ruleId)).status, { timeout: 30_000 }).toBe('active');
  const resumed = await rule(who, ruleId);
  expect(resumed.slots).toHaveLength(3);
  expect(toUnits((await venueBalance(owner, 'USDC')).free)).toBe(toUnits('110'));
  await page.goto('/notifications');
  await expect(page.getByTestId('nf-row').filter({ hasText: 'Recurring buy paused: not enough USDC' })).toHaveCount(1);
});

test(`${J} #7 leaves max investment blank and later terminates: no auto-close and the field reads "Not set"; terminate converts once`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = state('who');
  const ruleId = state('ruleId');
  // With no maximum, a slot past what any maximum would allow still buys: the rule never closes itself.
  const more = await nextSlot(ruleId, 4);
  expect([more.status, more.maxInvestment, more.slots[3].outcome]).toEqual(['active', null, 'bought']);
  const box = await openManage(page);
  await expect(box.getByText('Most to invest', { exact: true })).toBeVisible();
  await expect(box).toContainText(/Most to invest\s*Not set/);
  await box.getByRole('button', { name: 'End this recurring buy', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'End this recurring buy?' }).getByRole('button', { name: 'End and convert to USDC' }).click();
  await expect(box.getByRole('status')).toHaveText('Ended. What it bought was sold once.');
  const ended = await rule(who, ruleId);
  expect([ended.status, ended.nextRunAt]).toEqual(['terminated', null]);
  // Each coin it bought is sold once, as one venue order under its own key, at the maker's bid.
  expect(ended.conversions.map((c) => [c.orderKey, c.status])).toEqual(
    state('markets').map((m) => [`recurring:${ruleId}:convert:${m.symbol}`, 'filled']),
  );
  const usdc = (await venueBalance(state('owner'), 'USDC')).free;
  // Ending it again sends nothing more, and no slot runs again.
  const again = await (await api(who)).post(`${RULES}.terminate`, { ruleId });
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body.result.data.conversions).toEqual(ended.conversions);
  expect((await venueBalance(state('owner'), 'USDC')).free).toBe(usdc);
});

test(`${J} #8 opens the share page: cost always shown; value reads "Not set" without a mark feed; the profit percentage appears with a feed; the share sheet makes no server write`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = state('who');
  const markets = state('markets');
  // A running rule to share: one buy of 10 across the basket, made through the service (the form is #2's).
  const made = await (
    await api(who)
  ).post(`${RULES}.create`, {
    clientRequestId: `${J}-share-${Date.now().toString(36)}`,
    owner: state('owner'),
    funding: 'venue',
    basket: markets.map((m, i) => ({ symbol: m.symbol, weightPct: ['50', '30', '20'][i] })),
    amount: '10',
    frequency: 'weekly',
  });
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  const ruleId = made.body.result.data.ruleId;
  run.write({ shareRuleId: ruleId });
  await expect.poll(async () => (await rule(who, ruleId)).slots.filter((s) => s.outcome === 'bought').length).toBe(1);

  // No mark on one coin: the maker's bid on it is pulled, so the venue has no mid to price it by.
  await otherTraderRun(MAKER, {
    kind: 'cancel_order',
    symbol: markets[1].symbol,
    clientOrderKey: `order:${MAKER}:${markets[1].symbol}:buy:start`,
  });
  const writes = [];
  page.on('request', (req) => req.method() !== 'GET' && req.url().includes('/api/') && writes.push(req.url()));
  await signIn(page, who);
  writes.length = 0;
  await page.goto(`/trade/bots/dca?share=${encodeURIComponent(ruleId)}`);
  const card = page.getByRole('region', { name: 'Recurring buy result' });
  await expect(card).toContainText(/Cost\s*10 USDC/);
  await expect(card).toContainText(/Value\s*Not set/);
  await expect(card).not.toContainText('Profit');

  // With a mark on every coin again: the value and the profit percentage, from the venue's mid of 9.95.
  await rest(markets[1].symbol, 'buy', 'again');
  const priced = await rule(who, ruleId);
  expect(priced.result.cost).toBe('10');
  expect(priced.result.value).not.toBeNull();
  await page.reload();
  await expect(card).toContainText(/Cost\s*10 USDC/);
  await expect(card).toContainText(new RegExp(`Value\\s*${priced.result.value.replace('.', '\\.')}`));
  await expect(card).toContainText(/Profit\s*-?[0-9.]+%/);

  // The share sheet only offers the words to copy: no write leaves the page from opening it on (the reload above may
  // refresh the session, which is the sign-in's own write, not the sheet's).
  writes.length = 0;
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Share your result' });
  await expect(sheet.getByTestId('recurring-share-text')).toContainText('Cost 10 USDC');
  await expect(sheet.getByTestId('recurring-share-text')).toContainText('Profit');
  expect(writes).toEqual([]);
});

// Last on purpose: #3 is not built and fails at its first missing part, and a failed test starts a new worker for what
// follows it, which would leave the steps after it without the rule they act on. #7 ended the first rule, so it acts on #8's,
// which is still running.
test(`${J} #3 sets a target savings pool: each run routes the bought asset to flexible savings under its own key`, async ({ page }) => {
  const ruleId = state('shareRuleId');
  const box = await openManage(page, { newest: true });
  await box.getByLabel('Send what I buy to', { exact: true }).selectOption('Flexible savings', UNBUILT);
  await box.getByRole('button', { name: 'Save', exact: true }).click();
  const routed = await nextSlot(ruleId, 2);
  expect(routed.slots.at(-1).savingsKey).toMatch(new RegExp(`^recurring:${ruleId}:`));
});
