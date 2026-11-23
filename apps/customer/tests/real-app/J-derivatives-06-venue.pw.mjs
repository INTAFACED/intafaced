// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { fromUnits, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { doorCalls, ledgerUntouched, ledgerView, openVenueRoom, signedOnVenue, venueAt, venueNow, walletOwner } from './venue-door.mjs';
import { continueInWallet, venueBalance, venueForThisFile, venueRecord } from './venue.mjs';

// J-derivatives-06's venue steps, "I watch and top up the margin on an isolated position", on the person's own venue
// account (the launch money model: the venue holds the position and its margin, the ledger posts nothing), in the running
// app against the stack's TEST venue simulator (packages/venue-sim). One test per step, titled "J-derivatives-06 #<n>",
// run in order on one TEST account; #4 to #7 are not here yet (each lands with its own build), and J-derivatives-06.pw.mjs
// holds the custodial layer's own checks of #1 and #2 (not the steps' proof) and #5, on our own futures engine.
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
 * The TEST venue's own record for the person's account (`/positions`, `/account-summary`, `/isolated-margin`), read
 * straight from the venue (venue.mjs `venueRecord`), never through our door.
 */
const record = async (owner, path, extra = {}) => (await venueRecord(owner, path, extra)).value;
const positionOn = async (owner) => (await record(owner, '/positions')).find((p) => p.symbol === BTC);
/** The venue's own USDC balance of the account: free, locked and total. */
const usdcOn = (owner) => venueBalance(owner, 'USDC');

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
    const p = await positionOn(owner);
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
    const summary = await record(s.owner, '/account-summary');
    expect(summary.asset).toBe('USDC');
    expect(await metric('equity')).toBe(summary.equity);
    expect(await metric('free')).toBe(summary.free);
    expect(await metric('used')).toBe(summary.usedMargin);
    expect(await metric('maintenance')).toBe(summary.maintenanceMargin);
    expect(summary.marginRatio.known).toBe(true);
    expect(await metric('ratio')).toBe(percent(summary.marginRatio.value));
    // The venue's summary is its own record of this account: free is its free USDC, used margin the position's margin,
    // maintenance the position's, and equity all its USDC with the position's unrealised result.
    const [p, usdc] = await Promise.all([positionOn(s.owner), usdcOn(s.owner)]);
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
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  const wallet = await openVenueRoom(page, s, ROOM);
  const door = doorCalls(page);
  const before = await positionOn(s.owner);
  const usdcBefore = await usdcOn(s.owner);
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
  const after = await positionOn(s.owner);
  const usdcAfter = await usdcOn(s.owner);
  expect(after.margin).toBe(fromUnits(toUnits(before.margin) + toUnits(ADD)));
  expect(usdcAfter.free).toBe(fromUnits(toUnits(usdcBefore.free) - toUnits(ADD)));
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
  // And the free balance the panel shows is the venue's own after the change.
  await expect(async () => expect(same(await line(panel, 'free'), usdcAfter.free)).toBe(true)).toPass({ timeout: 20_000 });
  // The step's picture: the margin panel with the venue's margin and liquidation price after the change.
  await stepPicture();
  await ledgerUntouched(s);
});

test(`${J} #3 removes margin: allowed down to the venue's limit; otherwise refused in words`, async ({ page }) => {
  test.setTimeout(300_000);
  const s = state();
  const venue = await venueNow();
  const wallet = await openVenueRoom(page, s, ROOM);
  const door = doorCalls(page);
  const limit = await record(s.owner, '/isolated-margin', { symbol: BTC });
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
  const before = await positionOn(s.owner);
  const usdcBefore = await usdcOn(s.owner);
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
  expect(await positionOn(s.owner)).toEqual(before);
  expect(await usdcOn(s.owner)).toEqual(usdcBefore);

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
  const after = await positionOn(s.owner);
  expect(after.margin).toBe(limit.minimumMargin);
  expect((await usdcOn(s.owner)).free).toBe(fromUnits(toUnits(usdcBefore.free) + toUnits(limit.removable)));
  const now = await record(s.owner, '/isolated-margin', { symbol: BTC });
  expect(toUnits(now.removable)).toBe(0n);
  await expect(panel.locator('[data-line="removable"]')).toHaveText(now.removable, { timeout: 20_000 });
  await expect(panel.getByTestId('position-margin-after')).toHaveText(
    `After the change, from ${venue.name}: margin ${after.margin}, liquidation price ${after.liquidationPrice.value}.`,
  );
  await ledgerUntouched(s);
});
