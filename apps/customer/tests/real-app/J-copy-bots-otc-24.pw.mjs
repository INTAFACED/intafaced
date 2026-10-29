import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { approverSessions, makeContext, setFeeDiscountSchedule } from '../../../../tooling/scripts/local-test-gates.mjs';
import { api, fromUnits, fund, journeyState, signOutBrowser, toUnits, tool } from './stack.mjs';
import { fundedTrader, signIn, signUp } from './desk.mjs';

// J-copy-bots-otc-24, in the running app (docs/roadmap/journeys.json): ask the quote desk at /otc for a firm price on a
// large trade and settle it. One test per step, titled "J-copy-bots-otc-24 #<n>". The trader is a TEST account on the
// local stack, verified and funded with TEST USDT through the real ledger; accept binds the quoted price and size,
// settle posts once and expiry moves nothing, which the steps check against the ledger balance.
// The region-block clause of #1 and the settlement name-match clause of #3 are compliance gates and wait for launch
// prep (owner decision 2026-10-27); the level gate of #3 stays (identity verification). The region block has its own
// #1 test, red by name with that blocker until it is built.
// The stack publishes a TEST desk law (tooling/profiles/test-owner-values/trade.json): a 60 s firm quote and a 60 s
// window to settle an accepted one, so #7 and #8 watch both run out on the real clock. Each step checks the service's
// own record of the quote (rfq.get through Edge) and the ledger balance, not only the screen. Every request asks the
// providers it picks from the owner's TEST provider list (CB-otc-01); the steps after #2 ask the house desk.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #5: no RFQ board grouped by status (CB-otc-02); #9: Convert has no OTC price (CB-otc-12).
const J = 'J-copy-bots-otc-24';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

const desk = (page) => page.getByRole('region', { name: 'Desk status' });
const request = (page) => page.getByRole('region', { name: 'Request a price' });
const card = (page) => page.getByRole('region', { name: 'Quote', exact: true });
const dialog = (page) => page.getByRole('alertdialog');
const balances = async () => (await api(run.read().who)).balances();
/** The one platform-routed provider on the stack's TEST provider list: the house desk, which prices every step. */
const HOUSE = 'House desk (TEST)';

/** A decimal string as a whole number of 1e-18 units, so amounts compare exactly (never as floats). */
const units = (value) => {
  const [whole, fraction = ''] = String(value ?? '0').split('.');
  return BigInt(whole + fraction.padEnd(18, '0').slice(0, 18));
};
const held = (all, asset) => units(all[asset]?.total);

/** The service's own record of one quote (`rfq.get` through Edge), as the trader. */
async function rfq(quoteId) {
  const me = await api(run.read().who);
  const read = await me.get(`/api/trade/trpc/rfq.get?input=${encodeURIComponent(JSON.stringify({ quoteId }))}`);
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  return read.body.result.data;
}

/** Accepts the open quote card through its dialog and waits for the bound phase. */
async function accept(page, quote) {
  await quote.getByRole('button', { name: 'Accept', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Accept at this price' }).click();
  await expect(quote.getByTestId('phase-line')).toContainText('Accepted, not settled');
}

/** svc-trade restarted with one desk-law value blank (`<name>=off`), or back on the stack's TEST value. */
function tradeSwitch(name, on) {
  const before = process.env[name];
  if (on) delete process.env[name];
  else process.env[name] = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

/** svc-trade restarted with the desk's settle window blank, or back on the stack's TEST window. */
const tradeSettleWindow = (on) => tradeSwitch('LOCAL_STACK_TRADE_OTC_SETTLE_WINDOW', on);

/** The desk's own status (`otc.deskStatus`), as the trader reads it. */
async function deskStatus(client) {
  const read = await client.get('/api/trade/trpc/otc.deskStatus');
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  return read.body.result.data;
}

/** The desk's settle window in ms as its status line publishes it, or 'unset'. */
async function publishedWindow() {
  const desk = await (await api(run.read().who)).get('/api/trade/trpc/otc.deskStatus');
  return /settleWindowMs=(\d+|unset)/.exec(desk.body.result.data.statusLine)?.[1];
}

/** The desk's stake floor as its status line publishes it (`minStake=<decimal>`). */
async function publishedMinStake(client) {
  const desk = await client.get('/api/trade/trpc/otc.deskStatus');
  return /(?:^| )minStake=(\S+)/.exec(desk.body.result.data.statusLine)?.[1];
}

/** The desk's minimum for requests in `asset` as its status line publishes it (`minNotional=USDT:1000`), or 'unset'. */
async function publishedMinimum(client, asset) {
  const desk = await client.get('/api/trade/trpc/otc.deskStatus');
  const table = /(?:^| )minNotional=(\S+)/.exec(desk.body.result.data.statusLine)?.[1];
  if (table === 'unset') return 'unset';
  return table
    ?.split(',')
    .find((entry) => entry.startsWith(`${asset}:`))
    ?.slice(asset.length + 1);
}

/** The account's quotes as svc-trade records them (rfq.list), over a window around now. */
async function listedQuotes(client) {
  const window = { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString(), limit: 50 };
  const read = await client.get(`/api/trade/trpc/rfq.list?input=${encodeURIComponent(JSON.stringify(window))}`);
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  return read.body.result.data.rows;
}

/** The owner's provider list and pick cap as the desk publishes them (`otc.makers.list`). */
async function listedMakers(client) {
  const read = await client.get('/api/trade/trpc/otc.makers.list');
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  return read.body.result.data;
}

/** Ticks each named provider in the request form's Providers group. */
async function pickProviders(page, names, options) {
  const group = request(page).getByRole('group', { name: 'Providers' });
  for (const name of names) await group.getByRole('checkbox', { name, exact: true }).check(options);
}

/**
 * Asks for a price on `quantity` BTC against USDT from the providers named (the house desk unless told otherwise) on
 * the open room and returns the service's refusal code.
 */
async function askRefused(page, quantity, providers = [HOUSE]) {
  const answer = page.waitForResponse((res) => res.url().includes('rfq.quote'));
  await request(page).getByRole('combobox', { name: 'Pair' }).click();
  await page.getByRole('option', { name: 'BTC/USDT', exact: true }).click();
  await request(page).getByRole('textbox', { name: 'Quantity' }).fill(quantity);
  await pickProviders(page, providers);
  await page.getByRole('button', { name: 'Request price' }).click();
  return [await (await answer).json()].flat()[0].error?.data?.cause?.code;
}

/** svc-token's own record of what the account has staked, as the account reads it. */
async function stakedOf(client) {
  const read = await client.get('/api/token/trpc/stakeOf');
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  return read.body.result.data.staked;
}

/**
 * Stakes `amount` TEST IFC for the account through svc-token's own stake door, funded first through the ledger. The
 * deposit ref and the stake id are business keys for this account and amount, so a retried step neither funds nor
 * stakes twice.
 */
async function stake(who, client, amount) {
  const hex = createHash('sha256').update(`${J}:stake:${who.email}:${amount}`).digest('hex');
  expect(fund(who.email, 'IFC', amount, `${J}-stake-${hex.slice(0, 16)}`).tx).toBeTruthy();
  // Name-based (version 5) uuid from the business key.
  const stakeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const staked = await client.post('/api/token/trpc/stake', { amount, tier: 'flex', stakeId });
  expect(staked.status, JSON.stringify(staked.body).slice(0, 300)).toBe(200);
  await expect.poll(() => stakedOf(client)).toBe(amount);
}

/**
 * A TEST account registered in `region`. Not built: the stack has no way to register an account in a region yet, and
 * region gates wait for launch prep (owner decision 2026-10-27), so this fails by that name.
 */
async function signUpIn(page, region) {
  throw new Error(`no TEST account can be registered in ${region} yet: region gates wait for launch prep (owner decision 2026-10-27)`);
}

async function openOtc(page) {
  await signIn(page, run.read().who);
  await page.goto('/otc');
  await expect(desk(page)).toBeVisible();
}

/** Asks the house desk for a price on `quantity` BTC against USDT and returns the open quote card. */
async function ask(page, quantity = '0.5') {
  await request(page).getByRole('combobox', { name: 'Pair' }).click(UNBUILT);
  await page.getByRole('option', { name: 'BTC/USDT', exact: true }).click(UNBUILT);
  await request(page).getByRole('textbox', { name: 'Quantity' }).fill(quantity, UNBUILT);
  await pickProviders(page, [HOUSE], UNBUILT);
  await page.getByRole('button', { name: 'Request price' }).click(UNBUILT);
  await expect(card(page)).toBeVisible(UNBUILT);
  await expect(card(page).getByTestId('phase-line')).toContainText('firm');
  return card(page);
}

/**
 * The desk's stake gate reads the caller's stake from svc-token, which refuses every read while its fee-decay ladder is
 * blank. On a stack where no journey has published one yet, two TEST founders publish a one-step TEST ladder (no
 * discount at any stake) through the token's two-person door; a ladder that is already there is left as it is.
 */
async function stakeReadable(who) {
  const read = async () => (await (await api(who)).get('/api/token/trpc/feeDiscount.get')).body.result.data;
  if ((await read()).schedule != null) return;
  const ctx = await makeContext({ log: () => undefined });
  const schedule = { basis: 'staked', tiers: [{ minStake: '0', discountBps: 0 }] };
  await setFeeDiscountSchedule(ctx, schedule, { sessions: await approverSessions(ctx) }).catch(async (err) => {
    // Another journey published first, between the read and the write: its ladder stands.
    if ((await read()).schedule == null) throw err;
  });
}

test(`${J} starts: a verified TEST account with 50000 USDT, staked to the desk's tier`, async ({ page }) => {
  test.setTimeout(180_000);
  const who = await fundedTrader(page, 'ot', '50000');
  // Start the file again before anything can fail, so no later step reads an earlier run's account.
  run.reset({ who });
  await stakeReadable(who);
  const client = await api(who);
  // The desk's own floor, read back, not a number this file chose; the stack publishes a non-zero TEST floor.
  const floor = await publishedMinStake(client);
  expect(toUnits(floor)).toBeGreaterThan(0n);
  // Staked exactly to the floor (read back from svc-token inside stake()): at the tier, so the desk prices for this
  // account (#6 to #8 ask it).
  await stake(who, client, floor);
  // The desk is the counterparty and sells from the house inventory: TEST BTC for the one 0.5 BTC settle in #7.
  fund('house', 'BTC', '1');
  run.write({ floor });
});

test(`${J} starts: below the desk's tier the price request is refused with trade.otc_stake_gate and records nothing`, async ({ page }) => {
  test.setTimeout(180_000);
  const { floor } = run.read();
  const below = await fundedTrader(page, 'ob', '50000');
  const me = await api(below);
  // Exactly one IFC under the floor, so the gate is tested near its edge, not only at zero.
  const short = fromUnits(toUnits(floor) - 10n ** 18n);
  expect(toUnits(short)).toBeGreaterThan(0n);
  await stake(below, me, short);
  const before = await me.balances();
  expect(await listedQuotes(me)).toEqual([]);

  await signIn(page, below);
  await page.goto('/otc');
  await expect(desk(page)).toBeVisible();
  expect(await askRefused(page, '0.5')).toBe('trade.otc_stake_gate');
  await expect(page.getByText('trade.otc_stake_gate')).toBeVisible();
  await expect(card(page)).toHaveCount(0);

  // Re-read after the refusal: no quote was recorded for the account and nothing moved or was held.
  expect(await listedQuotes(me)).toEqual([]);
  expect(await me.balances()).toEqual(before);
  expect(await stakedOf(me)).toBe(short);
});

test(`${J} #1 desk status strip and asset list, each read back from the service`, async ({ page }) => {
  test.setTimeout(180_000);
  const me = await api(run.read().who);
  const status = await deskStatus(me);
  // The stack's TEST desk law lists BTC; the service's own list is what the room must show, nothing more or less.
  expect(status.published).toBe(true);
  expect(status.assets).toEqual(['BTC']);
  expect(/(?:^| )assets=(\S+)/.exec(status.statusLine)?.[1]).toBe(status.assets.join(','));

  await openOtc(page);
  // The overview: each item reads what the service publishes for it.
  await expect(desk(page).getByText(status.published ? 'Open' : 'Closed', { exact: true })).toBeVisible();
  await expect(desk(page).getByText(status.makerRouting.published ? 'Routed' : 'Platform only', { exact: true })).toBeVisible();
  await expect(desk(page).getByText(status.midFeed.published ? 'Wired' : 'Not wired', { exact: true })).toBeVisible();
  const assets = desk(page).getByRole('region', { name: 'Assets on the desk' });
  await expect(assets.getByRole('listitem')).toHaveText(status.assets);
  await expect(assets.getByText('Not set', { exact: true })).toHaveCount(0);
});

test(`${J} #1 asset list unpublished: "Not set" on the strip, the ask refuses trade.otc_assets_unset, no quote is kept`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const me = await api(run.read().who);
  try {
    tradeSwitch('LOCAL_STACK_TRADE_OTC_ASSETS', false);
    const status = await deskStatus(me);
    expect(status.assets).toBeNull();
    expect(/(?:^| )assets=(\S+)/.exec(status.statusLine)?.[1]).toBe('unset');
    const before = await me.balances();
    const quotes = await listedQuotes(me);
    await openOtc(page);
    const assets = desk(page).getByRole('region', { name: 'Assets on the desk' });
    await expect(assets.getByText('Not set', { exact: true })).toBeVisible();
    await expect(assets.getByRole('listitem')).toHaveCount(0);
    // A size and provider the house desk prices in #6, so only the blank list can refuse it.
    expect(await askRefused(page, '0.5')).toBe('trade.otc_assets_unset');
    await expect(page.getByText('trade.otc_assets_unset')).toBeVisible();
    await expect(page.getByText('The desk has no asset list, so a request cannot be sent.', { exact: false })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    // Re-read after the refusal: no quote was recorded and nothing moved or was held.
    expect(await listedQuotes(me)).toEqual(quotes);
    expect(await me.balances()).toEqual(before);
  } finally {
    tradeSwitch('LOCAL_STACK_TRADE_OTC_ASSETS', true);
  }
  expect((await deskStatus(me)).assets).toEqual(['BTC']);
});

// BLOCKED: compliance gates wait for launch prep (owner decision 2026-10-27). This test stays red, by this name, until
// the desk publishes the regions it refuses (CB-otc-21); it fails at that first missing part, quickly.
test(`${J} #1 region block (BLOCKED until launch prep, owner decision 2026-10-27): the desk publishes the regions it refuses, and an account in one is refused, nothing kept`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const me = await api(run.read().who);
  const status = await deskStatus(me);
  // The service's own list of refused regions is what the strip must show; a desk with none publishes an empty list,
  // never a missing field.
  expect(
    status,
    'the desk publishes no region block list: compliance gates wait for launch prep (owner decision 2026-10-27)',
  ).toHaveProperty('blockedRegions');
  expect(Array.isArray(status.blockedRegions)).toBe(true);
  expect(status.blockedRegions.length, 'a region block proves a refusal only with a region on the list').toBeGreaterThan(0);

  await openOtc(page);
  const regions = desk(page).getByRole('region', { name: 'Regions the desk refuses' });
  await expect(regions.getByRole('listitem')).toHaveText(status.blockedRegions, UNBUILT);

  // An account registered in a refused region asks for a size the house desk prices in #6: only the region can refuse it.
  const blocked = await signUpIn(page, status.blockedRegions[0]);
  const client = await api(blocked);
  const before = await client.balances();
  const quotes = await listedQuotes(client);
  await page.goto('/otc');
  expect(await askRefused(page, '0.5')).toBe('trade.otc_region_blocked');
  await expect(page.getByText('trade.otc_region_blocked')).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  // Re-read after the refusal: no quote was recorded and nothing moved or was held.
  expect(await listedQuotes(client)).toEqual(quotes);
  expect(await client.balances()).toEqual(before);
});

test(`${J} #2 blank provider list: the room says so, the ask refuses trade.otc_makers_unset, no quote is kept`, async ({ page }) => {
  test.setTimeout(300_000);
  const me = await api(run.read().who);
  try {
    tradeSwitch('LOCAL_STACK_TRADE_OTC_MAKERS', false);
    // The desk publishes no provider list, and says so.
    const blank = await listedMakers(me);
    expect(blank.published).toBe(false);
    expect(blank.makers).toEqual([]);
    const before = await me.balances();
    const quotes = await listedQuotes(me);
    await openOtc(page);
    const providers = request(page).getByRole('group', { name: 'Providers' });
    await expect(providers.getByText('No providers set')).toBeVisible();
    await expect(providers.getByRole('checkbox')).toHaveCount(0);
    // A size the house desk prices in #6, so only the blank list can refuse it.
    expect(await askRefused(page, '0.5', [])).toBe('trade.otc_makers_unset');
    await expect(page.getByText('trade.otc_makers_unset')).toBeVisible();
    await expect(page.getByText('The desk has no provider list, so a request cannot be sent.', { exact: false })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    // Re-read after the refusal: no quote was recorded and nothing moved or was held.
    expect(await listedQuotes(me)).toEqual(quotes);
    expect(await me.balances()).toEqual(before);
  } finally {
    tradeSwitch('LOCAL_STACK_TRADE_OTC_MAKERS', true);
  }
  expect((await listedMakers(me)).published).toBe(true);
});

test(`${J} #2 one provider over the published cap: refused trade.otc_provider_cap, the message carries the cap`, async ({ page }) => {
  test.setTimeout(180_000);
  const me = await api(run.read().who);
  // The owner's list and cap, read back from the desk, not numbers this file chose: three allowed, four listed.
  const list = await listedMakers(me);
  expect(list.published).toBe(true);
  expect(list.selectCap).toBe(3);
  const four = list.makers.map((m) => m.name);
  expect(four).toHaveLength(4);
  expect(four).toContain(HOUSE);
  const before = await me.balances();
  const quotes = await listedQuotes(me);

  await openOtc(page);
  const providers = request(page).getByRole('group', { name: 'Providers' });
  await expect(providers.getByRole('checkbox')).toHaveCount(4);
  await expect(providers.getByText(`Pick who to ask, up to ${list.selectCap}.`)).toBeVisible();
  expect(await askRefused(page, '0.5', four)).toBe('trade.otc_provider_cap');
  await expect(page.getByText('trade.otc_provider_cap')).toBeVisible();
  // The refusal names the limit the desk publishes and the number picked.
  await expect(
    page.getByText(`At most ${list.selectCap} providers can be picked for one request (got 4).`, { exact: false }),
  ).toBeVisible();
  await expect(card(page)).toHaveCount(0);

  // Re-read after the refusal: no quote was recorded and nothing moved or was held.
  expect(await listedQuotes(me)).toEqual(quotes);
  expect(await me.balances()).toEqual(before);
});

test(`${J} #3 account below the desk level: refused trade.otc_level_insufficient naming both levels, nothing kept`, async ({ page }) => {
  test.setTimeout(240_000);
  // The desk's own level, read back from the service, not a tier this file chose.
  const status = await deskStatus(await api(run.read().who));
  expect(status.minTier).toBe('full');
  expect(/(?:^| )minTier=(\S+)/.exec(status.statusLine)?.[1]).toBe(status.minTier);

  // A fresh account verified at Basic only: trade opens at Basic, so the request reaches the desk, which wants Full.
  // (An account with no verification at all is refused earlier by the trade product's own gate, denied.kyc_required.)
  const below = await signUp(page, 'ob');
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: 'Basic' });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  tool('local-test-gates.mjs', 'verify');
  const gates = tool('local-test-gates.mjs', 'status');
  const tiers = JSON.parse(gates.slice(gates.indexOf('{'))).accounts.find((a) => a.handle === below.handle)?.tiers;
  expect(tiers).toContain('basic');
  expect(tiers).not.toContain('full');
  await signOutBrowser(page.context());

  // TEST USDT on the account, so a hold or a posting would show in its balances.
  expect(fund(below.email, 'USDT', '50000').tx).toBeTruthy();
  const them = await api(below);
  const before = await them.balances();
  const quotes = await listedQuotes(them);

  await signIn(page, below);
  await page.goto('/otc');
  await expect(desk(page)).toBeVisible();
  // The room names the level before anything is typed.
  await expect(desk(page)).toContainText('Verification levelFull and above');
  // A size and provider the house desk prices for the verified trader in #6, so only the level can refuse it.
  expect(await askRefused(page, '0.5')).toBe('trade.otc_level_insufficient');
  await expect(page.getByText('trade.otc_level_insufficient')).toBeVisible();
  await expect(
    page.getByText(`The desk prices for ${status.minTier} verification and above. Your account is at basic.`, { exact: false }),
  ).toBeVisible();
  await expect(card(page)).toHaveCount(0);

  // Re-read after the refusal: no quote was recorded and nothing moved or was held.
  expect(await listedQuotes(them)).toEqual(quotes);
  expect(await them.balances()).toEqual(before);
});

test(`${J} #3 level unpublished: even a verified account is refused trade.otc_level_unset, nothing kept`, async ({ page }) => {
  test.setTimeout(300_000);
  const me = await api(run.read().who);
  try {
    tradeSwitch('LOCAL_STACK_TRADE_OTC_MIN_TIER', false);
    const status = await deskStatus(me);
    expect(status.minTier).toBeNull();
    expect(/(?:^| )minTier=(\S+)/.exec(status.statusLine)?.[1]).toBe('unset');
    const before = await me.balances();
    const quotes = await listedQuotes(me);
    await openOtc(page);
    await expect(desk(page)).toContainText('Verification levelNot set');
    expect(await askRefused(page, '0.5')).toBe('trade.otc_level_unset');
    await expect(page.getByText('trade.otc_level_unset')).toBeVisible();
    await expect(page.getByText('The desk has no verification level set, so a request cannot be sent.', { exact: false })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    expect(await listedQuotes(me)).toEqual(quotes);
    expect(await me.balances()).toEqual(before);
  } finally {
    tradeSwitch('LOCAL_STACK_TRADE_OTC_MIN_TIER', true);
  }
  expect((await deskStatus(me)).minTier).toBe('full');
});

test(`${J} #4 size under the published minimum: refused trade.rfq_below_minimum, the message carries that minimum`, async ({ page }) => {
  test.setTimeout(180_000);
  // The account from "starts" is staked to the desk's tier, so the stake gate passes and the minimum is what refuses.
  const me = await api(run.read().who);
  // The desk's own minimum for USDT requests, read back from its status line, not a number this file chose.
  const minimum = await publishedMinimum(me, 'USDT');
  expect(toUnits(minimum)).toBeGreaterThan(0n);
  const before = await me.balances();
  const quotes = await listedQuotes(me);

  // 0.00001 BTC at the TEST reference price of 65000 is 0.65 USDT, far below the minimum.
  await openOtc(page);
  expect(await askRefused(page, '0.00001')).toBe('trade.rfq_below_minimum');
  // The refusal names the minimum, and it is the number the desk publishes.
  await expect(page.getByText(`Below the desk minimum of ${minimum} USDT.`)).toBeVisible();
  await expect(card(page)).toHaveCount(0);

  // Re-read after the refusal: no quote was recorded and nothing moved or was held.
  expect(await listedQuotes(me)).toEqual(quotes);
  expect(await me.balances()).toEqual(before);
});

test(`${J} #4 minimum unpublished: refused trade.rfq_size_not_set, no quote is kept`, async ({ page }) => {
  test.setTimeout(300_000);
  const me = await api(run.read().who);
  try {
    tradeSwitch('LOCAL_STACK_TRADE_OTC_MIN_NOTIONAL', false);
    expect(await publishedMinimum(me, 'USDT')).toBe('unset');
    const before = await me.balances();
    const quotes = await listedQuotes(me);
    await openOtc(page);
    // A size the TEST minimum would price (#6 asks the same), so only the blank minimum can refuse it.
    expect(await askRefused(page, '0.5')).toBe('trade.rfq_size_not_set');
    await expect(page.getByText('The desk minimum is not set')).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    expect(await listedQuotes(me)).toEqual(quotes);
    expect(await me.balances()).toEqual(before);
  } finally {
    tradeSwitch('LOCAL_STACK_TRADE_OTC_MIN_NOTIONAL', true);
  }
  expect(toUnits(await publishedMinimum(me, 'USDT'))).toBeGreaterThan(0n);
});

test(`${J} #5 board of requests: status groups, counts and quote ranking`, async ({ page }) => {
  await openOtc(page);
  const board = page.getByRole('region', { name: 'Your requests' });
  for (const group of ['Open', 'Accepted', 'Settled', 'Expired']) {
    await expect(board.getByRole('heading', { name: new RegExp(`^${group} \\(\\d+\\)$`) })).toBeVisible(UNBUILT);
  }
});

test(`${J} #6 accept binds the quoted price; naming a different price refuses as last look`, async ({ page }) => {
  await openOtc(page);
  const quote = await ask(page);
  const id = await quote.getAttribute('data-quote-id');
  const quoted = await rfq(id);
  const price = await quote.getByTestId('quote-price').textContent();
  const before = await balances();
  await accept(page, quote);
  await expect(quote.getByTestId('quote-price')).toHaveText(price ?? '');
  // Bound at the quoted price, and not settled: nothing has moved on the ledger.
  const bound = await rfq(id);
  expect(bound.lifecycle).toBe('bound');
  expect(bound.fillPrice).toBe(quoted.quotedPrice);
  expect(await balances()).toEqual(before);
  // Last look: an accept that asserts any other price is refused, and the bound price stands.
  const other = (units(quoted.quotedPrice) + 10n ** 18n).toString();
  const asserted = `${other.slice(0, -18) || '0'}.${other.slice(-18)}`;
  const refused = await (await api(run.read().who)).post('/api/trade/trpc/rfq.accept', { quoteId: id, assertedPrice: asserted });
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.body)).toContain('trade.otc_last_look_forbidden');
  expect((await rfq(id)).fillPrice).toBe(quoted.quotedPrice);
  expect(await balances()).toEqual(before);
});

test(`${J} #7 deferred settle: one posting inside the window, refused past it, "Not set" when unpublished`, async ({ page }) => {
  test.setTimeout(420_000);
  await openOtc(page);
  // One quote accepted now and left past its window, one accepted and settled later inside it.
  const late = await ask(page);
  const lateId = await late.getAttribute('data-quote-id');
  await accept(page, late);
  const soon = await ask(page);
  const soonId = await soon.getAttribute('data-quote-id');
  await accept(page, soon);

  const bound = await rfq(soonId);
  const me = await api(run.read().who);
  const windowMs = Number(await publishedWindow());
  expect(windowMs).toBeGreaterThan(0);
  expect(Date.parse(bound.settleBy) - Date.parse(bound.acceptedAt)).toBe(windowMs);
  expect(bound.settleWindowMs).toBe(windowMs);

  // Later: the accepted quote opened again by its id, then settled before its settle-by time.
  const before = await balances();
  await page.goto(`/otc?quoteId=${soonId}`);
  await expect(card(page).getByTestId('phase-line')).toContainText('Accepted, not settled');
  await expect(card(page).getByTestId('settle-by')).toHaveText(/^Settle by \d{2} [A-Z][a-z]{2}, \d{2}:\d{2}/);
  await card(page).getByRole('button', { name: 'Settle', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Settle now' }).click();
  await expect(card(page).getByTestId('phase-line')).toContainText('Settled. The trade is complete.');
  expect(Date.now()).toBeLessThanOrEqual(Date.parse(bound.settleBy));
  const after = await balances();
  expect(held(after, 'BTC') - held(before, 'BTC')).toBe(units(bound.qty));
  expect(held(before, 'USDT') - held(after, 'USDT')).toBe(units(bound.userNotional));
  // Its key: settling the same quote again returns the same fill and moves nothing more.
  const first = await me.post('/api/trade/trpc/otc.settle', { quoteId: soonId });
  const second = await me.post('/api/trade/trpc/otc.settle', { quoteId: soonId });
  expect(first.status).toBe(200);
  expect(second.body.result.data.fillId).toBe(first.body.result.data.fillId);
  expect(await balances()).toEqual(after);
  expect((await rfq(soonId)).lifecycle).toBe('settled');

  // After the window: the other accepted quote refuses to settle, and nothing moves.
  const lateBound = await rfq(lateId);
  await page.waitForTimeout(Math.max(0, Date.parse(lateBound.settleBy) - Date.now()) + 1_000);
  await page.goto(`/otc?quoteId=${lateId}`);
  await expect(card(page).getByTestId('phase-line')).toContainText('Accepted, not settled');
  await card(page).getByRole('button', { name: 'Settle', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Settle now' }).click();
  await expect(page.getByText('The settlement window has closed')).toBeVisible();
  await expect(page.getByText('trade.rfq_window_passed')).toBeVisible();
  expect((await rfq(lateId)).lifecycle).toBe('bound');
  expect(await balances()).toEqual(after);

  // A blank window: the desk offers no deferral. The card reads "Not set" and names the quote's own expiry as the
  // deadline; a settle after that expiry is refused with its code and nothing moves.
  try {
    tradeSettleWindow(false);
    expect(await publishedWindow()).toBe('unset');
    await page.goto('/otc');
    const blank = await ask(page);
    const blankId = await blank.getAttribute('data-quote-id');
    await accept(page, blank);
    const blankBound = await rfq(blankId);
    expect(blankBound.settleWindowMs).toBeNull();
    expect(blankBound.settleBy).toBe(blankBound.expiresAt);
    await expect(blank.getByTestId('settle-by')).toHaveText(
      /^Not set: no deferral, settle by the quote expiry \d{2} [A-Z][a-z]{2}, \d{2}:\d{2}/,
    );
    const beforeBlank = await balances();
    await page.waitForTimeout(Math.max(0, Date.parse(blankBound.expiresAt) - Date.now()) + 1_000);
    await page.goto(`/otc?quoteId=${blankId}`);
    await card(page).getByRole('button', { name: 'Settle', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Settle now' }).click();
    await expect(page.getByText('trade.rfq_window_passed')).toBeVisible();
    expect((await rfq(blankId)).lifecycle).toBe('bound');
    expect(await balances()).toEqual(beforeBlank);
  } finally {
    tradeSettleWindow(true);
  }
  expect(await publishedWindow()).toBe(String(windowMs));
});

test(`${J} #8 expiry then re-price: the old quote stays expired, a new one exists, balances untouched`, async ({ page }) => {
  test.setTimeout(180_000);
  await openOtc(page);
  const quote = await ask(page);
  const oldId = await quote.getAttribute('data-quote-id');
  const old = await rfq(oldId);
  const before = await balances();
  await page.waitForTimeout(Math.max(0, Date.parse(old.expiresAt) - Date.now()) + 1_000);
  // The service, not the screen's clock, says it expired.
  await quote.getByRole('button', { name: 'Check status' }).click();
  await expect(quote.getByTestId('phase-line')).toContainText('Expired.');
  expect((await rfq(oldId)).lifecycle).toBe('expired');
  expect(await balances()).toEqual(before);

  await quote.getByRole('button', { name: 'Ask again' }).click();
  const fresh = card(page);
  await expect(fresh).not.toHaveAttribute('data-quote-id', oldId);
  await expect(fresh.getByTestId('phase-line')).toContainText('firm');
  const renewed = await rfq(await fresh.getAttribute('data-quote-id'));
  expect(renewed.lifecycle).toBe('open');
  expect([renewed.side, renewed.baseAsset, renewed.quoteAsset, renewed.qty]).toEqual([old.side, old.baseAsset, old.quoteAsset, old.qty]);
  expect(Date.parse(renewed.createdAt)).toBeGreaterThan(Date.parse(old.expiresAt));
  expect((await rfq(oldId)).lifecycle).toBe('expired');
  expect(await balances()).toEqual(before);
});

test(`${J} #9 convert at the desk price: price and settle time shown, an unpublished bound refuses`, async ({ page }) => {
  await signIn(page, run.read().who);
  await page.goto('/convert');
  await page
    .getByRole('textbox', { name: /Amount/ })
    .first()
    .fill('0.5', UNBUILT);
  await expect(page.getByTestId('convert-otc-price')).toContainText(/OTC price/, UNBUILT);
  await expect(page.getByTestId('convert-otc-price')).toContainText(/Settles/);
});
