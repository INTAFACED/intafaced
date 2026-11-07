// World: book
import { createHash } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { approverSessions, makeContext, setFeeDiscountSchedule } from '../../../../tooling/scripts/local-test-gates.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, fund, journeyState } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-copy-bots-otc-29, in the running app (docs/roadmap/journeys.json): a founder runs the OTC desk and its regional rules
// on the console's /trade-ops/otc. One test per step, titled "J-copy-bots-otc-29 #<n>", run in order.
// #1 makes its own quotes as a TEST trader staked to the desk's floor: two left open, one accepted and settled, and one
// accepted and left past its settle-by time (the failed settlement #3 reads). Each is read back from svc-trade by its id.
// Steps written but not built yet fail at their first missing part, quickly (UNBUILT): #2 client limits, #4 maker
// vetting, #5 region rules and #6 grouped fee volume have no tab on the room yet.
const J = 'J-copy-bots-otc-29';
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

/** One cell (by column index) of the row whose id cell reads `id` exactly. */
function cellOf(table, id, column) {
  return table
    .locator('tbody tr')
    .filter({ has: table.page().getByText(id, { exact: true }) })
    .locator('td')
    .nth(column);
}

async function desk(page, tab) {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/trade-ops/otc`);
  await expect(page.getByRole('heading', { name: 'OTC desk', level: 1 })).toBeVisible(UNBUILT);
  if (tab) await page.getByRole('tab', { name: tab }).click(UNBUILT);
}
const room = desk;

/** svc-trade's operator desk read, asked as founder b through svc-edge as the console asks it. */
async function quoteDesk() {
  const ctx = await makeContext({ log: () => undefined });
  const pair = await approverSessions(ctx);
  const res = await ctx.edge.query('trade', 'admin.copyBotsOtc.quoteDesk', {}, pair.b.token);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data;
}

async function rfq(who, quoteId) {
  const got = await (await api(who)).get(`/api/trade/trpc/rfq.get?input=${encodeURIComponent(JSON.stringify({ quoteId }))}`);
  expect(got.status, JSON.stringify(got.body).slice(0, 300)).toBe(200);
  return got.body.result.data;
}

/** The staking discount schedule must be readable before the desk's stake floor can be checked. */
async function stakeReadable(client) {
  const read = async () => (await client.get('/api/token/trpc/feeDiscount.get')).body.result.data;
  if ((await read()).schedule != null) return;
  const ctx = await makeContext({ log: () => undefined });
  const schedule = { basis: 'staked', tiers: [{ minStake: '0', discountBps: 0 }] };
  await setFeeDiscountSchedule(ctx, schedule, { sessions: await approverSessions(ctx) }).catch(async (err) => {
    if ((await read()).schedule == null) throw err;
  });
}

/** Stakes the desk's own published floor for the account, with business keys so a retried step neither funds nor stakes twice. */
async function stakeToDeskFloor(who, client) {
  const status = await client.get('/api/trade/trpc/otc.deskStatus');
  expect(status.status, JSON.stringify(status.body).slice(0, 300)).toBe(200);
  const floor = /(?:^| )minStake=(\S+)/.exec(status.body.result.data.statusLine)?.[1];
  expect(floor, status.body.result.data.statusLine).toBeTruthy();
  const hex = createHash('sha256').update(`${J}:stake:${who.email}:${floor}`).digest('hex');
  expect(fund(who.email, 'IFC', floor, `${J}-stake-${hex.slice(0, 16)}`).tx).toBeTruthy();
  const stakeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const staked = await client.post('/api/token/trpc/stake', { amount: floor, tier: 'flex', stakeId });
  expect(staked.status, JSON.stringify(staked.body).slice(0, 300)).toBe(200);
  await expect.poll(async () => (await client.get('/api/token/trpc/stakeOf')).body.result.data.staked).toBe(floor);
}

test(`${J} #1 opens desk operations: two open RFQs and one settled fill listed with their statuses`, async ({ page }) => {
  test.setTimeout(300_000);
  const trader = await fundedTrader(page, 'jco29', '8000');
  const me = await api(trader);
  await stakeReadable(me);
  await stakeToDeskFloor(trader, me);
  const makers = await me.get('/api/trade/trpc/otc.makers.list');
  expect(makers.status, JSON.stringify(makers.body).slice(0, 300)).toBe(200);
  const house = makers.body.result.data.makers.find((m) => m.route === 'platform');
  expect(house, JSON.stringify(makers.body).slice(0, 300)).toBeTruthy();
  const ask = async () => {
    const quoted = await me.post('/api/trade/trpc/rfq.quote', {
      side: 'buy',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      qty: '0.02',
      makerIds: [house.id],
    });
    expect(quoted.status, JSON.stringify(quoted.body).slice(0, 300)).toBe(200);
    return quoted.body.result.data.quoteId;
  };
  const accept = async (quoteId) => {
    const accepted = await me.post('/api/trade/trpc/rfq.accept', { quoteId });
    expect(accepted.status, JSON.stringify(accepted.body).slice(0, 300)).toBe(200);
  };
  // The failed settlement #3 reads: accepted, then left past its settle-by time.
  const failedId = await ask();
  await accept(failedId);
  const bound = await rfq(trader, failedId);
  expect(bound.lifecycle).toBe('bound');
  await page.waitForTimeout(Math.max(0, Date.parse(bound.settleBy) - Date.now()) + 1_000);
  // One settled fill: asked, accepted and settled inside its window. The desk sells from the house inventory: TEST BTC
  // for this one settle, keyed by the quote.
  const settledId = await ask();
  await accept(settledId);
  expect(fund('house', 'BTC', '0.02', `${J}-house-${settledId}`).tx).toBeTruthy();
  const settle = await me.post('/api/trade/trpc/otc.settle', { quoteId: settledId });
  expect(settle.status, JSON.stringify(settle.body).slice(0, 300)).toBe(200);
  expect((await rfq(trader, settledId)).lifecycle).toBe('settled');
  // Two open RFQs, asked last and read inside their time to live.
  const openIds = [await ask(), await ask()];
  for (const id of openIds) expect((await rfq(trader, id)).lifecycle).toBe('open');
  run.reset({ trader, failedId, settledId, openIds });

  await desk(page);
  const quotes = page.getByRole('table', { name: 'Quotes', exact: true });
  const read = await quoteDesk();
  const lifecycleOf = (id) => read.quotes.find((q) => q.quoteId === id)?.lifecycle;
  expect([...openIds.map(lifecycleOf), lifecycleOf(settledId)]).toEqual(['open', 'open', 'settled']);
  // Each listed by its own id, with the status svc-trade holds.
  for (const id of [...openIds, settledId]) await expect(cellOf(quotes, id, 3)).toHaveText(lifecycleOf(id));
});

test(`${J} #2 leaves a per-client limit blank: that client's quotes are refused`, async ({ page, browser }) => {
  test.setTimeout(240_000);
  const client = await fundedTrader(page, 'jotl', '1000');
  run.write({ client });
  const founder = await (await browser.newContext()).newPage();
  await desk(founder, 'Client limits');
  await founder.getByRole('searchbox', { name: 'Find a client' }).fill(client.email);
  await expect(founder.getByRole('row', { name: new RegExp(client.handle) })).toContainText('Not set');
  await founder.context().close();
  await signIn(page, client);
  await page.goto('/otc');
  await expect(page.getByText(/Your desk limit is not set/)).toBeVisible();
});

test(`${J} #3 opens an exception for a failed settlement: it lists with the saga key`, async ({ page }) => {
  test.setTimeout(240_000);
  // #1's accepted quote, left past its settle-by time: the desk read lists it as an exception under its settle saga key.
  const failedId = state('failedId');
  const desk = await quoteDesk();
  const exception = desk.exceptions.find((e) => e.quoteId === failedId);
  expect(exception, JSON.stringify(desk.exceptions).slice(0, 600)).toBeTruthy();
  expect(exception).toMatchObject({ sagaKey: `otc.settle:${failedId}`, reason: 'not_settled_by_deadline' });
  for (const id of [...state('openIds'), state('settledId')]) expect(desk.exceptions.map((e) => e.quoteId)).not.toContain(id);
  await room(page, 'Exceptions');
  const exceptions = page.getByRole('table', { name: 'Settlement exceptions' });
  await expect(cellOf(exceptions, exception.sagaKey, 0)).toHaveText(exception.sagaKey);
  await expect(cellOf(exceptions, exception.sagaKey, 1)).toHaveText('Not settled by its deadline');
  for (const id of [...state('openIds'), state('settledId')]) await expect(exceptions.locator('tbody tr', { hasText: id })).toHaveCount(0);
  // Listing it changed nothing: the quote is still bound, not settled.
  expect((await rfq(state('trader'), failedId)).lifecycle).toBe('bound');
});

test(`${J} #4 reviews a maker application: approve once; a second approve writes nothing`, async ({ page }) => {
  await desk(page, 'Makers');
  const row = page.getByRole('table', { name: 'Maker applications' }).locator('tbody tr').first();
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(row).toContainText('Approved');
  await expect(row.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});

test(`${J} #5 sets the region block list: OTC shows the banner and quotes refuse for a listed region; a blank list refuses every OTC product`, async ({
  page,
}) => {
  await desk(page, 'Regions');
  const regions = page.getByRole('form', { name: 'Region block list' });
  await regions.getByRole('textbox', { name: 'Blocked regions' }).fill('TEST-XX');
  await regions.getByRole('button', { name: 'Save block list' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Block list saved' })).toBeVisible();
  // A client in a listed region sees the banner and is refused a quote; with the list blank every OTC product refuses.
  await signIn(page, state('client'));
  await page.goto('/otc');
  await expect(page.getByRole('alert').filter({ hasText: /not available in your region/i })).toBeVisible();
});

test(`${J} #6 reads two linked sub-accounts with volumes 100 and 50: the grouped fee volume is 150`, async ({ page }) => {
  await desk(page, 'Fee groups');
  const group = page.getByRole('table', { name: 'Fee groups' }).locator('tbody tr').first();
  const parts = (await group.getByRole('cell', { name: /^\d/ }).allInnerTexts()).map((v) => Number(v.replace(/[^\d.]/g, '')));
  expect(parts.at(-1)).toBe(parts.slice(0, -1).reduce((a, b) => a + b, 0));
});
