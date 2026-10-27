import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { copiedOrders, followOnScreen, leadFill, listLeader, openFollow } from './copy.mjs';

// J-copy-bots-otc-12, in the running app (docs/roadmap/journeys.json): two founders pause copy or bots by lead, bot type
// or symbol on the console's /trade-ops/kill-switch. One test per step, titled "J-copy-bots-otc-12 #<n>", run in order.
// #1 makes the start: a TEST leader listed by the stack's TEST founder and a verified follower copying it, with one
// copied buy. Mirrors, bot slices and positions are read back from svc-trade.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - every step: the kill switch room halts markets only; it has no copy or bot scope (by lead, by bot type, by symbol for
//   copy and bots), and no grid bot exists to pause (J-copy-bots-otc-14).
const J = 'J-copy-bots-otc-12';
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

/** A founder on the kill switch room, with the copy and bots scope open. */
async function killSwitch(browser, key = 'a') {
  const page = await (await browser.newContext()).newPage();
  await founderSignIn(page, key);
  await page.goto(`${ADMIN}/trade-ops/kill-switch`);
  await page.getByRole('tab', { name: 'Copy and bots' }).click(UNBUILT);
  return page;
}

/** Founder A asks, founder B confirms. */
async function twoFounders(browser, ask) {
  const a = await killSwitch(browser, 'a');
  await ask(a);
  await a.getByRole('button', { name: 'Ask for a second founder' }).click();
  const b = await killSwitch(browser, 'b');
  await b
    .getByRole('table', { name: 'Waiting for a second founder' })
    .locator('tbody tr')
    .first()
    .getByRole('button', { name: 'Confirm' })
    .click();
  await a.context().close();
  await b.context().close();
}

test(`${J} #1 pauses one lead: its next mirror is refused as paused by the platform, and existing positions keep running`, async ({
  page,
  browser,
}) => {
  test.setTimeout(360_000);
  const tag = Date.now().toString(36);
  const leader = await fundedTrader(page, 'jcl12', '2000');
  const leaderName = `Journey Pause ${tag}`;
  const leaderRef = await listLeader(leader, leaderName);
  const follower = await fundedTrader(page, 'jcf12', '1000');
  run.reset({ tag, leader, leaderName, leaderRef, follower });
  await signIn(page, follower);
  await followOnScreen(page, follower, leaderRef, { perOrder: '50', total: '300', fixed: '20' });
  await leadFill(leader, 'buy', '0.001', `${J}-1-a-${tag}`);
  await expect(async () => {
    await expect(copiedOrders(await openFollow(page, leaderRef))).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  const holding = (await (await api(follower)).balances()).BTC.total;

  await twoFounders(browser, async (a) => {
    await a.getByLabel('Scope').selectOption('Lead');
    await a.getByLabel('Lead').fill(leaderRef);
  });
  await leadFill(leader, 'buy', '0.001', `${J}-1-b-${tag}`);
  await page.waitForTimeout(10_000);
  await expect(copiedOrders(await openFollow(page, leaderRef))).toHaveCount(1);
  expect((await (await api(follower)).balances()).BTC.total).toBe(holding);
});

test(`${J} #2 pauses a bot type such as grid: a new grid refused, running grids continue`, async ({ page, browser }) => {
  await twoFounders(browser, async (a) => {
    await a.getByLabel('Scope').selectOption('Bot type');
    await a.getByLabel('Bot type').selectOption('Grid');
  });
  await signIn(page, state('follower'));
  await page.goto('/trade/bots');
  await expect(page.getByRole('table', { name: 'Bot catalogue' }).getByRole('row', { name: /^Grid/ })).toContainText(
    'Paused by the platform',
  );
});

test(`${J} #3 halts a symbol: copy mirrors and bot slices on it stop`, async ({ page, browser }) => {
  await twoFounders(browser, async (a) => {
    await a.getByLabel('Scope').selectOption('Symbol');
    await a.getByLabel('Symbol').fill('ETH/USDT');
  });
  await signIn(page, state('follower'));
  await page.goto('/trade/copy?tab=follows');
  await expect(page.getByText('Copying on ETH/USDT is paused by the platform.')).toBeVisible();
});

test(`${J} #4 tries a pause with one founder: refused`, async ({ browser }) => {
  const a = await killSwitch(browser, 'a');
  await a.getByLabel('Scope').selectOption('Lead');
  await a.getByLabel('Lead').fill(state('leaderRef'));
  await a.getByRole('button', { name: 'Pause now' }).click();
  await expect(a.getByText('A second founder must confirm this.')).toBeVisible();
  await a.context().close();
});

test(`${J} #5 resumes with two founders: the scope runs again and an audit row exists`, async ({ page, browser }) => {
  await twoFounders(browser, async (a) => {
    await a
      .getByRole('table', { name: 'Paused scopes' })
      .getByRole('row', { name: new RegExp(state('leaderRef')) })
      .getByRole('button', { name: 'Resume' })
      .click();
  });
  await leadFill(state('leader'), 'buy', '0.001', `${J}-5-${state('tag')}`);
  await signIn(page, state('follower'));
  await expect(async () => {
    await expect(copiedOrders(await openFollow(page, state('leaderRef')))).toHaveCount(2, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  const founder = await (await browser.newContext()).newPage();
  await founderSignIn(founder, 'a');
  await founder.goto(`${ADMIN}/trade-ops/audit`);
  await expect(founder.getByRole('row', { name: new RegExp(`resume.*${state('leaderRef')}`, 'i') })).toHaveCount(1);
  await founder.context().close();
});
