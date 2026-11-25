// World: book, gates, restart, stack
import { test, expect } from './journey.mjs';
import { journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { hyperliquidForThisFile, openVenueDesk, sameDecimal, venueBalance, venueRecord } from './venue.mjs';

// J-cex-spot-04 #3 on Hyperliquid's own test network: the step whose every figure (the pair's tick, lot and
// smallest order value) the test network publishes to any wallet. The daily run on main
// (.github/workflows/hl-venue-daily.yml) runs this file live and writes its recording; every other run replays that
// recording strictly, and until the first one lands the file runs on the TEST venue simulator (hyperliquidForThisFile).
// The step reads BTC-USDC's rules from the venue's own record and checks the desk against them, so the same words hold on
// either venue: BTC-USDC is listed on both (the stack's TEST listing seed, tooling/scripts/local-stack-services/trade.mjs).
//
// Simulator-only, in J-cex-spot-04-venue.pw.mjs: #2 (the test network publishes no price band and no largest order:
// packages/venue-hyperliquid/src/market-terms.ts), #5 (the test network's cap is 1000 open orders), #6 (its owner branch
// blanks the stack's own settings, and its pairs are the simulator's TEST markets) and #7 (it rests a TEST order, which
// needs a funded venue account). Every figure is TEST.
const J = 'J-cex-spot-04';
const SYMBOL = 'BTC-USDC';
const BASE = 'BTC';
const run = journeyState(`${J}-hl-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
const venue = hyperliquidForThisFile(test, 'J-cex-spot-04-hl-venue');

/**
 * TEST setup, not a journey step: a verified account and the wallet it signs with, the trader's own key on Hyperliquid
 * (live or replayed, never written to the run's state file) and a fresh TEST key on the simulator. Nothing is funded:
 * the step sends nothing.
 */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'h04');
    await verify(page, account);
    run.reset({ account, walletKey: venue.key ? null : testWalletKey() });
  } finally {
    await page.close();
  }
});

const buyForm = (page) => page.locator('form[data-testid="dk-form"][data-side="buy"]');
const placesOf = (step) => (step.split('.')[1] ?? '').length;
/** A figure on `step` with every decimal place it allows, then one keystroke finer: a digit past them, or a decimal mark. */
const finer = (onStep, step) => (placesOf(step) > 0 ? `${onStep}5` : `${onStep}.`);

test(`${J} #3 types an amount below the smallest order, or finer than the lot or tick: "Too small" in words; finer digits cannot be typed; nothing is previewed or sent`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const s = run.read();
  const walletKey = venue.key ?? s.walletKey;
  if (!s.account || !walletKey) throw new Error(`${J} setup made no account and wallet, so this step has no one to act as`);

  const wallet = await openVenueDesk(page, s.account, `/trade/spot/${SYMBOL}`, walletKey);
  const owner = wallet.address.toLowerCase();
  const own = (await venueRecord(owner, '/markets')).value.find((m) => m.symbol === SYMBOL);
  expect(own, `${SYMBOL} is on the venue's own market list`).toBeTruthy();
  expect(own.minOrderNotional, `${SYMBOL}'s smallest order value, as the venue publishes it`).toBeTruthy();
  const openBefore = (await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === SYMBOL);
  const lockedBefore = (await venueBalance(owner, 'USDC')).locked;

  const asked = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (r.method() === 'POST' && ['/api/v1/venue/preview', '/api/v1/venue/prepare', '/api/v1/venue/submit'].includes(p)) asked.push(p);
  });

  // Finer digits than the venue's tick or lot cannot be typed: the box keeps the figure on the step.
  const tickPlaces = placesOf(own.tickSize);
  const priceOnTick = tickPlaces > 0 ? `1.${'1'.repeat(tickPlaces)}` : '1';
  const priceBox = buyForm(page).getByRole('textbox', { name: 'Price', exact: true });
  await priceBox.fill('');
  await priceBox.pressSequentially(finer(priceOnTick, own.tickSize));
  await expect(priceBox).toHaveValue(priceOnTick);

  const amountBox = buyForm(page).getByRole('textbox', { name: 'Amount', exact: true });
  await amountBox.fill('');
  await amountBox.pressSequentially(finer(own.lotSize, own.lotSize));
  await expect(amountBox).toHaveValue(own.lotSize);

  // One lot at that price is below the venue's smallest order value: "Too small" in words, Buy disabled.
  const one = toUnits('1');
  expect((toUnits(priceOnTick) * toUnits(own.lotSize)) / one).toBeLessThan(toUnits(own.minOrderNotional));
  const note = buyForm(page).getByTestId('venue-ticket-below-min');
  await expect(note).toHaveText(`Too small: the smallest order is ${own.minOrderNotional} USDC. Nothing was previewed or sent.`);
  await expect(buyForm(page).getByRole('button', { name: `Buy ${BASE}`, exact: true })).toBeDisabled();
  await stepPicture();

  // Nothing was previewed, prepared, signed or locked on the venue itself, read straight from it.
  expect(asked).toEqual([]);
  expect(wallet.requests).toHaveLength(0);
  expect((await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === SYMBOL)).toEqual(openBefore);
  expect(sameDecimal((await venueBalance(owner, 'USDC')).locked, lockedBefore)).toBe(true);
});
