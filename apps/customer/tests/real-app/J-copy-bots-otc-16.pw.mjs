import { test, expect } from '@playwright/test';
import { api, journeyState, toUnits, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-16, in the running app (docs/roadmap/journeys.json): set up a recurring buy of a basket and keep it
// running. One test per step, titled "J-copy-bots-otc-16 #<n>", run in order on one verified TEST account with TEST 200
// USDT. Runs are triggered by the stack's TEST clock for recurring buys (`local-test-world.mjs recurring-tick`), which
// moves the schedule to its next slot; every rule, run and balance is read back from the service and the ledger.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: there is no recurring-order service (the bot catalogue's DCA row reads "Not built"), no basket editor on
//   a coin page and no share page; the stack has no recurring-buy clock.
const J = 'J-copy-bots-otc-16';
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
const editor = (page) => page.getByRole('dialog', { name: 'Recurring buy' });
const getRule = async (who, ruleId) => (await (await api(who)).get(trpc('recurring.get', { ruleId }))).body?.result?.data;

async function openEditor(page) {
  await page.goto('/coin/BTC');
  await page.getByRole('button', { name: 'Recurring buy' }).click(UNBUILT);
  await expect(editor(page)).toBeVisible();
}

/** Fills the basket rows: [asset, weight] pairs. */
async function basket(page, rows) {
  const box = editor(page);
  for (const [i, [asset, weight]] of rows.entries()) {
    if (i > 0) await box.getByRole('button', { name: 'Add a coin' }).click();
    await box.getByLabel(`Coin ${i + 1}`).selectOption(asset);
    await box.getByLabel(`Weight ${i + 1}, %`).fill(String(weight));
  }
}

test(`${J} #1 opens the recurring buy form from a coin page: a basket editor with weights, frequency and price range`, async ({ page }) => {
  test.setTimeout(240_000);
  const buyer = await fundedTrader(page, 'jrb', '200');
  run.reset({ buyer });
  await signIn(page, buyer);
  await openEditor(page);
  const box = editor(page);
  await expect(box.getByLabel('Weight 1, %')).toBeVisible();
  await expect(box.getByLabel('How often')).toBeVisible();
  await expect(box.getByLabel('Buy only above')).toBeVisible();
  await expect(box.getByLabel('Buy only below')).toBeVisible();
});

test(`${J} #2 enters weights totalling 90 and a range with min above max: each refused; a 50, 30, 20 basket saves`, async ({ page }) => {
  const buyer = state('buyer');
  await signIn(page, buyer);
  await openEditor(page);
  const box = editor(page);
  await basket(page, [
    ['BTC', 50],
    ['ETH', 30],
    ['IFC', 10],
  ]);
  await box.getByRole('button', { name: 'Save' }).click();
  await expect(box.getByText('The weights add up to 90%. They must add up to 100%.')).toBeVisible();
  await box.getByLabel('Weight 3, %').fill('20');
  await box.getByLabel('Buy only above').fill('100000');
  await box.getByLabel('Buy only below').fill('10');
  await box.getByRole('button', { name: 'Save' }).click();
  await expect(box.getByText('The lower price must be below the upper price.')).toBeVisible();
  await box.getByLabel('Buy only above').fill('');
  await box.getByLabel('Buy only below').fill('');
  await box.getByLabel('Amount each time (USDT)').fill('10');
  await box.getByLabel('How often').selectOption('Daily');
  const saved = page.waitForResponse((res) => res.url().includes('recurring.create'));
  await box.getByRole('button', { name: 'Save' }).click();
  const rule = (await (await saved).json()).result.data;
  expect(rule.basket.map((b) => b.weightPct)).toEqual(['50', '30', '20']);
  run.write({ ruleId: rule.id });
});

test(`${J} #3 sets a target savings pool: each run routes the bought asset to flexible savings under its own key`, async ({ page }) => {
  const buyer = state('buyer');
  await signIn(page, buyer);
  await page.goto('/trade/bots?tab=mine');
  await page
    .getByRole('row', { name: /Recurring buy/ })
    .getByRole('button', { name: 'Manage' })
    .click(UNBUILT);
  await page.getByRole('dialog').getByLabel('Send what I buy to').selectOption('Flexible savings');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  tool('local-test-world.mjs', 'recurring-tick', '--rule', state('ruleId'));
  const runs = (await getRule(buyer, state('ruleId'))).runs;
  expect(runs.at(-1).savingsKey).toMatch(new RegExp(`recurring:${state('ruleId')}:`));
});

test(`${J} #4 chooses card funding: the notice that it needs the card processor and is off in this build; nothing saved`, async ({
  page,
}) => {
  await signIn(page, state('buyer'));
  await openEditor(page);
  await editor(page).getByRole('radio', { name: 'Card' }).check();
  await expect(editor(page).getByText('Card funding needs the card processor, which is switched off in this build.')).toBeVisible();
  await expect(editor(page).getByRole('button', { name: 'Save' })).toBeDisabled();
});

test(`${J} #5 changes the amount from 10 to 20: the next slot buys 20, earlier slots unchanged`, async ({ page }) => {
  const buyer = state('buyer');
  const ruleId = state('ruleId');
  await signIn(page, buyer);
  await page.goto('/trade/bots?tab=mine');
  await page
    .getByRole('row', { name: /Recurring buy/ })
    .getByRole('button', { name: 'Manage' })
    .click(UNBUILT);
  await page.getByRole('dialog').getByLabel('Amount each time (USDT)').fill('20');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  const earlier = (await getRule(buyer, ruleId)).runs.map((r) => r.spent);
  tool('local-test-world.mjs', 'recurring-tick', '--rule', ruleId);
  const runs = (await getRule(buyer, ruleId)).runs;
  expect(runs.slice(0, earlier.length).map((r) => r.spent)).toEqual(earlier);
  expect(toUnits(runs.at(-1).spent)).toBe(toUnits('20'));
});

test(`${J} #6 runs out of funds for a slot, then adds funds: suspended for insufficient funds with one notice; funds resume it once`, async ({
  page,
}) => {
  const buyer = state('buyer');
  const ruleId = state('ruleId');
  tool('local-test-gates.mjs', 'hold', buyer.email, 'USDT', 'all');
  tool('local-test-world.mjs', 'recurring-tick', '--rule', ruleId);
  expect((await getRule(buyer, ruleId)).state).toBe('suspended_insufficient_funds');
  await signIn(page, buyer);
  await page.goto('/notifications');
  await expect(page.getByRole('article').filter({ hasText: 'Recurring buy paused: not enough USDT' })).toHaveCount(1, UNBUILT);
  tool('local-test-gates.mjs', 'release', buyer.email, 'USDT', 'all');
  await expect.poll(async () => (await getRule(buyer, ruleId)).state, { timeout: 30_000 }).toBe('active');
});

test(`${J} #7 leaves max investment blank, then terminates: no auto-close, the field reads "Not set"; terminate converts once`, async ({
  page,
}) => {
  const buyer = state('buyer');
  await signIn(page, buyer);
  await page.goto('/trade/bots?tab=mine');
  await page
    .getByRole('row', { name: /Recurring buy/ })
    .getByRole('button', { name: 'Manage' })
    .click(UNBUILT);
  const detail = page.getByRole('dialog');
  await expect(detail).toContainText(/Most to invest\s*Not set/);
  await detail.getByRole('button', { name: 'End this recurring buy' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'End and convert to USDT' }).click();
  const rule = await getRule(buyer, state('ruleId'));
  expect(rule.state).toBe('terminated');
  expect(rule.conversions).toHaveLength(1);
});

test(`${J} #8 opens the share page: cost always shown; value "Not set" without a mark feed; the share sheet writes nothing`, async ({
  page,
}) => {
  await signIn(page, state('buyer'));
  const writes = [];
  page.on('request', (req) => req.method() !== 'GET' && writes.push(req.url()));
  await page.goto(`/trade/bots/share/${encodeURIComponent(state('ruleId'))}`);
  const card = page.getByRole('region', { name: 'Recurring buy result' });
  await expect(card).toContainText(/Cost\s*[\d.]+ USDT/, UNBUILT);
  await expect(card).toContainText(/Value\s*(Not set|[\d.]+ USDT)/);
  await page.getByRole('button', { name: 'Share' }).click();
  expect(writes.filter((u) => u.includes('/api/'))).toHaveLength(0);
});
