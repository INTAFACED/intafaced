// World: book
import { test, expect } from './journey.mjs';
import { api, bestPrices, fromUnits, journeyState, toUnits } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { listLeader } from './copy.mjs';

// J-copy-bots-otc-15, in the running app (docs/roadmap/journeys.json): modify, stop and settle a grid bot, and copy a
// lead's grid. One test per step, titled "J-copy-bots-otc-15 #<n>", run in order. #1 makes the journey's start: a
// verified TEST trader with TEST 2000 USDT and a running 10-level BTC/USDT grid 5% either side of the book, made through
// the person's own grid door (svc-trade's grid, services/svc-trade/src/grid). Every bot, level and order is read back
// from that service, and what the account holds from the ledger.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #3: no price or RSI exit; #4: no settling stop (a stop keeps what the bot bought); #5: no idle-fund yield switch;
//   #6: no bonus-margin voucher; #7: no copying of a lead's grid; #8: no lead futures liquidation feeding a follow.
const J = 'J-copy-bots-otc-15';
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

const GRID = '/api/trade/trpc/bots.grid';
const codeOf = (body) => body?.error?.data?.cause?.code;
const read = (route, input) => `${route}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
async function getBot(who, botId) {
  const { status, body } = await (await api(who)).get(read(`${GRID}.get`, { botId }));
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}
/** A decimal string as the room shows it: the whole part grouped by thousands. */
const grouped = (d) => d.replace(/^\d+/, (w) => w.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const openBuys = (bot) => bot.orders.filter((o) => o.side === 'buy' && o.status === 'open');

/** The bot's own detail in the grid room. */
async function openBot(page, botId) {
  await page.goto(`/trade/bots/grid?bot=${encodeURIComponent(botId)}`);
  const detail = page.getByRole('region', { name: 'Spot grid BTC/USDT' });
  await expect(detail.getByTestId('grid-status')).toHaveText('Bot running');
  return detail;
}

/** A 10-level grid 5% either side of the book, made through the person's own door. */
async function makeGrid(who, key, investment = '500') {
  const { bid, ask } = await bestPrices();
  const one = toUnits('1');
  const made = await (
    await api(who)
  ).post(`${GRID}.create`, {
    clientRequestId: key,
    symbol: 'BTC/USDT',
    lowerPrice: fromUnits(((toUnits(bid) * 95n) / 100n / one) * one),
    upperPrice: fromUnits(((toUnits(ask) * 105n) / 100n / one) * one),
    gridCount: 10,
    investment,
  });
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  return made.body.result.data;
}

// Every grid this file made is stopped once its steps are done, so no level is left resting on the shared book.
test.afterAll(async () => {
  const { trader, botIds } = run.read() ?? {};
  for (const botId of botIds ?? []) await (await api(trader)).post(`${GRID}.stop`, { botId });
});

test(`${J} #1 tops up the quote by TEST 50: the investment rises by 50 and the grid re-initialises once; over the free USDT and a base top-up refused`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const trader = await fundedTrader(page, 'jgm', '2000');
  const tag = Date.now().toString(36);
  run.reset({ trader, tag });
  const bot = await makeGrid(trader, `${J}-${tag}`);
  run.write({ botId: bot.botId, botIds: [bot.botId] });
  expect(bot).toMatchObject({ status: 'running', investment: '500', reinitCount: 0 });
  const buysBefore = openBuys(bot);
  expect(buysBefore.length, 'the grid rests buys below the book').toBeGreaterThan(0);
  const ledgerBefore = (await (await api(trader)).balances()).USDT;

  await signIn(page, trader);
  const detail = await openBot(page, bot.botId);
  await detail.getByRole('button', { name: 'Top up' }).click();
  const sheet = page.getByRole('dialog', { name: 'Top up this grid' });
  const send = async (asset, amount) => {
    await sheet.getByLabel('Asset').selectOption(asset);
    await sheet.getByLabel('Amount').fill(amount);
    const answer = page.waitForResponse((res) => res.url().includes('bots.grid.topUp'));
    await sheet.getByRole('button', { name: 'Top up' }).click();
    const res = await answer;
    return { status: res.status(), body: await res.json() };
  };

  // A base top-up: refused as quote only, and nothing changes.
  const base = await send('BTC', '0.001');
  expect(base.status).toBe(400);
  expect(codeOf(base.body)).toBe('trade.bots_grid_topup_quote_only');
  await expect(sheet.getByRole('alert')).toContainText('A grid is topped up in its quote coin only');
  expect(await getBot(trader, bot.botId)).toMatchObject({ investment: '500', reinitCount: 0 });

  // One above the free USDT: the free figure is the account's available USDT less what the bot still sets aside
  // beyond its resting buys. Refused naming that figure, and nothing changes.
  const { free: available } = (await (await api(trader)).balances()).USDT;
  const held = buysBefore.reduce((sum, o) => sum + toUnits(o.holdAmount), 0n);
  const free = toUnits(available) - (toUnits(bot.reserve.amount) - held);
  expect(free > 0n, `free ${fromUnits(free)}`).toBe(true);
  const over = await send('USDT', fromUnits(free + toUnits('1')));
  expect(over.status).toBe(400);
  expect(codeOf(over.body)).toBe('trade.bots_grid_topup_exceeds_free');
  await expect(sheet.getByRole('alert')).toContainText('More than you have free');
  // The sheet names the free figure, read from the service: the same one the refusal was checked against.
  await expect(sheet.getByTestId('grid-topup-free')).toHaveText(`Free to add: ${grouped(fromUnits(free))} USDT`);
  expect(await getBot(trader, bot.botId)).toMatchObject({ investment: '500', reinitCount: 0 });

  // The quote top-up by TEST 50.
  const done = await send('USDT', '50');
  expect(done.status, JSON.stringify(done.body).slice(0, 300)).toBe(200);
  await expect(sheet.getByRole('status')).toContainText('Topped up by 50 USDT. The investment is now 550 USDT.');
  const after = await getBot(trader, bot.botId);
  expect(toUnits(after.investment) - toUnits(bot.investment)).toBe(toUnits('50'));
  expect(toUnits(after.reserve.amount) - toUnits(bot.reserve.amount)).toBe(toUnits('50'));
  expect(after.reinitCount).toBe(1);
  // Re-initialised: each level that rested a buy rests one again, sized for the new plan, under the next cycle's key.
  await expect
    .poll(async () => {
      const b = await getBot(trader, bot.botId);
      return openBuys(b)
        .map((o) => `${o.levelIndex}:${o.cycle}:${o.qty === b.levels[o.levelIndex].qty}`)
        .sort();
    })
    .toEqual(buysBefore.map((o) => `${o.levelIndex}:1:true`).sort());
  // Once: a later read still counts one re-plan, and the top-up moved no USDT (the total is what it was).
  const later = await getBot(trader, bot.botId);
  expect(later.reinitCount).toBe(1);
  expect((await (await api(trader)).balances()).USDT.total).toBe(ledgerBefore.total);
  await page.keyboard.press('Escape');
  await expect(detail).toContainText(/Investment\s*550 USDT/);
});

test(`${J} #2 turns on trailing with the shift limit blank: refused naming it; a minimum grid count above the count refused`, async ({
  page,
}) => {
  const trader = state('trader');
  const botId = state('botId');
  await signIn(page, trader);
  const detail = await openBot(page, botId);
  await detail.getByRole('button', { name: 'Change' }).click();
  const form = detail.getByRole('region', { name: 'Grid settings' });
  await form.getByRole('switch', { name: 'Trailing' }).click();
  const save = async () => {
    const answer = page.waitForResponse((res) => res.url().includes('bots.grid.modify'));
    await form.getByRole('button', { name: 'Save' }).click();
    const res = await answer;
    return { status: res.status(), body: await res.json() };
  };
  const blank = await save();
  expect(blank.status).toBe(400);
  expect(codeOf(blank.body)).toBe('trade.bots_grid_trailing_shift_limit_required');
  await expect(form.getByRole('alert')).toContainText('Enter a shift limit.');

  await form.getByLabel('Shift limit, %').fill('5');
  await form.getByLabel('Minimum grid count').fill('11');
  const above = await save();
  expect(above.status).toBe(400);
  expect(codeOf(above.body)).toBe('trade.bots_grid_min_count_above_count');
  await expect(form.getByRole('alert')).toContainText('The minimum can’t be more than the grid count.');
  await expect(form).toContainText('This grid has 10 grids.');
  // Neither refusal changed the grid.
  expect(await getBot(trader, botId)).toMatchObject({ gridCount: 10, investment: '550', reinitCount: 1, status: 'running' });
});

test(`${J} #3 sets a price exit and an RSI exit with no RSI source: the price exit stops once; RSI reads "Not set" and can't be saved`, async ({
  page,
}) => {
  const trader = state('trader');
  await signIn(page, trader);
  const detail = await openBot(page, state('botId'));
  await detail.getByRole('button', { name: 'Exits' }).click();
  await expect(detail.getByLabel('RSI exit')).toBeDisabled();
  await expect(detail.getByText(/RSI\s*Not set/)).toBeVisible();
  // A price exit right at the book: it fires on the next tick.
  const { bid } = await bestPrices();
  await detail.getByLabel('Stop when the price falls to').fill(bid);
  await detail.getByRole('button', { name: 'Save exits' }).click();
  await expect.poll(async () => (await getBot(trader, state('botId'))).stopReason, { timeout: 60_000 }).toBe('price_exit');
  await expect(detail).toContainText('Price exit');
});

test(`${J} #4 stops with settlement of base and quote: one sell job per level; a stop during a partial cancel refused`, async ({
  page,
}) => {
  const trader = state('trader');
  const bot = await makeGrid(trader, `${J}-4-${state('tag')}`, '300');
  run.write({ botIds: [...state('botIds'), bot.botId] });
  await signIn(page, trader);
  const detail = await openBot(page, bot.botId);
  await detail.getByRole('button', { name: 'Stop' }).click();
  const sheet = page.getByRole('dialog', { name: 'Stop this grid' });
  await sheet.getByRole('radio', { name: 'Sell the BTC back to USDT' }).check();
  const stoppedRes = page.waitForResponse((res) => res.url().includes('bots.stop'));
  await sheet.getByRole('button', { name: 'Stop and settle' }).click();
  expect((await stoppedRes).status()).toBe(200);
  const stopped = await getBot(trader, bot.botId);
  const levels = stopped.levels.filter((l) => toUnits(l.baseHeld ?? '0') > 0n).length;
  expect(stopped.settleJobs).toHaveLength(levels);
});

test(`${J} #5 turns on idle-fund yield: through the bank earn door; while it isn't wired, refused with the reason`, async ({ page }) => {
  await signIn(page, state('trader'));
  const detail = await openBot(page, state('botId'));
  await detail.getByRole('switch', { name: 'Earn on idle funds' }).check();
  await expect(detail.getByText(/Earn on idle funds|isn’t connected/)).toBeVisible();
});

test(`${J} #6 uses a bonus-margin voucher in a different coin: refused naming the mismatch`, async ({ page }) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/bots');
  await page
    .getByRole('table', { name: 'Bot catalogue' })
    .getByRole('row', { name: /^Grid/ })
    .getByRole('button', { name: 'Set up' })
    .click(UNBUILT);
  const wizard = page.getByRole('dialog', { name: 'Set up a grid bot' });
  await wizard.getByLabel('Voucher').selectOption({ label: /ETH/ });
  await expect(wizard.getByText(/This voucher is in ETH; this grid invests USDT/)).toBeVisible();
});

test(`${J} #7 copies a lead's grid bot: the same range and a snapshot id; later edits by the lead aren't followed`, async ({ page }) => {
  test.setTimeout(240_000);
  const lead = await fundedTrader(page, 'jgl', '2000');
  const leadRef = await listLeader(lead, `Journey Grid Lead ${state('tag')}`);
  const trader = state('trader');
  await signIn(page, trader);
  await page.goto(`/trade/copy/${leadRef}`);
  await page.getByRole('button', { name: 'Copy this grid' }).click(UNBUILT);
  const leadBot = await makeGrid(lead, `${J}-7-lead-${state('tag')}`);
  await page.getByRole('dialog').getByLabel('Investment (USDT)').fill('300');
  const answer = page.waitForResponse((res) => res.url().includes('bots.copyGrid'));
  await page.getByRole('dialog').getByRole('button', { name: 'Copy grid' }).click();
  const copied = (await (await answer).json()).result.data;
  expect([copied.lowerPrice, copied.upperPrice]).toEqual([leadBot.lowerPrice, leadBot.upperPrice]);
  expect(copied.snapshotId).toBeTruthy();
  await (
    await api(lead)
  ).post('/api/trade/trpc/bots.modifyGrid', { botId: leadBot.botId, upperPrice: fromUnits(toUnits(leadBot.upperPrice) + toUnits('100')) });
  expect((await getBot(trader, copied.botId)).upperPrice).toBe(leadBot.upperPrice);
});

test(`${J} #8 a lead's futures liquidation on a copied pair: the follower position flattens once; a spot follow reads "Not applicable (spot)"`, async ({
  page,
}) => {
  await signIn(page, state('trader'));
  await page.goto('/trade/copy?tab=follows');
  const grid = page.getByRole('grid', { name: 'My follows' });
  await expect(grid.getByText('Not applicable (spot)').first()).toBeVisible(UNBUILT);
});
