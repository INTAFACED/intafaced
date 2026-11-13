// World: book, gates, restart
import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, api, journeyState, tool, toolAwaited } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { copiedOrders, followOnScreen, leadFill, listLeader, openFollow, takeBest, weekAhead, wizardAtLimits } from './copy.mjs';

// J-copy-bots-otc-02, in the running app (docs/roadmap/journeys.json): keep my copying inside my own limits. One test per
// step, titled "J-copy-bots-otc-02 #<n>", run in order. #1 makes the journey's start: a TEST leader listed by the stack's
// TEST founder (spot, BTC/USDT and ETH/USDT), and a verified follower with TEST 1000 USDT who follows it on screen. The
// leader's trades are its own real fills on the TEST book; the follower's copies, skips and limits are read back from
// svc-trade. The failure count before auto-unfollow is the stack's TEST copy value.
// The minimum investment and the owner day are the stack's TEST values (tooling/profiles/test-owner-values/trade.json).
// #2 restarts svc-trade once with the minimum blank (`LOCAL_STACK_TRADE_COPY_MIN_INVESTMENT=off`) and puts it back.
// #3 restarts svc-trade with the TEST owner day moved so a day begins a few minutes later
// (`LOCAL_STACK_TRADE_COPY_DAY_START_UTC_OFFSET_MINUTES`), waits for that day to begin, and puts the TEST value back.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #4: no take-profit, total-loss limit or equity trailing stop on Edit limits.
// - #5: no copy-existing-positions switch and no slippage limit on Edit limits.
// - #6: the most in total can't be changed on Edit limits.
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

/** The follower's follows as the service lists them. */
async function myFollows(who) {
  const { status, body } = await (await api(who)).get(trpc('copy.listMyFollows', { limit: 100 }));
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

/** Restart trade with the given `LOCAL_STACK_TRADE_*` switches (a value, or undefined for the TEST profile's own). */
async function restartTrade(switches) {
  const before = Object.fromEntries(Object.keys(switches).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(switches)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await toolAwaited('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  // A restart outlasts Edge's idle timeout: drop the closed kept-alive sockets before the next write (as in J-copy-bots-otc-01).
  for (let i = 0, live = 0; i < 20 && live < 3; i++) {
    try {
      await fetch(`${EDGE}/api/v1/orderbook/${encodeURIComponent('BTC/USDT')}?limit=1`, { headers: { origin: ORIGIN } }).then((r) =>
        r.arrayBuffer(),
      );
      live += 1;
    } catch (error) {
      if (error?.cause?.code !== 'UND_ERR_SOCKET') throw error;
      live = 0;
    }
  }
}

/** Restart trade with the copy minimum investment blank (`blank`) or as the TEST profile sets it (`set`). */
const copyMinimum = (value) => restartTrade({ LOCAL_STACK_TRADE_COPY_MIN_INVESTMENT: value === 'blank' ? 'off' : undefined });

/**
 * The owner-day offset (minutes from UTC, -720 to 840) whose day begins at the UTC minute `at`: local midnight for that
 * offset is `at`, so the offset is minus `at`'s minute of the UTC day, wrapped into the allowed range.
 */
function ownerDayStartingAt(at) {
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  const offset = -minute;
  return offset < -720 ? offset + 1440 : offset;
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
  const otherName = `Journey Limits B ${tag}`;
  const other = await fundedTrader(page, 'jcl2b', '100');
  const otherRef = await listLeader(other, otherName);
  await signIn(page, follower);
  const wizard = await wizardAtLimits(page, otherRef);
  const sizing = wizard.getByRole('radiogroup', { name: 'How each copy is sized' });
  await expect(sizing.getByRole('radio', { name: 'Smart sync' })).toBeVisible();
  await expect(sizing.getByRole('radio', { name: 'Fixed amount' })).toBeVisible();
  await sizing.getByRole('radio', { name: 'Multiplier' }).check();
  await expect(wizard.getByText('Multiplier sizing is not offered: the platform has not decided it.')).toBeVisible();
  // Multiplier can't go further: Next stays on the limits step.
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByRole('button', { name: 'Start copying' })).toHaveCount(0);

  // Smart sync is a real choice: a follow of the second leader made with it reads back as smart sync.
  await sizing.getByRole('radio', { name: 'Smart sync' }).check();
  await expect(wizard.getByLabel(/Fixed amount per copied order/)).toHaveCount(0);
  await wizard.getByLabel('Most per order (USDT)').fill('50');
  await wizard.getByLabel('Most in total (USDT)').fill('50');
  await wizard.getByLabel('Permission ends').fill(weekAhead());
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard).toContainText(/How each copy is sized\s*Smart sync/);
  const answer = page.waitForResponse((res) => res.url().includes('copy.follow'));
  await wizard.getByRole('button', { name: 'Start copying' }).click();
  const res = await answer;
  expect(res.status(), (await res.text()).slice(0, 300)).toBe(200);
  const synced = (await res.json()).result.data;
  // The room records the answer and moves to My follows; leaving before then would leave its write unconfirmed.
  await expect(page).toHaveURL(/tab=follows/);
  expect(synced.sizingMode).toBe('smart_sync');
  expect(synced.smartSync).toEqual({ followerTotal: '50' });
  const syncedDetail = await openFollow(page, otherRef);
  await expect(syncedDetail).toContainText(/How each copy is sized\s*Smart sync/);
  await page.keyboard.press('Escape');

  // Once the follow is active its mode is locked: a change is refused by name and the mode stays.
  const detail = await myFollow(page);
  await expect(detail).toContainText(/How each copy is sized\s*Fixed amount/);
  await detail.getByRole('button', { name: 'Edit limits' }).click();
  await detail.getByRole('radio', { name: 'Smart sync' }).check();
  await detail.getByRole('button', { name: 'Save changes' }).click();
  await expect(detail.getByText('The sizing mode can’t change while the follow is active.')).toBeVisible();
  const kept = await (await api(follower)).get(trpc('copy.listMyFollows', { limit: 100 }));
  expect(kept.status, JSON.stringify(kept.body).slice(0, 300)).toBe(200);
  expect(kept.body.result.data.find((f) => f.followId === followId)?.sizingMode).toBe('fixed_amount');
  await page.keyboard.press('Escape');

  // A new follow after stopping may use another mode: the smart-sync follow is stopped on screen, and the same leader
  // is followed again with a fixed amount.
  const stopping = await openFollow(page, otherRef);
  await stopping.getByRole('button', { name: 'Stop', exact: true }).click();
  const stopped = page.waitForResponse((r) => r.url().includes('copy.stop'));
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop', exact: true }).click();
  expect((await stopped).status()).toBe(200);
  const refollowId = await followOnScreen(page, follower, otherRef, { perOrder: '50', total: '50', fixed: '20' });
  expect(refollowId).not.toBe(synced.followId);
  const both = (await myFollows(follower)).filter((f) => [synced.followId, refollowId].includes(f.followId));
  expect(Object.fromEntries(both.map((f) => [f.followId === refollowId ? 'new' : 'stopped', f.sizingMode]))).toEqual({
    stopped: 'smart_sync',
    new: 'fixed_amount',
  });
});

test(`${J} #2 sets a per-contract cap, a daily cap, a minimum investment and a leverage limit: no leverage field on a spot follow`, async ({
  page,
}) => {
  await signIn(page, state('follower'));
  const detail = await myFollow(page);
  await detail.getByRole('button', { name: 'Edit limits' }).click();
  await detail.getByLabel('Most per contract (USDT)').fill('25');
  await detail.getByLabel('Most per day (USDT)').fill('100');
  // The owner's minimum is shown: the stack's TEST value, 10 USDT (tooling/profiles/test-owner-values/trade.json), as
  // the service publishes it.
  const desk = await (await api(state('follower'))).get(trpc('copy.deskStatus'));
  expect(desk.status, JSON.stringify(desk.body).slice(0, 300)).toBe(200);
  expect(desk.body.result.data.minInvestment).toBe('10');
  await expect(detail.getByText('Minimum investment: 10 USDT')).toBeVisible();
  // A spot follow has no leverage to limit, so no field asks for one.
  await expect(detail.getByLabel(/Leverage/)).toHaveCount(0);
  await detail.getByRole('button', { name: 'Save changes' }).click();
  await expect(detail).toContainText(/Most per contract\s*25 USDT/);
  await expect(detail).toContainText(/Most per day\s*100 USDT/);
  // Both caps are the follow's own, as the service keeps them.
  const saved = (await myFollows(state('follower'))).find((f) => f.followId === state('followId'));
  expect({ maxPerMarket: saved?.maxPerMarket, maxPerDay: saved?.maxPerDay }).toEqual({ maxPerMarket: '25', maxPerDay: '100' });
  // A follow below the minimum is refused on the wizard before anything is sent.
  const third = await fundedTrader(page, 'jcl2c', '100');
  const thirdRef = await listLeader(third, `Journey Limits C ${state('tag')}`);
  await signIn(page, state('follower'));
  const wizard = await wizardAtLimits(page, thirdRef);
  await wizard.getByLabel('Most per order (USDT)').fill('1');
  await wizard.getByLabel('Most in total (USDT)').fill('1');
  await wizard.getByLabel('Fixed amount per copied order (USDT)').fill('1');
  await wizard.getByLabel('Permission ends').fill(weekAhead());
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByText('The minimum investment is 10 USDT')).toBeVisible();
  await expect(wizard.getByRole('button', { name: 'Start copying' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A leverage limit sent for this spot follow anyway is refused by name, and nothing is followed.
  const levered = await (
    await api(state('follower'))
  ).post('/api/trade/trpc/copy.follow', {
    leaderRef: thirdRef,
    region: 'DE',
    permittedMarkets: ['BTC/USDT'],
    maxNotionalPerOrder: '50',
    maxAggregateExposure: '50',
    fixedOrderSize: '20',
    maxLeverage: '3',
    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    clientRequestId: `${J}-2-lev-${state('tag')}`,
  });
  expect(levered.status, JSON.stringify(levered.body).slice(0, 300)).not.toBe(200);
  expect(JSON.stringify(levered.body)).toContain('trade.copy_leverage_unsupported');
  expect((await myFollows(state('follower'))).filter((f) => f.leaderRef === thirdRef)).toEqual([]);

  // A blank minimum refuses the follow: trade restarted with no minimum, a valid follow of the third leader is refused by
  // name and nothing is followed; the TEST minimum is put back after.
  await copyMinimum('blank');
  try {
    await signIn(page, state('follower'));
    const blank = await wizardAtLimits(page, thirdRef);
    await expect(blank.getByText('The platform hasn’t set a minimum investment, so no copy can start.')).toBeVisible();
    await blank.getByLabel('Most per order (USDT)').fill('50');
    await blank.getByLabel('Most in total (USDT)').fill('50');
    await blank.getByLabel('Fixed amount per copied order (USDT)').fill('20');
    await blank.getByLabel('Permission ends').fill(weekAhead());
    await blank.getByRole('button', { name: 'Next' }).click();
    const answer = page.waitForResponse((res) => res.url().includes('copy.follow'));
    await blank.getByRole('button', { name: 'Start copying' }).click();
    const res = await answer;
    const body = await res.json();
    expect(res.status(), JSON.stringify(body).slice(0, 300)).not.toBe(200);
    expect(JSON.stringify(body)).toContain('trade.copy_min_not_set');
    await expect(blank.getByText('Copy trading has no minimum investment set')).toBeVisible();
    expect((await myFollows(state('follower'))).filter((f) => f.leaderRef === thirdRef)).toEqual([]);
  } finally {
    await copyMinimum('set');
  }
});

test(`${J} #3 a lead order past the per-contract cap: refused with the cap code, other contracts still copy; the daily cap resumes the next owner day`, async ({
  page,
}) => {
  test.setTimeout(720_000);
  const [leader, follower, followId, tag] = ['leader', 'follower', 'followId', 'tag'].map(state);
  // The leader buys BTC worth more than the follower's 25 USDT per-contract cap at 20 a copy, twice; then ETH once.
  await takeBest(leader, 'buy', '0.001', `${J}-3-btc1-${tag}`);
  await takeBest(leader, 'buy', '0.001', `${J}-3-btc2-${tag}`);
  await leadFill(leader, 'buy', '0.01', `${J}-3-eth-${tag}`, 'ETH/USDT');
  await expect.poll(async () => (await skips(follower, followId)).map((s) => s.reason), { timeout: 60_000 }).toContain('per_contract_cap');
  await signIn(page, follower);
  const detail = await myFollow(page);
  await expect(copiedOrders(detail).filter({ hasText: 'ETH/USDT' })).toHaveCount(1);
  await expect(copiedOrders(detail).filter({ hasText: 'BTC/USDT' })).toHaveCount(1);

  // The daily cap: the most per contract cleared and the most per day set to what is already copied today (BTC 20 and
  // ETH 20), so the leader's next BTC buy is skipped with the daily reason.
  await detail.getByRole('button', { name: 'Edit limits' }).click();
  await detail.getByLabel('Most per contract (USDT)').fill('');
  await expect(detail.getByLabel('Most per contract (USDT)')).toHaveValue('');
  await detail.getByLabel('Most per day (USDT)').fill('40');
  const amended = page.waitForResponse((r) => r.url().includes('copy.amendFollow'));
  await detail.getByRole('button', { name: 'Save changes' }).click();
  const amend = await amended;
  const sentAmend = amend.request().postData() ?? '';
  expect(amend.status(), `${sentAmend} -> ${(await amend.text()).slice(0, 300)}`).toBe(200);
  expect(JSON.parse(sentAmend), 'Save sends the cleared cap as blank').toMatchObject({ maxPerMarket: '', maxPerDay: '40' });
  const kept = (await myFollows(follower)).find((f) => f.followId === followId);
  expect({ maxPerMarket: kept?.maxPerMarket, maxPerDay: kept?.maxPerDay }, `sent ${sentAmend}`).toEqual({
    maxPerMarket: null,
    maxPerDay: '40',
  });
  await expect(detail).toContainText(/Most per contract\s*Not set/);
  await expect(detail).toContainText(/Most per day\s*40 USDT/);
  // A real owner day: trade restarted with the owner day moved so the next day begins at a whole UTC minute about six
  // minutes from now. The leader's next BTC buy before then is skipped with the daily reason; once that day has begun,
  // the leader's next BTC buy copies again. The TEST owner day is put back after.
  const dayStarts = new Date(Math.ceil((Date.now() + 6 * 60_000) / 60_000) * 60_000);
  await restartTrade({ LOCAL_STACK_TRADE_COPY_DAY_START_UTC_OFFSET_MINUTES: String(ownerDayStartingAt(dayStarts)) });
  try {
    expect(Date.now(), `trade restarted too late: the owner day begins at ${dayStarts.toISOString()}`).toBeLessThan(
      dayStarts.getTime() - 90_000,
    );
    await takeBest(leader, 'buy', '0.001', `${J}-3-btc3-${tag}`);
    await expect.poll(async () => (await skips(follower, followId)).map((s) => s.reason), { timeout: 60_000 }).toContain('daily_cap');
    expect(Date.now(), 'the daily-cap skip came before the next owner day').toBeLessThan(dayStarts.getTime());
    expect((await skips(follower, followId)).filter((s) => s.reason === 'per_contract_cap')).toHaveLength(1);

    await page.waitForTimeout(Math.max(0, dayStarts.getTime() - Date.now()) + 5_000);
    await takeBest(leader, 'buy', '0.001', `${J}-3-btc4-${tag}`);
    const after = await myFollow(page);
    await expect(copiedOrders(after).filter({ hasText: 'BTC/USDT' })).toHaveCount(2, { timeout: 60_000 });
    expect((await skips(follower, followId)).filter((s) => s.reason === 'daily_cap')).toHaveLength(1);
  } finally {
    await restartTrade({ LOCAL_STACK_TRADE_COPY_DAY_START_UTC_OFFSET_MINUTES: undefined });
  }
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
