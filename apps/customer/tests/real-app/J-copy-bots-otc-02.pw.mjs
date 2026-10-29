import { test, expect } from '@playwright/test';
import { api, journeyState, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { copiedOrders, followOnScreen, leadFill, listLeader, openFollow, takeBest, wizardAtLimits } from './copy.mjs';

// J-copy-bots-otc-02, in the running app (docs/roadmap/journeys.json): keep my copying inside my own limits. One test per
// step, titled "J-copy-bots-otc-02 #<n>", run in order. #1 makes the journey's start: a TEST leader listed by the stack's
// TEST founder (spot, BTC/USDT and ETH/USDT), and a verified follower with TEST 1000 USDT who follows it on screen. The
// leader's trades are its own real fills on the TEST book; the follower's copies, skips and limits are read back from
// svc-trade. The failure count before auto-unfollow is the stack's TEST copy value.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the wizard offers a fixed amount only: no sizing mode choice (smart sync, multiplier refused), no mode lock.
// - #2, #3: no per-contract cap, daily cap, minimum investment or leverage limit.
// - #4: no take-profit, total-loss limit or equity trailing stop (only "Stop at a loss of").
// - #5: no copy-existing-positions switch and no slippage limit.
// - #1, #2, #4 to #6: the follow's limits can't be edited ("Change this follow" holds Pause, Stop and Leave only).
// - #7: no consecutive-failure count, auto-unfollow or notice; no stack tool holds a balance away
//   (`local-test-gates.mjs hold`) so copies fail for lack of funds.
const J = 'J-copy-bots-otc-02';
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

/** The follow's skipped mirrors as the service lists them. */
async function skips(who, followId) {
  const { status, body } = await (await api(who)).get(trpc('copy.skipLog', { followId }));
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data.items;
}

/** The follow #1 made, opened on My follows; with none made, the step stops here and says so. */
async function myFollow(page) {
  state('followId');
  return openFollow(page, state('leaderRef'));
}

test(`${J} #1 chooses a sizing mode: smart sync and fixed amount offered, multiplier refused; once active the mode is locked`, async ({
  page,
}) => {
  test.setTimeout(360_000);
  const tag = Date.now().toString(36);
  const leader = await fundedTrader(page, 'jcl2', '2000');
  const leaderName = `Journey Limits ${tag}`;
  const leaderRef = await listLeader(leader, leaderName, { assets: ['BTC/USDT', 'ETH/USDT'] });
  const follower = await fundedTrader(page, 'jcf2', '1000');
  run.reset({ tag, leader, leaderName, leaderRef, follower });

  // The follow the later steps change, made the way a person makes one.
  await signIn(page, follower);
  const followId = await followOnScreen(page, follower, leaderRef, {
    perOrder: '50',
    total: '300',
    fixed: '20',
    markets: ['BTC/USDT', 'ETH/USDT'],
  });
  run.write({ followId });

  // The sizing choice, on the wizard for a second leader (one follow per leader).
  const other = await fundedTrader(page, 'jcl2b', '100');
  const otherRef = await listLeader(other, `Journey Limits B ${tag}`);
  await signIn(page, follower);
  const wizard = await wizardAtLimits(page, otherRef);
  const sizing = wizard.getByRole('radiogroup', { name: 'How each copy is sized' });
  await expect(sizing.getByRole('radio', { name: 'Smart sync' })).toBeVisible(UNBUILT);
  await expect(sizing.getByRole('radio', { name: 'Fixed amount' })).toBeVisible();
  await sizing.getByRole('radio', { name: 'Multiplier' }).check();
  await expect(wizard.getByText('Multiplier sizing is not offered: the platform has not decided it.')).toBeVisible();
  await page.keyboard.press('Escape');

  // Once the follow is active its mode is locked.
  const detail = await myFollow(page);
  await detail.getByRole('button', { name: 'Edit limits' }).click(UNBUILT);
  await detail.getByRole('radio', { name: 'Smart sync' }).check();
  await detail.getByRole('button', { name: 'Save changes' }).click();
  await expect(detail.getByText('The sizing mode can’t change while the follow is active.')).toBeVisible();
});

test(`${J} #2 sets a per-contract cap, a daily cap, a minimum investment and a leverage limit: no leverage field on a spot follow`, async ({
  page,
}) => {
  await signIn(page, state('follower'));
  const detail = await myFollow(page);
  await detail.getByRole('button', { name: 'Edit limits' }).click(UNBUILT);
  await detail.getByLabel('Most per contract (USDT)').fill('25', UNBUILT);
  await detail.getByLabel('Most per day (USDT)').fill('100');
  await expect(detail.getByText(/Minimum investment: [\d.]+ USDT/)).toBeVisible();
  // A spot follow has no leverage to limit, so no field asks for one.
  await expect(detail.getByLabel(/Leverage/)).toHaveCount(0);
  await detail.getByRole('button', { name: 'Save changes' }).click();
  await expect(detail).toContainText(/Most per contract\s*25 USDT/);
  await expect(detail).toContainText(/Most per day\s*100 USDT/);
});

test(`${J} #3 a lead order past the per-contract cap: refused with the cap code, while orders on other contracts still copy`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const [leader, follower, followId, tag] = ['leader', 'follower', 'followId', 'tag'].map(state);
  // The leader buys BTC worth more than the follower's 25 USDT per-contract cap at 20 a copy, twice; then ETH once.
  await takeBest(leader, 'buy', '0.001', `${J}-3-btc1-${tag}`);
  await takeBest(leader, 'buy', '0.001', `${J}-3-btc2-${tag}`);
  await leadFill(leader, 'buy', '0.01', `${J}-3-eth-${tag}`, 'ETH/USDT');
  await expect.poll(async () => (await skips(follower, followId)).map((s) => s.reason), { timeout: 60_000 }).toContain('per_contract_cap');
  await signIn(page, follower);
  const detail = await myFollow(page);
  await expect(copiedOrders(detail).filter({ hasText: 'ETH/USDT' })).toHaveCount(1);
});

test(`${J} #4 sets stop-loss, take-profit, total-loss limit and equity trailing stop: loosening a stop-loss is refused`, async ({
  page,
}) => {
  await signIn(page, state('follower'));
  const detail = await myFollow(page);
  await detail.getByRole('button', { name: 'Edit limits' }).click(UNBUILT);
  await detail.getByLabel('Take profit at (USDT)').fill('50', UNBUILT);
  await detail.getByLabel('Stop at a loss of (USDT)').fill('20');
  await detail.getByLabel('Stop all copying at a total loss of (USDT)').fill('60');
  await detail.getByLabel('Equity trailing stop, %').fill('10');
  await detail.getByRole('radio', { name: 'Close copied positions when it is reached' }).check();
  await detail.getByRole('button', { name: 'Save changes' }).click();
  await expect(detail).toContainText(/Take profit at\s*50 USDT/);

  // Raising the stop-loss after it is set would loosen it: refused by name.
  await detail.getByRole('button', { name: 'Edit limits' }).click(UNBUILT);
  await detail.getByLabel('Stop at a loss of (USDT)').fill('40');
  await detail.getByRole('button', { name: 'Save changes' }).click();
  await expect(detail.getByText('A stop-loss can only be tightened.')).toBeVisible();
});

test(`${J} #5 turns copying of existing positions off and on, and sets a slippage limit: a fill past it is skipped with no ledger row`, async ({
  page,
}) => {
  await signIn(page, state('follower'));
  const detail = await myFollow(page);
  await detail.getByRole('button', { name: 'Edit limits' }).click(UNBUILT);
  const existing = detail.getByRole('switch', { name: 'Copy the leader’s positions opened before I followed' });
  await expect(existing).toBeVisible(UNBUILT);
  await expect(existing).not.toBeChecked();
  await detail.getByLabel('Slippage limit, %').fill('0.01');
  await detail.getByRole('button', { name: 'Save changes' }).click();
  // A lead buy that walks the book: the follower's copy would fill further than 0.01% away, so it is skipped.
  const before = await (await api(state('follower'))).balances();
  await takeBest(state('leader'), 'buy', '0.002', `${J}-5-${state('tag')}`);
  await expect
    .poll(async () => (await skips(state('follower'), state('followId'))).map((s) => s.reason), { timeout: 60_000 })
    .toContain('slippage_limit');
  expect(await (await api(state('follower'))).balances()).toEqual(before);
});

test(`${J} #6 adjusts the investment below current exposure, then above the free balance: each refused with its code`, async ({ page }) => {
  await signIn(page, state('follower'));
  const detail = await myFollow(page);
  await detail.getByRole('button', { name: 'Edit limits' }).click(UNBUILT);
  await detail.getByLabel('Most in total (USDT)').fill('1', UNBUILT);
  await detail.getByRole('button', { name: 'Save changes' }).click();
  await expect(detail.getByText(/below what this follow already uses/)).toBeVisible();
  await detail.getByLabel('Most in total (USDT)').fill('100000');
  await detail.getByRole('button', { name: 'Save changes' }).click();
  await expect(detail.getByText('That is more than your free USDT')).toBeVisible();
});

test(`${J} #7 lets the TEST number of consecutive failures pass: the follow auto-unfollows, with a notice naming the reason and next step`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const follower = state('follower');
  // The follower's USDT goes elsewhere (a hold on the desk), so each copy fails for lack of funds.
  tool('local-test-gates.mjs', 'hold', follower.email, 'USDT', 'all');
  for (let i = 0; i < 5; i++) await takeBest(state('leader'), 'buy', '0.0005', `${J}-7-${i}-${state('tag')}`);
  await signIn(page, follower);
  await page.goto('/trade/copy?tab=follows');
  await expect(page.getByRole('grid', { name: 'My follows' })).toContainText('Unfollowed automatically', { timeout: 60_000 });
  await page.goto('/notifications');
  const notice = page
    .getByRole('article')
    .filter({ hasText: state('leaderName') })
    .first();
  await expect(notice).toContainText(/copies failed in a row/);
  await expect(notice).not.toContainText(/trade\.[a-z_]+/);
});
