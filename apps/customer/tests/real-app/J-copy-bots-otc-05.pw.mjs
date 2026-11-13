// World: book
import { test, expect } from './journey.mjs';
import { approverSessions, makeContext, refusalText } from '../../../../tooling/scripts/local-test-gates.mjs';
import { api, fromUnits, fund, journeyState, signOutBrowser, toUnits } from './stack.mjs';
import { fundedTrader, signIn, signUp, verify } from './desk.mjs';
import { refusalCode } from './p2p.mjs';
import { followOnScreen, leadFill, listLeader, takeBest } from './copy.mjs';

// J-copy-bots-otc-05, in the running app (docs/roadmap/journeys.json): manage my followers, my privacy and my lead
// listing. One test per step, titled "J-copy-bots-otc-05 #<n>", run in order. #1 makes the start: a TEST lead the stack's
// TEST founder lists, with one follower who holds a copied position, and ten more copiers. The removal limit (10 a day)
// and the levels (TEST Cadet from 0 USDT, TEST Silver from 5000) are the stack's TEST copy terms
// (tooling/profiles/test-owner-values/trade.json); the disclosure delays, nickname window, capacity and batch limit
// will be too.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #2 to #5: the lead desk has no Privacy, Profile, Capacity or Access tab yet.
const J = 'J-copy-bots-otc-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
const REMOVAL_LIMIT = 10;

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

/** The lead's own desk, on one of its tabs. */
async function leadDesk(page, tab, opts = UNBUILT) {
  await signIn(page, state('lead'));
  await page.goto('/trade/copy?lead=1');
  await page.getByRole('tab', { name: tab }).click(opts);
  return page.getByRole('tabpanel', { name: tab });
}

const trpc = (proc, input) => `/api/trade/trpc/${proc}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;
async function read(who, proc, input) {
  const res = await (await api(who)).get(trpc(proc, input));
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** A copier is shown by their follow, never by who they are. */
const copierName = (followId) => `Copier ${followId.slice(0, 8)}`;
const copierRow = (panel, followId) => panel.getByRole('row').filter({ hasText: copierName(followId) });

/** `who` follows the lead through svc-trade's own door, as the room's wizard sends it. Returns the follow id. */
async function followByApi(who, leaderRef, key) {
  const res = await (
    await api(who)
  ).post('/api/trade/trpc/copy.follow', {
    leaderRef,
    region: 'DE',
    permittedMarkets: ['BTC/USDT'],
    maxNotionalPerOrder: '50',
    maxAggregateExposure: '200',
    fixedOrderSize: '20',
    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    clientRequestId: key,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.followId;
}

/**
 * `n` more copiers: each signs up and asks for Full verification; the stack's TEST operators then approve them all in
 * one run (desk.mjs `verify` approves every request waiting), and each is funded with TEST USDT.
 */
async function moreCopiers(page, n) {
  const made = [];
  for (let i = 0; i < n; i += 1) {
    const who = await signUp(page, `jcm${i}x`);
    if (i < n - 1) {
      await page.goto('/verification');
      await page.getByLabel('Level to request').selectOption({ label: 'Full' });
      await page.getByLabel('Country code').fill('DE');
      await page.getByRole('button', { name: 'Review request' }).click();
      await page.getByRole('button', { name: 'Submit this request' }).click();
      await expect(page.getByText('Your reviewed request')).toBeVisible();
      await signOutBrowser(page.context());
    } else {
      await verify(page, who);
    }
    made.push(who);
  }
  for (const who of made) expect(fund(who.email, 'USDT', '300').tx).toBeTruthy();
  return made;
}

/**
 * The follower closes every copied position of the follow. A copy that is still resting as a buy (the TEST maker
 * requoted before it matched) is cancelled instead, so nothing of it stays open; a filled one is closed through the
 * room's own close door, a sell into the bid.
 */
async function closeAll(who, followId) {
  const positions = async () => (await read(who, 'copy.copiedPositions', { followId })).positions;
  await expect
    .poll(async () => (await positions()).length, { timeout: 30_000, message: 'the lead fill was never copied' })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await positions()).every((p) => p.status !== 'buying'), { timeout: 20_000 })
    .toBe(true)
    .catch(async () => {
      const client = await api(who);
      for (const p of (await positions()).filter((x) => x.status === 'buying')) {
        const res = await client.delete(`/api/v1/orders/${p.positionId}?symbol=BTC%2FUSDT`);
        expect(res.status, `cancelling the resting copy: ${JSON.stringify(res.body).slice(0, 300)}`).toBeLessThan(300);
      }
    });
  const client = await api(who);
  for (const p of (await positions()).filter((x) => x.status === 'open')) {
    const res = await client.post('/api/trade/trpc/copy.closeCopiedPosition', { followId, positionId: p.positionId });
    expect(res.status, `closing ${JSON.stringify(p)}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  }
  await expect
    .poll(async () => (await positions()).map((p) => p.status).filter((s) => s !== 'closed'), {
      timeout: 45_000,
      message: 'the copied positions never all closed',
    })
    .toEqual([]);
}

test(`${J} #1 removes a follower with open positions: refused until they close; the eleventh removal in a day is refused; a bulk removal keys each id and a retry skips completed ids`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const tag = Date.now().toString(36);
  const lead = await fundedTrader(page, 'jcm', '2000');
  const leadRef = await listLeader(lead, `Journey Manage ${tag}`);
  const follower = await fundedTrader(page, 'jcmf', '500');
  await signIn(page, follower);
  const followId = await followOnScreen(page, follower, leadRef, { perOrder: '50', total: '200', fixed: '20' });
  // The lead's buy is copied: the follower now holds a copied position, and the lead an open spot position (#7).
  await leadFill(lead, 'buy', '0.001', `${J}-1-${tag}`);
  run.reset({ tag, lead, leadRef, follower, followId });

  // Refused while the copier's copied position is open: the copier still follows.
  let panel = await leadDesk(page, 'Followers', {});
  const row = copierRow(panel, followId);
  await expect(row).toContainText('Active');
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(panel.getByRole('alert').filter({ hasText: 'This copier has open copied positions' })).toBeVisible();
  expect((await read(follower, 'copy.listMyFollows', { limit: 100 })).find((f) => f.followId === followId)?.relationshipState).toBe(
    'ACTIVE',
  );

  // Once they have closed, the same removal goes through, under the follow's own key.
  await closeAll(follower, followId);
  panel = await leadDesk(page, 'Followers', {});
  await copierRow(panel, followId).getByRole('button', { name: 'Remove' }).click();
  const results = panel.getByRole('status', { name: 'Removal results' });
  await expect(results).toContainText(`${copierName(followId)} removed`);
  await expect(results.locator(`[data-key="copy.lead.remove:${followId}"]`)).toHaveCount(1);
  await expect(copierRow(panel, followId)).toContainText('Removed');
  expect((await read(follower, 'copy.listMyFollows', { limit: 100 })).find((f) => f.followId === followId)?.relationshipState).toBe(
    'DETACHED',
  );

  // Ten more copiers; the lead picks them all and removes them in one go. With one removal already made today, nine go
  // through and the eleventh removal of the day is refused, each id under its own key.
  const copiers = await moreCopiers(page, REMOVAL_LIMIT);
  const ids = [];
  for (const [i, who] of copiers.entries()) ids.push(await followByApi(who, leadRef, `${J}-1-copier-${i}-${tag}`));
  run.write({ copiers, copierIds: ids });
  panel = await leadDesk(page, 'Followers', {});
  for (const id of ids) await panel.getByRole('checkbox', { name: `Pick ${copierName(id)}` }).check();
  await panel.getByRole('button', { name: `Remove picked (${ids.length})` }).click();
  const bulk = panel.getByRole('status', { name: 'Removal results' });
  for (const id of ids.slice(0, REMOVAL_LIMIT - 1)) {
    await expect(bulk.locator(`[data-key="copy.lead.remove:${id}"]`)).toHaveText(`${copierName(id)} removed`);
  }
  const eleventh = ids[REMOVAL_LIMIT - 1];
  await expect(bulk.locator(`[data-key="copy.lead.remove:${eleventh}"]`)).toHaveText(
    `${copierName(eleventh)} not removed: You’ve reached today’s removal limit`,
  );
  await expect(copierRow(panel, eleventh)).toContainText('Active');

  // The same list sent again: every id already removed is skipped by its key, and the eleventh is still refused.
  const retry = await (await api(lead)).post('/api/trade/trpc/copy.lead.removeFollowers', { followIds: ids });
  expect(retry.status, JSON.stringify(retry.body).slice(0, 300)).toBe(200);
  const again = retry.body.result.data.results;
  expect(again.map((r) => r.key)).toEqual(ids.map((id) => `copy.lead.remove:${id}`));
  expect(again.slice(0, REMOVAL_LIMIT - 1).map((r) => r.outcome)).toEqual(Array(REMOVAL_LIMIT - 1).fill('already_removed'));
  expect(again[REMOVAL_LIMIT - 1]).toMatchObject({ outcome: 'refused', code: 'trade.copy_removal_limit_reached' });
  const listed = (await read(lead, 'copy.lead.followers')).followers;
  expect(
    listed
      .filter((f) => f.removedAt !== null)
      .map((f) => f.followId)
      .sort(),
  ).toEqual([followId, ...ids.slice(0, -1)].sort());
});

test(`${J} #2 sets a 5-minute disclosure delay and hides location: others see trades later; copiers at once; no location`, async ({
  page,
}) => {
  const panel = await leadDesk(page, 'Privacy');
  await panel.getByLabel('Show my trades to non-copiers after, minutes').fill('5');
  await panel.getByRole('switch', { name: 'Show my location' }).uncheck();
  await panel.getByRole('button', { name: 'Save' }).click();
  const profile = await (
    await api(state('follower'))
  ).get(`/api/trade/trpc/copy.leader?input=${encodeURIComponent(JSON.stringify({ leaderRef: state('leadRef') }))}`);
  expect(JSON.stringify(profile.body)).not.toMatch(/"(country|region|location)"/);
});

test(`${J} #3 edits the nickname twice within the window: the first goes to review; the second refused as throttled`, async ({ page }) => {
  const panel = await leadDesk(page, 'Profile');
  for (const name of ['Journey Renamed A', 'Journey Renamed B']) {
    await panel.getByLabel('Nickname').fill(`${name} ${state('tag')}`);
    await panel.getByRole('button', { name: 'Save' }).click();
  }
  await expect(panel.getByText(/In review/)).toBeVisible();
  await expect(panel.getByText(/You can change it again on/)).toBeVisible();
});

test(`${J} #4 fills the lead to capacity: a new follower refused and may join the waitlist; a freed slot sends one notice`, async ({
  page,
}) => {
  const panel = await leadDesk(page, 'Capacity');
  await panel.getByLabel('Most copiers').fill('1');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel).toContainText(/1 of 1/);
});

test(`${J} #5 uploads an oversize whitelist and makes an invitation with a copier limit: nothing written; the limit holds`, async ({
  page,
}) => {
  const panel = await leadDesk(page, 'Access');
  await panel.getByLabel('Whitelist file').setInputFiles({
    name: 'whitelist.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(Array.from({ length: 5001 }, (_, i) => `user${i}@local-test.invalid`).join('\n')),
  });
  await expect(panel.getByText(/more than the \d+ a file may hold/)).toBeVisible();
});

test(`${J} #6 checks the lead level: the level with its threshold and "Maximum ratio: not set by the platform"; any attempt to set a ratio is refused`, async ({
  page,
}) => {
  const panel = await leadDesk(page, 'Level', {});
  await expect(panel).toContainText('TEST Cadet');
  await expect(panel).toContainText('From 0 USDT of copied funds');
  await expect(panel).toContainText('TEST Silver from 5,000 USDT');
  await expect(panel).toContainText('Maximum ratio: not set by the platform');
  // The one copier still following holds 200 USDT for it.
  expect(await read(state('lead'), 'copy.lead.level')).toMatchObject({
    asset: 'USDT',
    copiedFunds: '200',
    level: { name: 'TEST Cadet', threshold: '0' },
    maxRatio: null,
  });
  for (const input of [{ ratio: '0.1' }, { ratio: '0.15', scope: 'private' }, { ratio: '0.1', scope: 'invitees' }]) {
    const res = await (await api(state('lead'))).post('/api/trade/trpc/copy.lead.setProfitShareRatio', input);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(403);
    expect(refusalCode(res)).toBe('trade.copy_pnl_fee_forbidden');
  }
});

test(`${J} #7 stops leading with an open spot position, then after closing it: refused while open; once closed review pending, and a founder approval delists`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const leadRef = state('leadRef');
  let panel = await leadDesk(page, 'Listing', {});
  await expect(panel).toContainText('Listed');
  await panel.getByRole('button', { name: 'Stop leading' }).click();
  await expect(panel.getByRole('alert').filter({ hasText: 'Close your open positions first' })).toBeVisible();
  expect(await read(state('lead'), 'copy.lead.listing')).toMatchObject({ leaderRef: leadRef, state: 'listed', stop: null });

  // The lead sells what #1 bought: every whole lot of the BTC held. The buy's fee was taken in BTC, so less than 0.001
  // is held, and a remainder under one lot can never be sold; no position the lead could close is left open.
  const lead = await api(state('lead'));
  const btc = (await lead.balances()).BTC?.free;
  expect(btc, 'the lead holds no BTC from the buy in #1').toBeTruthy();
  const { body: markets } = await lead.get('/api/v1/markets?limit=500');
  const lot = toUnits(markets.find((m) => m.symbol === 'BTC/USDT')?.precision?.amount ?? '0');
  expect(lot, 'BTC/USDT publishes its lot size').toBeGreaterThan(0n);
  await takeBest(state('lead'), 'sell', fromUnits((toUnits(btc) / lot) * lot), `${J}-7-close-${state('tag')}`);
  panel = await leadDesk(page, 'Listing', {});
  await panel.getByRole('button', { name: 'Stop leading' }).click();
  await expect(panel).toContainText('Review pending');
  const pending = await read(state('lead'), 'copy.lead.listing');
  expect(pending).toMatchObject({ state: 'listed', stop: { state: 'review_pending' } });

  // A founder approves it at the founders' door: the listing moves to delisted, and the lead page is gone.
  const ctx = await makeContext({ log: () => {} });
  const founders = await approverSessions(ctx);
  const queue = await ctx.edge.query('trade', 'copy.ops.leadStops.queue', undefined, founders.a.token);
  const stop = queue.json?.result?.data?.stops?.find((s) => s.leaderRef === leadRef);
  expect(stop, `the founders' queue has no stop for ${leadRef}: ${refusalText(queue)}`).toBeTruthy();
  const decided = await ctx.edge.mutate(
    'trade',
    'copy.ops.leadStops.decide',
    { stopId: stop.stopId, decision: 'approve', reason: `TEST ${J} #7 positions closed` },
    founders.a.token,
  );
  expect(decided.json?.result?.data?.state, refusalText(decided)).toBe('approved');
  panel = await leadDesk(page, 'Listing', {});
  await expect(panel).toContainText('Delisted');
  await expect(panel).toContainText('Approved: you no longer lead');
  const profile = await (await api(state('follower'))).get(trpc('copy.leaderProfile', { leaderRef }));
  expect(profile.status, JSON.stringify(profile.body).slice(0, 300)).toBe(404);
});
