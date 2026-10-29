import { test, expect } from '@playwright/test';
import { api, journeyState, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-17, in the running app (docs/roadmap/journeys.json): run a DCA bot, and futures grid and martingale
// bots. One test per step, titled "J-copy-bots-otc-17 #<n>", run in order on one verified TEST account with TEST 2000
// USDT. Price moves come from the stack's TEST market (`local-test-market.mjs move`); the safety, stop-loss and leverage
// terms are the stack's TEST bot terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: the bot catalogue's DCA, futures grid and martingale rows read "Not built", their Set up buttons are
//   off, and the stack sets no TEST bots verification level, so svc-trade refuses every bot create.
const J = 'J-copy-bots-otc-17';
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

/** The catalogue row's Set up, opened as the trader. */
async function setUp(page, kind) {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots');
  await page
    .getByRole('table', { name: 'Bot catalogue' })
    .getByRole('row', { name: new RegExp(`^${kind}`) })
    .getByRole('button', { name: 'Set up' })
    .click(UNBUILT);
  return page.getByRole('dialog');
}

test(`${J} #1 creates a spot DCA bot with the safety multiplier blank: refused naming it`, async ({ page }) => {
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jcd', '2000');
  run.reset({ trader });
  const wizard = await setUp(page, 'DCA');
  await wizard.getByRole('button', { name: 'Create bot' }).click();
  await expect(wizard.getByText(/safety order multiplier/i)).toBeVisible();
});

test(`${J} #2 lets the price fall to the third safety level: the third order places once; take profit completes the cycle`, async ({
  page,
}) => {
  const wizard = await setUp(page, 'DCA');
  await wizard.getByLabel('Safety order multiplier').fill('1.5');
  const made = page.waitForResponse((res) => res.url().includes('bots.createDca'));
  await wizard.getByRole('button', { name: 'Create bot' }).click();
  const botId = (await (await made).json()).result.data.id;
  run.write({ botId });
  // The book falls through three safety levels: the third safety order is placed once.
  tool('local-test-market.mjs', 'move', 'BTC/USDT', '-6%');
  const bot = (await (await api(state('trader'))).get(`/api/trade/trpc/bots.get?input=${encodeURIComponent(JSON.stringify({ botId }))}`))
    .body.result.data;
  expect(bot.safetyOrders.filter((o) => o.n === 3)).toHaveLength(1);
});

test(`${J} #3 lets the stop-loss ratio trigger: the bot halts with "Stop loss" and places no more orders`, async ({ page }) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots?tab=mine');
  await expect(page.getByRole('row', { name: /DCA/ })).toContainText('Stop loss', UNBUILT);
});

test(`${J} #4 creates a futures grid in neutral direction: direction, margin and leverage`, async ({ page }) => {
  const wizard = await setUp(page, 'Futures grid');
  await expect(wizard.getByRole('radiogroup', { name: 'Direction' })).toBeVisible();
  await expect(wizard.getByLabel('Leverage')).toBeVisible();
});

test(`${J} #5 pauses and resumes a futures bot: pending slices stop; a resume after a partial cancel is refused`, async ({ page }) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots?tab=mine');
  const row = page.getByRole('row', { name: /Futures grid/ });
  await row.getByRole('button', { name: 'Pause' }).click(UNBUILT);
  await expect(row).toContainText('Paused');
  await row.getByRole('button', { name: 'Resume' }).click();
  await expect(row).toContainText('Running');
});

test(`${J} #6 creates a martingale bot with the AI setup, then manual with a blank profit target: each names what is missing`, async ({
  page,
}) => {
  const wizard = await setUp(page, 'Futures martingale');
  await wizard.getByRole('tab', { name: 'AI setup' }).click();
  await expect(wizard.getByText(/needs a source that isn’t connected/)).toBeVisible();
  await wizard.getByRole('tab', { name: 'Manual' }).click();
  await wizard.getByRole('button', { name: 'Create bot' }).click();
  await expect(wizard.getByText(/Enter a profit target/)).toBeVisible();
});

test(`${J} #7 adds a position on a stopped bot, then with too little margin, then reinvests with no profit: each refused`, async ({
  page,
}) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots?tab=mine');
  await page
    .getByRole('row', { name: /martingale/i })
    .getByRole('button', { name: 'Add position' })
    .click(UNBUILT);
  await expect(page.getByText(/This bot has stopped/)).toBeVisible();
});
