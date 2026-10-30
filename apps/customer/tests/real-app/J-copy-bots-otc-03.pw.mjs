import { test, expect } from '@playwright/test';
import { api, journeyState, toUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { copiedOrders, copiedOrdersLoaded, followOnScreen, leadFill, listLeader, openFollow } from './copy.mjs';

// J-copy-bots-otc-03, in the running app (docs/roadmap/journeys.json): pause, stop or leave a copy, close what I choose,
// and read why trades were skipped. One test per step, titled "J-copy-bots-otc-03 #<n>", run in order. #1 makes the
// journey's start: a TEST leader listed by the stack's TEST founder, a verified follower with TEST 1000 USDT who follows
// it on screen, and one copied buy (the leader's own fill on the TEST book, copied by the copy driver). Every state is
// read back from svc-trade and every balance from the ledger.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #2: a stopped follow doesn't close the follower's position when the leader closes (close-only).
// - #3: no Positions tab with a close for one order or a part of it.
// - #4: no close-all with a step-up (copy.flatten closes at once, with no step-up asked).
// - #5: no skip log; #6: no notice for a skipped or stopped follow.
const J = 'J-copy-bots-otc-03';
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

/** Presses a follow action and confirms it in its dialog. */
async function act(page, detail, button) {
  await detail.getByRole('button', { name: button, exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: button, exact: true }).click();
}

/** The follower's own BTC/USDT fills: what the ledger settles, one posting per fill. */
async function myFills(who) {
  const res = await (await api(who)).get('/api/v1/account/trades?symbol=BTC%2FUSDT&limit=100');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body;
}

/** BTC and USDT totals from the ledger, as scaled bigints. */
async function holdings(who) {
  const b = await (await api(who)).balances();
  return { BTC: toUnits(b.BTC?.total ?? '0'), USDT: toUnits(b.USDT?.total ?? '0') };
}

/**
 * Waits for a sell of the follower's that was not among `seen`, then for the ledger to read exactly `before` moved by
 * those new fills: base out and quote in on a sell (in and out on a buy), the fee out, a rebate in. Returns the BTC sold.
 */
async function settlesExactly(who, before, seen) {
  let sold = 0n;
  await expect
    .poll(
      async () => {
        const fresh = (await myFills(who)).filter((f) => !seen.has(f.id));
        if (!fresh.some((f) => f.side === 'sell')) return 'no close fill yet';
        const moved = { BTC: 0n, USDT: 0n };
        sold = 0n;
        for (const f of fresh) {
          const sign = f.side === 'buy' ? 1n : -1n;
          moved.BTC += sign * toUnits(f.amount);
          moved.USDT -= sign * toUnits(f.cost);
          if (f.side === 'sell') sold += toUnits(f.amount);
          if (f.fee.currency in moved) moved[f.fee.currency] -= toUnits(f.fee.cost);
          if (f.rebate && f.rebate.currency in moved) moved[f.rebate.currency] += toUnits(f.rebate.cost);
        }
        const now = await holdings(who);
        const want = { BTC: before.BTC + moved.BTC, USDT: before.USDT + moved.USDT };
        return now.BTC === want.BTC && now.USDT === want.USDT
          ? 'exact'
          : `ledger ${now.BTC}/${now.USDT}, fills say ${want.BTC}/${want.USDT}`;
      },
      { timeout: 60_000, message: 'the ledger never read exactly what the close fills settle' },
    )
    .toBe('exact');
  return sold;
}

/** Copied orders on the follow after the page re-reads it. */
async function copiedNow(page) {
  return (await copiedOrdersLoaded(await openFollow(page, state('leaderRef')))).count();
}

test(`${J} #1 pauses the follow: new mirrors refused as paused, and existing positions stay open`, async ({ page }) => {
  test.setTimeout(360_000);
  const tag = Date.now().toString(36);
  const leader = await fundedTrader(page, 'jcl3', '2000');
  const leaderRef = await listLeader(leader, `Journey Exits ${tag}`);
  const follower = await fundedTrader(page, 'jcf3', '1000');
  run.reset({ tag, leader, leaderRef, follower });
  // A second follow for #4's close-all, so a close-all that runs without its step-up can't end the follow #7 leaves. It
  // is made first: on the stack (27 Oct) a follow made before another one of the same person's copied nothing after it.
  const other = await fundedTrader(page, 'jcl3b', '100');
  const otherRef = await listLeader(other, `Journey Exits B ${tag}`);
  await signIn(page, follower);
  run.write({ otherRef, otherFollowId: await followOnScreen(page, follower, otherRef, { perOrder: '50', total: '100', fixed: '20' }) });
  run.write({ followId: await followOnScreen(page, follower, leaderRef, { perOrder: '50', total: '300', fixed: '20' }) });
  // Two copied buys: the journey starts with open copied positions (#2's lead close takes one, #3 closes the other).
  // A copied order is listed before the ledger credits its fill (run 701 read the holding with one of two credited), so
  // the holding "nothing was sold" is compared with is read only once the ledger holds both: the first copied buy's
  // credit, read while it is the only one, sets the credit per BTC filled, and the second must bring the BTC to that
  // rate times everything filled.
  const btc = async () => toUnits((await (await api(follower)).balances()).BTC?.total ?? '0');
  const filledBuys = async () => {
    const closed = await (await api(follower)).get('/api/v1/orders/closed?symbol=BTC%2FUSDT&limit=50');
    expect(closed.status, JSON.stringify(closed.body).slice(0, 300)).toBe(200);
    return closed.body.filter((o) => o.side === 'buy' && o.status === 'closed').map((o) => toUnits(o.filled));
  };
  await leadFill(leader, 'buy', '0.001', `${J}-1-open-${tag}`);
  await expect.poll(() => copiedNow(page), { timeout: 60_000 }).toBe(1);
  await expect.poll(btc, { timeout: 60_000 }).toBeGreaterThan(0n);
  const firstCredit = await btc();
  const [firstFilled] = await filledBuys();
  expect(firstFilled).toBeGreaterThan(0n);
  await leadFill(leader, 'buy', '0.001', `${J}-1-open2-${tag}`);
  await expect.poll(() => copiedNow(page), { timeout: 60_000 }).toBe(2);
  // The copied order is listed before closed orders show its buy as closed (run 796), so that read is polled too.
  await expect.poll(async () => (await filledBuys()).length, { timeout: 60_000 }).toBe(2);
  const filled = await filledBuys();
  expect(filled).toHaveLength(2);
  const settled = (firstCredit * filled.reduce((a, b) => a + b, 0n)) / firstFilled;
  await expect.poll(btc, { timeout: 60_000, message: 'the ledger never credited both copied buys' }).toBe(settled);
  const holding = (await (await api(follower)).balances()).BTC.total;

  const detail = await openFollow(page, leaderRef);
  await act(page, detail, 'Pause');
  await expect(detail).toContainText('Paused');
  await leadFill(leader, 'buy', '0.001', `${J}-1-paused-${tag}`);
  expect(await copiedNow(page)).toBe(2);
  // Nothing was sold.
  expect((await (await api(follower)).balances()).BTC.total).toBe(holding);
});

test(`${J} #2 stops with close-only: a new lead fill isn't mirrored, and a lead close still closes the position`, async ({ page }) => {
  test.setTimeout(180_000);
  const follower = state('follower');
  await signIn(page, follower);
  const detail = await openFollow(page, state('leaderRef'));
  await act(page, detail, 'Stop');
  // Stop is close-only: the follow reads Stopping while the leader's closes still close the copied positions.
  await expect(detail).toContainText('Stopping');
  await expect(detail.getByText('Close-only: the leader’s closes still close your copied positions.')).toBeVisible(UNBUILT);
  const before = await holdings(follower);
  const seen = new Set((await myFills(follower)).map((f) => f.id));
  await leadFill(state('leader'), 'buy', '0.001', `${J}-2-new-${state('tag')}`);
  await leadFill(state('leader'), 'sell', '0.001', `${J}-2-close-${state('tag')}`);
  // The close's fills and the ledger agree to the unit.
  expect(await settlesExactly(follower, before, seen)).toBeGreaterThan(0n);
  // The two buys from before the stop, no copy of the new buy, and one close.
  const orders = copiedOrders(await openFollow(page, state('leaderRef')));
  await expect(orders.filter({ hasText: 'Buy' })).toHaveCount(2);
  await expect(orders.filter({ hasText: 'Sell' })).toHaveCount(1);
});

test(`${J} #3 opens Positions and closes one order, then a part larger than open: the close runs once; the oversize part refused`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  // The copied buy #2's lead close left open.
  const follower = state('follower');
  await signIn(page, follower);
  const detail = await openFollow(page, state('leaderRef'));
  await detail.getByRole('tab', { name: 'Positions' }).click(UNBUILT);
  const positions = detail.getByRole('table', { name: 'Copied positions' });
  const row = positions.locator('tbody tr').first();
  await row.getByRole('button', { name: 'Close part' }).click();
  await page.getByRole('dialog', { name: 'Close part of this position' }).getByLabel('Amount').fill('1');
  await page.getByRole('dialog', { name: 'Close part of this position' }).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('That is more than is open.')).toBeVisible();
  const before = await holdings(follower);
  const seen = new Set((await myFills(follower)).map((f) => f.id));
  await row.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close' }).click();
  await expect(row).toContainText('Closed');
  // The funds return exactly: the ledger reads the balance before, moved by exactly what the close's fills settle.
  expect(await settlesExactly(follower, before, seen)).toBeGreaterThan(0n);
});

test(`${J} #4 presses close-all with an unrealised loss: a step-up opens, and the call without its token is refused`, async ({ page }) => {
  const follower = state('follower');
  const bare = await (await api(follower)).post('/api/trade/trpc/copy.flatten', { followId: state('otherFollowId') });
  expect(bare.status).toBe(403);
  expect(JSON.stringify(bare.body)).toMatch(/step_up/);
  await signIn(page, follower);
  const detail = await openFollow(page, state('otherRef'));
  await detail.getByRole('button', { name: 'Close copied positions' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close copied positions' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm it’s you' })).toBeVisible(UNBUILT);
});

test(`${J} #5 opens the skip log: one row per skipped mirror with the reason in words; a repeat writes no second row`, async ({ page }) => {
  const follower = state('follower');
  await signIn(page, follower);
  const detail = await openFollow(page, state('leaderRef'));
  await detail.getByRole('tab', { name: 'Skipped' }).click(UNBUILT);
  const log = detail.getByRole('table', { name: 'Skipped copies' });
  // #1 paused the follow before the leader's second buy, so that buy is skipped as paused.
  await expect(log.locator('tbody tr').filter({ hasText: 'You had paused this follow' })).toHaveCount(1);
  await expect(log).not.toContainText(/trade\.[a-z_]+/);
  const { body } = await (await api(follower)).get(trpc('copy.skipLog', { followId: state('followId') }));
  const ids = body.result.data.items.map((s) => s.leaderFillId);
  expect(new Set(ids).size).toBe(ids.length);
});

test(`${J} #6 receives an in-app notice for a skipped or stopped follow: the reason and next step, no raw code`, async ({ page }) => {
  await signIn(page, state('follower'));
  await page.goto('/notifications');
  const notice = page.getByRole('article').filter({ hasText: /stopped copying|skipped a copy/i });
  await expect(notice.first()).toBeVisible(UNBUILT);
  await expect(notice.first()).toContainText(/You can /);
  await expect(notice.first()).not.toContainText(/trade\.[a-z_]+/);
});

test(`${J} #7 leaves the leader: the follow is left and the positions stay the person's own; leaving again is refused`, async ({
  page,
}) => {
  const follower = state('follower');
  await signIn(page, follower);
  const before = (await (await api(follower)).balances()).BTC?.total ?? '0';
  const detail = await openFollow(page, state('leaderRef'));
  await act(page, detail, 'Leave leader');
  await expect(detail).toContainText('Left');
  expect((await (await api(follower)).balances()).BTC?.total ?? '0').toBe(before);
  // Leaving again: the button is off and says why.
  await expect(detail.getByRole('button', { name: 'Leave leader', exact: true })).toBeDisabled();
  await expect(detail.getByText('Leave leader: You have already left this leader')).toBeVisible();
});
