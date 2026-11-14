// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { fromUnits, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  sameDecimal,
  testDeposit,
  testVenue,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-derivatives-02's venue steps on the person's own venue account (launch money model: the venue holds the margin and
// sets the risk rules), in the running app against the stack's TEST venue simulator. #2, #3, #4 and #7 are the steps
// CUSTODY-DELTA marks Adapted: the tiers, what counts as margin, the refusal of an asset the venue doesn't take, and the
// venue's open-interest limit, each read from the venue's own record (venueRecord, venueBalance) and compared with what
// the desk shows. The contract is the TEST perpetual XRSK-PERP (packages/venue-sim/src/http-server.ts), which only this
// file trades; BTC-PERP is the TEST perpetual whose venue publishes no tiers. One test per step, titled
// "J-derivatives-02 #<n>"; #1, #5, #6 and #8 are in J-derivatives-02.pw.mjs. Every figure is TEST. The door is on for this
// file only.
const J = 'J-derivatives-02';
const SYMBOL = 'XRSK-PERP';
const DESK = `/trade/futures?symbol=${SYMBOL}`;
const UNPUBLISHED = 'BTC-PERP';
/** The TEST venue's open-interest cap on XRSK-PERP (packages/venue-sim/src/http-server.ts), put back after #7. */
const OI_CAP = '1000';
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J} #2 made no account and wallet, so this step has no one to act as`);
  return s;
}

async function desk(page, path = DESK, symbol = SYMBOL) {
  const s = state();
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

/** The figures that say nothing moved: balances, open orders and positions, as the venue records them. */
async function venueState(owner) {
  return {
    balances: (await venueRecord(owner, '/balances')).value,
    orders: (await venueRecord(owner, '/open-orders')).value,
    positions: (await venueRecord(owner, '/positions')).value,
  };
}

const percent = (rate) => `${fromUnits(toUnits(rate) * 100n)}%`;
const grouped = (x) => {
  const [whole, fraction] = String(x).split('.');
  const w = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${w}.${fraction}` : w;
};
const plain = (text) => text.replace(/,/g, '').trim();

test(`${J} #2 reads the tier table: the venue's published tiers and maintenance rates, or "not published by this venue"; nothing invented`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  // The journey's start: a verified person with TEST collateral in their own venue account, and one TEST asset the
  // venue doesn't take as margin (#3, #4).
  const account = await signUp(page, 'vrisk');
  await verify(page, account);
  run.reset({ account, walletKey: testWalletKey() });
  const { owner } = await desk(page);
  expect(await testDeposit(owner, 'USDC', '1000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  expect(await testDeposit(owner, 'BTC', '0.01', `84532:0x${randomBytes(32).toString('hex')}:1`)).toBe(true);
  const { displayName } = await venueInfo();
  const sent = venueWrites(page);

  // The venue's own record of the contract's tiers.
  const m = await venueMarket(owner);
  expect(m.marginTiers.known, JSON.stringify(m.marginTiers)).toBe(true);
  const tiers = m.marginTiers.value;
  expect(tiers.length).toBeGreaterThan(1);

  // The desk's tier table is those tiers, row for row: where each starts, its most leverage and its maintenance rate.
  const panel = page.getByTestId('venue-tiers');
  await expect(panel.getByRole('heading')).toContainText(`Margin tiers on ${displayName}`);
  await expect(panel.getByTestId('venue-test').first()).toHaveText('TEST');
  const table = panel.getByRole('table', { name: `Margin tiers ${SYMBOL}` });
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

  // A contract whose venue publishes no tiers: "not published", and no table of ours in its place.
  const btc = await venueMarket(owner, UNPUBLISHED);
  expect(btc.marginTiers).toEqual({ known: false });
  await page
    .getByTestId('venue-contract-list')
    .getByRole('button', { name: `${UNPUBLISHED} · ${displayName}` })
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
}) => {
  const { owner } = await desk(page);
  const { displayName } = await venueInfo();
  const sent = venueWrites(page);
  const m = await venueMarket(owner);
  expect(m.collateral.known, JSON.stringify(m.collateral)).toBe(true);
  const taken = m.collateral.value;
  const held = (await venueRecord(owner, '/balances')).value;
  // The person holds something the venue doesn't take here (#2's TEST BTC), so "nothing else counts" is tested.
  const others = held.filter((b) => !taken.some((c) => c.asset === b.asset) && toUnits(b.total) > 0n);
  expect(others.map((b) => b.asset)).toContain('BTC');

  const panel = page.getByTestId('venue-collateral');
  await expect(panel.getByRole('heading')).toContainText(`What ${displayName} takes as margin`);
  const table = panel.getByRole('table', { name: `Margin ${displayName} takes on ${SYMBOL}` });
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
    expect(sameDecimal(plain(await row.locator('[data-cell="counts"]').innerText()), fromUnits(counts))).toBe(true);
    power += counts;
  }
  // Buying power is what the venue takes, less its haircut: the TEST BTC adds nothing.
  const shown = page.getByTestId('venue-buying-power-value');
  await expect(shown).toHaveAttribute('data-value', fromUnits(power));
  await expect(shown).toHaveText(`${grouped(fromUnits(power))} ${m.quoteAsset}`);
  const notTaken = panel.getByRole('list', { name: `Not taken as margin by ${displayName}` });
  await expect(notTaken.getByRole('listitem')).toHaveCount(others.length);
  for (const b of others) {
    await expect(notTaken.locator(`li[data-asset="${b.asset}"]`)).toHaveText(
      `${b.asset}: ${displayName} does not take it as margin on ${SYMBOL}, so it adds nothing to buying power`,
    );
  }
  expect(sent).toEqual([]);
  run.write({ power: fromUnits(power) });
});

test(`${J} #4 selects an asset the venue doesn't accept as margin: refused naming the venue; buying power unchanged`, async ({ page }) => {
  const s = state();
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
  await ticket.getByRole('textbox', { name: `Size (${m.baseAsset})` }).fill('1');
  await ticket.getByRole('textbox', { name: 'Price', exact: true }).fill('100');
  await ticket.getByRole('combobox', { name: 'Margin asset' }).selectOption('BTC');
  await ticket.getByRole('button', { name: 'Review long' }).click();
  await expect(ticket.getByRole('alert')).toHaveText(
    `${displayName} does not take BTC as margin on ${SYMBOL}: it takes ${takenAssets.join(', ')}. Nothing was sent, and buying power is unchanged.`,
  );
  await expect(page.getByTestId('venue-review')).toHaveCount(0);
  await page.waitForTimeout(1_000);

  // Nothing previewed, signed or sent, and the venue's record is as it was.
  expect(sent).toEqual([]);
  expect(wallet.requests.length).toBe(signedBefore);
  expect(await venueState(owner)).toEqual(before);
  // Buying power unchanged: the venue's free USDC is as #3 read it, and the desk shows the same figure.
  const usdc = await venueBalance(owner, 'USDC');
  expect(sameDecimal(usdc.free, s.power)).toBe(true);
  await expect(page.getByTestId('venue-buying-power-value')).toHaveAttribute('data-value', s.power);
});

test(`${J} #7 opens beyond the venue's open-interest limit: refused with the venue's reason and the room left the venue reports`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { owner, wallet } = await desk(page);
  const { displayName } = await venueInfo();
  // The person's leverage on the contract, signed, within its first tier.
  const margin = page.getByTestId('venue-margin');
  await margin.getByRole('textbox', { name: 'Leverage (times)' }).fill('5');
  await margin.getByRole('button', { name: 'Sign this leverage setting' }).click();
  await continueInWallet(page);
  await expect(margin.getByTestId('venue-outcome')).toContainText('The venue accepted it.', { timeout: 15_000 });

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
    await ticket.getByRole('textbox', { name: `Size (${m.baseAsset})` }).fill(size);
    await ticket.getByRole('textbox', { name: 'Price', exact: true }).fill('100');
    await ticket.getByRole('combobox', { name: 'Margin asset' }).selectOption('USDC');
    await ticket.getByRole('button', { name: 'Review long' }).click();
    // Refused in the venue's words, with the room left under its cap, before the wallet is asked.
    await expect(ticket.getByRole('alert')).toHaveText(
      `The venue refused it: ${displayName} caps ${SYMBOL}'s open interest at ${cap} ${m.baseAsset}; ${open} ${m.baseAsset} is open, so ${size} ${m.baseAsset} more would pass the cap. Room left under the cap: ${room} ${m.baseAsset}, as the venue reports it.`,
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('venue-review')).toHaveCount(0);
    await page.waitForTimeout(1_000);
  } finally {
    await testVenue('/test/open-interest-cap', { symbol: SYMBOL, capSize: OI_CAP });
  }
  // Nothing signed and nothing sent: no margin locked, no order, no position on the venue.
  expect(wallet.requests.length).toBe(signedBefore);
  await expect(page.getByRole('dialog', { name: 'Check before you sign' })).toHaveCount(0);
  expect(submits).toEqual([]);
  expect(await venueState(owner)).toEqual(before);
});
