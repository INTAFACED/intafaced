// World: book, restart
import { randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { api, fund, journeyState, restartWith, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { approvedSeller } from './market-listing.mjs';

// J-copy-bots-otc-22, in the running app (docs/roadmap/journeys.json): publish a signal and see what it earned. One test
// per step, titled "J-copy-bots-otc-22 #<n>", run in order on one TEST provider: a TEST account verified at Full, an
// approved Market seller holding one listing slot (market-listing.mjs), with a track record of one market buy filled on
// the stack's TEST book. The signal provider criteria are the stack's labelled TEST values (Full verification, at least
// one fill of your own orders: tooling/profiles/test-owner-values/market.json); step 1 restarts svc-market with them
// blank. The sales of step 6 are TEST buyers paying the provider's monthly fee signals through the Market's own
// purchase door, at the stack's TEST house commission of 1%.
const J = 'J-copy-bots-otc-22';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const MONTH = '30';
const DAY = 86_400;

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(...keys) {
  const all = run.read();
  for (const key of keys) {
    if (!all[key]) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  }
  return all;
}

const form = (page) => page.getByRole('form', { name: 'Publish a signal' });
const query = (path, input) => `/api/market/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`;
const codeOf = (res) => res.body?.error?.data?.cause?.code ?? res.body?.error?.message;

/**
 * Presses Publish and returns svc-market's own answer to that press: its HTTP status and typed code. A refusal the
 * screen drew without asking the service has no answer, so the wait fails.
 */
async function pressPublish(page) {
  const answer = page.waitForResponse((r) => r.url().includes('/trpc/signals.publish') && r.request().method() === 'POST');
  await form(page).getByRole('button', { name: 'Publish' }).click();
  const res = await answer;
  const body = await res.json().catch(() => null);
  return { status: res.status(), code: codeOf({ body }) };
}

/** The provider's signals and vetting, as svc-market stores them. */
async function mine(who) {
  const res = await (await api(who)).get(query('signals.mine', { limit: 50 }));
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** The public list of published signals. */
async function listed() {
  const res = await (await api(state('provider').provider)).get(query('signals.list', { limit: 50 }));
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

async function openPublish(page) {
  await signIn(page, state('provider').provider);
  await page.goto('/trade/bots/signals/publish');
  await expect(form(page)).toBeVisible();
}

/** Fills the publish form: a title, a description, USDT, and the fee model with its price and period when given. */
async function fill(page, { title, fee, price, days }) {
  // Each field by its own textbox: a fee model's hint ("in one asset") also carries a field's word.
  const box = (name) => form(page).getByRole('textbox', { name: new RegExp(`^${name}\\b`) });
  await box('Title').fill(title);
  await box('Description').fill('TEST signal on the local test stack. Not real advice.');
  await box('Asset').fill('USDT');
  await form(page).getByRole('radio', { name: fee }).check();
  if (price !== undefined) await box('Price').fill(price);
  if (days !== undefined) await box('Period, days').fill(days);
}

/** A TEST buyer, verified and funded with TEST USDT, who buys one period of `listingId` through the Market's purchase door. */
async function buyer(page, prefix, listingId) {
  const who = await signUp(page, prefix);
  await verify(page, who);
  expect(fund(who.email, 'USDT', '50').tx).toBeTruthy();
  const client = await api(who);
  const bought = await client.post('/api/market/trpc/purchase', { listingId, purchaseId: randomUUID() });
  expect(bought.status, JSON.stringify(bought.body).slice(0, 300)).toBe(200);
  return { who, purchase: bought.body.result.data };
}

async function accessOf(who, listingId) {
  const res = await (await api(who)).get(query('subscriptionAccess', { listingId }));
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

test(`${J} #1 publishes with the provider criteria blank: refused as criteria not set`, async ({ page }) => {
  test.setTimeout(360_000);
  const { seller: provider } = await approvedSeller(page);
  run.reset({ provider });
  // The track record: one market buy of the provider's own, filled against the TEST book's maker.
  expect(fund(provider.email, 'USDT', '200').tx).toBeTruthy();
  const order = await (
    await api(provider)
  ).post('/api/v1/orders', {
    symbol: 'BTC/USDT',
    type: 'market',
    side: 'buy',
    amount: '0.0002',
    clientOrderId: `${J}-record-${Date.now()}`,
  });
  expect(order.status, JSON.stringify(order.body).slice(0, 300)).toBeLessThan(300);
  run.write({ recordOrderId: order.body.id });

  restartWith('market', 'LOCAL_STACK_MARKET_SIGNAL_CRITERIA', false);
  try {
    await openPublish(page);
    await expect(page.getByText('Not set by the platform. Publishing is refused until it is set.')).toBeVisible();
    await fill(page, { title: `TEST blank criteria ${provider.handle}`, fee: 'Free' });
    // svc-market refuses it by name, not the screen.
    expect(await pressPublish(page)).toEqual({ status: 412, code: 'market.provider_criteria_not_set' });
    await expect(form(page).getByRole('alert')).toContainText('Signal provider criteria are not set');
    await expect(form(page).getByRole('alert')).toContainText('Nothing was published.');
    // Nothing was written: no signal and no vetting.
    expect(await mine(provider)).toEqual({ signals: [], vetting: null });
  } finally {
    restartWith('market', 'LOCAL_STACK_MARKET_SIGNAL_CRITERIA', true);
  }
});

test(`${J} #2 publishes with a verified record: vetting passes once and the state is published`, async ({ page }) => {
  test.setTimeout(180_000);
  const { provider, recordOrderId } = state('provider', 'recordOrderId');
  // The record is the filled buy: wait until svc-trade has settled it.
  await expect
    .poll(async () => (await (await api(provider)).get(`/api/v1/orders/${recordOrderId}`)).body?.status, { timeout: 60_000 })
    .toBe('closed');
  await openPublish(page);
  await expect(page.getByRole('region', { name: 'Provider criteria' })).toContainText('Full');
  const title = `TEST monthly signal ${provider.handle}`;
  await fill(page, { title, fee: 'Monthly fee', price: '10', days: MONTH });
  await form(page).getByRole('button', { name: 'Publish' }).click();
  const done = page.getByRole('region', { name: 'Published signal' });
  await expect(done.getByRole('status')).toContainText(`Published ${title}`);
  await expect(done).toContainText(
    /Vetting passed on \d{4}-\d{2}-\d{2}: verification Full, [1-9]\d* trades of your own \(needed Full and 1\)/,
  );

  // Vetting passed once, against the criteria in force and the provider's own record; the signal is published.
  const { signals, vetting } = await mine(provider);
  expect(vetting).toMatchObject({ minTier: 'full', minFills: 1, tierSeen: 'full' });
  expect(vetting.fillsSeen).toBeGreaterThanOrEqual(1);
  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject({ title, state: 'published', feeModel: 'monthly', periodSeconds: 30 * DAY });
  expect(toUnits(signals[0].price)).toBe(toUnits('10'));
  expect(signals[0].listingId).toBeTruthy();
  run.write({ passedAt: vetting.passedAt, monthly: signals[0] });

  // The state reads published where the provider keeps their signals.
  await page.goto('/trade/bots/signals?view=mine');
  await expect(page.getByRole('row', { name: new RegExp(title) })).toContainText('Published');
});

test(`${J} #3 publishes free, monthly with a blank price, then profit share: free lists once; blank refused; profit share forbidden`, async ({
  page,
}) => {
  const { provider, passedAt } = state('provider', 'passedAt');
  await openPublish(page);
  const title = `TEST free signal ${provider.handle}`;
  await fill(page, { title, fee: 'Free' });
  await form(page).getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByRole('region', { name: 'Published signal' }).getByRole('status')).toContainText(`Published ${title}`);
  // A second press of Publish on the answered form starts a new one; the reply lost and sent again is the same signal.
  const free = (await mine(provider)).signals.find((s) => s.title === title);
  expect(free).toMatchObject({ feeModel: 'free', price: null, listingId: null, state: 'published' });
  await expect.poll(async () => (await listed()).filter((s) => s.title === title).length).toBe(1);
  await page.goto('/trade/bots/signals');
  await expect(page.getByRole('table', { name: 'Published signals' }).getByRole('row', { name: new RegExp(title) })).toHaveCount(1);

  // A monthly fee with its price left blank is refused by the service, and nothing is published.
  await openPublish(page);
  const blank = `TEST blank price ${provider.handle}`;
  await fill(page, { title: blank, fee: 'Monthly fee', days: MONTH });
  expect(await pressPublish(page)).toEqual({ status: 412, code: 'market.price_not_set' });
  await expect(form(page).getByRole('alert')).toContainText('Enter a price');
  await expect(form(page).getByRole('alert')).toContainText('A monthly fee needs its price. Nothing was published.');

  // A profit share is refused as forbidden.
  await form(page).getByRole('radio', { name: 'Profit share' }).check();
  expect(await pressPublish(page)).toEqual({ status: 412, code: 'market.strategy_profit_share_forbidden' });
  await expect(form(page).getByRole('alert')).toContainText('A profit share isn’t allowed');

  const after = await mine(provider);
  expect(after.signals.map((s) => s.title).sort()).toEqual([title, `TEST monthly signal ${provider.handle}`].sort());
  // Vetting passed once: the later publishes reused the first pass.
  expect(after.vetting.passedAt).toBe(passedAt);
});

test(`${J} #4 tries a recurring subscription: refused as not built`, async ({ page }) => {
  const { provider } = state('provider');
  await openPublish(page);
  await fill(page, { title: `TEST recurring ${provider.handle}`, fee: 'Recurring subscription' });
  expect(await pressPublish(page)).toEqual({ status: 412, code: 'market.subscription_recurring_not_built' });
  await expect(form(page).getByRole('alert')).toContainText('Recurring subscriptions aren’t built');
  await expect(form(page).getByRole('alert')).toContainText('Nothing was published.');
  expect((await mine(provider)).signals.some((s) => s.title.startsWith('TEST recurring'))).toBe(false);
});

test(`${J} #5 archives the signal: the listing withdraws and existing subscribers keep their period`, async ({ page, browser }) => {
  test.setTimeout(240_000);
  const { provider, monthly } = state('provider', 'monthly');
  // An existing subscriber: a TEST buyer pays one period of the monthly signal.
  const buyerPage = await (await browser.newContext()).newPage();
  const sub = await buyer(buyerPage, 'jcsb', monthly.listingId);
  const before = await accessOf(sub.who, monthly.listingId);
  expect(before.granted).toBe(true);
  run.write({ firstBuyer: sub.who });

  await signIn(page, provider);
  await page.goto('/trade/bots/signals?view=mine');
  const row = page.getByRole('row', { name: new RegExp(monthly.title) });
  await row.getByRole('button', { name: `Archive ${monthly.title}` }).click();
  await expect(row).toContainText('Archived');
  await expect(row).toContainText('Subscribers keep the period they paid for.');

  // The listing withdraws: out of the signal list and out of the Market; a new purchase is refused.
  expect((await listed()).some((s) => s.id === monthly.id)).toBe(false);
  await page.goto('/trade/bots/signals');
  await expect(page.getByRole('table', { name: 'Published signals' })).not.toContainText(monthly.title);
  // A new buyer, never subscribed, finds no Market listing and cannot buy: the refusal is the withdrawal's, not a repeat purchase's.
  const newcomerPage = await (await browser.newContext()).newPage();
  const newcomer = await signUp(newcomerPage, 'jcsn');
  await verify(newcomerPage, newcomer);
  expect(fund(newcomer.email, 'USDT', '50').tx).toBeTruthy();
  const client = await api(newcomer);
  const shown = await client.get(query('listing', { listingId: monthly.listingId }));
  expect({ status: shown.status, code: codeOf(shown) }).toEqual({ status: 404, code: 'market.listing_not_found' });
  const late = await client.post('/api/market/trpc/purchase', { listingId: monthly.listingId, purchaseId: randomUUID() });
  expect({ status: late.status, code: codeOf(late) }).toEqual({ status: 404, code: 'market.listing_not_found' });
  // The subscriber keeps the period they paid for, to the same second.
  const after = await accessOf(sub.who, monthly.listingId);
  expect(after).toMatchObject({ granted: true, accessUntil: before.accessUntil });
});

test(`${J} #6 opens earnings after two sales of 10 and 5 with commission 1: gross 15 and net 14 per asset`, async ({ page, browser }) => {
  test.setTimeout(420_000);
  const { provider } = state('provider', 'firstBuyer');
  // The second sale: a monthly fee signal at 5, in the slot the archive freed, bought by a second TEST buyer.
  await openPublish(page);
  const title = `TEST five signal ${provider.handle}`;
  await fill(page, { title, fee: 'Monthly fee', price: '5', days: MONTH });
  await form(page).getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByRole('region', { name: 'Published signal' }).getByRole('status')).toContainText(`Published ${title}`);
  const five = (await mine(provider)).signals.find((s) => s.title === title);
  const buyerPage = await (await browser.newContext()).newPage();
  await buyer(buyerPage, 'jcsc', five.listingId);

  // Each sale is held for the stack's two-minute refund window, then settles to the provider: earnings count settled sales.
  await signIn(page, provider);
  await page.goto('/trade/bots/signals?view=earnings');
  const earnings = page.getByRole('table', { name: 'Earnings by asset' });
  const usdtRow = earnings.getByRole('row', { name: /USDT/ });
  await expect(async () => {
    await page.reload();
    await expect(usdtRow).toContainText('2', { timeout: 5_000 });
  }).toPass({ timeout: 300_000, intervals: [10_000] });
  await expect(usdtRow.getByRole('cell').nth(2)).toHaveText('15');
  await expect(usdtRow.getByRole('cell').nth(3)).toHaveText('1');
  await expect(usdtRow.getByRole('cell').nth(4)).toHaveText('14');
  await expect(page.getByText(/Profit share\s*Not set by the platform/)).toBeVisible();
  await expect(page.getByText(/Settlement\s*Settled at sale/)).toBeVisible();
});
