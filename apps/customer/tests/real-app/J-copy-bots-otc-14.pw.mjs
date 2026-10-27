import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, api, bestPrices, fromUnits, fund, journeyState, signOutBrowser, toUnits, tool } from './stack.mjs';
import { awayBid, fundedTrader, signIn, signUp } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-copy-bots-otc-14, in the running app (docs/roadmap/journeys.json): start a spot grid bot and watch it earn. One test
// per step, titled "J-copy-bots-otc-14 #<n>", run in order on one verified TEST account funded with 2000 TEST USDT. The
// grid runs on the real TEST BTC/USDT book; its levels, profit and withdrawals are read back from the service.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the stack sets no TEST bots verification level (TRADE_BOTS_VERIFICATION_LEVEL), so svc-trade refuses every bot
//   create ("The verification level required for bots is not set"); and My bots is the list this browser remembers
//   (BotsRoom refsKey), not the service's.
// - #2 to #7: there is no grid service. The catalogue's Grid row reads "Not built" and its button is disabled. #5 also
//   needs a stack tool that moves the TEST book past a price (`local-test-market.mjs move`), not written yet.
const J = 'J-copy-bots-otc-14';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const trpc = (proc, input) => `/api/trade/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
const catalogue = (page) => page.getByRole('table', { name: 'Bot catalogue' });
const gridRow = (page) => catalogue(page).getByRole('row', { name: /^Grid/ });
const wizard = (page) => page.getByRole('dialog', { name: 'Set up a grid bot' });

/** Opens the grid wizard from the catalogue's Grid row. */
async function openGridWizard(page) {
  await page.goto('/trade/bots');
  await gridRow(page).getByRole('button', { name: 'Set up' }).click(UNBUILT);
  await expect(wizard(page)).toBeVisible();
}

/** The person's grid bots as the service lists them. */
async function gridBots(who) {
  const { status, body } = await (await api(who)).get(trpc('bots.list', { kind: 'grid' }));
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data.items;
}

test(`${J} #1 opens Bots: one status and one link per bot type, a refusal names its reason, My bots comes from the server in a new browser`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jgr', '2000');
  run.reset({ trader });
  await signIn(page, trader);
  await page.goto('/trade/bots');
  await expect(page.getByRole('heading', { name: 'Bots', level: 1 })).toBeVisible();
  const rows = catalogue(page).getByRole('row');
  // A header row and one row per bot type.
  await expect(rows).toHaveCount(7);
  for (const name of ['Time-weighted (TWAP)', 'Volume-weighted (VWAP)', 'Participation (POV)', 'Grid', 'Recurring buy (DCA)']) {
    const row = catalogue(page).getByRole('row', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}`) });
    await expect(row.getByRole('button')).toHaveCount(1);
    // A status word in every row; a type that can't start says why in words, with no raw code.
    await expect(row).toContainText(/Ready|Checking|Needs trading history|Switched off|Not built|Paper only/);
    await expect(row).not.toContainText(/trade\.[a-z_]+/);
  }

  // A bot the service holds, made through the person's own door: a TWAP buy resting far under the book.
  const limitPrice = await awayBid(50);
  const made = await (
    await api(trader)
  ).post('/api/trade/trpc/algo.createTwap', {
    symbol: 'BTC/USDT',
    side: 'buy',
    totalQty: '0.002',
    durationMs: 600_000,
    sliceIntervalMs: 60_000,
    limitPrice,
    clientAlgoId: `${J}-1-${Date.now().toString(36)}`,
    kind: 'twap',
  });
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  const id = made.body.result.data.id;
  run.write({ twap: id });

  // A new browser has nothing remembered, so the row can only come from the service.
  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  try {
    await signIn(other, trader);
    await other.goto('/trade/bots?tab=mine');
    await expect(other.getByRole('table', { name: 'My bots' }).getByRole('row', { name: /TWAP BTC\/USDT/ })).toBeVisible(UNBUILT);
  } finally {
    await fresh.close();
  }
});

test(`${J} #2 opens the grid wizard below the owner's verification level: refused as verification insufficient, and no bot is written`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Verified only at Basic; the TEST bot verification level is Full.
  const basic = await signUp(page, 'jgb');
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: 'Basic' });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  tool('local-test-gates.mjs', 'verify');
  fund(basic.email, 'USDT', '500');
  await signOutBrowser(page.context());
  await signIn(page, basic);

  await openGridWizard(page);
  await expect(wizard(page).getByText('Reference trade.bots_verification_insufficient')).toBeVisible();
  await expect(wizard(page).getByRole('button', { name: 'Review grid' })).toHaveCount(0);
  expect(await gridBots(basic)).toHaveLength(0);
});

test(`${J} #3 opens presets: with no backtest source the list reads "Not set" and shows no APR`, async ({ page }) => {
  await signIn(page, state('trader'));
  await openGridWizard(page);
  await wizard(page).getByRole('tab', { name: 'Presets' }).click();
  const presets = wizard(page).getByRole('region', { name: 'Presets' });
  await expect(presets.getByText('Not set')).toBeVisible();
  await expect(presets).not.toContainText(/APR\s*[\d.]+\s*%/);
});

test(`${J} #4 enters blank bounds, then 1 grid, then 20 grids: the first two refused by field, twenty levels planned, the same key returns the same bot`, async ({
  page,
}) => {
  const trader = state('trader');
  await signIn(page, trader);
  await openGridWizard(page);
  const box = wizard(page);
  await box.getByRole('tab', { name: 'Manual' }).click();
  await box.getByLabel('Market').selectOption('BTC/USDT');
  await box.getByLabel('Investment (USDT)').fill('500');

  // Blank bounds: refused naming the fields, nothing sent.
  await box.getByLabel('Number of grids').fill('20');
  await box.getByRole('button', { name: 'Review grid' }).click();
  await expect(box.getByText('Enter a lower price.')).toBeVisible();
  await expect(box.getByText('Enter an upper price.')).toBeVisible();

  // A range around the book, so the grid has buys under the price and sells over it.
  const { bid, ask } = await bestPrices();
  const one = toUnits('1');
  const lower = fromUnits(((toUnits(bid) * 95n) / 100n / one) * one);
  const upper = fromUnits(((toUnits(ask) * 105n) / 100n / one) * one);
  await box.getByLabel('Lower price').fill(lower);
  await box.getByLabel('Upper price').fill(upper);
  await box.getByLabel('Number of grids').fill('1');
  await box.getByRole('button', { name: 'Review grid' }).click();
  await expect(box.getByText('A grid needs at least 2 levels.')).toBeVisible();

  await box.getByLabel('Number of grids').fill('20');
  await box.getByRole('button', { name: 'Review grid' }).click();
  const review = page.getByRole('dialog', { name: 'Review your grid' });
  await expect(review.getByRole('list', { name: 'Grid levels' }).getByRole('listitem')).toHaveCount(20);
  const created = page.waitForResponse((res) => res.url().includes('bots.createGrid') && res.request().method() === 'POST');
  await review.getByRole('button', { name: 'Start grid bot' }).click();
  const answer = await created;
  expect(answer.status(), (await answer.text()).slice(0, 300)).toBe(200);
  const sent = answer.request().postDataJSON();
  const bot = (await answer.json()).result.data;
  run.write({ grid: bot.id, lower, upper });

  // The reserve is the investment, held from the free balance.
  const balances = await (await api(trader)).balances();
  expect(toUnits(balances.USDT.used)).toBeGreaterThanOrEqual(toUnits('500'));

  // The same request again (same key) answers with the same bot and holds nothing more.
  const again = await (await api(trader)).post('/api/trade/trpc/bots.createGrid', sent);
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body.result.data.id).toBe(bot.id);
  expect(await gridBots(trader)).toHaveLength(1);
});

test(`${J} #5 lets the price leave the upper bound: no new buy is placed and the range pause shows`, async ({ page }) => {
  test.setTimeout(180_000);
  const trader = state('trader');
  const id = state('grid');
  await signIn(page, trader);
  // The stack moves the TEST book over the grid's upper bound (the market maker requotes there).
  tool('local-test-market.mjs', 'move', 'BTC/USDT', String(Math.round(Number(state('upper')) * 1.02)));
  const bot = async () => (await (await api(trader)).get(trpc('bots.get', { botId: id }))).body.result.data;
  await expect.poll(async () => (await bot()).state, { timeout: 60_000 }).toBe('range_paused');
  const buys = (await bot()).levels.filter((l) => l.side === 'buy' && l.status === 'open').length;
  await page.waitForTimeout(20_000);
  expect((await bot()).levels.filter((l) => l.side === 'buy' && l.status === 'open').length).toBeLessThanOrEqual(buys);
  await page.goto(`/trade/bots?tab=mine&bot=${encodeURIComponent(id)}`);
  await expect(page.getByText('Paused: the price is above your range')).toBeVisible(UNBUILT);
});

test(`${J} #6 opens Metrics after two closed level pairs: grid profit is their sum net of fees, and a zero-day APR reads "Not set"`, async ({
  page,
}) => {
  const trader = state('trader');
  const id = state('grid');
  await signIn(page, trader);
  const { body } = await (await api(trader)).get(trpc('bots.get', { botId: id }));
  const bot = body?.result?.data;
  expect(bot, JSON.stringify(body).slice(0, 300)).toBeTruthy();
  const pairs = bot.closedPairs ?? [];
  expect(pairs.length, 'two level pairs have closed').toBeGreaterThanOrEqual(2);
  const net = pairs.reduce((sum, p) => sum + toUnits(p.profit) - toUnits(p.fees), 0n);
  await page.goto(`/trade/bots?tab=mine&bot=${encodeURIComponent(id)}`);
  const detail = page.getByRole('dialog', { name: /Grid BTC\/USDT/ });
  await detail.getByRole('tab', { name: 'Metrics' }).click(UNBUILT);
  await expect(detail.getByTestId('grid-profit')).toHaveText(new RegExp(fromUnits(net).replace('.', '\\.')));
  // The bot is less than a day old.
  await expect(detail.getByTestId('grid-apr')).toHaveText('Not set');
});

test(`${J} #7 withdraws over the cap, then within it with no step-up: both refused; within both it succeeds with a receipt`, async ({
  page,
}) => {
  const trader = state('trader');
  const id = state('grid');
  await signIn(page, trader);
  await page.goto(`/trade/bots?tab=mine&bot=${encodeURIComponent(id)}`);
  const detail = page.getByRole('dialog', { name: /Grid BTC\/USDT/ });
  await detail.getByRole('button', { name: 'Withdraw profit' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Withdraw from this bot' });
  const cap = (await sheet.getByTestId('grid-withdraw-cap').innerText()).replace(/[^\d.]/g, '');
  expect(cap).toMatch(/^\d/);
  await sheet.getByLabel('Amount (USDT)').fill(fromUnits(toUnits(cap) + toUnits('1')));
  await sheet.getByRole('button', { name: 'Withdraw' }).click();
  await expect(sheet.getByText(/more than you can withdraw/)).toBeVisible();

  // Within the cap, sent without the step-up token: refused at the service.
  const bare = await (await api(trader)).post('/api/trade/trpc/bots.withdraw', { botId: id, amount: '1', requestId: `${J}-7-bare` });
  expect(bare.status).toBe(403);
  expect(JSON.stringify(bare.body)).toContain('step_up');

  // The step-up needs a second factor: the person adds an authenticator app and answers with its next code.
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const factor = await addAuthenticator(page, totp);
  const before = await (await api(trader)).balances();
  await page.goto(`/trade/bots?tab=mine&bot=${encodeURIComponent(id)}`);
  await detail.getByRole('button', { name: 'Withdraw profit' }).click();
  await sheet.getByLabel('Amount (USDT)').fill('1');
  await sheet.getByRole('button', { name: 'Withdraw' }).click();
  const stepUp = page.getByRole('dialog', { name: 'Confirm it’s you' });
  const { code } = await nextCode(totp, factor.secret, factor.step);
  await stepUp.getByLabel('Authenticator code or recovery code').fill(code);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('dialog', { name: 'Withdrawal receipt' })).toContainText('1 USDT');
  const after = await (await api(trader)).balances();
  expect(toUnits(after.USDT.free) - toUnits(before.USDT.free)).toBe(toUnits('1'));
});
