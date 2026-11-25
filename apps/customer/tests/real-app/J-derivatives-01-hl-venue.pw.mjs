// World: book, gates, restart, stack
import { test, expect } from './journey.mjs';
import { journeyState } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { hyperliquidForThisFile, openVenueDesk, venueInfo, venueRecord } from './venue.mjs';

// J-derivatives-01 #5 and #7 on Hyperliquid's own test network: the steps every figure of which the test network
// serves to any wallet, funded or not. The daily run on main (.github/workflows/hl-venue-daily.yml) runs this file live
// and writes its recording; every other run replays that recording strictly, and until the first one lands the file runs
// on the TEST venue simulator (hyperliquidForThisFile). Each step reads the contract's terms from the venue's own record
// and checks the desk against them, so the same words hold on either venue.
//
// Simulator-only, in J-derivatives-01-venue.pw.mjs: #1 (its "no contract listed" and "venue down" branches are the
// simulator's TEST switches), #2 (the venue's halt is the simulator's TEST control), #4 (this adapter does not read the
// contract size, mark or funding yet: packages/venue-hyperliquid/src/market-terms.ts), and #6 and #8 to #11 (they need a
// venue account funded for perpetual margin, which the test network's faucet does not give a new wallet; a step funded by
// `usdSend` from the trader's spot balance comes with the adapter's spot-to-perps move, not offered yet). Every figure is
// TEST.
const J = 'J-derivatives-01';
const DESK = '/trade/futures';
const SYMBOL = 'BTC-PERP';
const MODES = ['isolated', 'cross'];
const MODE_WORD = { isolated: 'Isolated', cross: 'Cross' };
const RESTING = { stop: 'Stop', take_profit: 'Take profit', trailing_stop: 'Trailing stop' };
const run = journeyState(`${J}-hl-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
const venue = hyperliquidForThisFile(test, 'J-derivatives-01-hl-venue');

/**
 * TEST setup, not a journey step: a verified account and the wallet it signs with, the trader's own key on Hyperliquid
 * (live or replayed) and a fresh TEST key on the simulator. Neither step here moves money, so nothing is funded.
 */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'vhl');
    await verify(page, account);
    // The trader's key is never written to the run's state file: it is read from the environment each time.
    run.reset({ account, walletKey: venue.key ? null : testWalletKey() });
  } finally {
    await page.close();
  }
});

/** The desk on BTC-PERP with the wallet connected, and the contract as the venue's own record lists it. */
async function desk(page) {
  const s = run.read();
  const walletKey = venue.key ?? s.walletKey;
  if (!s.account || !walletKey) throw new Error(`${J} setup made no account and wallet, so this step has no one to act as`);
  const wallet = await openVenueDesk(page, s.account, DESK, walletKey);
  const owner = wallet.address.toLowerCase();
  const { displayName } = await venueInfo();
  await page
    .getByTestId('venue-contract-list')
    .getByRole('button', { name: `${SYMBOL} · ${displayName}`, exact: true })
    .click();
  const market = (await venueRecord(owner, '/markets')).value.find((m) => m.symbol === SYMBOL);
  expect(market, `${SYMBOL} is on the venue's own market list`).toBeTruthy();
  return { wallet, owner, market };
}

test(`${J} #5 chooses the margin mode: the modes the venue offers for the contract, the others listed as not offered by this venue; nothing changes, on Hyperliquid's test network`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const { wallet, owner, market } = await desk(page);
  const before = await venueRecord(owner, '/balances');
  const offered = MODES.filter((m) => market.marginModes.includes(m));
  const notOffered = MODES.filter((m) => !market.marginModes.includes(m));
  expect(offered.length, `${SYMBOL} offers at least one margin mode`).toBeGreaterThan(0);

  const margin = page.getByTestId('venue-margin');
  // Each mode the venue offers is a choice; each it does not is listed, disabled, as not offered by this venue.
  for (const m of offered) {
    await expect(margin.locator(`[data-mode="${m}"]`)).toHaveAttribute('data-offered', 'true');
    await expect(margin.locator(`[data-mode="${m}"]`)).toHaveText(MODE_WORD[m]);
    await expect(margin.locator(`[data-mode="${m}"] input`)).toBeEnabled();
  }
  for (const m of notOffered) {
    await expect(margin.locator(`[data-mode="${m}"]`)).toHaveAttribute('data-offered', 'false');
    await expect(margin.locator(`[data-mode="${m}"]`)).toContainText(`${MODE_WORD[m]} · not offered by this venue`);
    await expect(margin.locator(`[data-mode="${m}"] input`)).toBeDisabled();
  }
  // Choosing each offered mode changes nothing on the venue: no signature, and its balances are the same.
  for (const m of offered) {
    await margin.locator(`[data-mode="${m}"] input`).check();
    await expect(margin.locator(`[data-mode="${m}"] input`)).toBeChecked();
  }
  await stepPicture();
  expect(wallet.requests).toHaveLength(0);
  expect((await venueRecord(owner, '/balances')).value).toEqual(before.value);
});

test(`${J} #7 looks at the order types: market and limit as offered; resting types that are not live are listed with the honest refusal and no network write, on Hyperliquid's test network`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const { wallet, owner, market } = await desk(page);
  // The venue's own record offers market and limit, and none of the resting types.
  expect(market.orderTypes).toEqual(expect.arrayContaining(['limit', 'market']));
  const resting = Object.keys(RESTING).filter((x) => !market.orderTypes.includes(x));
  expect(resting).toEqual(Object.keys(RESTING));

  const types = page.getByTestId('venue-order-types');
  await expect(types.getByRole('button', { name: 'Market', exact: true })).toBeEnabled();
  await expect(types.getByRole('button', { name: 'Limit', exact: true })).toBeEnabled();
  const writes = [];
  page.on('request', (r) => r.method() !== 'GET' && new URL(r.url()).pathname.startsWith('/api/') && writes.push(r.url()));
  for (const x of resting) {
    const button = types.getByRole('button', { name: `${RESTING[x]}: not offered by this venue`, exact: true });
    await expect(button).toBeDisabled();
    await button.click({ force: true });
  }
  // Each pressed type stays disabled and the desk still offers market and limit: nothing was chosen or sent.
  for (const x of resting)
    await expect(types.getByRole('button', { name: `${RESTING[x]}: not offered by this venue`, exact: true })).toBeDisabled();
  await expect(types.getByRole('button', { name: 'Market', exact: true })).toBeEnabled();
  await stepPicture();
  expect(writes).toEqual([]);
  expect(wallet.requests).toHaveLength(0);
  expect((await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === SYMBOL)).toEqual([]);
});
