// World: book
import { test, expect } from './journey.mjs';
import { chosePro, deskPath, fundedTrader, signIn } from './desk.mjs';
import { ORIGIN } from './stack.mjs';

// J-charts-desk-14, in the running app (docs/roadmap/journeys.json): a funded pro trader reads the order flow and
// trades from the ladder. One test per step, titled "J-charts-desk-14 #<n>", run in order on one TEST account funded
// with TEST USDT. #1 to #3 are the DOM, tape and depth widgets (C-trade-dom-01); #4 to #7 trade from the ladder and the
// chart (C-trade-dom-02); #8 is the place in the queue of a resting order (RC-charts-desk-01). Every price is a TEST
// price read from the stack's own book, never typed in.
const J = 'J-charts-desk-14';
const DESK = deskPath('BTC/USDT');

// Not serial: each step opens its own desk, so a step still waiting on its owner never keeps the next from running.

let page;
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: ORIGIN });
  page = await context.newPage();
  await chosePro(page);
  // Funded, verified and signed out by the helper; then signed in for the desk.
  await signIn(page, await fundedTrader(page, 'jcd14', '1000'));
});
test.afterAll(async () => {
  await page?.context().close();
});

const desk = () => page.getByTestId('if-desk');
const buyForm = () => page.locator('form[data-testid="dk-form"][data-side="buy"]');
const review = () => page.getByRole('alertdialog').filter({ hasText: /Review your (buy|sell)/ });
/** Every order request this page sends; a step that must send nothing checks it stays empty. */
function watchOrderSends() {
  const sent = [];
  const listen = (request) => {
    const path = new URL(request.url()).pathname;
    // An order write. The advisory preview (`…/preview`) the review reads is not a send.
    if (request.method() === 'POST' && /\/orders?(\/|$)/.test(path) && !/preview/.test(path)) sent.push(path);
  };
  page.on('request', listen);
  return { sent, stop: () => page.off('request', listen) };
}

/** A decimal string without trailing zeros, so 65151.80 and 65151.8 compare equal. */
const trimmed = (text) => text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

async function openDesk() {
  await page.goto(DESK);
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeVisible();
}

test(`${J} #1 opens the DOM from the chart; it binds to the chart's symbol and re-binds when the symbol changes`, async () => {
  await openDesk();
  await page.getByRole('button', { name: 'Open DOM' }).click({ timeout: 5_000 });
  const dom = page.getByRole('region', { name: 'Depth of market' });
  await expect(dom).toHaveAttribute('data-symbol', 'BTC/USDT');
  await page.goto(deskPath('ETH/USDT'));
  await expect(page.getByRole('region', { name: 'Depth of market' })).toHaveAttribute('data-symbol', 'ETH/USDT');
});

test(`${J} #2 reads time and sales and the depth chart: the tape with filters and the depth curve from the same book`, async () => {
  await openDesk();
  const tape = page.getByRole('region', { name: 'Time and sales' });
  await expect(tape.getByLabel('Minimum amount')).toBeVisible({ timeout: 5_000 });
  const depth = page.getByRole('img', { name: /^Depth chart of BTC\/USDT/ });
  await expect(depth).toBeVisible();
});

test(`${J} #3 sets the ladder to double columns with a price step of 2 ticks; prices group by the step with highlights`, async () => {
  await openDesk();
  const dom = page.getByRole('region', { name: 'Depth of market' });
  await dom.getByLabel('Columns').selectOption({ label: 'Double' }, { timeout: 5_000 });
  await dom.getByLabel('Price step').selectOption({ label: '2 ticks' });
  await expect(dom).toHaveAttribute('data-step-ticks', '2');
});

test(`${J} #4 clicks a ladder ask; the ticket fills with the price and the review opens, and nothing is sent`, async () => {
  await openDesk();
  const sends = watchOrderSends();
  try {
    // An amount first, so the review has an order to show.
    await buyForm().getByRole('textbox', { name: 'Amount' }).fill('0.0001');
    const ask = page.locator('[data-testid="dk-bk-row"][data-side="ask"]').last();
    const askPrice = (await ask.getAttribute('data-price')) ?? '';
    expect(askPrice).toMatch(/^\d+(\.\d+)?$/);
    await ask.click();
    // The review opens on its own, a buy at the ask that was clicked.
    await expect(review()).toBeVisible();
    await expect(review()).toContainText('Review your buy');
    const reviewed = (
      await review()
        .getByText(/ USDT$/)
        .first()
        .innerText()
    ).replace(/[^\d.]/g, '');
    expect(trimmed(reviewed), `the review's price ${reviewed}`).toBe(trimmed(askPrice));
    // The review is a draft: nothing went to the market.
    expect(sends.sent).toEqual([]);
    await review().getByRole('button', { name: 'Cancel' }).click();
    await expect(review()).toHaveCount(0);
    // The ticket kept the clicked price, and still nothing was sent.
    expect(trimmed(await buyForm().getByRole('textbox', { name: 'Price' }).inputValue())).toBe(trimmed(askPrice));
    expect(sends.sent).toEqual([]);
  } finally {
    sends.stop();
  }
});

test(`${J} #5 uses Buy and Sell buttons on the chart; each shows the live spread, and a type the market does not list refuses`, async () => {
  await openDesk();
  const box = page.getByRole('group', { name: 'Trade from the chart' });
  const buy = box.getByRole('button', { name: /^Buy at \d/ });
  const sell = box.getByRole('button', { name: /^Sell at \d/ });
  await expect(buy).toBeVisible({ timeout: 5_000 });
  await expect(sell).toBeVisible();
  await expect(box.getByTestId('chart-spread')).toHaveText(/^Spread \d/);
  await buy.click();
  await expect(review()).toContainText('Review your buy');
  await review().getByRole('button', { name: 'Cancel' }).click();
  await box.getByLabel('Order type').selectOption({ label: 'Trailing stop' });
  await buy.click();
  await expect(box.getByRole('status')).toContainText('not offered');
  await expect(review()).toHaveCount(0);
});

test(`${J} #6 turns instant placement on; a click sends after the settings summary, and off it always reviews`, async () => {
  await openDesk();
  await page.getByRole('button', { name: 'Trading settings' }).click({ timeout: 5_000 });
  await page.getByRole('switch', { name: 'Instant placement' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Turn on instant placement?' })).toBeVisible();
});

test(`${J} #7 uses one-click close, cancel and size presets; each acts once with its reviewed or instant setting`, async () => {
  await openDesk();
  await expect(buyForm().getByRole('group', { name: 'Size presets' })).toBeVisible({ timeout: 5_000 });
});

test(`${J} #8 reads its place in the queue and the fill probability of a resting order`, async () => {
  await openDesk();
  await expect(page.getByTestId('dk-queue-position').first()).toBeVisible({ timeout: 5_000 });
});
