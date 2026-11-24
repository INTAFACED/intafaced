// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fromUnits, journeyState, restartService, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  otherTraderKey,
  otherTraderRun,
  sameDecimal,
  testDeposit,
  testVenue,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
  venueRunState,
  walletDoorAct,
} from './venue.mjs';

// J-derivatives-02 on the person's own venue account (launch money model: the venue holds the margin and sets the
// risk rules), in the running app against the stack's TEST venue simulator. All eight steps (#1 to #8) are proven here
// on the person's own venue account:
//   #1 standalone margin and P&L calculator with named formulas, matching the venue's own preview
//   #2 published margin tiers and maintenance rates (and "not published by this venue" where unpublished)
//   #3 accepted collateral with published haircuts; nothing else counts toward buying power
//   #4 refusal naming the venue when an unaccepted asset is chosen as margin; buying power unchanged
//   #5 order above the cap (split offered and signed once), price outside the band (refused, then moved to the edge),
//      and a blank slippage cap refusing market opens
//   #6 adding size across a tier threshold requires an explicit confirm naming the new tier and its leverage
//   #7 opening beyond the venue's open-interest cap refused with the venue's reason and room left
//   #8 previewing while the venue's dynamic price band is wider than usual; outside the wider band refuses
// The contract is the TEST perpetual XRSK-PERP (packages/venue-sim/src/http-server.ts), which only this file trades;
// BTC-PERP is the TEST perpetual whose venue publishes no tiers. One test per step, titled "J-derivatives-02 #<n>".
// Every figure is TEST. The door is on for this file only.
const J = 'J-derivatives-02';
const SYMBOL = 'XRSK-PERP';
const DESK = `/trade/futures?symbol=${SYMBOL}`;
const UNPUBLISHED = 'BTC-PERP';
const START_USDC = '20000';
/** The TEST venue's default limits on XRSK-PERP (packages/venue-sim/src/http-server.ts), restored in finally. */
const DEFAULT_MAX_ORDER_NOTIONAL = '1000000';
const OI_CAP = '1000';
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

async function desk(page, path = DESK, symbol = SYMBOL) {
  const s = venueRunState(run, J);
  const wallet = await openVenueDesk(page, s.account, path, s.walletKey);
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(symbol, { timeout: 20_000 });
  return { ...s, wallet, owner: wallet.address };
}

/** The venue's own market record for `symbol`, read straight from the TEST venue for `owner`. */
async function venueMarket(owner, symbol = SYMBOL) {
  const m = (await venueRecord(owner, '/markets')).value.find((x) => x.symbol === symbol);
  expect(m, `${symbol} is not listed on the TEST venue`).toBeTruthy();
  return m;
}

/** Every call the page makes that could send, sign or hold something on the venue. */
function venueWrites(page) {
  const sent = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/v1\/venue\/(prepare|submit|preview|route-preview)/.test(r.url())) sent.push(r.url());
  });
  return sent;
}

/** The wallet's signature prompts so far (typed data is the only thing a venue action is signed as). */
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;

/** The figures that say nothing moved: balances, open orders and positions, as the venue records them. */
async function venueState(owner) {
  return {
    balances: (await venueRecord(owner, '/balances')).value,
    orders: (await venueRecord(owner, '/open-orders')).value,
    positions: (await venueRecord(owner, '/positions')).value,
  };
}

/** TEST setup, not a step (the Starts line): a verified account, wallet, TEST USDC + TEST BTC, and 5x leverage on XRSK-PERP. */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'vrisk');
    await verify(page, account);
    const walletKey = testWalletKey();
    const key = privateKeyToAccount(walletKey);
    const owner = key.address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', START_USDC, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    expect(await testDeposit(owner, 'BTC', '0.01', `84532:0x${randomBytes(32).toString('hex')}:1`)).toBe(true);
    await walletDoorAct(await api(account), key, {
      intent: { kind: 'update_leverage', symbol: SYMBOL, leverageBps: 50_000, marginMode: 'isolated' },
      actionKey: `leverage:${owner}:${SYMBOL}:5x:${randomBytes(4).toString('hex')}`,
    });
    run.reset({ account, walletKey });
  } finally {
    await page.close();
  }
}

/** Approve our builder fee inside a review sheet if this wallet has not signed it yet. */
async function approveBuilderIfNeeded(page, sheet) {
  const approval = sheet.locator('[data-line="builder-approval"]');
  if ((await approval.count()) > 0 && !/Signed, up to/.test(await approval.innerText())) {
    await sheet.getByRole('button', { name: 'Approve our builder fee in your wallet', exact: true }).click();
    await continueInWallet(page);
    await expect(approval).toHaveText(/Signed, up to/, { timeout: 15_000 });
  }
}

const percent = (rate) => `${fromUnits(toUnits(rate) * 100n)}%`;
const grouped = (x) => {
  const [whole, fraction] = String(x).split('.');
  const w = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${w}.${fraction}` : w;
};
const plain = (text) => text.replace(/,/g, '').trim();

test(`${J} #1 opens the standalone margin and P&L calculator: margin, liquidation price and P&L for typed inputs with the formula named`, async ({
  page,
  browser,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  await startsLine(browser);
  const { account, owner, wallet } = await desk(page);
  const { displayName } = await venueInfo();
  const m = await venueMarket(owner);
  const me = await api(account);
  const statusRes = await me.get('/api/v1/venue/status');
  expect(statusRes.status, JSON.stringify(statusRes.body)).toBe(200);
  const builderFeeBps = statusRes.body.builder?.feeBps ?? '0';

  // Read the venue's own preview for 10 XRSK long at 100 USDC (5x leverage) directly from the TEST venue.
  const venuePreview = await venueRecord(owner, '/preview', {
    intent: {
      kind: 'place_order',
      symbol: SYMBOL,
      side: 'buy',
      type: 'limit',
      amount: '10',
      price: '100',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `calc-ref:${randomBytes(4).toString('hex')}`,
      builderFee: null,
    },
  });
  expect(venuePreview.value.perpetual.initialMargin.known).toBe(true);
  expect(venuePreview.value.perpetual.liquidationPrice.known).toBe(true);

  const before = await venueState(owner);
  const signedBefore = signatures(wallet);
  const sent = venueWrites(page);

  // Open the Calculator tab inside the venue blotter and compute for typed inputs: 10 XRSK, entry 100, exit 110, 5x.
  await page.getByTestId('venue-blotter').getByRole('button', { name: 'Calculator', exact: true }).click();
  const panel = page.getByTestId('venue-calculator');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Nothing is placed, held or saved.');
  await panel.getByLabel('Size', { exact: true }).fill('10');
  await panel.getByLabel('Entry price', { exact: true }).fill('100');
  await panel.getByLabel('Exit price (optional)', { exact: true }).fill('110');
  await panel.getByLabel('Leverage', { exact: true }).fill('5');
  await panel.getByRole('button', { name: 'Calculate', exact: true }).click();

  const results = panel.getByTestId('venue-calculator-results');
  await expect(results).toBeVisible();
  const valueOf = async (label) => {
    const row = results.locator('[data-slot="key-value-row"]').filter({ has: page.getByText(label, { exact: true }) });
    await expect(row).toHaveCount(1);
    return (await row.locator('dd').innerText()).trim();
  };

  // Initial margin and liquidation price match the venue's own preview; P&L, ROE, maintenance and net P&L are exact.
  const shownMargin = await valueOf('Initial margin');
  const shownLiq = await valueOf('Liquidation price');
  expect(sameDecimal(shownMargin.replace(/ USDC$/, ''), venuePreview.value.perpetual.initialMargin.value)).toBe(true);
  expect(sameDecimal(shownLiq.replace(/ USDC$/, ''), venuePreview.value.perpetual.liquidationPrice.value)).toBe(true);
  expect(await valueOf('Notional')).toBe('1,000 USDC');
  expect(await valueOf('Margin tier')).toBe('Tier 1 (up to 20x, maintenance 2.5%)');
  expect(await valueOf('Maintenance margin')).toBe('25 USDC');
  expect(await valueOf('P&L at exit')).toBe('100 USDC');
  expect(await valueOf('Return on margin')).toBe('50%');
  // Estimated fees: (1000 + 1100) * (takerFeeBps + builderFeeBps) / 10000.
  const rateBps = toUnits(m.takerFeeBps.value) + toUnits(builderFeeBps);
  const expectedFees = (toUnits('2100') * rateBps) / 10_000n / 10n ** 18n;
  const shownFees = (await valueOf('Estimated fees (open and close)')).replace(/ USDC$/, '');
  const shownNet = (await valueOf('P&L after fees')).replace(/ USDC$/, '');
  expect(sameDecimal(shownFees, fromUnits(expectedFees))).toBe(true);
  expect(sameDecimal(shownNet, fromUnits(toUnits('100') - expectedFees))).toBe(true);

  // Every formula is named on screen.
  const formulas = panel.getByTestId('venue-calculator-formulas');
  await expect(formulas).toContainText('Notional = size × entry price');
  await expect(formulas).toContainText('Initial margin = size × entry price ÷ leverage');
  await expect(formulas).toContainText(`Maintenance margin = notional × tier 1 maintenance rate (2.5%, as ${displayName} publishes it)`);
  await expect(formulas).toContainText('Liquidation price (long) = entry price − (initial margin − maintenance margin) ÷ size');
  await expect(formulas).toContainText('P&L = size × (exit price − entry price) for a long');
  await expect(formulas).toContainText('Return on margin = P&L ÷ initial margin × 100%');
  await expect(formulas).toContainText(`venue taker rate ${m.takerFeeBps.value} bps`);

  // Step picture while the calculator figures and named formulas are on screen.
  await stepPicture();

  // Leverage above the tier cap warns naming the tier and its cap (60 * 100 = 6000 USDC -> Tier 2 max 10x; typing 15x).
  await panel.getByLabel('Size', { exact: true }).fill('60');
  await panel.getByLabel('Leverage', { exact: true }).fill('15');
  await panel.getByRole('button', { name: 'Calculate', exact: true }).click();
  await expect(panel.getByTestId('venue-calculator-warning')).toContainText(
    `Leverage 15x is above ${displayName}’s tier 2 cap of 10x for this notional on ${SYMBOL}.`,
  );

  // Unpublished tiers (BTC-PERP): maintenance margin and liquidation price say "not published", never invented.
  await page
    .getByTestId('venue-contract-list')
    .getByRole('button', { name: `${UNPUBLISHED} · ${displayName}`, exact: true })
    .click();
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(UNPUBLISHED);
  await panel.getByLabel('Size', { exact: true }).fill('0.1');
  await panel.getByLabel('Entry price', { exact: true }).fill('60000');
  await panel.getByLabel('Leverage', { exact: true }).fill('5');
  await panel.getByRole('button', { name: 'Calculate', exact: true }).click();
  expect(await valueOf('Margin tier')).toBe(`not published by ${displayName}`);
  expect(await valueOf('Maintenance margin')).toBe(`not published by ${displayName}`);
  expect(await valueOf('Liquidation price')).toBe(`not published by ${displayName}`);

  // Nothing sent, signed, or held on the venue.
  expect(sent).toEqual([]);
  expect(signatures(wallet)).toBe(signedBefore);
  expect(await venueState(owner)).toEqual(before);
});

test(`${J} #2 reads the tier table: the venue's published tiers and maintenance rates, or "not published by this venue"; nothing invented`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const { owner } = await desk(page);
  const { displayName } = await venueInfo();
  const sent = venueWrites(page);

  // The venue's own record of the contract's tiers.
  const m = await venueMarket(owner);
  expect(m.marginTiers.known, JSON.stringify(m.marginTiers)).toBe(true);
  const tiers = m.marginTiers.value;
  expect(tiers.length).toBeGreaterThan(1);

  // The desk's tier table is those tiers, row for row: where each starts, its most leverage and its maintenance rate.
  const panel = page.getByTestId('venue-tiers');
  await expect(panel.getByRole('heading', { level: 2 })).toContainText(`Margin tiers on ${displayName}`);
  await expect(panel.getByTestId('venue-test').first()).toHaveText('TEST');
  const table = panel.getByRole('region', { name: `Margin tiers ${SYMBOL}`, exact: true }).getByRole('table');
  await expect(table).toBeVisible();
  const rows = table.locator('tr[data-tier]');
  await expect(rows).toHaveCount(tiers.length);
  for (const [i, tier] of tiers.entries()) {
    const row = rows.nth(i);
    await expect(row).toHaveAttribute('data-tier', String(i + 1));
    await expect(row.locator('[data-cell="from"]')).toHaveText(`${grouped(tier.fromNotional)} ${m.quoteAsset}`);
    await expect(row.locator('[data-cell="leverage"]')).toHaveText(`${tier.maxLeverageBps / 10_000}x`);
    await expect(row.locator('[data-cell="maintenance"]')).toHaveText(percent(tier.maintenanceRate));
  }
  await expect(panel).toContainText(`As ${displayName} publishes them`);
  await stepPicture();

  // A contract whose venue publishes no tiers: "not published", and no table of ours in its place.
  const btc = await venueMarket(owner, UNPUBLISHED);
  expect(btc.marginTiers).toEqual({ known: false });
  await page
    .getByTestId('venue-contract-list')
    .getByRole('button', { name: `${UNPUBLISHED} · ${displayName}`, exact: true })
    .click();
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(UNPUBLISHED);
  await expect(panel.getByTestId('venue-tiers-unpublished')).toHaveText(
    `Margin tiers not published by ${displayName}. Nothing is shown in their place.`,
  );
  await expect(panel.getByRole('table')).toHaveCount(0);
  // Reading the tiers sends, signs and holds nothing.
  expect(sent).toEqual([]);
});

test(`${J} #3 opens Collateral: what the venue accepts as margin with its haircut; nothing else counts toward buying power`, async ({
  page,
  stepPicture,
}) => {
  const { owner } = await desk(page);
  const { displayName } = await venueInfo();
  const sent = venueWrites(page);
  const m = await venueMarket(owner);
  expect(m.collateral.known, JSON.stringify(m.collateral)).toBe(true);
  const taken = m.collateral.value;
  const held = (await venueRecord(owner, '/balances')).value;
  // The person holds something the venue doesn't take here (#1's TEST BTC), so "nothing else counts" is tested.
  const others = held.filter((b) => !taken.some((c) => c.asset === b.asset) && toUnits(b.total) > 0n);
  expect(others.map((b) => b.asset)).toContain('BTC');

  const panel = page.getByTestId('venue-collateral');
  await expect(panel.getByRole('heading', { level: 2 })).toContainText(`What ${displayName} takes as margin`);
  const table = panel.getByRole('region', { name: `Margin ${displayName} takes on ${SYMBOL}`, exact: true }).getByRole('table');
  await expect(table.locator('tr[data-asset]')).toHaveCount(taken.length);
  let power = 0n;
  for (const c of taken) {
    const row = table.locator(`tr[data-asset="${c.asset}"]`);
    const bal = await venueBalance(owner, c.asset);
    // Each accepted asset with the haircut the venue publishes, and the person's free balance as the venue holds it.
    await expect(row.locator('[data-cell="haircut"]')).toHaveText(
      c.haircut.known ? percent(c.haircut.value) : `not published by ${displayName}`,
    );
    await expect.poll(async () => plain(await row.locator('[data-cell="free"]').innerText()), { timeout: 20_000 }).toBe(bal.free);
    expect(c.haircut.known, `${c.asset}'s haircut is published, so its buying power is known`).toBe(true);
    const counts = (toUnits(bal.free) * (toUnits('1') - toUnits(c.haircut.value))) / toUnits('1');
    await expect.poll(async () => sameDecimal(plain(await row.locator('[data-cell="counts"]').innerText()), fromUnits(counts))).toBe(true);
    power += counts;
  }
  // Buying power is what the venue takes, less its haircut: the TEST BTC adds nothing.
  const shown = page.getByTestId('venue-buying-power-value');
  await expect(shown).toHaveAttribute('data-value', fromUnits(power));
  await expect(shown).toHaveText(`${grouped(fromUnits(power))} ${m.quoteAsset}`);
  const notTaken = panel.getByRole('list', { name: `Not taken as margin by ${displayName}`, exact: true });
  await expect(notTaken.getByRole('listitem')).toHaveCount(others.length);
  for (const b of others) {
    await expect(notTaken.locator(`li[data-asset="${b.asset}"]`)).toHaveText(
      `${b.asset}: ${displayName} does not take it as margin on ${SYMBOL}, so it adds nothing to buying power`,
    );
  }
  await stepPicture();
  expect(sent).toEqual([]);
  run.write({ power: fromUnits(power) });
});

test(`${J} #4 selects an asset the venue doesn't accept as margin: refused naming the venue; buying power unchanged`, async ({
  page,
  stepPicture,
}) => {
  const s = venueRunState(run, J);
  if (!s.power) throw new Error(`${J} #3 read no buying power, so this step has none to compare`);
  const { owner, wallet } = await desk(page);
  const { displayName } = await venueInfo();
  const m = await venueMarket(owner);
  const takenAssets = m.collateral.value.map((c) => c.asset);
  expect(takenAssets).not.toContain('BTC');
  const before = await venueState(owner);
  const signedBefore = wallet.requests.length;
  const sent = venueWrites(page);

  const ticket = page.getByTestId('venue-ticket');
  await ticket.getByRole('button', { name: 'Long', exact: true }).click();
  await ticket.getByRole('button', { name: 'Limit', exact: true }).click();
  await ticket.getByRole('textbox', { name: `Size (${m.baseAsset})`, exact: true }).fill('1');
  await ticket.getByRole('textbox', { name: 'Price', exact: true }).fill('100');
  await ticket.getByRole('combobox', { name: 'Margin asset', exact: true }).selectOption('BTC');
  await ticket.getByRole('button', { name: 'Review long', exact: true }).click();
  await expect(ticket.getByRole('alert')).toHaveText(
    `${displayName} does not take BTC as margin on ${SYMBOL}: it takes ${takenAssets.join(', ')}. Nothing was sent, and buying power is unchanged.`,
  );
  await expect(page.getByTestId('venue-review')).toHaveCount(0);
  await stepPicture();

  // Nothing previewed, signed or sent, and the venue's record is as it was.
  expect(sent).toEqual([]);
  expect(wallet.requests.length).toBe(signedBefore);
  expect(await venueState(owner)).toEqual(before);
  // Buying power unchanged: the venue's free USDC is as #3 read it, and the desk shows the same figure.
  const usdc = await venueBalance(owner, 'USDC');
  expect(sameDecimal(usdc.free, s.power)).toBe(true);
  await expect(page.getByTestId('venue-buying-power-value')).toHaveAttribute('data-value', s.power);
});

test(`${J} #5 previews above the order cap and outside the price band: split offered and placed, price moved to band edge, blank slippage cap refuses market opens`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(360_000);
  const s = venueRunState(run, J);
  const me = await api(s.account);
  const { displayName } = await venueInfo();

  // Lower XRSK-PERP's maxOrderNotional to 2,000 USDC so a 30 XRSK order at 95 USDC (2,850 USDC) splits into 2 orders.
  const setCap = await testVenue('/test/market-limits', { symbol: SYMBOL, maxOrderNotional: '2000' });
  expect(setCap.status, JSON.stringify(setCap.body)).toBe(200);
  try {
    const { owner, wallet } = await desk(page);
    const m = await venueMarket(owner);
    expect(m.maxOrderNotional).toBe('2000');
    expect(m.priceBand).toMatchObject({
      known: true,
      value: { widthBps: '500', bandLow: '95', bandHigh: '105', widened: false },
    });

    const ticket = page.getByTestId('venue-ticket');
    await ticket.getByRole('button', { name: 'Long', exact: true }).click();
    await ticket.getByRole('button', { name: 'Limit', exact: true }).click();
    await expect(ticket.getByTestId('venue-price-band')).toContainText('95 to 105 USDC (±5%)');

    // Limit long 30 XRSK at 80 USDC: outside the 95-105 band AND above the 2,000 USDC order cap.
    const signedBefore = signatures(wallet);
    await ticket.getByRole('textbox', { name: `Size (${m.baseAsset})`, exact: true }).fill('30');
    await ticket.getByRole('textbox', { name: 'Price', exact: true }).fill('80');
    await ticket.getByRole('button', { name: 'Review long', exact: true }).click();

    // Both refusals shown; split button stays disabled while price is outside the band; nothing signed.
    const bandAlert = ticket.locator('[data-code="trade.venue.price_outside_venue_band"]');
    const capAlert = ticket.locator('[data-code="trade.venue.order_above_venue_max"]');
    await expect(bandAlert).toContainText(`Price 80 USDC is outside ${displayName}’s band of 95 to 105 USDC (±5%)`);
    await expect(capAlert).toContainText('2000 USDC');
    await expect(capAlert).toContainText('it can be placed as 2 orders');
    const splitRegion = ticket.getByTestId('venue-split-offer');
    await expect(splitRegion).toBeVisible();
    await expect(splitRegion.getByRole('button', { name: 'Place as 2 orders', exact: true })).toBeDisabled();
    expect(signatures(wallet)).toBe(signedBefore);

    // Switch ON price correction: price moves to the band's low edge (95 USDC), band refusal clears, split enables.
    await ticket.getByRole('switch', { name: 'Move a price outside the band to its edge', exact: true }).click();
    await ticket.getByRole('button', { name: 'Review long', exact: true }).click();
    await expect(ticket.getByTestId('venue-price-moved')).toContainText('80 moved to 95 USDC');
    await expect(bandAlert).toHaveCount(0);
    await expect(capAlert).toContainText('it can be placed as 2 orders');
    const splitBtn = splitRegion.getByRole('button', { name: 'Place as 2 orders', exact: true });
    await expect(splitBtn).toBeEnabled();
    await stepPicture();

    // Review and sign the 2-order split in one wallet signature.
    await splitBtn.click();
    const sheet = page.getByTestId('venue-split-review');
    await expect(sheet).toBeVisible({ timeout: 20_000 });
    await expect(sheet.locator('[data-line="split"]')).toContainText('2 orders within');
    await expect(sheet.locator('[data-line="split"]')).toContainText('15 XRSK, 15 XRSK');
    await expect(sheet.locator('[data-line="price-moved"]')).toContainText('80 moved to 95 USDC');
    await approveBuilderIfNeeded(page, sheet);

    const beforeSign = signatures(wallet);
    await sheet.getByRole('button', { name: 'Open long', exact: true }).click();
    await continueInWallet(page);
    await expect(ticket.getByTestId('venue-split-placed')).toBeVisible({ timeout: 20_000 });
    await expect(ticket.getByTestId('venue-split-placed').getByRole('heading')).toHaveText('Placed as 2 orders');
    await expect(ticket.getByTestId('venue-split-placed').getByRole('listitem')).toHaveCount(2);
    expect(signatures(wallet)).toBe(beforeSign + 1);

    // Both orders rest on the venue at 95 USDC, each within the 2,000 USDC cap, summing to 30 XRSK.
    const open = (await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === SYMBOL);
    expect(open, JSON.stringify(open)).toHaveLength(2);
    expect(open.reduce((sum, o) => sum + toUnits(o.amount), 0n)).toBe(toUnits('30'));
    for (const o of open) {
      expect(o).toMatchObject({ symbol: SYMBOL, side: 'buy', type: 'limit', status: 'open', price: '95' });
      expect((toUnits(o.amount) * toUnits(o.price)) / 10n ** 18n <= toUnits('2000')).toBe(true);
    }
    const lockedDuring = toUnits((await venueBalance(owner, 'USDC')).locked);
    expect(lockedDuring > 0n).toBe(true);

    // Cancel both split children from the Open orders tab so the account is clean for the rest of the step.
    await page.getByTestId('venue-blotter').getByRole('button', { name: 'Open orders', exact: true }).click();
    for (const o of open) {
      const row = page.getByTestId('venue-open-orders').locator(`tr[data-client-order-id="${o.venueClientOrderId}"]`);
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.getByRole('button', { name: 'Cancel', exact: true }).click();
      await continueInWallet(page);
      await expect(row).toHaveCount(0, { timeout: 20_000 });
    }
    await expect.poll(async () => (await venueRecord(owner, '/open-orders')).value.length, { timeout: 20_000 }).toBe(0);
    expect(sameDecimal((await venueBalance(owner, 'USDC')).locked, '0')).toBe(true);
  } finally {
    await testVenue('/test/market-limits', { symbol: SYMBOL, maxOrderNotional: DEFAULT_MAX_ORDER_NOTIONAL });
  }

  // Blank slippage cap: restart trade with LOCAL_STACK_TRADE_SLIPPAGE_CAP=off (keeping user venue ON), verify market
  // opens are refused on the ticket AND at /preview + /prepare with trade.slippage_cap_unset, sending nothing.
  const unsetBefore = await venueState(s.owner);
  try {
    await restartService('trade', { LOCAL_STACK_USER_VENUE: 'on', LOCAL_STACK_TRADE_SLIPPAGE_CAP: 'off' });
    const { owner, wallet } = await desk(page);
    const ticket = page.getByTestId('venue-ticket');
    await ticket.getByRole('button', { name: 'Long', exact: true }).click();
    await ticket.getByRole('button', { name: 'Market', exact: true }).click();
    await expect(ticket.getByTestId('venue-slippage-cap')).toHaveAttribute('data-code', 'trade.slippage_cap_unset', {
      timeout: 30_000,
    });
    const sigsBefore = signatures(wallet);
    await ticket.getByRole('textbox', { name: 'Size (XRSK)', exact: true }).fill('1');
    await ticket.getByRole('textbox', { name: 'Worst price (slippage limit)', exact: true }).fill('105');
    await ticket.getByRole('button', { name: 'Review long', exact: true }).click();
    await expect(ticket.locator('[data-code="trade.slippage_cap_unset"]').last()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('venue-review')).toHaveCount(0);
    expect(signatures(wallet)).toBe(sigsBefore);

    // Direct /preview and /prepare also refuse trade.slippage_cap_unset, locking nothing.
    const marketIntent = {
      kind: 'place_order',
      symbol: SYMBOL,
      side: 'buy',
      type: 'market',
      amount: '1',
      price: '105',
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: `order:${J.toLowerCase()}:slippage-unset:${randomBytes(4).toString('hex')}`,
      builderFee: null,
    };
    const prev = await me.post('/api/v1/venue/preview', { owner, intent: marketIntent });
    expect(prev.status, JSON.stringify(prev.body)).toBe(422);
    expect(prev.body.intafacedCode).toBe('trade.slippage_cap_unset');
    const prep = await me.post('/api/v1/venue/prepare', {
      owner,
      signer: { role: 'owner', address: owner },
      intent: marketIntent,
    });
    expect(prep.status, JSON.stringify(prep.body)).toBe(422);
    expect(prep.body.intafacedCode).toBe('trade.slippage_cap_unset');
    expect(await venueState(owner)).toEqual(unsetBefore);
  } finally {
    await restartService('trade', { LOCAL_STACK_USER_VENUE: 'on', LOCAL_STACK_TRADE_SLIPPAGE_CAP: undefined });
  }
});

test(`${J} #6 adds size that crosses a tier threshold: a confirm step names the new tier and its leverage`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  // Seed a counter-party TEST maker on XRSK-PERP so our Tier 1 open (30 XRSK = 3,000 USDC) and Tier 2 add
  // (+30 XRSK -> 60 XRSK = 6,000 USDC, crossing the 5,000 USDC Tier 2 bound) fill immediately at 100 USDC.
  const makerName = `jd2-tier-maker-${randomBytes(4).toString('hex')}`;
  const maker = otherTraderKey(makerName).address.toLowerCase();
  expect(await testDeposit(maker, 'USDC', '50000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  expect(
    await otherTraderRun(makerName, { kind: 'update_leverage', symbol: SYMBOL, leverageBps: 50_000, marginMode: 'isolated' }),
  ).toMatchObject({ accepted: true });

  const askKey = `order:maker:ask:${randomBytes(4).toString('hex')}`;
  const bidKey = `order:maker:bid:${randomBytes(4).toString('hex')}`;
  let bidPlaced = false;
  expect(
    await otherTraderRun(makerName, {
      kind: 'place_order',
      symbol: SYMBOL,
      side: 'sell',
      type: 'limit',
      amount: '100',
      price: '100',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: askKey,
      builderFee: null,
    }),
  ).toMatchObject({ accepted: true, order: { status: 'open' } });

  try {
    const { owner, wallet } = await desk(page);
    const ticket = page.getByTestId('venue-ticket');

    // First position: 30 XRSK at 100 USDC (3,000 USDC, inside Tier 1: 0 to 5,000). No tier confirm step.
    await ticket.getByRole('button', { name: 'Long', exact: true }).click();
    await ticket.getByRole('button', { name: 'Limit', exact: true }).click();
    await ticket.getByRole('textbox', { name: 'Size (XRSK)', exact: true }).fill('30');
    await ticket.getByRole('textbox', { name: 'Price', exact: true }).fill('100');
    await ticket.getByRole('button', { name: 'Review long', exact: true }).click();
    const sheet = page.getByTestId('venue-review');
    await expect(sheet).toBeVisible({ timeout: 20_000 });
    await expect(sheet.locator('[data-line="margin-tier"]')).toHaveText('Tier 1, maintenance 2.5%, max leverage 20x');
    await expect(sheet.getByTestId('venue-tier-confirm')).toHaveCount(0);
    await approveBuilderIfNeeded(page, sheet);
    await sheet.getByRole('button', { name: 'Open long', exact: true }).click();
    await continueInWallet(page);
    await expect(sheet.getByTestId('venue-outcome').last()).toContainText('Filled on the venue.', { timeout: 20_000 });
    await sheet.getByRole('button', { name: 'Back', exact: true }).click();
    await expect.poll(async () => (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === SYMBOL)?.size).toBe('30');

    // Add 30 XRSK at 100 USDC: combined 60 XRSK (6,000 USDC) crosses Tier 1 -> Tier 2 (5% maintenance, 10x cap).
    await ticket.getByRole('textbox', { name: 'Size (XRSK)', exact: true }).fill('30');
    await ticket.getByRole('textbox', { name: 'Price', exact: true }).fill('100');
    await ticket.getByRole('button', { name: 'Review long', exact: true }).click();
    await expect(sheet).toBeVisible({ timeout: 20_000 });
    await expect(sheet.locator('[data-line="margin-tier"]')).toHaveText('Tier 2, maintenance 5%, max leverage 10x');

    const tierStep = sheet.getByTestId('venue-tier-confirm');
    await expect(tierStep).toBeVisible();
    await expect(tierStep.getByRole('heading')).toHaveText('New margin tier: tier 2');
    await expect(tierStep).toContainText('This order moves your position from tier 1 into tier 2.');
    await expect(tierStep).toContainText(`Tier 2 requires 5% maintenance margin on ${SYMBOL}.`);
    await expect(tierStep).toContainText(`Leverage 5x. Tier 2 allows up to 10x on ${SYMBOL}.`);

    const openBtn = sheet.getByRole('button', { name: 'Open long', exact: true });
    await expect(openBtn).toBeDisabled();
    await stepPicture();

    const sigsBefore = signatures(wallet);
    await tierStep.getByRole('checkbox', { name: 'I accept tier 2', exact: true }).click();
    await expect(openBtn).toBeEnabled();
    await openBtn.click();
    await continueInWallet(page);
    await expect(sheet.getByTestId('venue-outcome').last()).toContainText('Filled on the venue.', { timeout: 20_000 });
    expect(signatures(wallet)).toBe(sigsBefore + 1);
    await sheet.getByRole('button', { name: 'Back', exact: true }).click();
    await expect.poll(async () => (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === SYMBOL)?.size).toBe('60');

    // Clean up position with a reduce-only close (verifying reduce-only never asks for a tier confirm).
    await otherTraderRun(makerName, { kind: 'cancel_order', symbol: SYMBOL, clientOrderKey: askKey }).catch(() => undefined);
    expect(
      await otherTraderRun(makerName, {
        kind: 'place_order',
        symbol: SYMBOL,
        side: 'buy',
        type: 'limit',
        amount: '60',
        price: '100',
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: bidKey,
        builderFee: null,
      }),
    ).toMatchObject({ accepted: true, order: { status: 'open' } });
    bidPlaced = true;

    await ticket.getByRole('button', { name: 'Short', exact: true }).click();
    await ticket.getByRole('button', { name: 'Limit', exact: true }).click();
    await ticket.getByRole('textbox', { name: 'Size (XRSK)', exact: true }).fill('60');
    await ticket.getByRole('textbox', { name: 'Price', exact: true }).fill('100');
    await ticket.getByLabel('Reduce-only', { exact: true }).check();
    await ticket.getByRole('button', { name: 'Review short', exact: true }).click();
    await expect(sheet).toBeVisible({ timeout: 20_000 });
    await expect(sheet.getByTestId('venue-tier-confirm')).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Open short', exact: true }).click();
    await continueInWallet(page);
    await expect(sheet.getByTestId('venue-outcome').last()).toContainText('Filled on the venue.', { timeout: 20_000 });
    await expect.poll(async () => (await venueRecord(owner, '/positions')).value.filter((p) => p.symbol === SYMBOL).length).toBe(0);
  } finally {
    await otherTraderRun(makerName, { kind: 'cancel_order', symbol: SYMBOL, clientOrderKey: askKey }).catch(() => undefined);
    if (bidPlaced) await otherTraderRun(makerName, { kind: 'cancel_order', symbol: SYMBOL, clientOrderKey: bidKey }).catch(() => undefined);
  }
});

test(`${J} #7 opens beyond the venue's open-interest limit: refused with the venue's reason and the room left the venue reports`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const { owner, wallet } = await desk(page);
  const { displayName } = await venueInfo();
  await expect(page.getByTestId('venue-leverage-current')).toContainText('5x, Isolated', { timeout: 20_000 });

  const before = await venueState(owner);
  const signedBefore = wallet.requests.length;
  const submits = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/v1\/venue\/(prepare|submit)/.test(r.url())) submits.push(r.url());
  });
  const size = '2';
  try {
    // The venue's cap, one unit above what is open now: an open of two would pass it.
    const open = (await venueMarket(owner)).openInterest.value.size;
    const cap = fromUnits(toUnits(open) + toUnits('1'));
    const set = await testVenue('/test/open-interest-cap', { symbol: SYMBOL, capSize: cap });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const m = await venueMarket(owner);
    expect(m.openInterest).toEqual({ known: true, value: { size: open, capSize: cap } });
    const room = fromUnits(toUnits(cap) - toUnits(open));
    // The desk shows the limit the venue sets.
    await expect(page.getByTestId('venue-open-interest-cap')).toHaveText(`At most ${cap} ${m.baseAsset} open, set by the venue`, {
      timeout: 20_000,
    });

    const ticket = page.getByTestId('venue-ticket');
    await ticket.getByRole('button', { name: 'Long', exact: true }).click();
    await ticket.getByRole('button', { name: 'Limit', exact: true }).click();
    await ticket.getByRole('textbox', { name: `Size (${m.baseAsset})`, exact: true }).fill(size);
    await ticket.getByRole('textbox', { name: 'Price', exact: true }).fill('100');
    await ticket.getByRole('combobox', { name: 'Margin asset', exact: true }).selectOption('USDC');
    await ticket.getByRole('button', { name: 'Review long', exact: true }).click();
    // Refused in the venue's words, with the room left under its cap, before the wallet is asked.
    await expect(ticket.getByRole('alert')).toHaveText(
      `The venue refused it: ${displayName} caps ${SYMBOL}'s open interest at ${cap} ${m.baseAsset}; ${open} ${m.baseAsset} is open, so ${size} ${m.baseAsset} more would pass the cap. Room left under the cap: ${room} ${m.baseAsset}, as the venue reports it.`,
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('venue-review')).toHaveCount(0);
    await stepPicture();
  } finally {
    await testVenue('/test/open-interest-cap', { symbol: SYMBOL, capSize: OI_CAP });
  }
  // Nothing signed and nothing sent: no margin locked, no order, no position on the venue.
  expect(wallet.requests.length).toBe(signedBefore);
  await expect(page.getByRole('dialog', { name: 'Check before you sign', exact: true })).toHaveCount(0);
  expect(submits).toEqual([]);
  expect(await venueState(owner)).toEqual(before);
});

test(`${J} #8 previews while the dynamic price range is wider than usual: the band shown with its current width; an order outside refuses`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const s = venueRunState(run, J);
  const me = await api(s.account);
  const { displayName } = await venueInfo();
  const reason = 'TEST: widened while futures price is 7% away from the mark';

  // Widen XRSK-PERP's band on the TEST venue from ±5% (500 bps -> 95..105) to ±12% (1200 bps -> 88..112).
  const widened = await testVenue('/test/price-band', { symbol: SYMBOL, widthBps: '1200', reason });
  expect(widened.status, JSON.stringify(widened.body)).toBe(200);
  try {
    const { owner, wallet } = await desk(page);
    const m = await venueMarket(owner);
    expect(m.priceBand).toEqual({
      known: true,
      value: {
        widthBps: '1200',
        usualWidthBps: '500',
        bandReference: '100',
        bandLow: '88',
        bandHigh: '112',
        widened: true,
        reason,
      },
    });

    const before = await venueState(owner);
    const signedBefore = signatures(wallet);
    const ticket = page.getByTestId('venue-ticket');
    await ticket.getByRole('button', { name: 'Long', exact: true }).click();
    await ticket.getByRole('button', { name: 'Limit', exact: true }).click();
    await expect(ticket.getByTestId('venue-price-band')).toContainText('88 to 112 USDC (±12%)');
    await expect(ticket.getByTestId('venue-price-band-widened')).toHaveText(`Wider than usual: ±12% (usual ±5%). ${reason}`);

    // A limit at 109 USDC (outside the usual 95-105 band, inside the widened 88-112 band) previews cleanly and shows
    // the widened band in the review.
    await ticket.getByRole('textbox', { name: 'Size (XRSK)', exact: true }).fill('1');
    await ticket.getByRole('textbox', { name: 'Price', exact: true }).fill('109');
    await ticket.getByRole('button', { name: 'Review long', exact: true }).click();
    const sheet = page.getByTestId('venue-review');
    await expect(sheet).toBeVisible({ timeout: 20_000 });
    await expect(sheet.locator('[data-line="price-band"]')).toContainText('88 to 112 USDC (±12%)');
    await expect(sheet.locator('[data-line="price-band"]')).toContainText('Wider than usual: ±12% (usual ±5%)');
    await stepPicture();
    await sheet.getByRole('button', { name: 'Back', exact: true }).click();

    // A limit at 115 USDC (outside the widened 88-112 band) is refused on the ticket AND at the venue preview door.
    await ticket.getByRole('textbox', { name: 'Price', exact: true }).fill('115');
    await ticket.getByRole('button', { name: 'Review long', exact: true }).click();
    await expect(ticket.locator('[data-code="trade.venue.price_outside_venue_band"]')).toContainText(
      `Price 115 USDC is outside ${displayName}’s band of 88 to 112 USDC (±12%)`,
    );
    await expect(sheet).toHaveCount(0);

    const directOutside = await me.post('/api/v1/venue/preview', {
      owner,
      intent: {
        kind: 'place_order',
        symbol: SYMBOL,
        side: 'buy',
        type: 'limit',
        amount: '1',
        price: '115',
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: `order:${J.toLowerCase()}:wide-outside:${randomBytes(4).toString('hex')}`,
        builderFee: null,
      },
    });
    expect(directOutside.status, JSON.stringify(directOutside.body)).toBe(422);
    expect(directOutside.body.intafacedCode).toBe('trade.venue.price_outside_venue_band');
    expect(signatures(wallet)).toBe(signedBefore);
    expect(await venueState(owner)).toEqual(before);
  } finally {
    await testVenue('/test/price-band', { symbol: SYMBOL, widthBps: null });
  }

  // With the dynamic widening cleared, the usual ±5% band (95-105) is back in force and 109 USDC refuses again.
  const restored = await venueMarket(s.owner);
  expect(restored.priceBand).toMatchObject({
    known: true,
    value: { widthBps: '500', usualWidthBps: '500', bandLow: '95', bandHigh: '105', widened: false },
  });
  const backOutside = await me.post('/api/v1/venue/preview', {
    owner: s.owner,
    intent: {
      kind: 'place_order',
      symbol: SYMBOL,
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '109',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${J.toLowerCase()}:usual-outside:${randomBytes(4).toString('hex')}`,
      builderFee: null,
    },
  });
  expect(backOutside.status, JSON.stringify(backOutside.body)).toBe(422);
  expect(backOutside.body.intafacedCode).toBe('trade.venue.price_outside_venue_band');
});
