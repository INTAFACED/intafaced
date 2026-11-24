// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { fromUnits, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { doorCalls, ledgerUntouched, ledgerView, openVenueRoom, signedOnVenue, venueAt, venueNow, walletOwner } from './venue-door.mjs';
import { continueInWallet, venueForThisFile, venueRecord } from './venue.mjs';

// J-derivatives-06's venue steps, "I watch and top up the margin on an isolated position", on the person's own venue
// account (the launch money model: the venue holds the position and its margin, the ledger posts nothing), in the running
// app against the stack's TEST venue simulator (packages/venue-sim). One test per step, titled "J-derivatives-06 #<n>",
// run in order on one TEST account; J-derivatives-06.pw.mjs holds the custodial branch, checked on our own futures engine
// (its own-engine stop is still titled #5 there: the merge seal fails closed on a journey file left with no step title).
//
// The Starts line, made at the start of #1 straight on the TEST venue with the person's own key: a TEST isolated long of
// 0.02 BTC-PERP at 10x, taken from the TEST makers' ladder. Every figure the page shows is checked against the TEST
// venue's own record, read straight from the venue, never through our door; the ledger is read before and after to show
// it posts nothing. Every figure is TEST.
const J = 'J-derivatives-06';
const ROOM = '/trade/positions';
const BTC = 'BTC-PERP';
const FUNDS = '3000';
const SIZE = '0.02';
const ADD = '7.123456';
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

// ── the TEST venue, read and signed on directly ──

const accountOf = (venue, owner) => ({ venueId: venue.id, owner, subAccount: null });
/**
 * The venue's own record for the account (`/positions`, `/balances`, `/account-summary`, `/isolated-margin`, ...), read
 * through the venue fixture (`venueRecord`): straight from the TEST venue on loopback, never through our door. The
 * fixture reads the same TEST venue `venueNow` names, and checks it is labelled TEST.
 */
const record = async (venue, owner, path, extra = {}) => (await venueRecord(owner, path, extra)).value;
const positionOn = async (venue, owner) => (await record(venue, owner, '/positions')).find((p) => p.symbol === BTC);
const usdcOn = async (venue, owner) =>
  (await record(venue, owner, '/balances')).find((b) => b.asset === 'USDC') ?? { free: '0', locked: '0', total: '0' };

// ── the person and the page ──

const state = () => walletOwner(run, `${J} #1`);
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;
const same = (a, b) => toUnits(String(a).trim()) === toUnits(String(b).trim());
/** A fraction as the room draws it in percent: times 100, to its last digit. */
const percent = (fraction) => `${fromUnits(toUnits(fraction) * 100n)}%`;

/** Opens the margin panel of the BTC-PERP row and waits for the venue's figures in it. */
async function openMargin(page, venue) {
  await page
    .getByTestId('positions-all')
    .locator(`tr[data-venue="${venue.id}"][data-symbol="${BTC}"]`)
    .getByRole('button', { name: 'Margin', exact: true })
    .click();
  const panel = page.getByTestId('position-margin');
  await expect(panel).toContainText(`Margin on ${BTC}`);
  await expect(panel.locator('[data-line="margin"]')).toBeVisible({ timeout: 20_000 });
  return panel;
}
const line = async (panel, name) => (await panel.locator(`[data-line="${name}"]`).innerText()).trim();

/** TEST setup, not a step (the Starts line): a verified account, its wallet, TEST USDC on the venue and an isolated long. */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'jd6v');
    await verify(page, account);
    const walletKey = testWalletKey();
    const key = privateKeyToAccount(walletKey);
    const owner = key.address.toLowerCase();
    const venue = await venueNow();
    await venueAt('/test/deposit', {
      account: accountOf(venue, owner),
      asset: 'USDC',
      amount: FUNDS,
      depositRef: `84532:0x${randomBytes(32).toString('hex')}:0`,
    });
    const tag = randomBytes(4).toString('hex');
    await signedOnVenue(venue, key, { kind: 'update_leverage', symbol: BTC, leverageBps: 100_000, marginMode: 'isolated' });
    await signedOnVenue(venue, key, {
      kind: 'place_order',
      symbol: BTC,
      side: 'buy',
      type: 'limit',
      amount: SIZE,
      price: '60100',
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: `order:jd6v:${tag}:open`,
      builderFee: null,
    });
    const p = await positionOn(venue, owner);
    expect(p).toMatchObject({ side: 'long', marginMode: 'isolated', leverageBps: 100_000 });
    expect(same(p.size, SIZE)).toBe(true);
    run.reset({ account, walletKey, tag, ledger: await ledgerView(account) });
  } finally {
    await page.close();
  }
}

test(`${J} #1 opens Account metrics: equity, free, used margin and margin ratio as exact decimals as the venue reports them, with an as-of time`, async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  await startsLine(browser);
  const s = state();
  const venue = await venueNow();
  await openVenueRoom(page, s, ROOM);
  const region = page.getByRole('region', { name: 'Account metrics', exact: true });
  await expect(region).toBeVisible();
  const block = region.locator(`[data-venue="${venue.id}"]`);
  await expect(block).toContainText(`On ${venue.name}`);
  for (const label of ['Equity', 'Free', 'Used margin', 'Maintenance margin', 'Margin ratio'])
    await expect(block.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) })).toBeVisible();
  const metric = async (name) => (await block.locator(`[data-metric="${name}"]`).innerText()).trim();

  // Every figure is the venue's own, to its last digit, read from the venue at the same moment as the page.
  await expect(async () => {
    const summary = await record(venue, s.owner, '/account-summary');
    expect(summary.asset).toBe('USDC');
    expect(await metric('equity')).toBe(summary.equity);
    expect(await metric('free')).toBe(summary.free);
    expect(await metric('used')).toBe(summary.usedMargin);
    expect(await metric('maintenance')).toBe(summary.maintenanceMargin);
    expect(summary.marginRatio.known).toBe(true);
    expect(await metric('ratio')).toBe(percent(summary.marginRatio.value));
    // The venue's summary is its own record of this account: free is its free USDC, used margin the position's margin,
    // maintenance the position's, and equity all its USDC with the position's unrealised result.
    const [p, usdc] = await Promise.all([positionOn(venue, s.owner), usdcOn(venue, s.owner)]);
    expect(summary.free).toBe(usdc.free);
    expect(summary.usedMargin).toBe(p.margin);
    expect(p.maintenanceMargin.known).toBe(true);
    expect(summary.maintenanceMargin).toBe(p.maintenanceMargin.value);
    expect(summary.equity).toBe(fromUnits(toUnits(usdc.free) + toUnits(usdc.locked) + toUnits(p.unrealisedPnl)));
    // Exact decimals: nothing rounded to the cent (the used margin carries every digit the venue gave).
    expect(summary.usedMargin).toMatch(/^\d+(\.\d+)?$/);
  }).toPass({ timeout: 30_000 });
  // With the time the venue's figures are as of.
  await expect(block.getByTestId('venue-as-of')).toHaveText(/\d{4}.*\d{2}:\d{2}:\d{2}/);
  await ledgerUntouched(s);
});

test(`${J} #2 adds margin to a position: a signed venue margin change; margin and liquidation price after, from the venue`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  const wallet = await openVenueRoom(page, s, ROOM);
  const door = doorCalls(page);
  const before = await positionOn(venue, s.owner);
  const usdcBefore = await usdcOn(venue, s.owner);
  expect(before.liquidationPrice.known).toBe(true);
  const panel = await openMargin(page, venue);
  expect(same(await line(panel, 'margin'), before.margin)).toBe(true);
  expect(same(await line(panel, 'free'), usdcBefore.free)).toBe(true);
  expect(same(await line(panel, 'liquidation'), before.liquidationPrice.value)).toBe(true);

  const asked = signatures(wallet);
  await panel.getByRole('textbox', { name: 'Amount (USDC)', exact: true }).fill(ADD);
  await panel.getByRole('button', { name: 'Add margin', exact: true }).click();
  await continueInWallet(page);
  await expect(panel.getByTestId('venue-outcome')).toContainText('The venue accepted it.', { timeout: 20_000 });
  // One signed venue margin change, sent once.
  expect(signatures(wallet)).toBe(asked + 1);
  const prepares = door.of('prepare');
  expect(prepares).toHaveLength(1);
  expect(prepares[0].body.intent).toMatchObject({ kind: 'update_isolated_margin', symbol: BTC, direction: 'add', amount: ADD });
  expect(prepares[0].body.intent.changeKey).toMatch(new RegExp(`^margin:${s.owner}:btc-perp:add:`));
  expect(door.of('submit')).toHaveLength(1);

  // On the venue: the margin rose by exactly the amount, taken from free once, and the liquidation price moved away.
  const after = await positionOn(venue, s.owner);
  expect(after.margin).toBe(fromUnits(toUnits(before.margin) + toUnits(ADD)));
  expect((await usdcOn(venue, s.owner)).free).toBe(fromUnits(toUnits(usdcBefore.free) - toUnits(ADD)));
  expect(after.liquidationPrice.known).toBe(true);
  expect(toUnits(after.liquidationPrice.value)).toBeLessThan(toUnits(before.liquidationPrice.value));
  // The page says the margin and liquidation price after, as the venue read them back.
  await expect(panel.getByTestId('position-margin-after')).toHaveText(
    `After the change, from ${venue.name}: margin ${after.margin}, liquidation price ${after.liquidationPrice.value}.`,
  );
  await expect(panel.locator('[data-line="margin"]')).toHaveText(after.margin, { timeout: 20_000 });
  await expect(panel.locator('[data-line="liquidation"]')).toHaveText(after.liquidationPrice.value);
  await expect(
    page.getByTestId('positions-all').locator(`tr[data-venue="${venue.id}"][data-symbol="${BTC}"] [data-cell="margin"]`),
  ).toHaveText(after.margin, { timeout: 20_000 });
  await ledgerUntouched(s);
});

test(`${J} #3 removes margin: allowed down to the venue's limit; otherwise refused in words`, async ({ page }) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  const wallet = await openVenueRoom(page, s, ROOM);
  const door = doorCalls(page);
  const limit = await record(venue, s.owner, '/isolated-margin', { symbol: BTC });
  // #2 added margin above the venue's minimum for the position, so there is room to remove, and the page shows the limit.
  expect(toUnits(limit.removable)).toBe(toUnits(ADD));
  const panel = await openMargin(page, venue);
  expect(same(await line(panel, 'minimum'), limit.minimumMargin)).toBe(true);
  expect(same(await line(panel, 'removable'), limit.removable)).toBe(true);
  await expect(panel.locator('[data-line="rule"]')).toHaveText(`${venue.name}: ${limit.rule}`);
  const input = panel.getByRole('textbox', { name: 'Amount (USDC)', exact: true });
  const remove = panel.getByRole('button', { name: 'Remove margin', exact: true });

  // Past the limit: the venue refuses in words, before the wallet is asked, and nothing moves.
  const asked = signatures(wallet);
  const before = await positionOn(venue, s.owner);
  const usdcBefore = await usdcOn(venue, s.owner);
  const tooMuch = fromUnits(toUnits(limit.removable) + 1_000_000_000_000n);
  await input.fill(tooMuch);
  await remove.click();
  await expect(panel.getByTestId('venue-outcome')).toContainText(
    `would leave ${fromUnits(toUnits(before.margin) - toUnits(tooMuch))} margin, below this venue's minimum of ${limit.minimumMargin} for the position`,
    { timeout: 20_000 },
  );
  await expect(panel.getByTestId('venue-outcome')).toContainText(`at most ${limit.removable} can be removed`);
  expect(signatures(wallet)).toBe(asked);
  expect(door.of('submit')).toHaveLength(0);
  expect(await positionOn(venue, s.owner)).toEqual(before);
  expect(await usdcOn(venue, s.owner)).toEqual(usdcBefore);

  // Down to the limit: allowed, one signed change, the margin at the venue's minimum and the amount back in free.
  await input.fill(limit.removable);
  await remove.click();
  await continueInWallet(page);
  await expect(panel.getByTestId('venue-outcome')).toContainText('The venue accepted it.', { timeout: 20_000 });
  expect(signatures(wallet)).toBe(asked + 1);
  expect(door.of('submit')).toHaveLength(1);
  expect(door.of('prepare').at(-1).body.intent).toMatchObject({
    kind: 'update_isolated_margin',
    symbol: BTC,
    direction: 'remove',
    amount: limit.removable,
  });
  const after = await positionOn(venue, s.owner);
  expect(after.margin).toBe(limit.minimumMargin);
  expect((await usdcOn(venue, s.owner)).free).toBe(fromUnits(toUnits(usdcBefore.free) + toUnits(limit.removable)));
  const now = await record(venue, s.owner, '/isolated-margin', { symbol: BTC });
  expect(toUnits(now.removable)).toBe(0n);
  await expect(panel.locator('[data-line="removable"]')).toHaveText(now.removable, { timeout: 20_000 });
  await expect(panel.getByTestId('position-margin-after')).toHaveText(
    `After the change, from ${venue.name}: margin ${after.margin}, liquidation price ${after.liquidationPrice.value}.`,
  );
  await ledgerUntouched(s);
});

// ── #4: auto top-up through the agent permission ──

const EACH = '10';
const CAP = '25';
const RAISED_CAP = '50';
const PERMISSION_CAP = '30';
/** The figure a top-up watches, as the venue reports it: the position's margin with its unrealised result. */
const withResult = (p) => fromUnits(toUnits(p.margin) + toUnits(p.unrealisedPnl));

/**
 * The TEST mark control (`/test/set-mark` on the TEST venue): moves BTC-PERP's mark so the position's margin with its
 * result is exactly `target`, read back from the venue. A long of SIZE moves SIZE per unit of mark.
 */
async function marginWithResultTo(venue, owner, target) {
  const p = await positionOn(venue, owner);
  const perUnit = toUnits(SIZE);
  const delta = toUnits(withResult(p)) - toUnits(target);
  const mark = toUnits(p.markPrice) - (delta * 10n ** 18n) / perUnit;
  await venueAt('/test/set-mark', { symbol: BTC, price: fromUnits(mark) });
  expect(withResult(await positionOn(venue, owner))).toBe(target);
}

test(`${J} #4 turns on auto top-up, setting the margin level that starts it, the amount each top-up adds, and a cap: our engine adds the set amount through the agent permission once each time margin falls to the set level, never past the cap or the permission's own cap`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(600_000);
  const s = state();
  const venue = await venueNow();
  const wallet = await openVenueRoom(page, s, ROOM);
  const start = await positionOn(venue, s.owner);
  // The position is moving against the trader: the TEST mark falls from here, and is put back after the step.
  const markBefore = start.markPrice;
  try {
    const level = fromUnits(toUnits(withResult(start)) - toUnits('20'));
    const below = fromUnits(toUnits(level) - toUnits('1'));
    const panel = await openMargin(page, venue);
    const atu = panel.getByTestId('auto-top-up');
    await expect(atu).toContainText(`Auto top-up on ${BTC}`);
    await expect(atu.locator('[data-line="atu-state"]')).toHaveText('Off.', { timeout: 20_000 });
    // The figure it watches is the venue's own.
    await expect(atu.locator('[data-line="atu-margin"]')).toHaveText(withResult(start));
    const box = (name) => atu.getByRole('textbox', { name, exact: true });
    const state4 = atu.locator('[data-line="atu-state"]');
    const watching = `On: watching for the margin to fall to ${level}.`;

    // The person sets the level that starts a top-up, the amount each adds, a cap, and the agent permission's own cap; the
    // wallet signs the agent permission once.
    await box('Margin level that starts a top-up (USDC)').fill(level);
    await box('Amount each top-up adds (USDC)').fill(EACH);
    await box('Cap for this position (USDC)').fill(CAP);
    await box('Agent permission cap (USDC)').fill(PERMISSION_CAP);
    const asked = signatures(wallet);
    await atu.getByRole('button', { name: 'Turn on auto top-up', exact: true }).click();
    await continueInWallet(page);
    await expect(atu.locator('[data-line="atu-permission"]')).toHaveText(`Approved on ${venue.name}.`, { timeout: 20_000 });
    expect(signatures(wallet)).toBe(asked + 1);
    await expect(state4).toHaveText(watching);
    await expect(atu.locator('[data-line="atu-permission-cap"]')).toHaveText(PERMISSION_CAP);
    // The venue lists the agent permission on the person's account: the key that signs every top-up, never a withdrawal.
    const agents = await record(venue, s.owner, '/agents');
    expect(agents.filter((x) => x.name === 'auto-top-up')).toHaveLength(1);

    /** One fall of the margin to the level; the venue's margin after, once our engine has acted or not. */
    const marginBase = toUnits(start.margin);
    const crossing = async (added) => {
      await marginWithResultTo(venue, s.owner, below);
      const expected = fromUnits(marginBase + toUnits(added));
      await expect(async () => expect((await positionOn(venue, s.owner)).margin).toBe(expected)).toPass({ timeout: 30_000 });
      return expected;
    };
    const rows = atu.getByTestId('auto-top-ups').locator('tbody tr');

    // Crossings 1 and 2: the set amount once each, through the agent permission (the wallet is not asked again), each
    // re-armed only when the margin is back above the level.
    for (const n of [1, 2]) {
      await crossing(String(n * Number(EACH)));
      await expect(rows).toHaveCount(n, { timeout: 20_000 });
      await expect(rows.nth(n - 1)).toHaveAttribute('data-state', 'added');
      await expect(rows.nth(n - 1).locator('[data-cell="amount"]')).toHaveText(EACH);
      await expect(rows.nth(n - 1)).toHaveAttribute('data-key', `margin:${s.owner}:btc-perp:auto:${n}`);
      // Once per crossing: the engine has read the position again since the top-up (it is watching for the next fall),
      // and the venue's margin holds at exactly n top-ups.
      await expect(state4).toHaveText(watching, { timeout: 20_000 });
      expect((await positionOn(venue, s.owner)).margin).toBe(fromUnits(marginBase + toUnits(String(n * Number(EACH)))));
    }
    expect(signatures(wallet)).toBe(asked + 1);

    // Crossing 3: 20 added, and 10 more would pass the cap of 25: nothing is sent, and the page names the cap.
    await marginWithResultTo(venue, s.owner, below);
    await expect(state4).toHaveText(`Stopped at this position’s cap: 20 of ${CAP} added, and ${EACH} more would pass it.`, {
      timeout: 20_000,
    });
    expect((await positionOn(venue, s.owner)).margin).toBe(fromUnits(marginBase + toUnits('20')));
    await expect(rows).toHaveCount(2);

    // The person raises the position's cap; the permission's own cap of 30 now stops it at one more top-up.
    await box('Cap for this position (USDC)').fill(RAISED_CAP);
    await atu.getByRole('button', { name: 'Save auto top-up', exact: true }).click();
    await expect(atu.getByTestId('auto-top-up-said')).toHaveText('Saved.', { timeout: 20_000 });
    expect(signatures(wallet)).toBe(asked + 1);
    await marginWithResultTo(venue, s.owner, fromUnits(toUnits(level) + toUnits('5')));
    await expect(state4).toHaveText(watching, { timeout: 20_000 });
    await crossing('30');
    await expect(rows).toHaveCount(3, { timeout: 20_000 });
    await expect(rows.nth(2)).toHaveAttribute('data-state', 'added');
    await expect(atu.locator('[data-line="atu-permission-used"]')).toHaveText('30', { timeout: 20_000 });
    await expect(state4).toHaveText(watching, { timeout: 20_000 });

    // Crossing 5: the position's cap has room, and the permission's own cap of 30 is used: nothing is sent.
    await marginWithResultTo(venue, s.owner, below);
    await expect(state4).toHaveText(
      `Stopped at the agent permission’s own cap: 30 of ${PERMISSION_CAP} used, and ${EACH} more would pass it.`,
      { timeout: 20_000 },
    );
    const end = await positionOn(venue, s.owner);
    expect(end.margin).toBe(fromUnits(marginBase + toUnits('30')));
    await expect(rows).toHaveCount(3);
    await expect(atu.locator('[data-line="atu-added"]')).toHaveText('30');
    await expect(atu.locator('[data-line="atu-permission-room"]')).toHaveText('0');
    expect(signatures(wallet)).toBe(asked + 1);
    await stepPicture();
    await ledgerUntouched(s);
  } finally {
    await venueAt('/test/set-mark', { symbol: BTC, price: markBefore });
  }
});

// ── #5: a pre-liquidation stop ──

const STOP_LEVEL = '50';
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The venue's own listing of BTC-PERP: its tick, and the prices it judges trigger orders on. */
const btcMarket = async (owner) => (await record(null, owner, '/markets')).find((m) => m.symbol === BTC);
/** The venue's open trigger orders on BTC-PERP for the account, as the venue lists them. */
const triggersOn = async (owner) => (await record(null, owner, '/open-orders')).filter((o) => o.symbol === BTC && o.trigger);
/** The position's margin with its unrealised result were the mark at `price`: margin + size × (price − entry) for a long. */
const equityAt = (p, price) => toUnits(p.margin) + (toUnits(p.size) * (toUnits(price) - toUnits(p.entryPrice))) / 10n ** 18n;

test(`${J} #5 sets a pre-liquidation stop: a close order at the maintenance level, shown on the position`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  // TEST control: the venue judges trigger orders on BTC-PERP's mark (its TEST listing declares none until a step needs
  // them), put back after the step.
  await venueAt('/test/market-triggers', { symbol: BTC, sources: ['mark', 'last'] });
  const key = privateKeyToAccount(s.walletKey);
  let stopId = null;
  try {
    const market = await btcMarket(s.owner);
    expect(market.triggerSources).toContain('mark');
    const p = await positionOn(venue, s.owner);
    expect(p.maintenanceMargin.known).toBe(true);
    expect(p.liquidationPrice.known).toBe(true);
    expect(await triggersOn(s.owner)).toEqual([]);
    const maintenance = toUnits(p.maintenanceMargin.value);

    const wallet = await openVenueRoom(page, s, ROOM);
    const door = doorCalls(page);
    const row = page.getByTestId('positions-all').locator(`tr[data-venue="${venue.id}"][data-symbol="${BTC}"]`);
    await row.getByRole('button', { name: 'Pre-liquidation stop', exact: true }).click();
    const panel = page.getByTestId('pre-liquidation-stop-panel');
    await expect(panel).toContainText(`Pre-liquidation stop on ${BTC}`);
    // The figures the level is turned into a price from are the venue's own.
    await expect(panel.locator('[data-line="maintenance"]')).toHaveText(p.maintenanceMargin.value);
    await expect(panel.locator('[data-line="liquidation"]')).toHaveText(p.liquidationPrice.value);
    await expect(panel.locator('[data-line="mark"]')).toHaveText(p.markPrice);
    const current = panel.getByRole('region', { name: 'On this position now', exact: true });
    await expect(current).toContainText('No pre-liquidation stop set.');
    const box = panel.getByRole('textbox', { name: 'Close at margin ratio (%)', exact: true });
    const set = panel.getByRole('button', { name: 'Set stop', exact: true });
    const why = panel.getByTestId('pre-liquidation-stop-why');

    // At 100% the venue liquidates: refused in words before anything is sent.
    await box.fill('100');
    await expect(why).toHaveText('Enter a percent above 0 and below 100, to two places at most.');
    await expect(set).toBeDisabled();
    // Below the ratio now (maintenance over the margin with its result, a few percent here), a stop would close at once.
    expect(maintenance * 100n * 10n ** 18n).toBeGreaterThan(toUnits('1') * toUnits(withResult(p)));
    await box.fill('1');
    await expect(why).toHaveText(
      'The margin ratio already stands at that level: a stop there would close the position at once. Set a higher level.',
    );
    await expect(set).toBeDisabled();
    expect(door.of('protections')).toEqual([]);
    expect(door.of('submit')).toEqual([]);

    // At the maintenance level the person sets: the mark, on the venue's tick, at which the venue's maintenance requirement
    // over the margin with its result reaches it, or the tick just before it, never after.
    await box.fill(STOP_LEVEL);
    const would = panel.getByTestId('pre-liquidation-stop-would');
    await expect(would).toHaveText(new RegExp(`^Closes ${esc(SIZE)} ${BTC} when ${esc(venue.name)}’s mark reaches \\d+\\.$`));
    const trigger = /reaches (\d+)\.$/.exec(await would.innerText())[1];
    const tick = toUnits(market.tickSize);
    expect(toUnits(trigger) % tick).toBe(0n);
    // Ratio at or under the level at the trigger (the margin with its result at least maintenance ÷ level) ...
    const atOrUnder = (price) => equityAt(p, price) * toUnits(STOP_LEVEL) >= maintenance * 100n * 10n ** 18n;
    expect(atOrUnder(trigger), `the ratio at ${trigger} has passed ${STOP_LEVEL}%`).toBe(true);
    // ... and past it one tick further down: no later tick would still be in time.
    expect(atOrUnder(fromUnits(toUnits(trigger) - tick)), `one tick below ${trigger} the ratio is still ${STOP_LEVEL}% or under`).toBe(
      false,
    );
    // A long's stop lies between the venue's liquidation price and its mark now.
    expect(toUnits(trigger)).toBeGreaterThan(toUnits(p.liquidationPrice.value));
    expect(toUnits(trigger)).toBeLessThan(toUnits(p.markPrice));

    // Every order on the venue carries our builder fee, which this account hasn't approved: the panel says so, and Set
    // stop asks for that one-time approval first (checked in the sheet), then the wallet signs the close order.
    await expect(panel.getByTestId('pre-liquidation-stop-approve')).toContainText(
      `Your account on ${venue.name} hasn’t approved our builder fee of`,
    );
    const asked = signatures(wallet);
    await set.click();
    await continueInWallet(page);
    await expect(panel.getByTestId('pre-liquidation-stop-said')).toHaveText(
      `Set: ${venue.name} holds the close order at mark ${trigger}.`,
      {
        timeout: 20_000,
      },
    );
    // The approval and one close order, each signed once by the person's wallet and sent once.
    expect(signatures(wallet)).toBe(asked + 2);
    const prepared = door.of('prepare');
    expect(prepared).toHaveLength(1);
    expect(prepared[0].body.intent).toMatchObject({ kind: 'approve_builder_fee' });
    const created = door.of('protections');
    expect(created).toHaveLength(1);
    expect(created[0].body).toMatchObject({
      owner: s.owner,
      symbol: BTC,
      kind: 'stop_loss',
      side: 'sell',
      quantity: SIZE,
      triggerPrice: trigger,
      triggerSource: 'mark',
    });
    stopId = created[0].body.clientOrderId;
    expect(stopId).toMatch(/^pls-5000-/);
    expect(door.of('submit')).toHaveLength(2);
    // On the venue: one reduce-only sell of the whole position, waiting on the mark at that price.
    const resting = await triggersOn(s.owner);
    expect(resting).toHaveLength(1);
    expect(resting[0]).toMatchObject({ side: 'sell', reduceOnly: true, trigger: { role: 'stop_loss', source: 'mark', state: 'waiting' } });
    expect(same(resting[0].trigger.price, trigger)).toBe(true);
    expect(same(resting[0].amount, (await positionOn(venue, s.owner)).size)).toBe(true);

    // Shown on the position: its row, and the panel read back from the venue's own order.
    await expect(row.getByTestId('pre-liquidation-stop')).toHaveText(`Stop ${STOP_LEVEL}% · close at ${trigger}`, { timeout: 20_000 });
    await expect(current).toContainText(
      `Closes at margin ratio ${STOP_LEVEL}%: close order at mark ${trigger} for ${SIZE}, resting on ${venue.name}.`,
    );
    // The position is still open: the stop waits.
    expect(same((await positionOn(venue, s.owner)).size, SIZE)).toBe(true);
    await stepPicture();

    // A second stop is refused while one rests; the person removes this one, signed once, and the venue holds none.
    await expect(panel).toContainText('A pre-liquidation stop already rests on this position. Remove it first, then set the new level.');
    await expect(box).toHaveCount(0);
    await panel.getByRole('button', { name: 'Remove stop', exact: true }).click();
    await continueInWallet(page);
    await expect(panel.getByTestId('pre-liquidation-stop-said')).toHaveText(`Removed: ${venue.name} cancelled the close order.`, {
      timeout: 20_000,
    });
    expect(signatures(wallet)).toBe(asked + 3);
    expect(await triggersOn(s.owner)).toEqual([]);
    await expect(row.getByTestId('pre-liquidation-stop')).toHaveCount(0, { timeout: 20_000 });
    await expect(current).toContainText('No pre-liquidation stop set.');
    await ledgerUntouched(s);
  } finally {
    // A stop left resting would close the position when #6 moves the mark: cancelled straight on the venue.
    if (stopId && (await triggersOn(s.owner)).length > 0)
      await signedOnVenue(venue, key, { kind: 'cancel_order', symbol: BTC, clientOrderKey: `protection:${s.owner}:stop_loss:${stopId}` });
    await venueAt('/test/market-triggers', { symbol: BTC, sources: [] });
  }
});

// ── #6 and #7: margin and liquidation-risk alerts, and the Margin calls tab ──

const RATIO_LEVEL = '40';
const ONE = 10n ** 18n;
/** The venue's maintenance requirement for the position, as it publishes it. */
const maintenanceOf = (p) => {
  expect(p.maintenanceMargin?.known, 'the TEST venue publishes a maintenance requirement on BTC-PERP').toBe(true);
  return p.maintenanceMargin.value;
};
/** The margin ratio in percent as svc-trade states it: maintenance × 100 over the margin with its result, floored. */
const ratioOf = (maintenance, marginWithResult) => fromUnits((toUnits(maintenance) * 100n * ONE) / toUnits(marginWithResult));
/** What a margin call asks: the margin that brings the ratio back to `level` percent, rounded up, less what there is. */
const askedFor = (maintenance, level, marginWithResult) => {
  const num = toUnits(maintenance) * 100n * ONE;
  const den = toUnits(level);
  return fromUnits((num + den - 1n) / den - toUnits(marginWithResult));
};
const ALERT_TITLE = { margin: `Margin alert: ${BTC}`, margin_call: `Margin call: ${BTC}`, liquidation: `Liquidation alert: ${BTC}` };

test(`${J} #6 receives margin and liquidation-risk alerts: one alert per crossing; with no risk levels set the toggle says "set your risk levels" and the liquidation alert still fires`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(600_000);
  const s = state();
  const venue = await venueNow();
  await openVenueRoom(page, s, ROOM);
  const start = await positionOn(venue, s.owner);
  const markBefore = start.markPrice;
  const maintenance = maintenanceOf(start);
  /** Each crossing the person should be told of, with the venue's figures at it and when it happened. */
  const crossings = [];
  try {
    const panel = await openMargin(page, venue);
    const ra = panel.getByTestId('risk-alerts-panel');
    await expect(ra).toContainText(`Risk alerts on ${BTC}`);
    const toggle = ra.getByTestId('risk-alerts-toggle');
    const sw = toggle.getByRole('switch', { name: 'Risk alerts', exact: true });
    const said = ra.locator('[data-line="ra-state"]');
    await expect(said).toHaveText('Off.', { timeout: 20_000 });
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    // The figures it watches are the venue's own.
    await expect(ra.locator('[data-line="ra-margin"]')).toHaveText(withResult(start));
    await expect(ra.locator('[data-line="ra-ratio"]')).toHaveText(`${ratioOf(maintenance, withResult(start))}%`);
    const rows = ra.getByTestId('risk-alerts').locator('tbody tr');

    /** Moves the margin with its result to `target`, and waits for our engine to have judged it (its row, or re-armed). */
    const moveTo = async (target, expectRow) => {
      const before = Date.now();
      await marginWithResultTo(venue, s.owner, target);
      if (expectRow) {
        crossings.push({ ...expectRow, marginWithResult: target, from: before });
        await expect(rows).toHaveCount(crossings.length, { timeout: 30_000 });
        crossings.at(-1).to = Date.now();
      }
    };

    // With no risk levels set, the toggle turned on says to set them, and the liquidation alert still fires.
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
    await expect(toggle).toContainText('set your risk levels');
    await expect(said).toHaveText(
      'On, with no risk levels: set your risk levels for margin alerts and margin calls. The liquidation alert still goes out at 100%.',
    );
    await expect(toggle).toHaveAttribute('data-armed-liquidation', 'true');

    // Crossing 1: the ratio reaches 100%, the venue's own maintenance requirement. One liquidation alert.
    const past = fromUnits(toUnits(maintenance) - toUnits('0.5'));
    await moveTo(past, { kind: 'liquidation', level: '100' });
    await expect(rows.first()).toHaveAttribute('data-kind', 'liquidation');
    await expect(toggle).toHaveAttribute('data-armed-liquidation', 'false', { timeout: 20_000 });
    // Further past it: the same crossing, nothing more.
    await moveTo(fromUnits(toUnits(maintenance) - toUnits('1')));
    // Back on the safe side re-arms it (our engine has judged the margin since, and sent nothing for it).
    await moveTo(withResult(start));
    await expect(toggle).toHaveAttribute('data-armed-liquidation', 'true', { timeout: 20_000 });
    await expect(rows).toHaveCount(1);
    // Crossing 2: a second fall is a second alert.
    await moveTo(past, { kind: 'liquidation', level: '100' });

    // The person sets both risk levels; the alerts stay on.
    await moveTo(withResult(start));
    await expect(toggle).toHaveAttribute('data-armed-liquidation', 'true', { timeout: 20_000 });
    const marginLevel = fromUnits(toUnits(withResult(start)) - toUnits('20'));
    await ra.getByRole('textbox', { name: 'Margin level for a margin alert (USDC)', exact: true }).fill(marginLevel);
    await ra.getByRole('textbox', { name: 'Margin ratio level for a margin call (%)', exact: true }).fill(RATIO_LEVEL);
    await ra.getByRole('button', { name: 'Save risk levels', exact: true }).click();
    await expect(ra.getByTestId('risk-alerts-said')).toHaveText('Saved.', { timeout: 20_000 });
    await expect(said).toHaveText(`On: margin alert at ${marginLevel} USDC, margin call at ${RATIO_LEVEL}%, liquidation alert at 100%.`);
    await expect(toggle).not.toContainText('set your risk levels');

    // Crossing 3: the margin falls to the margin level: one margin alert.
    await moveTo(fromUnits(toUnits(marginLevel) - toUnits('1')), { kind: 'margin', level: marginLevel });
    await expect(toggle).toHaveAttribute('data-armed-margin', 'false', { timeout: 20_000 });
    // Crossing 4: the ratio rises to 40%: one margin call; the margin alert is the same crossing, so not sent again.
    const at40 = toUnits(askedFor(maintenance, RATIO_LEVEL, '0'));
    const callAt = fromUnits(at40 - toUnits('0.25'));
    await moveTo(callAt, { kind: 'margin_call', level: RATIO_LEVEL });
    await expect(rows.first()).toHaveAttribute('data-kind', 'margin_call');
    await expect(toggle).toHaveAttribute('data-armed-call', 'false', { timeout: 20_000 });
    await expect(rows).toHaveCount(4);
    run.write({ crossings });

    // Each alert in the person's inbox, once, in words naming the venue's figures at the crossing.
    await page.goto('/notifications');
    const inbox = page.getByTestId('nf-row');
    for (const kind of ['margin', 'margin_call', 'liquidation'])
      await expect(inbox.filter({ hasText: ALERT_TITLE[kind] })).toHaveCount(crossings.filter((c) => c.kind === kind).length, {
        timeout: 30_000,
      });
    const ratioPast = ratioOf(maintenance, past);
    await expect(inbox.filter({ hasText: ALERT_TITLE.liquidation }).first()).toContainText(
      `Your ${BTC} margin ratio reached ${ratioPast}%: at 100% the venue liquidates the position. Add ${askedFor(maintenance, '100', past)} USDC of margin to bring it back to 100%.`,
    );
    await expect(inbox.filter({ hasText: ALERT_TITLE.margin })).toContainText(
      `The margin on your ${BTC} position, with its unrealised result, fell to ${fromUnits(toUnits(marginLevel) - toUnits('1'))} USDC, at or below your level of ${marginLevel} USDC.`,
    );
    await expect(inbox.filter({ hasText: ALERT_TITLE.margin_call })).toContainText(
      `Your ${BTC} margin ratio reached ${ratioOf(maintenance, callAt)}%, at or above your level of ${RATIO_LEVEL}%. Add ${askedFor(maintenance, RATIO_LEVEL, callAt)} USDC of margin to bring it back to ${RATIO_LEVEL}%.`,
    );
    await stepPicture();
    await ledgerUntouched(s);
  } finally {
    await venueAt('/test/set-mark', { symbol: BTC, price: markBefore });
  }
});

test(`${J} #7 opens the Margin calls tab: the margin call with its time and what was asked`, async ({ page, stepPicture }) => {
  test.setTimeout(300_000);
  const s = state();
  const { crossings } = run.read();
  if (!crossings?.length) throw new Error(`${J} #6 sent no alerts, so there is no margin call to open`);
  const venue = await venueNow();
  const maintenance = maintenanceOf(await positionOn(venue, s.owner));
  await openVenueRoom(page, s, ROOM);
  const tab = page.getByRole('tab', { name: 'Margin calls', exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const room = page.getByTestId('margin-calls-room');
  await expect(room).toContainText(`Margin calls on ${venue.name}`);
  // Margin calls and liquidation alerts, newest first; margin alerts stay in each position's Margin panel.
  const calls = crossings.filter((c) => c.kind !== 'margin').reverse();
  const rows = room.getByTestId('margin-calls').locator('tbody tr');
  await expect(rows).toHaveCount(calls.length, { timeout: 30_000 });
  for (const [i, c] of calls.entries()) {
    const row = rows.nth(i);
    await expect(row).toHaveAttribute('data-kind', c.kind);
    await expect(row.locator('[data-cell="market"]')).toHaveText(BTC);
    await expect(row.locator('[data-cell="alert"]')).toHaveText(
      c.kind === 'margin_call' ? `Margin call at ${c.level}%` : `Liquidation alert at ${c.level}%`,
    );
    await expect(row.locator('[data-cell="margin"]')).toHaveText(c.marginWithResult);
    await expect(row.locator('[data-cell="ratio"]')).toHaveText(`${ratioOf(maintenance, c.marginWithResult)}%`);
    // What was asked: the margin that brings the ratio back to the level, from the venue's figures at the crossing.
    await expect(row.locator('[data-cell="asked"]')).toHaveText(
      `Add ${askedFor(maintenance, c.level, c.marginWithResult)} USDC to bring the margin ratio back to ${c.level}%`,
    );
    // Its time: the instant our engine sent it, between the fall and the alert appearing, shown to the second.
    const time = row.locator('[data-cell="time"] time');
    const at = Date.parse(await time.getAttribute('datetime'));
    expect(at).toBeGreaterThanOrEqual(c.from - 1000);
    expect(at).toBeLessThanOrEqual(c.to + 1000);
    await expect(time).toHaveText(/\d{1,2}:\d{2}:\d{2}/);
  }
  await stepPicture();
  await ledgerUntouched(s);
});
