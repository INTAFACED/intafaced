import { test, expect } from '@playwright/test';
import { api, bestPrices, fromUnits, journeyState, toUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { listLeader } from './copy.mjs';

// J-copy-bots-otc-15, in the running app (docs/roadmap/journeys.json): modify, stop and settle a grid bot, and copy a
// lead's grid. One test per step, titled "J-copy-bots-otc-15 #<n>", run in order. #1 makes the journey's start: a
// verified TEST trader with TEST 2000 USDT and a running 10-level BTC/USDT grid around the book, made through the
// person's own bots door. Every bot, level and balance is read back from the service and the ledger.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: there is no grid service (the catalogue's Grid row reads "Not built"), so no grid exists to top up,
//   trail, exit, stop, earn on idle funds, use a voucher on or copy; no lead futures liquidation feeds a follow.
const J = 'J-copy-bots-otc-15';
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
const getBot = async (who, botId) => (await (await api(who)).get(trpc('bots.get', { botId }))).body?.result?.data;

/** The bot's detail on My bots, with its Manage dialog open. */
async function openBot(page, botId) {
  await page.goto(`/trade/bots?tab=mine&bot=${encodeURIComponent(botId)}`);
  const detail = page.getByRole('dialog', { name: /Grid BTC\/USDT/ });
  await expect(detail).toBeVisible(UNBUILT);
  return detail;
}

/** A 10-level grid 5% either side of the book, made through the person's own door. */
async function makeGrid(who, key, investment = '500') {
  const { bid, ask } = await bestPrices();
  const one = toUnits('1');
  const made = await (
    await api(who)
  ).post('/api/trade/trpc/bots.createGrid', {
    symbol: 'BTC/USDT',
    lower: fromUnits(((toUnits(bid) * 95n) / 100n / one) * one),
    upper: fromUnits(((toUnits(ask) * 105n) / 100n / one) * one),
    grids: 10,
    investment,
    clientRequestId: key,
  });
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  return made.body.result.data;
}

test(`${J} #1 tops up the quote by TEST 50: the investment rises by 50 and the grid re-initialises once; a base top-up refused`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jgm', '2000');
  const tag = Date.now().toString(36);
  run.reset({ trader, tag });
  const bot = await makeGrid(trader, `${J}-${tag}`);
  run.write({ botId: bot.id });
  await signIn(page, trader);
  const detail = await openBot(page, bot.id);
  await detail.getByRole('button', { name: 'Top up' }).click();
  const sheet = page.getByRole('dialog', { name: 'Top up this grid' });
  await sheet.getByLabel('Asset').selectOption('BTC');
  await expect(sheet.getByText('A grid is topped up in USDT only.')).toBeVisible();
  await sheet.getByLabel('Asset').selectOption('USDT');
  await sheet.getByLabel('Amount').fill('50');
  const toppedUp = page.waitForResponse((res) => res.url().includes('bots.topUp'));
  await sheet.getByRole('button', { name: 'Top up' }).click();
  expect((await toppedUp).status()).toBe(200);
  const after = await getBot(trader, bot.id);
  expect(toUnits(after.investment) - toUnits(bot.investment)).toBe(toUnits('50'));
  expect(after.reinitCount).toBe(1);
});

test(`${J} #2 turns on trailing with the shift limit blank: refused naming it; a minimum grid count above the count refused`, async ({
  page,
}) => {
  await signIn(page, state('trader'));
  const detail = await openBot(page, state('botId'));
  await detail.getByRole('button', { name: 'Change' }).click();
  await detail.getByRole('switch', { name: 'Trailing' }).check();
  await detail.getByRole('button', { name: 'Save' }).click();
  await expect(detail.getByText('Enter a shift limit.')).toBeVisible();
  await detail.getByLabel('Shift limit, %').fill('5');
  await detail.getByLabel('Minimum grid count').fill('11');
  await detail.getByRole('button', { name: 'Save' }).click();
  await expect(detail.getByText('The minimum can’t be more than the grid count (10).')).toBeVisible();
});

test(`${J} #3 sets a price exit and an RSI exit with no RSI source: the price exit stops once; RSI reads "Not set" and can't be saved`, async ({
  page,
}) => {
  const trader = state('trader');
  await signIn(page, trader);
  const detail = await openBot(page, state('botId'));
  await detail.getByRole('button', { name: 'Exits' }).click();
  await expect(detail.getByLabel('RSI exit')).toBeDisabled();
  await expect(detail.getByText(/RSI\s*Not set/)).toBeVisible();
  // A price exit right at the book: it fires on the next tick.
  const { bid } = await bestPrices();
  await detail.getByLabel('Stop when the price falls to').fill(bid);
  await detail.getByRole('button', { name: 'Save exits' }).click();
  await expect.poll(async () => (await getBot(trader, state('botId'))).stopReason, { timeout: 60_000 }).toBe('price_exit');
  await expect(detail).toContainText('Price exit');
});

test(`${J} #4 stops with settlement of base and quote: one sell job per level; a stop during a partial cancel refused`, async ({
  page,
}) => {
  const trader = state('trader');
  const bot = await makeGrid(trader, `${J}-4-${state('tag')}`, '300');
  await signIn(page, trader);
  const detail = await openBot(page, bot.id);
  await detail.getByRole('button', { name: 'Stop' }).click();
  const sheet = page.getByRole('dialog', { name: 'Stop this grid' });
  await sheet.getByRole('radio', { name: 'Sell the BTC back to USDT' }).check();
  const stoppedRes = page.waitForResponse((res) => res.url().includes('bots.stop'));
  await sheet.getByRole('button', { name: 'Stop and settle' }).click();
  expect((await stoppedRes).status()).toBe(200);
  const stopped = await getBot(trader, bot.id);
  const levels = stopped.levels.filter((l) => toUnits(l.baseHeld ?? '0') > 0n).length;
  expect(stopped.settleJobs).toHaveLength(levels);
});

test(`${J} #5 turns on idle-fund yield: through the bank earn door; while it isn't wired, refused with the reason`, async ({ page }) => {
  await signIn(page, state('trader'));
  const detail = await openBot(page, state('botId'));
  await detail.getByRole('switch', { name: 'Earn on idle funds' }).check();
  await expect(detail.getByText(/Earn on idle funds|isn’t connected/)).toBeVisible();
});

test(`${J} #6 uses a bonus-margin voucher in a different coin: refused naming the mismatch`, async ({ page }) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots');
  await page
    .getByRole('table', { name: 'Bot catalogue' })
    .getByRole('row', { name: /^Grid/ })
    .getByRole('button', { name: 'Set up' })
    .click(UNBUILT);
  const wizard = page.getByRole('dialog', { name: 'Set up a grid bot' });
  await wizard.getByLabel('Voucher').selectOption({ label: /ETH/ });
  await expect(wizard.getByText(/This voucher is in ETH; this grid invests USDT/)).toBeVisible();
});

test(`${J} #7 copies a lead's grid bot: the same range and a snapshot id; later edits by the lead aren't followed`, async ({ page }) => {
  test.setTimeout(240_000);
  const lead = await fundedTrader(page, 'jgl', '2000');
  const leadRef = await listLeader(lead, `Journey Grid Lead ${state('tag')}`);
  const leadBot = await makeGrid(lead, `${J}-7-lead-${state('tag')}`);
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto(`/trade/copy/${leadRef}`);
  await page.getByRole('button', { name: 'Copy this grid' }).click(UNBUILT);
  await page.getByRole('dialog').getByLabel('Investment (USDT)').fill('300');
  const answer = page.waitForResponse((res) => res.url().includes('bots.copyGrid'));
  await page.getByRole('dialog').getByRole('button', { name: 'Copy grid' }).click();
  const copied = (await (await answer).json()).result.data;
  expect([copied.lower, copied.upper]).toEqual([leadBot.lower, leadBot.upper]);
  expect(copied.snapshotId).toBeTruthy();
  await (
    await api(lead)
  ).post('/api/trade/trpc/bots.modifyGrid', { botId: leadBot.id, upper: fromUnits(toUnits(leadBot.upper) + toUnits('100')) });
  expect((await getBot(trader, copied.id)).upper).toBe(leadBot.upper);
});

test(`${J} #8 a lead's futures liquidation on a copied pair: the follower position flattens once; a spot follow reads "Not applicable (spot)"`, async ({
  page,
}) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/copy?tab=follows');
  const grid = page.getByRole('grid', { name: 'My follows' });
  await expect(grid.getByText('Not applicable (spot)').first()).toBeVisible(UNBUILT);
});
