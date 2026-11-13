// World: book
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, journeyState, toUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { copiedOrders, followOnScreen, leadFill, listLeader, openFollow, userIdOf } from './copy.mjs';

// J-copy-bots-otc-11, in the running app (docs/roadmap/journeys.json): check that profit settlement and broker rebates
// match the ledger. One test per step, titled "J-copy-bots-otc-11 #<n>", run in order, as the stack's TEST founder on the
// founder console (the finance view). #1 makes the journey's start: a TEST lead listed by the founder, a verified follower
// who follows it on screen, one copied buy (the lead's own fill on the TEST book), and the follower's fee share on that
// copy settled through svc-trade's settle door under the stack's TEST copy fee share. The copy filled on the TEST book,
// not at a venue, so no venue reports a builder fee for it: its share is "Held" for that reason, with its key.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #5: the console has no /trade-ops/broker room.
const J = 'J-copy-bots-otc-11';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
const VENUE_NOT_REPORTED = 'The venue reports no builder fee for this fill.';

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const trpcGet = async (who, proc, input) => {
  const { status, body } = await (await api(who)).get(`/api/trade/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`);
  expect(status, JSON.stringify(body).slice(0, 400)).toBe(200);
  return body.result.data;
};

/** quantity × price, as a decimal string of 18 places at most (the settle door's notional). */
function times(a, b) {
  const p = toUnits(a) * toUnits(b);
  const s = (p / 10n ** 18n).toString();
  const whole = s.length > 18 ? s.slice(0, -18) : '0';
  const frac = s.padStart(18, '0').slice(-18).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

async function settlements(page) {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/trade-ops/copy/settlements`);
  await expect(page.getByRole('heading', { name: 'Copy settlements', level: 1 })).toBeVisible(UNBUILT);
  return page.getByRole('table', { name: 'Settlements' });
}

/** Chooses the window, presses Reconcile and returns the latest run's line, waiting for this press's own line. */
async function reconcile(page, before) {
  await page.getByRole('button', { name: 'Reconcile' }).click();
  const result = page.getByRole('status', { name: 'Reconcile result' });
  await expect(result).toBeVisible();
  if (before !== undefined) await expect(result.getByRole('list', { name: 'Earlier runs' }).getByRole('listitem')).toHaveCount(before);
  return result.locator('[data-reconcile-latest]').innerText();
}

const cell = (row, n) => row.locator(`td:nth-child(${n})`);

test(`${J} #1 opens settlement oversight: "Settled" where the ledger post and the venue's builder fee match, "Held" with its key and reason otherwise`, async ({
  page,
}) => {
  test.setTimeout(360_000);
  const tag = Date.now().toString(36);
  const leader = await fundedTrader(page, 'jcl11', '2000');
  const leaderName = `Journey Settle ${tag}`;
  const leaderRef = await listLeader(leader, leaderName);
  const follower = await fundedTrader(page, 'jcf11', '1000');
  await signIn(page, follower);
  await followOnScreen(page, follower, leaderRef, { perOrder: '50', total: '300', fixed: '20' });
  await leadFill(leader, 'buy', '0.001', `${J}-1-${tag}`);
  await expect(async () => {
    await expect(copiedOrders(await openFollow(page, leaderRef))).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });

  // The follower's copy, as svc-trade's own trail names it: the lead fill it copies and the follower's own fill.
  const leaderId = await userIdOf(leader);
  const follows = await trpcGet(follower, 'copy.listMyFollows', { limit: 20 });
  const follow = (Array.isArray(follows) ? follows : follows.items).find((f) => f.leaderRef === leaderRef);
  expect(follow, 'the follower has a follow of this lead').toBeTruthy();
  const now = Date.now();
  let filled;
  await expect
    .poll(
      async () => {
        const trail = await trpcGet(follower, 'copy.mirrorTrail', {
          followId: follow.followId,
          from: new Date(now - 3_600_000).toISOString(),
          to: new Date(now + 600_000).toISOString(),
          limit: 50,
        });
        filled = trail.rows.find((r) => r.kind === 'filled' && r.followerFillId);
        return Boolean(filled);
      },
      { timeout: 30_000, message: 'the copy never filled on the trail' },
    )
    .toBe(true);
  const trades = (await (await api(follower)).get(`/api/v1/orders/${filled.followerOrderId}/trades?limit=10`)).body;
  const fill = trades.find((t) => t.id === filled.followerFillId) ?? trades[0];
  const feeAsset = fill.fee.currency;
  const settle = await (
    await api(follower)
  ).post('/api/trade/trpc/copy.settleFeeShare', {
    followId: follow.followId,
    fillId: filled.leaderFillId,
    followerFillId: filled.followerFillId,
    assetId: feeAsset,
    followerFillNotional: times(filled.quantity, filled.price),
    protocolFeeBps: 0,
  });
  expect(settle.status, JSON.stringify(settle.body).slice(0, 400)).toBe(200);
  const settled = settle.body.result.data;
  // A share owed on the copied fill: settled, not left at nothing by the cap.
  expect(settled).toMatchObject({ fillId: filled.leaderFillId, settled: true, skippedReason: null });
  const owed = settled.cappedLeaderShare;
  run.reset({ tag, leader, leaderId, follower, followId: follow.followId, leaderFillId: filled.leaderFillId, feeAsset, owed });

  const table = await settlements(page);
  const ours = table.locator(`tbody tr[data-fill="${filled.leaderFillId}"]`);
  await expect(ours).toHaveCount(1);
  // Held: the ledger holds the post under its key at the share's amount, and no venue reports a builder fee for a
  // copy filled on the TEST book.
  await expect(cell(ours, 1)).toHaveText('Held');
  await expect(cell(ours, 9)).toHaveText(`reward:copy-leader-share:${filled.leaderFillId}:${leaderId}`);
  await expect(cell(ours, 10)).toHaveText(VENUE_NOT_REPORTED);
  await expect(cell(ours, 8)).toHaveText('Not reported');
  await expect(cell(ours, 5)).toContainText(feeAsset);
  const owedShown = (await cell(ours, 5).innerText()).split(' ')[0];
  expect(toUnits(owedShown)).toBe(toUnits(String(owed)));
  expect(toUnits(await cell(ours, 7).innerText())).toBe(toUnits(owedShown));

  // Every row: "Settled" only where the ledger post and the venue's builder fee both agree with the share; "Held" names
  // its key and a reason; "Not owed" is a share the cap or a zero fee left at nothing.
  for (const row of await table.locator('tbody tr').all()) {
    const status = await cell(row, 1).innerText();
    expect(['Settled', 'Held', 'Not owed']).toContain(status);
    if (status === 'Settled') {
      expect(toUnits(await cell(row, 7).innerText())).toBe(toUnits((await cell(row, 5).innerText()).split(' ')[0]));
      expect(toUnits((await cell(row, 8).innerText()).split(' ')[0])).toBe(toUnits((await cell(row, 6).innerText()).split(' ')[0]));
      await expect(cell(row, 10)).toHaveText('');
    }
    if (status === 'Held') {
      await expect(cell(row, 9)).toHaveText(/^reward:copy-leader-share:\S+:\S+$/);
      await expect(cell(row, 10)).not.toHaveText('');
    }
  }
});

test(`${J} #2 runs reconcile twice: the counts are the same both times`, async ({ page }) => {
  state('leaderFillId');
  await settlements(page);
  await page.getByLabel('Window').selectOption({ label: 'Last 24 hours' });
  const first = await reconcile(page);
  const second = await reconcile(page, 1);
  expect(first).toMatch(/^Last 24 hours: \d+ compared through .* UTC\. Settled \d+, held \d+, not owed \d+\.$/);
  // The share #1 settled is in the window, held.
  expect(Number(first.match(/held (\d+)/)[1])).toBeGreaterThanOrEqual(1);
  expect(second.replace(/through .* UTC/, '')).toBe(first.replace(/through .* UTC/, ''));
});

test(`${J} #3 runs reconcile with the window blank: refused`, async ({ page }) => {
  await settlements(page);
  // One run with a window first, so a refused press can be seen to add nothing.
  await page.getByLabel('Window').selectOption({ label: 'Last 24 hours' });
  const before = await reconcile(page);
  await page.getByLabel('Window').selectOption({ label: 'Choose a window' });
  await page.getByRole('button', { name: 'Reconcile' }).click();
  // svc-trade refuses the blank window by name; the console shows its words and its code.
  const alert = page.getByRole('alert');
  await expect(alert).toHaveAttribute('data-refusal', 'trade.copy_settlement_window_required');
  await expect(alert).toHaveText('Choose a window to reconcile. Reference trade.copy_settlement_window_required');
  // Nothing was reconciled: the last run is still the one before, and no run was added.
  const result = page.getByRole('status', { name: 'Reconcile result' });
  await expect(result.locator('[data-reconcile-latest]')).toHaveText(before);
  await expect(result.getByRole('list', { name: 'Earlier runs' })).toHaveCount(0);
});

test(`${J} #4 opens a follow's position accounting: oversight links to the fee-share and position rows`, async ({ page }) => {
  const leaderFillId = state('leaderFillId');
  const table = await settlements(page);
  await table.locator(`tbody tr[data-fill="${leaderFillId}"]`).getByRole('link', { name: 'Open follow' }).click();
  await expect(page).toHaveURL(new RegExp(`/trade-ops/copy/follows/${state('followId')}$`));
  const shares = page.getByRole('table', { name: 'Fee shares' });
  await expect(shares.locator(`tbody tr[data-fill="${leaderFillId}"]`)).toHaveCount(1);
  const positions = page.getByRole('table', { name: 'Positions' });
  await expect(positions.locator('tbody tr')).toHaveCount(1);
  await expect(positions.locator('tbody tr').first()).toContainText('BTC/USDT');
});

test(`${J} #5 opens the broker dashboard for two days: a daily table with decimal sums; rebates "Not set" and payout refused`, async ({
  page,
}) => {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/trade-ops/broker`);
  const daily = page.getByRole('table', { name: 'Broker volume by day' });
  await expect(daily).toBeVisible(UNBUILT);
  for (const cell of await daily.getByRole('cell', { name: /^\d/ }).allInnerTexts()) expect(cell).toMatch(/^\d+(\.\d+)?/);
  await expect(daily).toContainText('Not set');
  await page.getByRole('button', { name: 'Pay rebates' }).click();
  await expect(page.getByText(/The rebate hierarchy is not set/)).toBeVisible();
});
