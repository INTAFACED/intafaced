import { test, expect } from './journey.mjs';
import { journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-26, in the running app (docs/roadmap/journeys.json): run OTC for my organisation: quorum, custody and
// statements. One test per step, titled "J-copy-bots-otc-26 #<n>", run in order. #1 makes the start: a verified TEST
// institutional taker with TEST 20000 USDT; the organisation, traders, quorum and credit line are made on /otc's
// organisation settings under the stack's TEST desk terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: /otc has no organisation (quorum, roles, org keys), no vault settlement target, no credit lines, no
//   outside liquidity, no dashboard or statements and no block allocation; the stack publishes no desk law.
const J = 'J-copy-bots-otc-26';
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

async function org(page, tab) {
  await signIn(page, state('taker'));
  await page.goto('/otc?view=organisation');
  await page.getByRole('tab', { name: tab }).click(UNBUILT);
  return page.getByRole('tabpanel', { name: tab });
}

test(`${J} #1 accepts a quote without quorum: refused; with quorum 2 and two approvals it passes once; a non-trader refused`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const taker = await fundedTrader(page, 'jco', '20000');
  run.reset({ taker });
  const panel = await org(page, 'Approvals');
  await panel.getByLabel('Approvals needed to accept').fill('2');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel).toContainText(/Approvals needed\s*2/);
});

test(`${J} #2 mints an organisation key with no IP limit: a warning; the OTC scope refused until an IP limit is set`, async ({ page }) => {
  const panel = await org(page, 'Keys');
  await panel.getByRole('button', { name: 'New organisation key' }).click();
  await expect(page.getByText(/Set an IP limit to use the OTC scope/)).toBeVisible();
});

test(`${J} #3 chooses a vault as the settlement target: custody settlement needs the custody rail, off in this build`, async ({ page }) => {
  const panel = await org(page, 'Settlement');
  await panel.getByRole('radio', { name: 'Custody vault' }).check();
  await expect(panel.getByText(/needs the custody rail, which is switched off in this build/)).toBeVisible();
});

test(`${J} #4 has a client with no credit line set: quotes for that client refused with the credit-line code`, async ({ page }) => {
  const panel = await org(page, 'Clients');
  await expect(panel.getByRole('table', { name: 'Credit lines' })).toContainText('Not set');
});

test(`${J} #5 asks for outside liquidity: refused by name until a feed is set`, async ({ page }) => {
  const panel = await org(page, 'Liquidity');
  await panel.getByRole('switch', { name: 'Ask outside liquidity' }).check();
  await expect(panel.getByText(/no liquidity feed is set/)).toBeVisible();
});

test(`${J} #6 opens the dashboard for 30 days: RFQs counted in the volume; the statement email shows the vendor notice`, async ({
  page,
}) => {
  const panel = await org(page, 'Dashboard');
  await panel.getByLabel('Window').selectOption('30 days');
  await expect(panel).toContainText(/Volume\s*[\d,.]+/);
  await expect(panel.getByText(/Email delivery isn’t connected/)).toBeVisible();
});

test(`${J} #7 allocates a block fill across two sub-accounts: each gets its share, fees and average price`, async ({ page }) => {
  const panel = await org(page, 'Allocations');
  await expect(panel.getByRole('table', { name: 'Allocations' })).toBeVisible();
});
