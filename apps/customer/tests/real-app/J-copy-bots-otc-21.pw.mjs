import { test, expect } from './journey.mjs';
import { journeyState, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-21, in the running app (docs/roadmap/journeys.json): subscribe to a signal and run a signal bot. One
// test per step, titled "J-copy-bots-otc-21 #<n>", run in order on one verified TEST account with TEST 500 USDT. The
// signal listing is one the stack's TEST provider publishes (`local-test-world.mjs signal-listing`), and signals arrive
// from that provider (`local-test-world.mjs signal-send`).
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: there is no /trade/bots/signals room, signal listing, signal bot or bot history; the stack has no TEST
//   signal provider.
const J = 'J-copy-bots-otc-21';
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

const listing = (page) => page.getByRole('article').filter({ hasText: state('title') });

async function signals(page) {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots/signals');
  await expect(page.getByRole('heading', { name: 'Signals', level: 1 })).toBeVisible(UNBUILT);
}

test(`${J} #1 tries to create a signal bot from an unpurchased listing: refused as access required`, async ({ page }) => {
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jcs', '500');
  run.reset({ trader });
  await signIn(page, trader);
  await page.goto('/trade/bots/signals');
  await expect(page.getByRole('heading', { name: 'Signals', level: 1 })).toBeVisible(UNBUILT);
  const seeded = JSON.parse(tool('local-test-world.mjs', 'signal-listing'));
  run.write({ title: seeded.title, listingId: seeded.id });
  await page.reload();
  await listing(page).getByRole('button', { name: 'Create a bot' }).click();
  await expect(page.getByText(/Buy access to this signal first/)).toBeVisible();
});

test(`${J} #2 purchases the listing and creates the bot twice with one key: one bot`, async ({ page }) => {
  await signals(page);
  await listing(page).getByRole('button', { name: 'Buy access' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Buy' }).click();
  await listing(page).getByRole('button', { name: 'Create a bot' }).dblclick();
  await page.goto('/trade/bots?tab=mine');
  await expect(page.getByRole('row', { name: /Signal/ })).toHaveCount(1);
});

test(`${J} #3 opens the bot before any signal: "awaiting signal"`, async ({ page }) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots?tab=mine');
  await expect(page.getByRole('row', { name: /Signal/ })).toContainText(/Awaiting signal/i, UNBUILT);
});

test(`${J} #4 a signal arrives for a pair not in one-way mode, and the bot cap is reached: each refused with its code`, async ({
  page,
}) => {
  tool('local-test-world.mjs', 'signal-send', state('listingId'), '--pair', 'ETH/USDT');
  await signIn(page, state('trader'));
  await page.goto('/trade/bots?tab=mine');
  await expect(page.getByRole('row', { name: /Signal/ })).toContainText(/one-way mode/, UNBUILT);
});

test(`${J} #5 opens the bot history after three alerts and two actions: five events in order`, async ({ page }) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots?tab=mine');
  await page
    .getByRole('row', { name: /Signal/ })
    .getByRole('button', { name: 'History' })
    .click(UNBUILT);
  await expect(page.getByRole('table', { name: 'Bot history' }).locator('tbody tr')).toHaveCount(5);
});
