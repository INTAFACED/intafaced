import { test, expect } from '@playwright/test';
import { api, bestPrices, fromUnits, journeyState, tool, toUnits } from './stack.mjs';
import { fundedTrader, signIn, signUp, verify } from './desk.mjs';

const ONE = toUnits('1');

// J-copy-bots-otc-14, in the running app (docs/roadmap/journeys.json): start a spot grid bot and watch it earn. One test
// per step, titled "J-copy-bots-otc-14 #<n>". The trader is a TEST account on the local stack, verified and funded with
// TEST USDT; the bot's levels go to the real TEST book. The reserve must equal the investment and each level hold only its
// own order, which the steps read from the ledger.
// The grid is svc-trade's own (services/svc-trade/src/grid): its reserve row and level orders are read back from it, and
// what the ledger holds is read from the ledger. A blank owner level comes from restarting trade with
// LOCAL_STACK_TRADE_BOTS_LEVEL=blank, and a price out of range from the TEST market's `move`, each undone in a finally.
// Steps that are written but not built yet fail at their first missing part, quickly, by name (UNBUILT):
// - #7 needs a grid profit withdrawal (CB-bots-05).
const J = 'J-copy-bots-otc-14';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

const wizard = (page) => page.getByRole('form', { name: 'Spot grid' });
const usdt = async () => (await (await api(run.read().who)).balances()).USDT;

async function openBots(page) {
  await signIn(page, run.read().who);
  await page.goto('/bots');
  await expect(page.getByRole('heading', { name: 'Bots', level: 1 })).toBeVisible();
}

async function openGrid(page) {
  await openBots(page);
  await page.getByRole('link', { name: /Spot grid/ }).click();
  await expect(wizard(page)).toBeVisible(UNBUILT);
}

test(`${J} starts: a verified TEST account with 1000 USDT`, async ({ page }) => {
  test.setTimeout(180_000);
  run.reset({ who: await fundedTrader(page, 'gb', '1000') });
});

test(`${J} #1 opens Bots: the hub with one status and one link per bot type, each refusal in words; My bots from the server even in a new browser`, async ({
  page,
}) => {
  // A bot this person started elsewhere: made through the service, never in this browser, which is new and holds nothing.
  const me = await api(run.read().who);
  const { ask } = await bestPrices();
  const made = await me.post('/api/trade/trpc/algo.createTwap', {
    symbol: 'BTC/USDT',
    side: 'buy',
    totalQty: '0.001',
    durationMs: 3_600_000,
    sliceIntervalMs: 600_000,
    // A buy limit must sit at or over the ask (the slice price band); a whole number 1% over it.
    limitPrice: String((toUnits(ask) * 101n) / 100n / ONE + 1n),
    clientAlgoId: `${J}-hub-${Date.now().toString(36)}`,
    kind: 'twap',
  });
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  const botId = made.body.result.data.id;
  try {
    await hub(page, botId);
  } finally {
    // Its slices would hold USDT while the grid steps measure the reserve, so the journey stops it, pass or fail.
    const stopped = await me.post('/api/trade/trpc/algo.cancel', { algoId: botId });
    expect(stopped.status, JSON.stringify(stopped.body).slice(0, 300)).toBe(200);
  }
});

// The one type with no engine yet, with the exact words its row and its own room give (BotsRoom NOT_BUILT).
// No service is called for it, so there is no typed code to match: the refusal is these words, read exactly.
const NOT_READY = {
  'Recurring buy (DCA)': 'No recurring-order service exists. Use Convert for a single trade.',
};

/** My bots' words for each algo state (BotDetail BOT_WORD). */
const STATE_WORD = { active: 'Running', paused: 'Paused', halted: 'Halted', cancelled: 'Stopped', completed: 'Finished' };

async function readAs(who, path, input) {
  const { status, body } = await (await api(who)).get(read(path, input));
  return { status, body };
}

/**
 * What each type's status must read, from the service's own answers: the algo kinds from `algo.policy`, the grid from
 * `bots.grid.setup` (answered, or refused with its typed code), paper strategies and DCA from what they are.
 */
async function expectedStatuses(who) {
  const policy = await readAs(who, '/api/trade/trpc/algo.policy');
  expect(policy.status, JSON.stringify(policy.body).slice(0, 300)).toBe(200);
  const { capability, immatureKinds } = policy.body.result.data;
  const algo = (kind) =>
    !capability.createEnabled
      ? 'Not available: New bots can’t be created right now'
      : immatureKinds.includes(kind)
        ? 'Available. Volume history is still short. A slice may be refused when it is due.'
        : 'Available';
  const setup = await readAs(who, `${GRID}.setup`);
  // The stack sets the owner's level and count range, so the setup read answers; a refusal here is a red, by its code.
  expect(setup.status, `bots.grid.setup refused ${codeOf(setup.body)}`).toBe(200);
  return {
    'Time-weighted (TWAP)': algo('twap'),
    'Volume-weighted (VWAP)': algo('vwap'),
    'Participation (POV)': algo('pov'),
    'Spot grid': 'Available',
    'Recurring buy (DCA)': `Not available: ${NOT_READY['Recurring buy (DCA)']}`,
    'Strategy from Quant Studio': 'Available on paper only',
  };
}

const myAlgoIds = async () => {
  const { status, body } = await readAs(run.read().who, '/api/trade/trpc/algo.list', { limit: 500 });
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  // The whole list in one read (the service's most), so a bot made now can't hide on a later page.
  expect(body.result.data.nextCursor).toBeNull();
  return body.result.data.rows.map((row) => row.id).sort();
};

async function hub(page, botId) {
  const who = run.read().who;
  await openBots(page);
  const types = page.getByRole('list', { name: 'Bot types' }).getByRole('listitem');
  await expect(types.first()).toBeVisible(UNBUILT);
  // The statuses settle once the service's bot policy answers: until then the live types read "Checking".
  await expect(types.getByTestId('bot-type-status').filter({ hasText: /^Checking$/ })).toHaveCount(0);
  const statuses = {};
  for (const type of await types.all()) {
    // One link and one status per type, each type once.
    await expect(type.getByRole('link')).toHaveCount(1);
    const name = (await type.getByRole('link').innerText()).trim();
    expect(statuses, `${name} is listed twice`).not.toHaveProperty([name]);
    statuses[name] = (await type.getByTestId('bot-type-status').innerText()).trim();
  }
  // Every type exactly once, each status the one the service's own answers call for, each refusal in its words.
  expect(statuses).toEqual(await expectedStatuses(who));

  // Following a refused type's link shows the same reason in its room, offers no form, and creates nothing.
  const before = await myAlgoIds();
  await page.getByRole('list', { name: 'Bot types' }).getByRole('link', { name: 'Recurring buy (DCA)', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recurring buy (DCA)', level: 1 })).toBeVisible();
  await expect(page.getByText('Not available', { exact: true })).toBeVisible();
  await expect(page.getByText(NOT_READY['Recurring buy (DCA)'], { exact: true })).toBeVisible();
  await expect(page.locator('form')).toHaveCount(0);
  expect(await myAlgoIds()).toEqual(before);
  await page.getByRole('button', { name: 'Back to Bots' }).click();
  await expect(page.getByRole('heading', { name: 'Bots', level: 1 })).toBeVisible();

  // My bots is the service's list: the same ids, each with its state's word, and nothing else. This browser is new, so
  // the bot made through the service above can only come from that read.
  const listed = await readAs(who, '/api/trade/trpc/algo.list', { limit: 50 });
  expect(listed.status, JSON.stringify(listed.body).slice(0, 300)).toBe(200);
  const want = Object.fromEntries(listed.body.result.data.rows.map((r) => [r.id, STATE_WORD[r.status]]));
  expect(Object.keys(want)).toContain(botId);
  const table = page.getByRole('grid', { name: 'My bots', exact: true });
  await expect(table.locator('a[href*="bot="]')).toHaveCount(Object.keys(want).length);
  const shown = {};
  for (const row of await table
    .getByRole('row')
    .filter({ has: page.locator('a[href*="bot="]') })
    .all()) {
    const href = await row.locator('a[href*="bot="]').getAttribute('href');
    const id = new URLSearchParams(href.split('?')[1]).get('bot');
    shown[id] = (
      await row
        .getByRole('gridcell')
        .filter({ hasText: /^(Running|Paused|Halted|Stopped|Finished|Unknown state)$/ })
        .innerText()
    ).trim();
  }
  expect(shown).toEqual(want);
  const row = table.getByRole('row').filter({ has: page.locator(`a[href*="bot=${botId}"]`) });
  await expect(row.getByRole('link')).toHaveText('TWAP BTC/USDT');
}

// ── The grid's own door, read through Edge as the person ─────────────────────────────────────────────────────────────

const codeOf = (body) => body?.error?.data?.cause?.code;
const GRID = '/api/trade/trpc/bots.grid';
const read = (route, input) => `${route}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;

async function gridList(who) {
  const { status, body } = await (await api(who)).get(read(`${GRID}.list`));
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

async function gridBot(who, botId) {
  const { status, body } = await (await api(who)).get(read(`${GRID}.get`, { botId }));
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

async function algoIds(who) {
  const { status, body } = await (await api(who)).get(read('/api/trade/trpc/algo.list', { limit: 500 }));
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  expect(body.result.data.nextCursor).toBeNull();
  return body.result.data.rows.map((row) => row.id).sort();
}

/** Every bot door the service has: the grid's create and the algo create, once per kind its input takes. */
const ALGO_KINDS = ['twap', 'vwap', 'pov'];
async function everyBotCreate(who, tag) {
  const me = await api(who);
  const { bid, ask } = await bestPrices();
  const answers = {};
  answers.grid = await me.post(`${GRID}.create`, {
    clientRequestId: `${J}-${tag}-grid-${Date.now().toString(36)}`,
    symbol: 'BTC/USDT',
    lowerPrice: String((toUnits(bid) * 95n) / 100n / ONE),
    upperPrice: String((toUnits(ask) * 105n) / 100n / ONE),
    gridCount: 20,
    investment: '200',
  });
  for (const kind of ALGO_KINDS) {
    answers[kind] = await me.post('/api/trade/trpc/algo.createTwap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      totalQty: '0.001',
      durationMs: 3_600_000,
      // 5m: a listed OHLCV timeframe, so a VWAP's own shape check passes and the refusal is the bots gate's.
      sliceIntervalMs: 300_000,
      limitPrice: String((toUnits(ask) * 101n) / 100n / ONE + 1n),
      clientAlgoId: `${J}-${tag}-${kind}-${Date.now().toString(36)}`,
      kind,
      ...(kind === 'pov' ? { participationBps: 1000 } : {}),
    });
  }
  return answers;
}

/** Restart trade with one owner value blank (`blank`) or as the TEST profile sets it (`set`), by its stack switch. */
function restartTrade(switchName, state) {
  const before = process.env[switchName];
  if (state === 'blank') process.env[switchName] = 'blank';
  else delete process.env[switchName];
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    if (before === undefined) delete process.env[switchName];
    else process.env[switchName] = before;
  }
}

/** The owner's bots verification level, blank or as the TEST profile sets it. */
const botsLevel = (state) => restartTrade('LOCAL_STACK_TRADE_BOTS_LEVEL', state);
/** The owner's distance a grid bound may sit from the market price, blank or as the TEST profile sets it. */
const gridBand = (state) => restartTrade('LOCAL_STACK_TRADE_GRID_BAND', state);

async function openGridRoom(page, who) {
  await signIn(page, who);
  await page.goto('/trade/bots/grid');
  await expect(page.getByRole('heading', { name: 'Spot grid', level: 1 })).toBeVisible();
}

test(`${J} #2 opens the grid wizard below the owner's verification level: refused as verification insufficient, with no parent row; a blank owner level refuses every bot`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  // Below the level: an account verified to Basic, which the trade module itself admits (its matrix minimum), against
  // the TEST profile's bots level (full). An unverified account never reaches the bots gate: the matrix refuses it first.
  const unverified = await signUp(page, 'gu');
  await verify(page, unverified, 'Basic');
  const setup = await (await api(unverified)).get(read(`${GRID}.setup`));
  expect(setup.status, JSON.stringify(setup.body).slice(0, 300)).toBe(403);
  expect(codeOf(setup.body)).toBe('trade.bots_verification_insufficient');
  await openGridRoom(page, unverified);
  await expect(page.getByText('Verification insufficient', { exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Spot grid' })).toHaveCount(0);
  // Every create door refuses with the same code, and the record read after holds no parent row of any kind.
  const below = await everyBotCreate(unverified, 'below');
  for (const [door, answer] of Object.entries(below)) {
    expect(answer.status, `${door}: ${JSON.stringify(answer.body).slice(0, 300)}`).toBe(403);
    expect(codeOf(answer.body), door).toBe('trade.bots_verification_insufficient');
  }
  expect(await gridList(unverified)).toEqual([]);
  expect(await algoIds(unverified)).toEqual([]);

  // A blank owner level: the verified trader, who is at the level, is refused by every bot door as the level not set.
  const who = run.read().who;
  const gridsBefore = (await gridList(who)).map((b) => b.botId).sort();
  const algosBefore = await algoIds(who);
  botsLevel('blank');
  try {
    const blankSetup = await (await api(who)).get(read(`${GRID}.setup`));
    expect(blankSetup.status, JSON.stringify(blankSetup.body).slice(0, 300)).toBe(403);
    expect(codeOf(blankSetup.body)).toBe('trade.bots_verification_level_not_set');
    const blank = await everyBotCreate(who, 'blank');
    expect(Object.keys(blank).sort()).toEqual(['grid', ...ALGO_KINDS].sort());
    for (const [door, answer] of Object.entries(blank)) {
      expect(answer.status, `${door}: ${JSON.stringify(answer.body).slice(0, 300)}`).toBe(403);
      expect(codeOf(answer.body), door).toBe('trade.bots_verification_level_not_set');
    }
    await openGridRoom(page, who);
    await expect(page.getByText('Bots are closed: no verification level is set', { exact: true })).toBeVisible();
    await expect(page.getByRole('form', { name: 'Spot grid' })).toHaveCount(0);
    expect((await gridList(who)).map((b) => b.botId).sort()).toEqual(gridsBefore);
    expect(await algoIds(who)).toEqual(algosBefore);
  } finally {
    botsLevel('set');
  }
});

test(`${J} #3 opens presets: with no backtest source the list reads "Not set" and no APR`, async ({ page }) => {
  const presets = await (await api(run.read().who)).get(read(`${GRID}.presets`));
  expect(presets.status, JSON.stringify(presets.body).slice(0, 300)).toBe(200);
  expect(presets.body.result.data).toEqual({ source: null, presets: [] });
  await openGrid(page);
  await wizard(page).getByRole('tab', { name: 'Presets' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Presets' });
  await expect(panel.getByText('Backtested presets', { exact: true })).toBeVisible();
  await expect(panel).toContainText(/Backtested presets\s*Not set/);
  await expect(panel.getByRole('listitem')).toHaveCount(0);
  // No APR figure anywhere in the panel: only the note that none is shown.
  await expect(panel).not.toContainText(/\d\s*%/);
  await expect(panel).toContainText('No backtest source is connected, so no preset and no APR is shown.');
});

/** The browser's own create call: its request body and the service's answer, with the refusal's typed code. */
async function pressCreate(page) {
  const answer = page.waitForResponse((res) => res.url().includes('bots.grid.create') && res.request().method() === 'POST');
  await wizard(page).getByRole('button', { name: 'Create bot' }).click();
  const res = await answer;
  const body = await res.json();
  return { status: res.status(), body, request: res.request().postDataJSON(), url: res.url() };
}

test(`${J} #4 enters bounds left blank, then one grid, then twenty: the first two refused naming the field; twenty levels planned; a second create with the same key returns the same bot`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = run.read().who;
  const before = await usdt();
  const gridsBefore = await gridList(who);

  // CB-bots-02's owner bounds relative to market, blank: the setup read names it unset, the wizard reads "Not set", and a
  // create with every field valid is refused by its code, with nothing written. Trade restarts as set in the finally.
  gridBand('blank');
  try {
    const blankSetup = await (await api(who)).get(read(`${GRID}.setup`));
    expect(blankSetup.status, JSON.stringify(blankSetup.body).slice(0, 300)).toBe(200);
    expect(blankSetup.body.result.data.boundsMaxDistanceBps).toBeNull();
    const { bid, ask } = await bestPrices();
    const blank = await (
      await api(who)
    ).post(`${GRID}.create`, {
      clientRequestId: `${J}-band-blank-${Date.now().toString(36)}`,
      symbol: 'BTC/USDT',
      lowerPrice: String((toUnits(bid) * 95n) / 100n / ONE),
      upperPrice: String((toUnits(ask) * 105n) / 100n / ONE),
      gridCount: 20,
      investment: '200',
    });
    expect(blank.status, JSON.stringify(blank.body).slice(0, 300)).toBe(400);
    expect(codeOf(blank.body)).toBe('trade.bots_grid_bounds_band_not_set');
    await openGrid(page);
    await expect(wizard(page)).toContainText(/Bounds allowed\s*Not set/);
    expect(await gridList(who)).toEqual(gridsBefore);
    expect(await usdt()).toEqual(before);
  } finally {
    gridBand('set');
  }

  // Set: the TEST distance read back from the service is the one the wizard names.
  const setup = await (await api(who)).get(read(`${GRID}.setup`));
  expect(setup.status, JSON.stringify(setup.body).slice(0, 300)).toBe(200);
  expect(setup.body.result.data.boundsMaxDistanceBps).toBe(1000);
  await openGrid(page);
  await expect(wizard(page)).toContainText(/Bounds allowed\s*Within 10% of the market price/);
  const field = (name) => wizard(page).getByRole('textbox', { name });
  await field('Investment').fill('200');
  await field('Grids').fill('20');

  // Bounds left blank: refused naming Lower price, and nothing written.
  const blank = await pressCreate(page);
  expect(blank.status, JSON.stringify(blank.body).slice(0, 300)).toBe(400);
  expect(codeOf(blank.body)).toBe('trade.bots_grid_bounds_not_set');
  // The wire carries the typed code and the service's own words, which name the field.
  expect(blank.body.error.message).toBe('Lower price is required');
  await expect(wizard(page).getByText('Enter both bounds', { exact: true })).toBeVisible();
  expect(await gridList(who)).toEqual(gridsBefore);

  // The range sits round the book's mid with the mid halfway between levels 10 and 11, half a percent from each,
  // so neither the walk nor a crossing reaches a level while the holds are read.
  const { bid, ask } = await bestPrices();
  const mid = (toUnits(bid) + toUnits(ask)) / 2n;
  const step = mid / 200n;
  const lower = ((mid - (step * 19n) / 2n) / ONE) * ONE;
  const upper = lower + step * 19n;
  await field('Lower price').fill(fromUnits(lower));
  await field('Upper price').fill(fromUnits((upper / ONE) * ONE));

  // One grid: refused naming Grids, with the range it must be in, and nothing written.
  await field('Grids').fill('1');
  const one = await pressCreate(page);
  expect(one.status, JSON.stringify(one.body).slice(0, 300)).toBe(400);
  expect(codeOf(one.body)).toBe('trade.bots_grid_count_out_of_range');
  expect(one.body.error.message).toBe('Grids must be from 2 to 100');
  await expect(wizard(page).getByText('Grids is out of range', { exact: true })).toBeVisible();
  expect(await gridList(who)).toEqual(gridsBefore);
  expect(await usdt()).toEqual(before);

  // A lower bound beyond the owner's distance (15% under the mid, against 10%): refused naming Lower price, nothing written.
  await field('Grids').fill('20');
  await field('Lower price').fill(fromUnits(((mid * 85n) / 100n / ONE) * ONE));
  const far = await pressCreate(page);
  expect(far.status, JSON.stringify(far.body).slice(0, 300)).toBe(400);
  expect(codeOf(far.body)).toBe('trade.bots_grid_bounds_out_of_band');
  expect(far.body.error.message).toBe('Lower price must be within 10% of the market price');
  await expect(wizard(page).getByText('A bound is too far from the market price', { exact: true })).toBeVisible();
  expect(await gridList(who)).toEqual(gridsBefore);
  expect(await usdt()).toEqual(before);
  await field('Lower price').fill(fromUnits(lower));

  // Twenty: twenty levels planned in the wizard, then by the service at the same prices.
  const planned = wizard(page).getByTestId('grid-plan').getByRole('listitem');
  await expect(planned).toHaveCount(20);
  const previewPrices = (await planned.allInnerTexts()).map((text) => toUnits(text.replace(/[^\d.]/g, '')));
  const made = await pressCreate(page);
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  const botId = made.body.result.data.botId;
  await expect(page).toHaveURL(new RegExp(`bot=${encodeURIComponent(botId)}`));
  await expect(page.getByTestId('grid-status')).toHaveText('Bot running');
  const bot = await gridBot(who, botId);
  expect(bot.status).toBe('running');
  expect(bot.gridCount).toBe(20);
  expect(bot.levels.map((l) => l.index)).toEqual([...Array(20).keys()]);
  expect(bot.levels.map((l) => toUnits(l.price))).toEqual(previewPrices);
  run.write({ ...run.read(), botId, request: made.request, url: made.url });

  // Lead ruling (CB-bots-02, J-copy-bots-otc-14 #4): the reserve row svc-trade reports is the investment, 200 USDT;
  // the ledger's `used` rises by exactly the holds of the level orders the service reports; nothing else is held.
  expect(bot.reserve).toMatchObject({ key: `bots.grid.reserve:${botId}`, asset: 'USDT', releasedAt: null });
  expect(toUnits(bot.reserve.amount)).toBe(toUnits('200'));
  const open = bot.orders.filter((o) => o.status === 'open');
  // One buy at each level under the mid, and no sell: the bot holds no base yet.
  expect(open.map((o) => o.side)).toEqual(Array(10).fill('buy'));
  expect(open.map((o) => o.levelIndex).sort((a, b) => a - b)).toEqual([...Array(10).keys()]);
  const holds = open.reduce((sum, o) => sum + toUnits(o.holdAmount), 0n);
  for (const o of open) expect(toUnits(o.holdAmount)).toBe(toUnits(bot.levels[o.levelIndex].hold));
  const after = await usdt();
  expect(toUnits(after.used) - toUnits(before.used)).toBe(holds);
  expect(toUnits(after.total)).toBe(toUnits(before.total));

  // The same key again, through the same door: the same bot, no second row, nothing more held.
  const again = await (await api(who)).post(new URL(made.url).pathname, made.request);
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body.result.data.botId).toBe(botId);
  const grids = await gridList(who);
  expect(grids.filter((b) => b.botId === botId)).toHaveLength(1);
  expect(grids.length).toBe(gridsBefore.length + 1);
  expect(toUnits((await usdt()).used)).toBe(toUnits(after.used));
});

/** Wait until the grid reads `status`, through its own door; the tick runs every second on the stack. */
async function untilStatus(who, botId, status, waitMs = 30_000) {
  const until = Date.now() + waitMs;
  for (;;) {
    const bot = await gridBot(who, botId);
    if (bot.status === status) return bot;
    if (Date.now() >= until) throw new Error(`grid ${botId} still reads ${bot.status} (${bot.statusReason}), not ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The trade service's fills of one of `who`'s orders. */
async function fillsOf(who, orderId) {
  const { status, body } = await readAs(who, '/api/trade/trpc/fills.forOrder', { orderId, limit: 50 });
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

/** Wait until the bot read satisfies `ok`. */
async function untilBot(who, botId, ok, waitMs = 90_000) {
  const until = Date.now() + waitMs;
  for (;;) {
    const bot = await gridBot(who, botId);
    if (ok(bot)) return bot;
    if (Date.now() >= until)
      throw new Error(
        `grid ${botId} did not reach the expected state: ${JSON.stringify(bot.orders.map((o) => [o.side, o.status, o.price]))}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The `move` percent (two decimals, whole basis points) that takes the mid `from` to about `to`. */
function shiftPercent(from, to) {
  const bps = ((to - from) * 10_000n) / from;
  const sign = bps < 0n ? '-' : '+';
  const abs = bps < 0n ? -bps : bps;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}%`;
}

/** Wait until the BTC/USDT book's mid is past `limit` (`above` or `below`). */
async function untilMid(side, limit, waitMs = 60_000) {
  const until = Date.now() + waitMs;
  for (;;) {
    const { bid, ask } = await bestPrices();
    const mid = (toUnits(bid) + toUnits(ask)) / 2n;
    if (side === 'above' ? mid > limit : mid < limit) return mid;
    if (Date.now() >= until) throw new Error(`the BTC/USDT mid ${fromUnits(mid)} is not ${side} ${fromUnits(limit)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test(`${J} #5 lets the price leave the upper bound: no new buy is placed and the range pause shows`, async ({ page }) => {
  test.setTimeout(180_000);
  const { who, botId } = run.read();
  const start = await gridBot(who, botId);
  expect(start.status).toBe('running');
  const upper = toUnits(start.upperPrice);
  try {
    // 7% up: the mid starts about 4.75% under the upper bound (#4), so this takes it past it.
    tool('local-test-market.mjs', 'move', 'BTC/USDT', '+7%');
    await untilMid('above', upper);
    const paused = await untilStatus(who, botId, 'paused_range');
    expect(paused.statusReason).toBe('mark_outside_range');
    const buys = paused.orders.filter((o) => o.side === 'buy').map((o) => o.clientOrderId);
    // Several more ticks with the price still above: no new buy order row, and the ledger holds no more.
    const held = toUnits((await usdt()).used);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await untilMid('above', upper);
    const still = await gridBot(who, botId);
    expect(still.status).toBe('paused_range');
    expect(still.orders.filter((o) => o.side === 'buy').map((o) => o.clientOrderId)).toEqual(buys);
    expect(toUnits((await usdt()).used)).toBeLessThanOrEqual(held);
    // The range pause in the room and in My bots.
    await signIn(page, who);
    await page.goto(`/trade/bots/grid?bot=${encodeURIComponent(botId)}`);
    await expect(page.getByTestId('grid-status')).toHaveText('Paused: the price is outside the range');
    await page.goto('/bots');
    const row = page
      .getByRole('grid', { name: 'My grid bots' })
      .getByRole('row')
      .filter({ has: page.locator(`a[href*="bot=${botId}"]`) });
    await expect(row).toContainText('Paused: the price is outside the range');
  } finally {
    tool('local-test-market.mjs', 'move', 'BTC/USDT', '0%');
    await untilMid('below', upper);
  }
});

test(`${J} #6 opens Metrics after two closed level pairs: grid profit is their sum net of fees; an APR with zero days reads "Not set"`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { who, botId } = run.read();
  const start = await untilStatus(who, botId, 'running', 60_000);
  expect(start.closedPairs).toBe(0);
  // Two level pairs close through the TEST book: the price falls through exactly two resting buys, the bot places a
  // sell one level above each, and the price comes back up through both sells.
  const buys = start.orders
    .filter((o) => o.side === 'buy' && o.status === 'open')
    .map((o) => toUnits(o.price))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  expect(buys.length).toBeGreaterThanOrEqual(3);
  const { bid, ask } = await bestPrices();
  const mid = (toUnits(bid) + toUnits(ask)) / 2n;
  const target = (buys[1] + buys[2]) / 2n;
  try {
    tool('local-test-market.mjs', 'move', 'BTC/USDT', shiftPercent(mid, target));
    await untilMid('below', buys[1]);
    const bought = await untilBot(who, botId, (b) => b.orders.filter((o) => o.side === 'sell' && o.status === 'open').length === 2);
    const filledBuys = bought.orders.filter((o) => o.side === 'buy' && o.status === 'filled').map((o) => toUnits(o.price));
    expect(filledBuys.sort()).toEqual([buys[1], buys[0]].sort());
    const sells = bought.orders.filter((o) => o.side === 'sell' && o.status === 'open').map((o) => toUnits(o.price));
    // The top sell sits one level above where the price started, so the price rises half a level past it. A move
    // shifts the TEST price from its base, which is where the mid stood before the first move.
    const top = sells.reduce((a, b) => (a > b ? a : b));
    tool('local-test-market.mjs', 'move', 'BTC/USDT', shiftPercent(mid, top + (buys[0] - buys[1]) / 2n));
    await untilMid('above', top);
    await untilBot(who, botId, (b) => b.closedPairs >= 2);
  } finally {
    tool('local-test-market.mjs', 'move', 'BTC/USDT', '0%');
  }
  const bot = await gridBot(who, botId);
  expect(bot.closedPairs, 'two closed level pairs').toBe(2);
  const pairs = bot.orders.filter((o) => o.side === 'sell' && o.status === 'filled' && o.pairProfit !== null);
  expect(pairs).toHaveLength(2);
  // Net of fees, from the trade service's own fills of each pair's buy and sell: the sell's proceeds less its fee, less
  // what the base it sold cost (the buy's cost with its fee, over what the buy delivered net of its base fee).
  const ONE = 10n ** 18n;
  const ceilDiv = (a, b) => (a + b - 1n) / b;
  for (const sell of pairs) {
    const buy = bot.orders.find((o) => o.side === 'buy' && o.levelIndex === sell.levelIndex && o.cycle === sell.cycle);
    expect(buy?.status, `the buy that opened level ${sell.levelIndex}`).toBe('filled');
    const buyFills = await fillsOf(who, buy.orderId);
    const sellFills = await fillsOf(who, sell.orderId);
    expect(buyFills.length).toBeGreaterThan(0);
    expect(sellFills.length).toBeGreaterThan(0);
    const total = (fills, pick) => fills.reduce((a, f) => a + pick(f), 0n);
    const fee = (fills, asset) => total(fills, (f) => (f.fee.currency === asset ? toUnits(f.fee.cost) : 0n));
    const bought = total(buyFills, (f) => toUnits(f.amount)) - fee(buyFills, 'BTC');
    const sold = total(sellFills, (f) => toUnits(f.amount)) + fee(sellFills, 'BTC');
    expect(sold).toBe(toUnits(sell.qty));
    const cost = ceilDiv(ceilDiv((total(buyFills, (f) => toUnits(f.cost)) + fee(buyFills, 'USDT')) * sold, ONE) * ONE, bought);
    const net = total(sellFills, (f) => toUnits(f.cost)) - fee(sellFills, 'USDT') - cost;
    expect(toUnits(sell.pairProfit), `level ${sell.levelIndex} pair profit net of fees`).toBe(net);
    expect(net > 0n, `level ${sell.levelIndex}: one level up is a profit`).toBe(true);
  }
  const sum = pairs.reduce((total, o) => total + toUnits(o.pairProfit), 0n);
  expect(toUnits(bot.gridProfit)).toBe(sum);
  await signIn(page, who);
  await page.goto(`/trade/bots/grid?bot=${encodeURIComponent(botId)}`);
  await page.getByRole('tab', { name: 'Metrics' }).click();
  const metrics = page.getByRole('tabpanel', { name: 'Metrics' });
  await expect(metrics).toContainText(`Grid profit${fromUnits(sum)} USDT`);
  // APR by the lead's ruling (CB-bots-05): none before a whole day has run. Read back from the service, with the bot's
  // own start time, then the words the Metrics tab shows for it.
  const metered = await gridBot(who, botId);
  expect(Date.now() - Date.parse(metered.createdAt)).toBeLessThan(86_400_000);
  expect(metered.gridApr).toEqual({ state: 'under_a_day', percent: null });
  await expect(metrics).toContainText(/Yearly return \(APR\)\s*Not set: the bot has run less than a day/);
});

test(`${J} #7 withdraws over the cap, then within it without a step-up: both refused; within both, it succeeds with a receipt`, async ({
  page,
}) => {
  await openBots(page);
  await page
    .getByRole('region', { name: 'My bots' })
    .getByRole('link', { name: /Spot grid/ })
    .first()
    .click(UNBUILT);
  // UNBUILT: CB-bots-05's withdrawal (the owner's daily cap and identity's step-up) is not built, so this fails here.
  await expect(
    page.getByRole('button', { name: 'Withdraw profit' }),
    'UNBUILT: CB-bots-05 grid profit withdrawal (daily cap, step-up) is not built',
  ).toBeVisible(UNBUILT);
  await page.getByRole('button', { name: 'Withdraw profit' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Amount, USDT' }).fill('1000000');
  await dialog.getByRole('button', { name: 'Withdraw' }).click();
  await expect(dialog.getByRole('alert')).toContainText(/more than you can withdraw/);
});
