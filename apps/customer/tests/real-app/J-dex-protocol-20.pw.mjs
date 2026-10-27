import { test, expect } from '@playwright/test';
import { UNBUILT, connectWallet, dexRun } from './dex.mjs';

// J-dex-protocol-20, in the running app (docs/roadmap/journeys.json): trade the on-chain book and make markets. One test
// per step, titled "J-dex-protocol-20 #<n>", run in order with one TEST wallet for the whole run. The venue balances are
// the person's own deposit in the venue contract (SovereignVenue); nothing posts to the ledger. While the book's stream is
// unwired the book falls back to polling and says rail.crypto; INTACHAIN rows read chain.go.
// Every step is written; none is built in the app yet, so each fails at its first missing part, quickly (UNBUILT):
// - /dex has no pro book view or venue trading panel (the venue tab shows only its wiring and supported networks);
// - the stack runs no svc-indexer, svc-dex or TEST chain, so there are no levels, pools, quoters or intents to read;
// - the venue's on-chain ask/cross/self-trade rule is proved below the app (svc-protocol sovereign-venue.onchain.test.ts),
//   not yet in the browser.
const J = 'J-dex-protocol-20';
const dex = dexRun(J);
const BASE = { address: '0x00000000000000000000000000000000000ba5e0', name: 'TEST Base', version: '1', decimals: 18, nonce: 0 };
const QUOTE = { address: '0x0000000000000000000000000000000000000c0e', name: 'TEST Quote', version: '1', decimals: 6, nonce: 0 };

test.describe.configure({ mode: 'default' });

const room = (page) => page.getByRole('main');
const book = (page) => room(page).getByRole('region', { name: 'Order book' });
const venue = (page) => room(page).getByRole('region', { name: 'Venue trading' });
const rfq = (page) => room(page).getByRole('region', { name: 'Private quote' });
const fillers = (page) => room(page).getByRole('region', { name: 'Intent filler' });

/** Opens the pro book view on /dex with the run's wallet connected. */
async function openBook(page) {
  const wallet = await connectWallet(page, dex, { tokens: [BASE, QUOTE] });
  await page.goto('/dex');
  await room(page).getByRole('tab', { name: 'Pro book' }).click(UNBUILT);
  await expect(book(page)).toBeVisible();
  return wallet;
}

/** Places a venue order from the trading panel and waits for its row. */
async function placeVenueOrder(page, { side, price, amount }) {
  const panel = venue(page);
  await panel.getByRole('radio', { name: side }).check();
  await panel.getByRole('textbox', { name: /^Price/ }).fill(price);
  await panel.getByRole('textbox', { name: /^Amount/ }).fill(amount);
  await panel.getByRole('button', { name: `Place ${side.toLowerCase()}` }).click();
}

test(`${J} starts: a TEST wallet holding TEST base and quote on the trading venue`, async ({ page }) => {
  dex.start();
  await openBook(page);
  const balances = venue(page).getByRole('table', { name: 'Venue balances' });
  await expect(balances).toContainText('TEST Base', UNBUILT);
  await expect(balances).toContainText('TEST Quote');
});

test(`${J} #1 opens the pro book view on /dex: levels with the finalized height and as-of time; a halted indexer shows its reason and no levels, never stale ones`, async ({
  page,
}) => {
  await openBook(page);
  const levels = book(page).getByRole('table', { name: 'Levels' });
  await expect(levels).toBeVisible(UNBUILT);
  await expect(book(page).getByTestId('book-finalized-height')).toHaveText(/^Finalized at block \d+$/);
  await expect(book(page).getByTestId('book-as-of')).toHaveText(/^As of \d{2}:\d{2}:\d{2}/);
  // The stream is not wired on the stack, so the book polls and names the rail.
  await expect(book(page).getByRole('note')).toContainText('rail.crypto');

  // The indexer halted: the reason, and no levels at all rather than the last ones it held.
  await expect(book(page).getByRole('alert')).toContainText('The indexer is halted');
  await expect(levels.getByRole('row')).toHaveCount(1);
});

test(`${J} #2 opens the venue tab with a registered pool: the pool is listed as a leg of the quote`, async ({ page }) => {
  await openBook(page);
  await room(page).getByRole('tab', { name: 'Venue' }).click();
  const legs = room(page).getByRole('table', { name: 'Quote legs' });
  await expect(legs).toBeVisible(UNBUILT);
  await expect(legs.getByRole('row').filter({ hasText: 'Pool' })).toContainText('TEST Base / TEST Quote');
});

test(`${J} #3 places an ask, then a crossing bid: the fill comes from matching and the level goes to zero; a self-trade is refused`, async ({
  page,
}) => {
  await openBook(page);
  await expect(venue(page)).toBeVisible(UNBUILT);
  await placeVenueOrder(page, { side: 'Sell', price: '2.00', amount: '1' });
  const level = book(page).getByRole('table', { name: 'Levels' }).getByRole('row').filter({ hasText: '2.00' });
  await expect(level).toContainText('1');

  // Crossing your own resting ask is a self-trade: the venue refuses it and the level stays.
  await placeVenueOrder(page, { side: 'Buy', price: '2.00', amount: '1' });
  await expect(venue(page).getByRole('alert')).toContainText('You cannot trade against your own order.');
  await expect(level).toContainText('1');

  // The other TEST maker's crossing bid fills it from matching; the level goes to zero.
  await expect(room(page).getByRole('table', { name: 'Your fills' }).getByRole('row').filter({ hasText: '2.00' })).toBeVisible();
  await expect(level).toHaveCount(0);
});

test(`${J} #4 requests a private quote from market makers: soft quotes within the timeout, the best shown, a timed-out quoter "unavailable: timeout"`, async ({
  page,
}) => {
  await openBook(page);
  await rfq(page)
    .getByRole('textbox', { name: /^Amount/ })
    .fill('1', UNBUILT);
  await rfq(page).getByRole('button', { name: 'Ask market makers' }).click();
  const quotes = rfq(page).getByRole('table', { name: 'Soft quotes' });
  await expect(quotes.getByRole('row').nth(1)).toContainText('Best');
  await expect(quotes).toContainText('unavailable: timeout');
});

test(`${J} #5 selects a quote: a hard quote with an expiry; signing after it is refused; a last-look decline reads "Quoter declined" and offers the pool route`, async ({
  page,
}) => {
  await openBook(page);
  await rfq(page)
    .getByRole('textbox', { name: /^Amount/ })
    .fill('1', UNBUILT);
  await rfq(page).getByRole('button', { name: 'Ask market makers' }).click();
  await rfq(page).getByRole('table', { name: 'Soft quotes' }).getByRole('row').nth(1).getByRole('button', { name: 'Select' }).click();
  const hard = rfq(page).getByRole('group', { name: 'Hard quote' });
  await expect(hard.getByTestId('quote-expires')).toHaveText(/^Expires in \d+ s$/);
  // Past its expiry the quote cannot be signed.
  await expect(hard.getByRole('button', { name: 'Sign and trade' })).toBeDisabled({ timeout: 120_000 });
  await expect(hard).toContainText('This quote expired. Ask again.');

  // A fresh hard quote that the quoter declines at last look.
  await rfq(page).getByRole('button', { name: 'Ask market makers' }).click();
  await rfq(page).getByRole('table', { name: 'Soft quotes' }).getByRole('row').nth(1).getByRole('button', { name: 'Select' }).click();
  await hard.getByRole('button', { name: 'Sign and trade' }).click();
  await expect(rfq(page).getByRole('alert')).toContainText('Quoter declined');
  await expect(rfq(page).getByRole('button', { name: 'Use the pool route' })).toBeVisible();
});

test(`${J} #6 registers as a filler and reads the open-order feed: intents in nonce order with a cursor; a 429 carries retry-after; unregistered is refused`, async ({
  page,
}) => {
  await openBook(page);
  // Before registering, the feed refuses this wallet.
  await expect(fillers(page).getByRole('alert')).toContainText('Register as a filler to read the open-order feed.', UNBUILT);
  await fillers(page).getByRole('button', { name: 'Register as a filler' }).click();
  const feed = fillers(page).getByRole('table', { name: 'Open intents' });
  // Wait for the feed to load before reading it, so an empty list never passes as "in order".
  await expect(feed.getByTestId('intent-nonce').nth(1)).toBeVisible();
  const nonces = await feed.getByTestId('intent-nonce').allInnerTexts();
  expect(nonces.map(Number)).toEqual([...nonces.map(Number)].sort((a, b) => a - b));
  await expect(fillers(page).getByRole('button', { name: 'Next page' })).toBeVisible();
  // Asking faster than the feed allows reads back the wait it named.
  await expect(fillers(page).getByRole('status')).toContainText(/Try again in \d+ s/);
});

test(`${J} #7 fills an intent as the exclusive filler: a rival under the improvement override is rejected, a larger one accepted; blank thresholds refuse`, async ({
  page,
}) => {
  await openBook(page);
  const intent = fillers(page).getByRole('table', { name: 'Open intents' }).getByRole('row').nth(1);
  await intent.getByRole('button', { name: 'Fill' }).click(UNBUILT);
  await expect(intent).toContainText('Filled by you (exclusive)');
  const rivals = fillers(page).getByRole('list', { name: 'Rival offers' });
  await expect(rivals).toContainText('Rejected: under the improvement override');
  await expect(rivals).toContainText('Accepted: above the improvement override');
  // With the owner's thresholds blank, the exclusive window refuses by name rather than inventing one.
  await expect(fillers(page).getByRole('note')).toContainText('protocol.intents.exclusivity_unset');
});

test(`${J} #8 answers an RFQ over the maker transport and downloads a month of market data: a late quote refused, a late webhook dropped and counted, one hashed file per kind`, async ({
  page,
}) => {
  await openBook(page);
  const maker = room(page).getByRole('region', { name: 'Maker transport' });
  await expect(maker).toBeVisible(UNBUILT);
  await expect(maker.getByRole('table', { name: 'Answered requests' })).toContainText('Refused: past its expiry');
  await expect(maker.getByTestId('late-webhooks')).toHaveText(/^\d+ late webhooks dropped$/);
  const archive = room(page).getByRole('region', { name: 'Market data' });
  await archive.getByRole('combobox', { name: 'Month' }).selectOption({ index: 0 });
  const download = page.waitForEvent('download');
  await archive.getByRole('button', { name: 'Download the month' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);
  // Each kind is one file, and its listed hash matches the file.
  for (const kind of ['trades', 'quotes', 'levels'])
    await expect(archive.getByRole('row').filter({ hasText: kind })).toContainText(/sha256 [0-9a-f]{64}/);
});

test(`${J} #9 reads the protocol-run strategy next to its own orders: equal-price orders coexist and the strategy has no priority`, async ({
  page,
}) => {
  await openBook(page);
  const level = book(page).getByRole('table', { name: 'Levels' }).getByRole('row').filter({ hasText: 'Protocol strategy' });
  await expect(level).toBeVisible(UNBUILT);
  await expect(level).toContainText('Your order');
  await expect(book(page).getByRole('note').filter({ hasText: 'strategy' })).toContainText(
    'The protocol strategy queues by time like any other order and has no priority.',
  );
});
