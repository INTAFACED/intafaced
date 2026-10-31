import { createHash } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { approverSessions, makeContext, setFeeDiscountSchedule } from '../../../../tooling/scripts/local-test-gates.mjs';
import { api, fromUnits, fund, journeyState, signOutBrowser, toUnits, tool } from './stack.mjs';
import { fundedTrader, signIn, signUp } from './desk.mjs';

// J-copy-bots-otc-24, in the running app (docs/roadmap/journeys.json): ask the quote desk at /otc for a firm price on a
// large trade and settle it. One test per step, titled "J-copy-bots-otc-24 #<n>". The trader is a TEST account on the
// local stack, verified and funded with TEST USDT through the real ledger; accept binds the quoted price and size,
// settle posts once and expiry moves nothing, which the steps check against the ledger balance.
// The region-block clause of #1 and the settlement name-match clause of #3 are compliance gates and wait for launch
// prep (owner decision 2026-10-27: no compliance work until launch prep); the level gate of #3 stays (identity verification). The region block and the name
// match each have their own test (#1 and #3), red by name with that blocker until they are built.
// The stack publishes a TEST desk law (tooling/profiles/test-owner-values/trade.json): a 60 s firm quote and a 60 s
// window to settle an accepted one, so #7 and #8 watch both run out on the real clock. Each step checks the service's
// own record of the quote (rfq.get through Edge) and the ledger balance, not only the screen. Every request asks the
// providers it picks from the owner's TEST provider list (CB-otc-01); the steps after #2 ask the house desk.
// #5 asks three TEST outside providers at once; each is priced at its LOCAL TEST spread against the house inventory
// (no outside routing), and the board ranks the quotes the desk collected.
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
 * region gates wait for launch prep (owner decision 2026-10-27: no compliance work until launch prep), so this fails by that name.
 */
async function signUpIn(page, region) {
  throw new Error(`no TEST account can be registered in ${region} yet: no compliance work until launch prep (owner decision 2026-10-27)`);
}

/**
 * Names a settlement account for the trader whose holder name differs from its verified name, and returns the service's
 * own record of it ({ id, holderName, verifiedName }). Not built: the stack has no settlement-account step, and name
 * matching waits for launch prep (owner decision 2026-10-27: no compliance work until launch prep), so this fails by that name.
 */
async function nameOtherSettlementAccount(who) {
  throw new Error(
    `no settlement account can be named for ${who.handle} yet: no compliance work until launch prep (owner decision 2026-10-27)`,
  );
}

/** Removes the settlement account named by nameOtherSettlementAccount, so the steps after #3 are not refused by it. */
async function removeSettlementAccount(who, account) {
  throw new Error(
    `settlement account ${account.id} of ${who.handle} cannot be removed yet: no compliance work until launch prep (owner decision 2026-10-27)`,
  );
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

// BLOCKED: no compliance work until launch prep (owner decision 2026-10-27). This test stays red, by this name, until
// the desk publishes the regions it refuses (CB-otc-21); it fails at that first missing part, quickly.
test(`${J} #1 region block (BLOCKED until launch prep, owner decision 2026-10-27): the desk publishes the regions it refuses, an account in one sees the banner and is refused, nothing kept`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const me = await api(run.read().who);
  const status = await deskStatus(me);
  // The service's own list of refused regions is what the strip must show; a desk with none publishes an empty list,
  // never a missing field.
  expect(
    status,
    'the desk publishes no region block list: no compliance work until launch prep (owner decision 2026-10-27)',
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
  // The account sees the banner naming its region before it asks.
  await expect(page.getByRole('alert').filter({ hasText: status.blockedRegions[0] })).toContainText('not available in your region');
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

test(`${J} #3 settlement name match (BLOCKED until launch prep, owner decision 2026-10-27): a settlement account in another name is refused trade.otc_name_mismatch, no quote is priced, nothing kept`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const me = await api(run.read().who);
  const status = await deskStatus(me);
  // The service's own statement that a request checks the settlement account holder against the verified name.
  expect(
    status,
    'the desk publishes no settlement name check: no compliance work until launch prep (owner decision 2026-10-27)',
  ).toHaveProperty('settlementNameMatch');
  expect(status.settlementNameMatch).toBe(true);

  // A settlement account in a name other than the trader's verified one, both names as the service records them.
  const account = await nameOtherSettlementAccount(run.read().who);
  expect(account.holderName).toBeTruthy();
  expect(account.verifiedName).toBeTruthy();
  expect(account.holderName).not.toBe(account.verifiedName);
  try {
    const before = await me.balances();
    const quotes = await listedQuotes(me);
    await openOtc(page);
    // A size and provider the house desk prices for the verified trader in #6, so only the name can refuse it.
    expect(await askRefused(page, '0.5')).toBe('trade.otc_name_mismatch');
    await expect(page.getByText('trade.otc_name_mismatch')).toBeVisible();
    await expect(page.getByText(account.holderName, { exact: false })).toBeVisible();
    await expect(card(page)).toHaveCount(0);

    // Re-read after the refusal: no quote was recorded and nothing moved or was held.
    expect(await listedQuotes(me)).toEqual(quotes);
    expect(await me.balances()).toEqual(before);
  } finally {
    await removeSettlementAccount(run.read().who, account);
  }
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

/** The caller's board of requests as the desk groups it (`rfq.board`), over a window around now. */
async function rfqBoard(client) {
  const window = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), limit: 50 };
  const read = await client.get(`/api/trade/trpc/rfq.board?input=${encodeURIComponent(JSON.stringify(window))}`);
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  return read.body.result.data;
}

/** The board region of the room. */
const board = (page) => page.getByRole('region', { name: 'Your requests' });

/** The board as the room shows it: each group's heading and its requests, each with its quote ids in the order shown. */
async function shownBoard(page) {
  return board(page)
    .getByTestId('board-group')
    .evaluateAll((groups) =>
      groups.map((group) => ({
        status: group.getAttribute('data-status'),
        heading: group.querySelector('h3')?.textContent,
        requests: [...group.querySelectorAll('[data-testid="board-request"]')].map((request) => ({
          rfqId: request.getAttribute('data-rfq-id'),
          quotes: [...request.querySelectorAll('[data-testid="board-quote"]')].map((quote) => ({
            quoteId: quote.getAttribute('data-quote-id'),
            line: quote.querySelector('[data-testid="board-quote-line"]')?.textContent,
            badges: [...quote.children]
              .filter((child) => child.getAttribute('data-testid') !== 'board-quote-line')
              .map((badge) => badge.textContent),
          })),
        })),
      })),
    );
}

/**
 * Asks for a price on `quantity` BTC against USDT from the providers named, ticked in that order, and returns the
 * desk's answer to `rfq.quote` (the request's best quote) once its card is up.
 */
async function askFrom(page, quantity, providers) {
  const answer = page.waitForResponse((res) => res.url().includes('rfq.quote'));
  await request(page).getByRole('combobox', { name: 'Pair' }).click();
  await page.getByRole('option', { name: 'BTC/USDT', exact: true }).click();
  await request(page).getByRole('textbox', { name: 'Quantity' }).fill(quantity);
  await pickProviders(page, providers);
  await page.getByRole('button', { name: 'Request price' }).click();
  const body = [await (await answer).json()].flat()[0];
  expect(body.error, JSON.stringify(body.error ?? null).slice(0, 300)).toBeUndefined();
  await expect(card(page)).toHaveAttribute('data-quote-id', body.result.data.quoteId);
  return body.result.data;
}

const BOARD_LABEL = { open: 'Open', accepted: 'Accepted', settled: 'Settled', expired: 'Expired' };

/** A request's status from its quotes as rfq.get reads each one: settled, then accepted, then open, then expired. */
function statusFromQuotes(lifecycles) {
  if (lifecycles.includes('settled')) return 'settled';
  if (lifecycles.includes('bound')) return 'accepted';
  if (lifecycles.includes('open')) return 'open';
  return 'expired';
}

test(`${J} #5 board of requests: one quote per provider asked, grouped by status with counts, best on top, ties to the earlier`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const me = await api(run.read().who);
  // The owner's LOCAL TEST spread for each provider, read back from the desk's own provider list.
  const listed = await listedMakers(me);
  const spreadOf = Object.fromEntries(listed.makers.map((m) => [m.name, m.spreadBps]));
  const idOf = Object.fromEntries(listed.makers.map((m) => [m.name, m.id]));
  // Asked out of id order, so a tie broken by provider id or name would come out the other way round.
  const asked = ['TEST provider 3', 'TEST provider 2', 'TEST provider 1'];
  for (const name of asked) expect(Number.isInteger(spreadOf[name]), `${name} has a spread`).toBe(true);
  // Two of the providers share a spread, so the ranking has a tie to break; the third is wider, so it ranks last.
  expect(spreadOf['TEST provider 1']).toBe(spreadOf['TEST provider 3']);
  expect(spreadOf['TEST provider 2']).toBeGreaterThan(spreadOf['TEST provider 1']);

  // One request in each status, driven through the room: expired (left to run out), accepted, settled, and open.
  await openOtc(page);
  const expiring = await (await ask(page, '0.02')).getAttribute('data-quote-id');
  await page.goto('/otc');
  const acceptedCard = await ask(page, '0.02');
  const acceptedId = await acceptedCard.getAttribute('data-quote-id');
  await accept(page, acceptedCard);
  await page.goto('/otc');
  const settledCard = await ask(page, '0.02');
  const settledId = await settledCard.getAttribute('data-quote-id');
  await accept(page, settledCard);
  await settledCard.getByRole('button', { name: 'Settle', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Settle now' }).click();
  await expect(settledCard.getByTestId('phase-line')).toContainText('Settled. The trade is complete.');
  await page.waitForTimeout(Math.max(0, Date.parse((await rfq(expiring)).expiresAt) - Date.now()) + 1_000);

  // One request to three providers, ticked in this order.
  await page.goto('/otc');
  const best = await askFrom(page, '0.02', asked);
  const rfqId = best.rfqId;
  expect(typeof rfqId).toBe('string');

  // The desk's own board: the request collected exactly one quote per provider asked, in the order asked, each priced
  // at that provider's spread and labelled TEST.
  const served = await rfqBoard(me);
  expect(served.more).toBe(false);
  expect(served.groups.map((g) => g.status)).toEqual(['open', 'accepted', 'settled', 'expired']);
  const all = served.groups.flatMap((g) => g.requests.map((r) => ({ ...r, group: g.status })));
  const mine = all.filter((r) => r.rfqId === rfqId);
  expect(mine).toHaveLength(1);
  const request = mine[0];
  expect(request.group).toBe('open');
  expect([request.side, request.baseAsset, request.quoteAsset, request.qty]).toEqual(['buy', 'BTC', 'USDT', '0.02']);
  expect([...request.quotes].sort((a, b) => a.rfqSeq - b.rfqSeq).map((q) => [q.rfqSeq, q.makerId, q.spreadBps, q.test])).toEqual(
    asked.map((name, i) => [i + 1, idOf[name], spreadOf[name], true]),
  );
  // Each quote is the service's own record (rfq.get), open at the price the board shows, and that price is the mid
  // plus that provider's own spread: notional = mid × qty, plus the spread on it rounded up, over qty rounded up.
  const SCALE = 10n ** 18n;
  const ceilDiv = (a, b) => (a + b - 1n) / b;
  for (const q of request.quotes) {
    const record = await rfq(q.quoteId);
    expect([record.lifecycle, record.quotedPrice, record.counterparty]).toEqual(['open', q.quotedPrice, 'platform']);
    const midNotional = (units(record.midPrice) * units(request.qty)) / SCALE;
    const userNotional = midNotional + ceilDiv(midNotional * BigInt(q.spreadBps), 10_000n);
    expect(units(q.quotedPrice), q.makerId).toBe(ceilDiv(userNotional * SCALE, units(request.qty)));
    expect(units(q.userNotional), q.makerId).toBe(userNotional);
  }
  // Best on top: a buy ranks the lowest price first, and equal prices go to the quote asked earlier.
  const expected = [...request.quotes].sort((a, b) => {
    const diff = units(a.quotedPrice) - units(b.quotedPrice);
    return diff !== 0n ? (diff < 0n ? -1 : 1) : a.rfqSeq - b.rfqSeq;
  });
  expect(request.quotes.map((q) => q.quoteId)).toEqual(expected.map((q) => q.quoteId));
  expect(request.quotes.map((q) => [q.rank, q.best])).toEqual([
    [1, true],
    [2, false],
    [3, false],
  ]);
  const tied = request.quotes.filter((q) => q.makerId === idOf['TEST provider 1'] || q.makerId === idOf['TEST provider 3']);
  expect(tied[0].quotedPrice).toBe(tied[1].quotedPrice);
  expect(tied.map((q) => q.makerId)).toEqual([idOf['TEST provider 3'], idOf['TEST provider 1']]);
  expect(units(request.quotes[2].quotedPrice)).toBeGreaterThan(units(tied[0].quotedPrice));
  expect(request.quotes[0].quoteId).toBe(best.quoteId);

  // Every request on the board sits in the group its quotes' own records say, exactly once, and each status group
  // holds one of the requests driven above.
  expect(new Set(all.map((r) => r.rfqId)).size).toBe(all.length);
  for (const r of all) {
    const lifecycles = await Promise.all(r.quotes.map(async (q) => (await rfq(q.quoteId)).lifecycle));
    expect(statusFromQuotes(lifecycles), r.rfqId).toBe(r.group);
  }
  const groupOf = (quoteId) => all.find((r) => r.quotes.some((q) => q.quoteId === quoteId))?.group;
  expect([groupOf(expiring), groupOf(acceptedId), groupOf(settledId), groupOf(best.quoteId)]).toEqual([
    'expired',
    'accepted',
    'settled',
    'open',
  ]);
  for (const g of served.groups) expect(g.count, g.status).toBe(g.requests.length);

  // The room shows that board: each group under "<Status> (<count>)" with the desk's count, its requests in the
  // desk's order, and each request's quotes best first, with only the first marked Best and each TEST quote labelled.
  await page.reload();
  await expect(board(page)).toBeVisible();
  await expect(async () => {
    const now = await rfqBoard(me);
    const shown = await shownBoard(page);
    expect(shown.map((g) => [g.status, g.heading])).toEqual(now.groups.map((g) => [g.status, `${BOARD_LABEL[g.status]} (${g.count})`]));
    expect(shown.map((g) => g.requests.map((r) => [r.rfqId, r.quotes.map((q) => q.quoteId)]))).toEqual(
      now.groups.map((g) => g.requests.map((r) => [r.rfqId, r.quotes.map((q) => q.quoteId)])),
    );
  }).toPass({ timeout: 20_000 });
  const shownRequest = (await shownBoard(page)).flatMap((g) => g.requests).find((r) => r.rfqId === rfqId);
  expect(shownRequest.quotes.map((q) => q.badges)).toEqual([['Best', 'TEST'], ['TEST'], ['TEST']]);
  const nameOf = Object.fromEntries(listed.makers.map((m) => [m.id, m.name]));
  expect(shownRequest.quotes.map((q) => q.line.split(': ')[0])).toEqual(request.quotes.map((q) => nameOf[q.makerId]));
  // Each line shows the service's price for that quote, in the request's quote asset.
  expect(shownRequest.quotes.map((q) => q.line.split(': ')[1].replaceAll(',', '').split(' '))).toEqual(
    request.quotes.map((q) => [String(units(q.quotedPrice) / 10n ** 18n), 'USDT']),
  );
  for (const q of request.quotes) expect(units(q.quotedPrice) % 10n ** 18n, q.makerId).toBe(0n);

  // The best provider's quote settles against the house inventory through the room: the trader gets exactly the
  // quantity and pays exactly that quote's notional, and the board moves the request to Settled.
  const before = await me.balances();
  await page.goto(`/otc/${best.quoteId}`);
  const bestCard = card(page);
  await expect(bestCard).toHaveAttribute('data-quote-id', best.quoteId);
  await accept(page, bestCard);
  await bestCard.getByRole('button', { name: 'Settle', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Settle now' }).click();
  await expect(bestCard.getByTestId('phase-line')).toContainText('Settled. The trade is complete.');
  const settledBest = await rfq(best.quoteId);
  expect([settledBest.lifecycle, settledBest.counterparty, settledBest.fillPrice]).toEqual(['settled', 'platform', best.quotedPrice]);
  const after = await me.balances();
  expect(held(after, 'BTC') - held(before, 'BTC')).toBe(units('0.02'));
  expect(held(before, 'USDT') - held(after, 'USDT')).toBe(units(best.userNotional));
  const moved = (await rfqBoard(me)).groups.find((g) => g.requests.some((r) => r.rfqId === rfqId));
  expect(moved.status).toBe('settled');
});

test(`${J} #5 blank provider spread: asking that provider refuses trade.otc_provider_spread_unset, nothing kept`, async ({ page }) => {
  test.setTimeout(300_000);
  const me = await api(run.read().who);
  try {
    tradeSwitch('LOCAL_STACK_TRADE_OTC_SPREADS', false);
    // Read back blank: no outside provider carries a spread.
    const listed = await listedMakers(me);
    const outside = listed.makers.filter((m) => m.route === 'outside');
    expect(outside.map((m) => m.name)).toEqual(['TEST provider 1', 'TEST provider 2', 'TEST provider 3']);
    for (const m of outside) expect(m, m.name).not.toHaveProperty('spreadBps');
    const before = await me.balances();
    const quotes = await listedQuotes(me);
    const boardBefore = await rfqBoard(me);
    await openOtc(page);
    // With the house desk in the same request: the whole request refuses, so no provider's quote is kept.
    expect(await askRefused(page, '0.02', [HOUSE, 'TEST provider 1'])).toBe('trade.otc_provider_spread_unset');
    await expect(page.getByText('trade.otc_provider_spread_unset')).toBeVisible();
    await expect(page.getByText('The spread for provider test-lp-1 is not set', { exact: false })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    // Re-read after the refusal: no quote was recorded, the board is the same, and nothing moved or was held.
    expect(await listedQuotes(me)).toEqual(quotes);
    expect((await rfqBoard(me)).groups.map((g) => g.requests.map((r) => r.rfqId))).toEqual(
      boardBefore.groups.map((g) => g.requests.map((r) => r.rfqId)),
    );
    expect(await me.balances()).toEqual(before);
    // The refusal is about the blank provider, not the desk: the house desk alone still prices, at no outside spread.
    await page.goto('/otc');
    const house = await askFrom(page, '0.02', [HOUSE]);
    expect([house.makerId, house.test]).toEqual([listed.makers.find((m) => m.name === HOUSE).id, false]);
    await me.post('/api/trade/trpc/rfq.expire', { quoteId: house.quoteId });
    expect((await rfq(house.quoteId)).lifecycle).toBe('expired');
  } finally {
    tradeSwitch('LOCAL_STACK_TRADE_OTC_SPREADS', true);
  }
  const restored = await listedMakers(me);
  for (const m of restored.makers.filter((m) => m.route === 'outside')) expect(Number.isInteger(m.spreadBps), m.name).toBe(true);
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

/** The large-conversion panel on /convert. */
const otcConvert = (page) => page.getByRole('region', { name: 'Large conversions at the desk price' });

/** The owner's size range for a conversion at the desk price (`otc.convertBounds`), as the trader reads it. */
async function convertBounds(client) {
  const read = await client.get('/api/trade/trpc/otc.convertBounds');
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  return read.body.result.data.convert;
}

/** svc-trade restarted with the convert size range blank, or back on the stack's TEST range. */
const tradeConvertBounds = (on) => tradeSwitch('LOCAL_STACK_TRADE_OTC_CONVERT_BOUNDS', on);

/** Asks the panel for the desk price on `quantity` BTC and returns the service's answer to `otc.convertQuote`. */
async function askConvert(page, quantity) {
  const answer = page.waitForResponse((res) => res.url().includes('otc.convertQuote'));
  await otcConvert(page).getByRole('textbox', { name: 'Desk amount' }).fill(quantity);
  await otcConvert(page).getByRole('button', { name: 'Get desk price' }).click();
  return [await (await answer).json()].flat()[0];
}

/** A shown amount ("65,130.5 USDT") as exact 1e-18 units. */
const shown = (text) => units(String(text).replace(/[^\d.]/g, ''));

test(`${J} #9 Convert at the desk price: the range, the quoted price and the settle time are the desk's own, and a blank range refuses`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const me = await api(run.read().who);
  await signIn(page, run.read().who);
  await page.goto('/trade/convert');
  const panel = otcConvert(page);
  await expect(panel).toBeVisible();
  // Only pairs on the desk's asset list are offered; BTC/USDT is the one the stack prices (its one TEST mid).
  await panel.getByRole('combobox', { name: 'Desk pair' }).click();
  await page.getByRole('option', { name: 'BTC/USDT', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: 'Desk pair' })).toContainText('BTC/USDT');

  // The size range on the page is the one the desk publishes, read back.
  const range = await convertBounds(me);
  expect(range).not.toBeNull();
  const rangeText = await panel.getByTestId('convert-otc-range').textContent();
  const [, min, max] = /^Desk size range:(\S+) to (\S+) BTC$/.exec(rangeText ?? '') ?? [];
  expect([shown(min), shown(max)]).toEqual([units(range.minQty), units(range.maxQty)]);

  // A size inside the range (and inside what the account holds after #7) is priced by the desk. The price on the page is
  // the one the service recorded for that quote, and the settle time is the desk's published window.
  const before = await balances();
  const priced = await askConvert(page, '0.2');
  const answer = priced.result.data;
  expect([answer.flow, answer.side, answer.baseAsset, answer.quoteAsset, answer.qty]).toEqual(['convert', 'buy', 'BTC', 'USDT', '0.2']);
  const recorded = await rfq(answer.quoteId);
  expect(recorded.lifecycle).toBe('open');
  expect(recorded.quotedPrice).toBe(answer.quotedPrice);
  const price = panel.getByTestId('convert-otc-price');
  await expect(price).toBeVisible();
  expect(shown(await price.getByTestId('convert-otc-quoted').textContent())).toBe(units(recorded.quotedPrice));
  await expect(price.getByTestId('convert-otc-quoted')).toHaveText(/ USDT$/);
  const windowMs = Number(await publishedWindow());
  expect(windowMs).toBeGreaterThan(0);
  expect(answer.settleWindowMs).toBe(windowMs);
  await expect(price.getByTestId('convert-otc-settles')).toHaveText(`Settles within ${windowMs / 1000} s of confirming.`);
  expect(await balances()).toEqual(before);

  // Confirming binds that price and settles it once: the ledger moves by exactly the recorded fill.
  await price.getByRole('button', { name: 'Convert at this price' }).click();
  await expect(panel.getByTestId('convert-otc-done')).toContainText('Converted and settled');
  const settled = await rfq(answer.quoteId);
  expect(settled.lifecycle).toBe('settled');
  expect(settled.fillPrice).toBe(answer.quotedPrice);
  expect(settled.qty).toBe('0.2');
  // The notional is the desk's own arithmetic on the recorded mid at the published desk spread: mid × qty, plus the
  // spread on it rounded up.
  const deskSpread = (await (await api(run.read().who)).get('/api/trade/trpc/otc.deskStatus')).body.result.data.statusLine;
  const spreadBps = Number(/(?:^| )spreadBps=(\d+)/.exec(deskSpread)?.[1]);
  expect(settled.spreadBps).toBe(spreadBps);
  const SCALE = 10n ** 18n;
  const ceilDiv = (a, b) => (a + b - 1n) / b;
  const midNotional = (units(settled.midPrice) * units('0.2')) / SCALE;
  expect(units(settled.userNotional)).toBe(midNotional + ceilDiv(midNotional * BigInt(spreadBps), 10_000n));
  const after = await balances();
  expect(held(after, 'BTC') - held(before, 'BTC')).toBe(units('0.2'));
  expect(held(before, 'USDT') - held(after, 'USDT')).toBe(units(settled.userNotional));
  // Settling it again, twice, answers the one fill under the quote's own key and moves nothing more.
  const again = await me.post('/api/trade/trpc/otc.settle', { quoteId: answer.quoteId });
  const twice = await me.post('/api/trade/trpc/otc.settle', { quoteId: answer.quoteId });
  expect([again.status, twice.status], JSON.stringify(again.body).slice(0, 300)).toEqual([200, 200]);
  expect(typeof again.body.result.data.fillId).toBe('string');
  expect(twice.body.result.data.fillId).toBe(again.body.result.data.fillId);
  expect(await balances()).toEqual(after);
  expect((await rfq(answer.quoteId)).lifecycle).toBe('settled');

  // The range left blank: the page says "Not set", a request refuses with its one code, no quote is kept and nothing moves.
  try {
    tradeConvertBounds(false);
    expect(await convertBounds(me)).toBeNull();
    await page.goto('/trade/convert');
    await panel.getByRole('combobox', { name: 'Desk pair' }).click();
    await page.getByRole('option', { name: 'BTC/USDT', exact: true }).click();
    await expect(panel.getByTestId('convert-otc-range')).toHaveText(
      'Desk size range:Not setThe desk has no size range for conversions, so a request refuses.',
    );
    const quotesBefore = await listedQuotes(me);
    const balancesBefore = await balances();
    const refused = await askConvert(page, '0.2');
    expect(refused.error?.data?.cause?.code).toBe('trade.convert_bounds_not_set');
    await expect(panel.getByText('Desk size range not set')).toBeVisible();
    await expect(panel.getByTestId('convert-otc-price')).toHaveCount(0);
    expect(await listedQuotes(me)).toEqual(quotesBefore);
    expect(await balances()).toEqual(balancesBefore);
  } finally {
    tradeConvertBounds(true);
  }
  expect(await convertBounds(me)).toEqual(range);
});
