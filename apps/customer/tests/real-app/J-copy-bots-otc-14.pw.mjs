// World: book, restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, bestPrices, fromUnits, journeyState, restartService, toUnits } from './stack.mjs';
import { ledgerRead } from './ledger-door.mjs';
import { fundedTrader, signIn, signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  otherTraderKey,
  otherTraderRun,
  openVenuePage,
  sameDecimal,
  testDeposit,
  venueBalance,
  venueForThisFile,
  venueRecord,
} from './venue.mjs';
import { ownSpotMarket } from './own-market.mjs';
import { signedOnVenue, venueNow } from './venue-door.mjs';
import { venueStatus } from './venue-reads.mjs';

const ONE = toUnits('1');

// J-copy-bots-otc-14, in the running app (docs/roadmap/journeys.json): start a spot grid bot and watch it earn. One test
// per step, titled "J-copy-bots-otc-14 #<n>". The grid trades on the person's own account at the stack's TEST venue
// simulator (BTC-USDC), with svc-trade's user-venue door on for this file: INTAFACED holds and moves nothing. The trader
// is a TEST account on the local stack, verified, with a TEST wallet holding TEST USDC on its venue account. Every level
// is one venue order under the grid agent permission the wallet signs once; what it holds, its fills and its fees are read
// from the venue itself, and our ledger is read to show it posts only our builder fee, once per fill.
// The grid trades a TEST spot market of this file's own (ownSpotMarket), whose only other trader is this file's TEST maker:
// it rests three levels a side, 10 apart, round a mid, and moves the price by resting them again round a new one, so a
// grid order the new levels cross fills.
// A blank owner level comes from restarting trade with LOCAL_STACK_TRADE_BOTS_LEVEL=blank, and a blank bounds distance
// with LOCAL_STACK_TRADE_GRID_BAND=blank, each undone in a finally. #1's TWAP runs on our own TEST book (BTC/USDT).
const J = 'J-copy-bots-otc-14';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
const MID = '60000';

test.describe.configure({ mode: 'default' });

// The file's grid bot is stopped once its steps are done, and its venue orders cancelled by the bot.
test.afterAll(async () => {
  test.setTimeout(120_000);
  const { who, botId } = run.read() ?? {};
  if (!who || !botId) return;
  const me = await api(who);
  const stopped = await me.post(`${GRID}.stop`, { botId });
  expect(stopped.status, JSON.stringify(stopped.body).slice(0, 300)).toBe(200);
  await expect
    .poll(
      async () => {
        const { status, body } = await me.get(read(`${GRID}.get`, { botId }));
        expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
        const bot = body.result.data;
        return bot.status === 'stopped' && bot.orders.every((o) => o.status !== 'open');
      },
      { timeout: 60_000, intervals: [500], message: `grid ${botId} still has open orders after its stop` },
    )
    .toBe(true);
});
// Declared after the stop above, so the door is still on when the file's bot is stopped (hooks run in declared order).
venueForThisFile(test);

const wizard = (page) => page.getByRole('form', { name: 'Spot grid', exact: true });

async function openBots(page) {
  await signIn(page, run.read().who);
  await page.goto('/bots');
  await expect(page.getByRole('heading', { name: 'Bots', level: 1, exact: true })).toBeVisible();
}

async function openGrid(page) {
  await openBots(page);
  await page.getByRole('link', { name: /Spot grid/ }).click();
  await expect(wizard(page)).toBeVisible(UNBUILT);
}

test(`${J} starts: signed in, verified to the owner's level, a TEST wallet with TEST USDC on its own venue account`, async ({ page }) => {
  test.setTimeout(180_000);
  // TEST USDT on our ledger is for #1's TWAP on our own TEST book; the grid trades on the venue.
  const who = await fundedTrader(page, 'gb', '1000');
  const walletKey = testWalletKey();
  const key = privateKeyToAccount(walletKey);
  const owner = key.address.toLowerCase();
  const venue = await venueNow();
  await testDeposit(owner, 'USDC', '5000', `${venue.chainId}:0x${randomBytes(32).toString('hex')}:0`);
  expect(toUnits((await venueBalance(owner, 'USDC')).free)).toBeGreaterThanOrEqual(toUnits('5000'));
  // Our builder fee rides on every grid sell: the wallet approves it once on its own account, signed on the venue itself
  // (setup, not a step: the step words start from an account that trades on the venue).
  const { builder } = await venueStatus(who);
  expect(builder, 'the stack publishes our TEST builder fee').toBeTruthy();
  await signedOnVenue(venue, key, { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps });
  run.reset({ who, walletKey, owner, since: new Date().toISOString() });
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
  const types = page.getByRole('list', { name: 'Bot types', exact: true }).getByRole('listitem');
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
  await page.getByRole('list', { name: 'Bot types', exact: true }).getByRole('link', { name: 'Recurring buy (DCA)', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recurring buy (DCA)', level: 1, exact: true })).toBeVisible();
  await expect(page.getByText('Not available', { exact: true })).toBeVisible();
  await expect(page.getByText(NOT_READY['Recurring buy (DCA)'], { exact: true })).toBeVisible();
  await expect(page.locator('form')).toHaveCount(0);
  expect(await myAlgoIds()).toEqual(before);
  await page.getByRole('button', { name: 'Back to Bots', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bots', level: 1, exact: true })).toBeVisible();

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

/**
 * Restart trade with one owner value blank (`blank`) or as the TEST profile sets it (`set`), by its stack switch. The
 * user-venue door stays on through this file's own restarts (venueForThisFile turns it off after the file).
 */
const restartTrade = (switchName, state) =>
  restartService('trade', { LOCAL_STACK_USER_VENUE: 'on', [switchName]: state === 'blank' ? 'blank' : null });

/** The owner's bots verification level, blank or as the TEST profile sets it. */
const botsLevel = (state) => restartTrade('LOCAL_STACK_TRADE_BOTS_LEVEL', state);
/** The owner's distance a grid bound may sit from the market price, blank or as the TEST profile sets it. */
const gridBand = (state) => restartTrade('LOCAL_STACK_TRADE_GRID_BAND', state);

async function openGridRoom(page, who) {
  await signIn(page, who);
  await page.goto('/trade/bots/grid');
  await expect(page.getByRole('heading', { name: 'Spot grid', level: 1, exact: true })).toBeVisible();
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
  await expect(page.getByRole('form', { name: 'Spot grid', exact: true })).toHaveCount(0);
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
  await botsLevel('blank');
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
    await expect(page.getByRole('form', { name: 'Spot grid', exact: true })).toHaveCount(0);
    expect((await gridList(who)).map((b) => b.botId).sort()).toEqual(gridsBefore);
    expect(await algoIds(who)).toEqual(algosBefore);
  } finally {
    await botsLevel('set');
  }
});

test(`${J} #3 opens presets: with no backtest source the list reads "Not set" and no APR`, async ({ page }) => {
  const presets = await (await api(run.read().who)).get(read(`${GRID}.presets`));
  expect(presets.status, JSON.stringify(presets.body).slice(0, 300)).toBe(200);
  expect(presets.body.result.data).toEqual({ source: null, presets: [] });
  await openGrid(page);
  await wizard(page).getByRole('tab', { name: 'Presets', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Presets', exact: true });
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
  await wizard(page).getByRole('button', { name: 'Create bot', exact: true }).click();
  const res = await answer;
  const body = await res.json();
  return { status: res.status(), body, request: res.request().postDataJSON(), url: res.url() };
}

/** The run's person: their account, wallet key, venue owner address and ledger balances read at the start. */
function person() {
  const s = run.read();
  if (!s?.who || !s.walletKey) throw new Error(`${J} starts made no account and wallet, so this step has no one to act as`);
  return s;
}

/** The file's own TEST spot market, made once (#4) and kept in the run state. */
async function gridMarket() {
  const s = run.read();
  if (s.market) return s.market;
  const market = await ownSpotMarket(J, 'JGB', 'A');
  run.write({ ...run.read(), market });
  return market;
}
const marketOf = () => {
  const m = run.read().market;
  if (!m) throw new Error(`${J} #4 made no market of its own, so this step has none to trade`);
  return m;
};

/** The person's open orders on the grid's market, as the venue itself records them. */
const venueOpen = async (owner) => (await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === marketOf().symbol);
/** The person's fills on the grid's market since the run began, as the venue itself records them. */
const venueFills = async (owner, since) =>
  (await venueRecord(owner, '/fills', { since })).value.filter((f) => f.symbol === marketOf().symbol);

/**
 * The file's TEST maker rests three levels a side, 10 apart, round `mid` on the grid's market, after cancelling the ones it
 * rested before: bids first, then asks, so a grid sell under the new bids, or a grid buy over the new asks, fills. TEST
 * funds only, deposited once under a fixed reference.
 */
async function bookAt(mid) {
  const market = marketOf();
  const name = `${J}-maker-${market.base}`;
  const maker = otherTraderKey(name).address.toLowerCase();
  const s = run.read();
  if (!s.makerFunded) {
    await testDeposit(maker, 'USDC', '10000000', `seed:${name}:USDC`);
    await testDeposit(maker, market.base, '1000', `seed:${name}:${market.base}`);
    run.write({ ...run.read(), makerFunded: true });
  }
  // A key already filled or cancelled is refused by the venue; only what still rests matters, and that is cancelled.
  // The grid's mark is the venue's mid, and the bot's own resting buys are bids in that book. Moving down, the maker's
  // asks go first: cancelling its bids first would leave the bot's highest buy against the maker's old asks, a mid
  // between the two prices that the price never meant to pass, where a running grid buys (#5, 61500 back to 60000,
  // saw mid 60730 and buys at levels 10 to 12). Moving up, its bids go first, for the same reason the other way round.
  const down = s.makerMid !== undefined && toUnits(mid) < toUnits(s.makerMid);
  const first = down ? ':sell' : ':buy';
  const stale = [...(s.makerKeys ?? [])].sort((a, b) => Number(!a.includes(first)) - Number(!b.includes(first)));
  for (const key of stale) await otherTraderRun(name, { kind: 'cancel_order', symbol: market.symbol, clientOrderKey: key });
  const tag = Date.now().toString(36);
  const keys = [];
  for (const side of ['buy', 'sell'])
    for (let level = 1; level <= 3; level += 1) {
      const step = toUnits('10') * BigInt(level);
      const at = side === 'buy' ? toUnits(mid) - step : toUnits(mid) + step;
      const clientOrderKey = `order:${name}:${tag}:${side}${level}`;
      const rested = await otherTraderRun(name, {
        kind: 'place_order',
        symbol: market.symbol,
        side,
        type: 'limit',
        amount: '1',
        price: fromUnits(at),
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey,
        builderFee: null,
      });
      expect(rested.definite && rested.accepted, JSON.stringify(rested).slice(0, 300)).toBe(true);
      keys.push(clientOrderKey);
    }
  run.write({ ...run.read(), makerKeys: keys, makerMid: mid });
  const open = (await venueRecord(maker, '/open-orders')).value.filter((o) => o.symbol === market.symbol);
  expect(open.length, `the maker rests round ${mid}`).toBeGreaterThan(0);
}

/** Opens the grid room in venue mode as the person, with their TEST wallet connected. Returns the wallet. */
async function openGridVenue(page, s, query = '') {
  const wallet = await openVenuePage(page, s.who, `/trade/bots/grid${query}`, s.walletKey);
  await expect(page.getByRole('heading', { name: 'Spot grid', level: 1, exact: true })).toBeVisible();
  return wallet;
}

/** Wait until the bot read satisfies `ok`, read again every half second; the tick runs every second on the stack. */
async function untilBot(who, botId, ok, what, waitMs = 60_000) {
  let bot;
  await expect
    .poll(
      async () => {
        bot = await gridBot(who, botId);
        return ok(bot);
      },
      {
        timeout: waitMs,
        intervals: [500],
        message: `grid ${botId} did not ${what}`,
      },
    )
    .toBe(true);
  return bot;
}

/** The bot's open orders by business key, with side and price. */
const openOf = (bot) =>
  bot.orders
    .filter((o) => o.status === 'open')
    .map((o) => `${o.clientOrderId} ${o.side} ${o.price}`)
    .sort();
/** The venue's open orders by its client order id, side, price and amount. */
const venueOpenOf = (orders) => orders.map((o) => `${o.venueClientOrderId} ${o.side} ${o.price} ${o.amount}`).sort();
const sum = (xs) => xs.reduce((t, x) => t + x, 0n);
/** price x amount, rounded down, as the venue and the service both count a quote. */
const quote = (price, amount) => (toUnits(price) * toUnits(amount)) / ONE;

test(`${J} #4 enters bounds left blank, then one grid, then twenty: the first two refused naming the field; twenty levels placed on the venue under the agent permission (a rejected signature places nothing); a second create with the same key returns the same bot`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = person();
  // Our ledger as the grid starts: #1's TWAP trades our own TEST book, so the grid's figure is read here, before it acts.
  run.write({ ...run.read(), ledger: await (await api(s.who)).balances() });
  s.ledger = run.read().ledger;
  const gridsBefore = await gridList(s.who);
  const market = await gridMarket();
  await bookAt(MID);
  const usdcBefore = await venueBalance(s.owner, 'USDC');
  expect(await venueOpen(s.owner)).toEqual([]);
  // The range round the mid, 100 a level, the mid halfway between levels 9 and 10: 59050 to 60950 in twenty levels.
  // 4000 USDC over twenty levels is about 0.003 BTC a level, three lots of 0.001: the venue takes a buy's fee in BTC, so
  // what a buy receives still holds whole lots to sell one level up.
  const range = { lowerPrice: '59050', upperPrice: '60950', gridCount: 20, investment: '4000' };

  // CB-bots-02's owner bounds relative to market, blank: the setup read names it unset, the wizard reads "Not set", and a
  // create with every field valid is refused by its code, with nothing placed. Trade restarts as set in the finally.
  await gridBand('blank');
  try {
    const blankSetup = await (await api(s.who)).get(read(`${GRID}.setup`));
    expect(blankSetup.status, JSON.stringify(blankSetup.body).slice(0, 300)).toBe(200);
    expect(blankSetup.body.result.data.boundsMaxDistanceBps).toBeNull();
    // The door learns a new venue market within a few seconds (user-venue-door.ts MARKET_MISS_REREAD_MS), so the create is
    // asked again until the market is known; the answer that counts is the band's refusal.
    await expect(async () => {
      const blank = await (
        await api(s.who)
      ).post(`${GRID}.create`, {
        clientRequestId: `${J}-band-blank-${Date.now().toString(36)}`,
        symbol: market.symbol,
        owner: s.owner,
        ...range,
      });
      expect(blank.status, JSON.stringify(blank.body).slice(0, 300)).toBe(400);
      expect(codeOf(blank.body)).toBe('trade.bots_grid_bounds_band_not_set');
    }).toPass({ timeout: 30_000, intervals: [2_000] });
    // Read only: the wizard's words, so the room opens without the wallet (installed once, below).
    await openGridRoom(page, s.who);
    await expect(wizard(page)).toContainText(/Bounds allowed\s*Not set/);
    expect(await gridList(s.who)).toEqual(gridsBefore);
    expect(await venueOpen(s.owner)).toEqual([]);
  } finally {
    await gridBand('set');
  }

  // Set: the TEST distance read back from the service is the one the wizard names; the venue's own spot market and mid.
  const setup = await (await api(s.who)).get(read(`${GRID}.setup`));
  expect(setup.status, JSON.stringify(setup.body).slice(0, 300)).toBe(200);
  expect(setup.body.result.data.boundsMaxDistanceBps).toBe(1000);
  const wallet = await openGridVenue(page, s);
  await expect(wizard(page)).toContainText(/Bounds allowed\s*Within 10% of the market price/);
  await wizard(page).getByRole('combobox', { name: 'Market', exact: true }).click();
  await page.getByRole('option', { name: market.symbol, exact: true }).click();
  await expect(wizard(page).getByRole('combobox', { name: 'Market', exact: true })).toContainText(market.symbol);
  await expect(page.getByTestId('grid-last-price')).toHaveText(/^60,?000(\.0+)? USDC$/);
  const field = (name) => wizard(page).getByRole('textbox', { name });
  await field('Investment').fill(range.investment);
  await field('Grids').fill('20');

  // Bounds left blank: refused naming Lower price, and nothing placed.
  const blank = await pressCreate(page);
  expect(blank.status, JSON.stringify(blank.body).slice(0, 300)).toBe(400);
  expect(codeOf(blank.body)).toBe('trade.bots_grid_bounds_not_set');
  expect(blank.body.error.message).toBe('Lower price is required');
  await expect(wizard(page).getByText('Enter both bounds', { exact: true })).toBeVisible();
  expect(await gridList(s.who)).toEqual(gridsBefore);

  // One grid: refused naming Grids, with the range it must be in, and nothing placed.
  await field('Lower price').fill(range.lowerPrice);
  await field('Upper price').fill(range.upperPrice);
  await field('Grids').fill('1');
  const one = await pressCreate(page);
  expect(one.status, JSON.stringify(one.body).slice(0, 300)).toBe(400);
  expect(codeOf(one.body)).toBe('trade.bots_grid_count_out_of_range');
  expect(one.body.error.message).toBe('Grids must be from 2 to 100');
  await expect(wizard(page).getByText('Grids is out of range', { exact: true })).toBeVisible();
  expect(await gridList(s.who)).toEqual(gridsBefore);
  expect(await venueOpen(s.owner)).toEqual([]);
  expect(wallet.requests).toHaveLength(0);

  // Twenty: twenty levels planned in the wizard.
  await field('Grids').fill('20');
  const planned = wizard(page).getByTestId('grid-plan').getByRole('listitem');
  await expect(planned).toHaveCount(20);
  const previewPrices = (await planned.allInnerTexts()).map((text) => toUnits(text.replace(/[^\d.]/g, '')));

  // The wallet is asked to sign the grid agent permission first, as none exists; rejected, the bot places nothing.
  wallet.rejectNext();
  const rejected = await pressCreate(page);
  expect(rejected.status, JSON.stringify(rejected.body).slice(0, 300)).toBe(200);
  const botId = rejected.body.result.data.botId;
  expect(rejected.body.result.data).toMatchObject({ status: 'signing', venue: { owner: s.owner, agentName: 'grid-bots', test: true } });
  // The plain-words sheet comes first; the wallet is asked only once the person continues, and they reject there.
  await continueInWallet(page);
  await expect(page.getByText('You rejected the signature', { exact: true })).toBeVisible();
  expect(wallet.requests).toHaveLength(1);
  // What the wallet was asked to sign names the bot's own agent key: the permission, not an order.
  const agent = rejected.body.result.data.venue.agentAddress.toLowerCase();
  expect(wallet.requests[0].params[1].toLowerCase()).toContain(agent.slice(2));
  expect((await gridBot(s.who, botId)).status).toBe('signing');
  expect(await venueOpen(s.owner)).toEqual([]);
  expect((await venueBalance(s.owner, 'USDC')).locked).toBe(usdcBefore.locked);

  // Pressed again with the same request key: the same bot asks again, the wallet signs, and the levels are placed.
  const made = await pressCreate(page);
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  expect(made.request.clientRequestId).toBe(rejected.request.clientRequestId);
  expect(made.body.result.data.botId).toBe(botId);
  await continueInWallet(page);
  await expect(page).toHaveURL(new RegExp(`bot=${encodeURIComponent(botId)}`), { timeout: 30_000 });
  await expect(page.getByTestId('grid-status')).toHaveText('Bot running', { timeout: 30_000 });
  expect(wallet.requests).toHaveLength(2);
  run.write({ ...run.read(), botId, request: made.request, url: made.url });

  const bot = await untilBot(
    s.who,
    botId,
    (b) => b.status === 'running' && b.orders.filter((o) => o.status === 'open').length === 10,
    'place its ten buys',
  );
  expect(bot.gridCount).toBe(20);
  expect(bot.levels.map((l) => l.index)).toEqual([...Array(20).keys()]);
  expect(bot.levels.map((l) => toUnits(l.price))).toEqual(previewPrices);
  expect(bot.reserve).toBeNull();
  await expect(page.getByText(`Your ${bot.venue.name} account ${s.owner}`, { exact: true })).toBeVisible();

  // One buy at each level under the mid, and no sell: the bot holds no base yet. Each is one venue order with its own
  // client order id, at the level's price and amount, on the person's own account.
  const open = bot.orders.filter((o) => o.status === 'open');
  expect(open.map((o) => o.side)).toEqual(Array(10).fill('buy'));
  expect(open.map((o) => o.levelIndex).sort((x, y) => x - y)).toEqual([...Array(10).keys()]);
  expect(new Set(open.map((o) => o.clientOrderId)).size).toBe(10);
  for (const o of open) expect(o.clientOrderId).toBe(`grid:${botId}:${o.levelIndex}:b0`);
  const onVenue = await venueOpen(s.owner);
  expect(onVenue).toHaveLength(10);
  expect(new Set(onVenue.map((o) => o.venueClientOrderId)).size).toBe(10);
  expect(onVenue.map((o) => `${o.side} ${fromUnits(toUnits(o.price))} ${fromUnits(toUnits(o.amount))}`).sort()).toEqual(
    open.map((o) => `buy ${fromUnits(toUnits(o.price))} ${fromUnits(toUnits(o.qty))}`).sort(),
  );

  // Each level holds only what the venue holds for it: the venue's locked USDC rose by exactly the open buys' quote, which
  // is the bot's own figure for each, and the investment caps them all. Our ledger posted nothing.
  const holds = sum(open.map((o) => toUnits(o.holdAmount)));
  for (const o of open) expect(toUnits(o.holdAmount)).toBe(quote(o.price, o.qty));
  const usdcAfter = await venueBalance(s.owner, 'USDC');
  expect(toUnits(usdcAfter.locked) - toUnits(usdcBefore.locked)).toBe(holds);
  expect(holds <= toUnits(range.investment)).toBe(true);
  expect(await (await api(s.who)).balances()).toEqual(s.ledger);

  // The same key again, through the same door: the same bot, no second row, nothing more placed on the venue.
  const again = await (await api(s.who)).post(new URL(made.url).pathname, made.request);
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body.result.data.botId).toBe(botId);
  const grids = await gridList(s.who);
  expect(grids.filter((b) => b.botId === botId)).toHaveLength(1);
  expect(grids.length).toBe(gridsBefore.length + 1);
  expect(venueOpenOf(await venueOpen(s.owner))).toEqual(venueOpenOf(onVenue));
});

test(`${J} #5 lets the price leave the upper bound: no new buy is placed and the range pause shows`, async ({ page }) => {
  test.setTimeout(180_000);
  const s = person();
  const botId = run.read().botId;
  if (!botId) throw new Error(`${J} #4 made no bot, so this step has none to watch`);
  const before = await untilBot(s.who, botId, (b) => b.status === 'running', 'run');
  const venueBefore = venueOpenOf(await venueOpen(s.owner));
  // Above the upper bound (60950): every level is under the mark, and ten of them are free, so a running grid would buy.
  await bookAt('61500');
  try {
    const paused = await untilBot(s.who, botId, (b) => b.status === 'paused_range', 'pause for the range');
    expect(paused.statusReason).toBe('mark_outside_range');
    // The tick that paused it placed nothing, and the ticks while the page opens (a sign-in and a load, several seconds)
    // place nothing either: the same orders on the bot and on the venue, before and after.
    expect(openOf(paused)).toEqual(openOf(before));
    expect(venueOpenOf(await venueOpen(s.owner))).toEqual(venueBefore);
    await openGridVenue(page, s, `?bot=${encodeURIComponent(botId)}`);
    await expect(page.getByTestId('grid-status')).toHaveText('Paused: the price is outside the range');
    const later = await gridBot(s.who, botId);
    expect(later.status).toBe('paused_range');
    expect(openOf(later)).toEqual(openOf(before));
    expect(venueOpenOf(await venueOpen(s.owner))).toEqual(venueBefore);
  } finally {
    await bookAt(MID);
  }
  const back = await untilBot(s.who, botId, (b) => b.status === 'running', 'run again inside the range');
  expect(openOf(back)).toEqual(openOf(before));
  await expect(page.getByTestId('grid-status')).toHaveText('Bot running', { timeout: 30_000 });
});

/** A metric's figure as the Metrics tab shows it, by its label. */
async function shown(panel, label) {
  const text = await panel.innerText();
  const m = new RegExp(`${label.replace(/[()]/g, '\\$&')}\\s*([-−]?[\\d.,]+)`).exec(text);
  expect(m, `${label} in ${text}`).not.toBeNull();
  return m[1];
}

test(`${J} #6 opens Metrics after two closed level pairs: grid profit is their sum net of the venue's fees and our builder fee, from the venue's fills; an APR with zero days reads "Not set"`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = person();
  const botId = run.read().botId;
  if (!botId) throw new Error(`${J} #4 made no bot, so this step has none to measure`);
  await untilBot(s.who, botId, (b) => b.status === 'running', 'run');
  // Down through two buys (levels 9 and 8, at 59950 and 59850), each sold one level up, then up through both sells.
  await bookAt('59900');
  await untilBot(
    s.who,
    botId,
    (b) => b.orders.some((o) => o.side === 'sell' && o.status === 'open' && o.levelIndex === 9),
    'sell its level 9 buy',
  );
  await bookAt('59800');
  await untilBot(
    s.who,
    botId,
    (b) => b.orders.some((o) => o.side === 'sell' && o.status === 'open' && o.levelIndex === 8),
    'sell its level 8 buy',
  );
  await bookAt('60100');
  const bot = await untilBot(s.who, botId, (b) => b.closedPairs === 2, 'close two pairs', 90_000);

  // Each pair by hand from the venue's own fills: the sell's quote less its fees in USDC (the venue's and our builder
  // fee), less the share of the buy's cost the sold base carries (the buy's fee is taken in BTC, so less was received).
  const fills = await venueFills(s.owner, s.since);
  const feeIn = (fs, asset) => sum(fs.filter((f) => f.feeAsset === asset).map((f) => toUnits(f.venueFee) + toUnits(f.builderFee)));
  const sells = bot.orders.filter((o) => o.side === 'sell' && o.status === 'filled');
  expect(sells).toHaveLength(2);
  let profit = 0n;
  for (const sell of sells) {
    const bf = fills.filter((f) => f.side === 'buy' && sameDecimal(f.price, bot.levels[sell.levelIndex].price));
    const sf = fills.filter((f) => f.side === 'sell' && sameDecimal(f.price, sell.price));
    expect(bf.length, `buy fills at level ${sell.levelIndex}`).toBeGreaterThan(0);
    expect(sf.length, `sell fills at ${sell.price}`).toBeGreaterThan(0);
    for (const f of sf) expect(toUnits(f.builderFee), `our builder fee on sell fill ${f.fillId}`).toBeGreaterThan(0n);
    const received = sum(bf.map((f) => toUnits(f.amount))) - feeIn(bf, marketOf().base);
    const cost = sum(bf.map((f) => quote(f.price, f.amount))) + feeIn(bf, 'USDC');
    const sold = sum(sf.map((f) => toUnits(f.amount))) + feeIn(sf, marketOf().base);
    const share = (((cost * sold + ONE - 1n) / ONE) * ONE + received - 1n) / received;
    const pair = sum(sf.map((f) => quote(f.price, f.amount))) - feeIn(sf, 'USDC') - share;
    expect(
      sameDecimal(sell.pairProfit, fromUnits(pair)),
      `pair at level ${sell.levelIndex}: ${sell.pairProfit} vs ${fromUnits(pair)}`,
    ).toBe(true);
    profit += pair;
  }
  expect(sameDecimal(bot.gridProfit, fromUnits(profit))).toBe(true);
  expect(bot.gridApr).toEqual({ state: 'under_a_day', percent: null });
  // The fees the bot shows are the venue's, by asset, from the same fills.
  for (const asset of new Set(fills.map((f) => f.feeAsset))) {
    const of = fills.filter((f) => f.feeAsset === asset);
    const row = bot.fees.find((f) => f.asset === asset);
    expect(row, `fees in ${asset}`).toBeTruthy();
    expect(sameDecimal(row.venueFee, fromUnits(sum(of.map((f) => toUnits(f.venueFee)))))).toBe(true);
    expect(sameDecimal(row.builderFee, fromUnits(sum(of.map((f) => toUnits(f.builderFee)))))).toBe(true);
  }

  // The Metrics tab shows the same figures.
  await openGridVenue(page, s, `?bot=${encodeURIComponent(botId)}`);
  await page.getByRole('tab', { name: 'Metrics', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Metrics', exact: true });
  expect(sameDecimal(await shown(panel, 'Grid profit'), bot.gridProfit)).toBe(true);
  expect(await shown(panel, 'Closed pairs')).toBe('2');
  await expect(panel).toContainText(/Yearly return \(APR\)\s*Not set: the bot has run less than a day/);
  const usdc = bot.fees.find((f) => f.asset === 'USDC');
  expect(sameDecimal(await shown(panel, 'Venue fees (USDC)'), usdc.venueFee)).toBe(true);
  expect(sameDecimal(await shown(panel, 'Our builder fee (USDC)'), usdc.builderFee)).toBe(true);

  // Our ledger posts only our builder fee: one transaction for each fill that carries it, under the fill's own key, our
  // fee exactly as the venue charged it; a fill without it posts nothing; the person's own balances never move.
  const venueId = bot.venue.id;
  for (const f of fills) {
    const businessKey = `builder-fee:${venueId}:${s.owner}:${f.fillId}`;
    const trace = () => ledgerRead(`/operator/trace?businessKey=${encodeURIComponent(businessKey)}`);
    if (toUnits(f.builderFee) === 0n) {
      expect(await trace()).toEqual({ found: false, businessKey });
      continue;
    }
    await expect.poll(async () => (await trace()).found, { timeout: 30_000, message: `${businessKey} posted` }).toBe(true);
    const tx = await trace();
    expect(tx).toMatchObject({ businessKey, module: 'trade', reason: 'trade.builder_fee.earned' });
    expect(tx.postings).toHaveLength(2);
    for (const p of tx.postings) {
      expect(p.assetId).toBe(f.feeAsset);
      expect(sameDecimal(p.amount, f.builderFee)).toBe(true);
    }
  }
  expect(await (await api(s.who)).balances()).toEqual(s.ledger);
});

test(`${J} #7 asks the bot to withdraw: refused, a bot's agent permission can't withdraw; the page says the person withdraws from the venue with their own wallet, and nothing moves`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const s = person();
  const botId = run.read().botId;
  if (!botId) throw new Error(`${J} #4 made no bot, so this step has none to ask`);
  const balances = async () => ({
    usdc: await venueBalance(s.owner, 'USDC'),
    btc: await venueBalance(s.owner, 'BTC'),
    open: venueOpenOf(await venueOpen(s.owner)),
    ledger: await (await api(s.who)).balances(),
  });
  await untilBot(s.who, botId, (b) => b.status === 'running', 'run');
  const before = await balances();

  // Through the door: refused by its code, in the service's words, whatever the amount.
  const asked = await (
    await api(s.who)
  ).post(`${GRID}.withdrawProfit`, {
    botId,
    requestId: `${J}-withdraw-${Date.now().toString(36)}`,
    asset: 'USDC',
    amount: '1',
    stepUpApprovalId: null,
  });
  expect(asked.status, JSON.stringify(asked.body).slice(0, 300)).toBe(403);
  expect(codeOf(asked.body)).toBe('trade.bots_grid_withdraw_not_permitted');
  expect(asked.body.error.message).toBe(
    "A bot's agent permission can't withdraw. Withdraw from the venue with your own wallet; nothing was moved.",
  );

  // On the page: the Withdraw press is refused in words, the page names the person's own wallet, and nothing is signed.
  const wallet = await openGridVenue(page, s, `?bot=${encodeURIComponent(botId)}`);
  await page.getByRole('tab', { name: 'Metrics', exact: true }).click();
  const section = page.getByRole('region', { name: 'Withdraw', exact: true });
  await expect(
    section.getByText('You withdraw from the venue with your own wallet. The bot’s agent permission can’t withdraw.', { exact: true }),
  ).toBeVisible();
  const answer = page.waitForResponse((res) => res.url().includes('bots.grid.withdrawProfit') && res.request().method() === 'POST');
  await section.getByRole('button', { name: 'Withdraw through the bot', exact: true }).click();
  const res = await answer;
  expect(res.status()).toBe(403);
  await expect(section.getByText('A bot can’t withdraw', { exact: true })).toBeVisible();
  await expect(
    section.getByText('Its agent permission can’t withdraw. You withdraw from the venue with your own wallet. Nothing was moved.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(wallet.requests).toHaveLength(0);

  // Nothing moved: the venue's balances and orders, and our ledger, read the same.
  expect(await balances()).toEqual(before);
});
