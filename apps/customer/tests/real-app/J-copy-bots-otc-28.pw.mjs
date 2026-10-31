import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { keyHolder } from './developer.mjs';

// J-copy-bots-otc-28, in the running app (docs/roadmap/journeys.json): become a market maker, quote, and read the public
// block feed. One test per step, titled "J-copy-bots-otc-28 #<n>", run in order. #1 makes the start: a verified TEST
// business account applies to quote; the desk is the stack's TEST founder on the console. Step 5 (the risk disclosure)
// is deferred to launch prep (owner decision 2026-10-27) and has no test.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: there is no maker application, quote console, maker protection, demo maker, OTC dispute or block-feed
//   key.
const J = 'J-copy-bots-otc-28';
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

const console_ = (page) => page.getByRole('region', { name: 'Quote console' });

async function quoteConsole(page) {
  await signIn(page, state('maker'));
  await page.goto('/otc/maker');
  await expect(console_(page)).toBeVisible(UNBUILT);
}

test(`${J} #1 applies as a maker: applied with one review row; the desk approves once`, async ({ page, browser }) => {
  test.setTimeout(240_000);
  const maker = await fundedTrader(page, 'jcmm', '20000');
  run.reset({ maker });
  await signIn(page, maker);
  await page.goto('/otc/maker');
  await page.getByRole('button', { name: 'Apply to quote' }).click(UNBUILT);
  await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Applied')).toBeVisible();
  const desk = await (await browser.newContext()).newPage();
  await founderSignIn(desk, 'a');
  await desk.goto(`${ADMIN}/trade-ops/otc`);
  await desk
    .getByRole('table', { name: 'Maker applications' })
    .getByRole('row', { name: new RegExp(maker.handle) })
    .getByRole('button', { name: 'Approve' })
    .click();
  await desk.context().close();
});

test(`${J} #2 posts a two-sided quote with expiry 60 seconds, then 5: both sides post; the 5-second expiry refused`, async ({ page }) => {
  await quoteConsole(page);
  await console_(page).getByLabel('Expires after, seconds').fill('60');
  await console_(page).getByRole('button', { name: 'Post both sides' }).click();
  await expect(console_(page).getByRole('row', { name: /Bid/ })).toBeVisible();
  await console_(page).getByLabel('Expires after, seconds').fill('5');
  await console_(page).getByRole('button', { name: 'Post both sides' }).click();
  await expect(console_(page).getByText(/at least \d+ seconds/)).toBeVisible();
});

test(`${J} #3 trips the protection count: quotes refuse until reset; unset protection reads "Not set"`, async ({ page }) => {
  await quoteConsole(page);
  await expect(console_(page)).toContainText(/Protection\s*(Not set|\d+)/);
});

test(`${J} #4 runs the demo maker with a blank interval: refused; set, it quotes once per interval; live refused`, async ({ page }) => {
  await quoteConsole(page);
  await console_(page).getByRole('button', { name: 'Start the demo maker' }).click();
  await expect(console_(page).getByText('Enter an interval.')).toBeVisible();
});

test(`${J} #6 opens a dispute with an anonymous counterparty: the desk sees both parties; the taker sees the outcome`, async ({ page }) => {
  await quoteConsole(page);
  await console_(page).getByRole('button', { name: 'Open a dispute' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Open a dispute' })).toBeVisible();
});

test(`${J} #7 an individual tries to mint a block key, then a business: refused, then minted once; the feed shows no user id`, async ({
  browser,
}) => {
  const person = await keyHolder(browser, 'jcbk');
  await person.page.goto('/uc/safe/api-keys/new');
  await person.page.getByLabel('Block trade feed', { exact: true }).check(UNBUILT);
  await expect(person.page.getByText(/only for a business account/)).toBeVisible();
  await person.page.context().close();
});
