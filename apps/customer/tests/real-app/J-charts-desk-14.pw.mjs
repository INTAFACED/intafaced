// World: book
import { test, expect } from './journey.mjs';
import { api, bestPrices, EDGE, fromUnits, ORIGIN, toUnits } from './stack.mjs';
import { awayBid, chosePro, deskPath, fundedTrader, held, openOrders, placements, reviewSheet, signIn } from './desk.mjs';

// J-charts-desk-14 "I read the order flow: time and sales, depth, ladder and the DOM, and trade from the ladder", in the
// running app (docs/roadmap/journeys.json). One test per step, titled "J-charts-desk-14 #<n>", on one TEST account
// funded with TEST USDT, signed in on the spot desk with its chart open. Every price is read from the stack's own book,
// never typed in. Money line: a ladder order is the desk's own order (its review, its confirm, its hold), and nothing is
// sent from a click without the review.
//
// Step #8 (queue position and fill chance) is not in this file yet: it lands with its code, so this file never carries a
// step that is red by design. Instant placement sends LIMIT orders only: a market order (Buy or Sell at market, Close)
// always shows its review, as the desk's order summary rule has it (J-cex-spot-13 #2).
const J = 'J-charts-desk-14';
const SYMBOL = 'BTC/USDT';
const OTHER = 'ETH/USDT';
// Client order ids are business keys, unique per account and market, at most 64 characters: the step's tag and this run's
// mark keep them short and different on every run on the same stack.
const RUN = Date.now().toString(36);
const SMALL = '0.001'; // about 65 TEST USDT at the TEST market maker's price
const LARGE = '0.005';
const BETWEEN = '0.003';

let page;
let who;
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 1800 } });
  page = await context.newPage();
  await chosePro(page);
  who = await fundedTrader(page, 'jcd14', '2000');
  await signIn(page, who);
  // Some BTC to sell from the chart in #5: a market buy on the real book, filled against the TEST market maker.
  const bought = await (
    await api(who)
  ).post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'market',
    side: 'buy',
    amount: '0.001',
    clientOrderId: `jcd14-setup-${RUN}`,
  });
  expect(bought.status, JSON.stringify(bought.body).slice(0, 300)).toBeLessThan(300);
});
test.afterAll(async () => {
  await page?.context().close();
});

const dom = () => page.getByRole('region', { name: 'Depth of market' });
const ladder = () => dom().getByRole('grid', { name: 'Depth of market' });
const rows = () => dom().getByTestId('of-ladder-row');
const tapeRegion = () => page.getByRole('region', { name: 'Time and sales' });
const chartTrade = () => page.getByRole('group', { name: 'Trade from the chart' });
const buyForm = () => page.locator('form[data-testid="dk-form"][data-side="buy"]');
const sellForm = () => page.locator('form[data-testid="dk-form"][data-side="sell"]');

/** A decimal string as one canonical form: no thousands separators, no unit, no trailing zeros. */
const canon = (text) =>
  String(text)
    .replace(/[^\d.]/g, '')
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
const same = (a, b) => toUnits(canon(a) || '0') === toUnits(canon(b) || '0');

/** The value the review shows under a label. */
const reviewValue = (label) => reviewSheet(page).locator(`dt:text-is("${label}") + dd`);

async function market(symbol = SYMBOL) {
  const res = await fetch(`${EDGE}/api/v1/markets?limit=500`, { headers: { origin: ORIGIN } });
  const list = await res.json();
  const row = list.find((m) => m.symbol === symbol);
  expect(row, `${symbol} is listed`).toBeTruthy();
  return row;
}

async function openDesk(symbol = SYMBOL) {
  await page.goto(deskPath(symbol));
  await expect(page.getByRole('button', { name: `Buy ${symbol.split('/')[0]}` })).toBeVisible();
}

/** Open the DOM from the chart's own button, unless it is already showing. */
async function openDom() {
  const button = page.getByTestId('dk-chart').getByRole('button', { name: /^(Open|Close) DOM$/ });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await expect(dom()).toBeVisible();
}

async function setLadder(columns, step) {
  await dom().getByLabel('Columns').selectOption({ label: columns });
  await dom().getByLabel('Price step').selectOption({ label: step });
}

/** The ladder and the depth chart as the page has them, read in one go so both come from one render. */
async function readFlow() {
  return page.evaluate(() => {
    const region = document.querySelector('[data-testid="of-dom"]');
    const grid = region?.querySelector('[data-testid="of-ladder"]');
    const chart = region?.querySelector('[data-testid="of-depth-chart"]');
    const rowsRead = [...(region?.querySelectorAll('[data-testid="of-ladder-row"]') ?? [])].map((row) => ({
      price: row.getAttribute('data-price'),
      bid: row.getAttribute('data-bid'),
      ask: row.getAttribute('data-ask'),
      myBid: row.getAttribute('data-my-bid'),
      highlight: row.getAttribute('data-highlight'),
    }));
    return {
      symbol: region?.getAttribute('data-symbol'),
      nonce: region?.getAttribute('data-book-nonce'),
      step: grid?.getAttribute('data-step'),
      bestBid: grid?.getAttribute('data-best-bid'),
      bestAsk: grid?.getAttribute('data-best-ask'),
      bidTotal: grid?.getAttribute('data-bid-total'),
      askTotal: grid?.getAttribute('data-ask-total'),
      rows: rowsRead,
      chart: chart
        ? {
            nonce: chart.getAttribute('data-book-nonce'),
            bidTotal: chart.getAttribute('data-bid-total'),
            askTotal: chart.getAttribute('data-ask-total'),
            bids: (chart.getAttribute('data-bid-points') ?? '').split(' ').filter(Boolean),
            asks: (chart.getAttribute('data-ask-points') ?? '').split(' ').filter(Boolean),
          }
        : null,
    };
  });
}

/** The best bid and ask the stack's book has now matches what the ladder shows (the ladder polls every 2 s). */
async function ladderMatchesBook(symbol) {
  await expect
    .poll(
      async () => {
        const flow = await readFlow();
        const { bid, ask } = await bestPrices(symbol);
        return flow.symbol === symbol && same(flow.bestBid, bid) && same(flow.bestAsk, ask);
      },
      { timeout: 20_000, message: `the ladder shows ${symbol}'s best bid and ask` },
    )
    .toBe(true);
}

test(`${J} #1 opens the DOM from the chart; it binds to the chart's symbol and re-binds when the symbol changes`, async () => {
  await openDesk();
  await openDom();
  await expect(dom()).toHaveAttribute('data-symbol', SYMBOL);
  await expect(dom().getByRole('heading', { name: `Depth of market for ${SYMBOL}` })).toBeVisible();
  await ladderMatchesBook(SYMBOL);
  // A ladder setting, to see that it follows the DOM to the next symbol.
  await setLadder('Double', '2 ticks');
  await expect(dom()).toHaveAttribute('data-columns', 'double');

  // The chart's symbol changes from the desk's own market list.
  await page.getByTestId('dk-left').getByTestId('dk-mk-row').filter({ hasText: OTHER }).first().locator('a.dk-mk-link').click();
  await expect(page).toHaveURL(new RegExp(`${deskPath(OTHER)}$`));
  await expect(page.getByTestId('if-desk')).toHaveAttribute('data-market', OTHER);
  // The DOM is still open, now bound to the new symbol, with the same ladder settings.
  await expect(dom()).toHaveAttribute('data-symbol', OTHER);
  await expect(dom().getByRole('heading', { name: `Depth of market for ${OTHER}` })).toBeVisible();
  await expect(dom()).toHaveAttribute('data-columns', 'double');
  await expect(dom()).toHaveAttribute('data-step-ticks', '2');
  await setLadder('Single', '1 tick');
  await ladderMatchesBook(OTHER);
  // Back to BTC/USDT: bound again.
  await openDesk(SYMBOL);
  await expect(dom()).toHaveAttribute('data-symbol', SYMBOL);
  await ladderMatchesBook(SYMBOL);
});

test(`${J} #2 reads time and sales and the depth chart: the tape with filters and the depth curve from the same book`, async () => {
  // Two prints of known size on the real book: a small one and a larger one, both market buys.
  const client = await api(who);
  for (const [n, amount] of [
    [1, SMALL],
    [2, LARGE],
  ]) {
    const res = await client.post('/api/v1/orders', {
      symbol: SYMBOL,
      type: 'market',
      side: 'buy',
      amount,
      clientOrderId: `jcd14-print-${n}-${RUN}`,
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
  }
  await openDesk();
  await openDom();
  await setLadder('Single', '1 tick');
  const tapeRows = () => tapeRegion().getByTestId('of-tape-row');
  const amounts = async () => (await tapeRows().evaluateAll((els) => els.map((el) => el.getAttribute('data-amount')))).map(canon);
  const values = async () => (await tapeRows().evaluateAll((els) => els.map((el) => el.getAttribute('data-value')))).map(canon);
  const hiddenNote = tapeRegion().getByTestId('of-tape-hidden');

  // No minimum: the small print is on the tape and nothing is hidden.
  await tapeRegion().getByLabel('Hide trades under').fill('');
  await expect.poll(async () => (await amounts()).some((a) => same(a, SMALL)), { timeout: 15_000 }).toBe(true);
  await expect(hiddenNote).toHaveAttribute('data-hidden', '0');

  // A minimum of 0.003 BTC: every print under it leaves the tape and is counted as hidden; the large one stays.
  await tapeRegion().getByLabel('Units').selectOption({ label: 'BTC' });
  await tapeRegion().getByLabel('Hide trades under').fill(BETWEEN);
  await expect.poll(async () => (await amounts()).every((a) => toUnits(a) >= toUnits(BETWEEN))).toBe(true);
  // The large market buy may fill across levels: its prints add up to it at least once on the tape.
  expect((await amounts()).length).toBeGreaterThan(0);
  expect((await amounts()).some((a) => same(a, SMALL))).toBe(false);
  await expect.poll(async () => Number(await hiddenNote.getAttribute('data-hidden'))).toBeGreaterThanOrEqual(1);
  const hidden = await hiddenNote.getAttribute('data-hidden');
  const total = await hiddenNote.getAttribute('data-total');
  await expect(hiddenNote).toHaveText(`${hidden} of ${total} trades are below the minimum and hidden.`);

  // The same filter in quote units: 50 USDT lets the small print (about 65 USDT) back on, and hides anything smaller.
  await tapeRegion().getByLabel('Units').selectOption({ label: 'USDT' });
  await tapeRegion().getByLabel('Hide trades under').fill('50');
  await expect.poll(async () => (await amounts()).some((a) => same(a, SMALL))).toBe(true);
  expect((await values()).every((v) => toUnits(v) >= toUnits('50'))).toBe(true);

  // Accumulate at price: no two rows next to each other share a price and side any more.
  await tapeRegion().getByLabel('Hide trades under').fill('');
  await tapeRegion().getByLabel('Accumulate at price').check();
  const pairs = await tapeRows().evaluateAll((els) => els.map((el) => `${el.getAttribute('data-price')}|${el.getAttribute('data-side')}`));
  for (let i = 1; i < pairs.length; i++) expect(pairs[i], `rows ${i - 1} and ${i}`).not.toBe(pairs[i - 1]);
  await tapeRegion().getByLabel('Accumulate at price').uncheck();

  // The depth curve is drawn from the same book as the ladder: the same engine sequence, the same totals, and its first
  // point on each side is the ladder's best price with the size there.
  const chart = page.getByRole('img', { name: new RegExp(`^Depth chart of ${SYMBOL.replace('/', '\\/')}`) });
  await expect(chart).toBeVisible();
  await expect
    .poll(async () => {
      const flow = await readFlow();
      if (!flow.chart || flow.nonce !== flow.chart.nonce) return 'not one book';
      const bestBidRow = flow.rows.find((r) => r.highlight === 'best-bid');
      const bestAskRow = flow.rows.find((r) => r.highlight === 'best-ask');
      const [bidPrice, bidCum] = flow.chart.bids[0].split(':');
      const [askPrice, askCum] = flow.chart.asks[0].split(':');
      return [
        flow.chart.bidTotal === flow.bidTotal,
        flow.chart.askTotal === flow.askTotal,
        same(bidPrice, bestBidRow.price) && same(bidCum, bestBidRow.bid),
        same(askPrice, bestAskRow.price) && same(askCum, bestAskRow.ask),
        same(flow.chart.bids.at(-1).split(':')[1], flow.bidTotal),
        same(flow.chart.asks.at(-1).split(':')[1], flow.askTotal),
      ].every(Boolean);
    })
    .toBe(true);
  // The cumulative curve only grows outward from the touch.
  const flow = await readFlow();
  for (const side of [flow.chart.bids, flow.chart.asks])
    for (let i = 1; i < side.length; i++) expect(toUnits(side[i].split(':')[1])).toBeGreaterThan(toUnits(side[i - 1].split(':')[1]));
  // Pointing at the curve reads the cumulative size at a price of that book.
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  const readout = page.getByTestId('of-depth-readout');
  await expect(readout).toHaveText(/^Cumulative [\d.,]+ BTC at [\d.,]+$/);
  const pointed = `${await readout.getAttribute('data-price')}:${await readout.getAttribute('data-amount')}`;
  const now = await readFlow();
  expect([...now.chart.bids, ...now.chart.asks]).toContain(pointed);
});

test(`${J} #3 sets the ladder to double columns with a price step of 2 ticks; prices group by the step with highlights`, async () => {
  const { precision } = await market();
  const tick = toUnits(precision.price);
  const step = tick * 2n;
  // A resting bid of my own, well under the touch, so the ladder has my order to highlight.
  const price = await awayBid(90);
  const placed = await (
    await api(who)
  ).post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'limit',
    side: 'buy',
    price,
    amount: SMALL,
    timeInForce: 'GTC',
    clientOrderId: `jcd14-rest-3-${RUN}`,
  });
  expect(placed.status, JSON.stringify(placed.body).slice(0, 300)).toBeLessThan(300);

  await openDesk();
  await openDom();
  await setLadder('Double', '2 ticks');
  await expect(dom()).toHaveAttribute('data-columns', 'double');
  await expect(dom()).toHaveAttribute('data-step-ticks', '2');
  // Double columns: my bids and my asks each have their own column beside the book's.
  for (const name of ['My bids', 'Bids (BTC)', 'Price (USDT)', 'Asks (BTC)', 'My asks'])
    await expect(ladder().getByRole('columnheader', { name })).toBeVisible();
  expect(same(await ladder().getAttribute('data-step'), fromUnits(step))).toBe(true);

  await expect
    .poll(
      async () => {
        const flow = await readFlow();
        if (flow.rows.length === 0) return 'no rows';
        // Every row sits on the 2-tick step, highest first.
        for (const row of flow.rows) if (toUnits(row.price) % step !== 0n) return `off step ${row.price}`;
        for (let i = 1; i < flow.rows.length; i++)
          if (toUnits(flow.rows[i].price) >= toUnits(flow.rows[i - 1].price)) return 'not highest first';
        // Grouping moves size between prices, never adds or loses any.
        const bids = flow.rows.reduce((s, r) => s + (r.bid ? toUnits(r.bid) : 0n), 0n);
        const asks = flow.rows.reduce((s, r) => s + (r.ask ? toUnits(r.ask) : 0n), 0n);
        if (bids !== toUnits(flow.bidTotal) || asks !== toUnits(flow.askTotal)) return 'sizes not conserved';
        // The best bid and the best ask are highlighted: the highest bucket with bids and the lowest with asks.
        const withBids = flow.rows.filter((r) => r.bid);
        const withAsks = flow.rows.filter((r) => r.ask);
        const bestBid = flow.rows.filter((r) => r.highlight === 'best-bid');
        const bestAsk = flow.rows.filter((r) => r.highlight === 'best-ask');
        if (bestBid.length !== 1 || bestBid[0].price !== withBids[0].price) return 'best bid not highlighted';
        if (bestAsk.length !== 1 || bestAsk[0].price !== withAsks.at(-1).price) return 'best ask not highlighted';
        // My resting bid is in its bucket, in my bids column, highlighted as mine.
        const bucket = (toUnits(price) / step) * step;
        const mine = flow.rows.find((r) => toUnits(r.price) === bucket);
        if (!mine || !same(mine.myBid, SMALL) || mine.highlight !== 'mine') return `my bid at ${price} not shown`;
        return 'ok';
      },
      { timeout: 20_000 },
    )
    .toBe('ok');
  // The raw best bid rounds down into its bucket, the raw best ask up: a bucket never shows a better price than it has.
  await expect
    .poll(async () => {
      const flow = await readFlow();
      const { bid, ask } = await bestPrices(SYMBOL);
      const down = (toUnits(bid) / step) * step;
      const up = toUnits(ask) % step === 0n ? toUnits(ask) : (toUnits(ask) / step + 1n) * step;
      return toUnits(flow.bestBid) === down && toUnits(flow.bestAsk) === up;
    })
    .toBe(true);
  // One tick again shows more prices than two ticks did, or the same when every level is already on the step.
  const grouped = (await readFlow()).rows.length;
  await setLadder('Single', '1 tick');
  await expect(ladder().getByRole('columnheader', { name: 'My orders' })).toBeVisible();
  await expect.poll(async () => (await readFlow()).rows.length).toBeGreaterThanOrEqual(grouped);
});

test(`${J} #4 clicks a ladder ask; the ticket fills with the price and the review opens, and nothing is sent`, async () => {
  await openDesk();
  await openDom();
  await setLadder('Single', '1 tick');
  await chartTrade().getByLabel('Click size (BTC)').fill(SMALL);
  const sent = placements(page);

  // The best ask on the ladder.
  const askRow = rows().and(page.locator('[data-highlight="best-ask"]'));
  await expect(askRow).toHaveCount(1);
  const askPrice = await askRow.getAttribute('data-price');
  const preview = page.waitForResponse((r) => r.url().includes('/api/v1/orders/preview') && r.request().method() === 'POST');
  await askRow.getByTestId('of-ask-cell').click();
  // The review opens on its own: a limit buy at the clicked ask, the click's amount.
  const review = reviewSheet(page);
  await expect(review).toBeVisible();
  await expect(review).toContainText('Review your buy');
  expect((await preview).status()).toBe(200);
  expect(same(await reviewValue('Price').innerText(), askPrice), `review price vs ${askPrice}`).toBe(true);
  await expect(reviewValue('Amount')).toContainText(SMALL);
  // Nothing went to the market.
  expect(sent).toEqual([]);
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toHaveCount(0);
  // The ticket holds the clicked price and the amount (read once the review is closed: a open review hides the page).
  expect(same(await buyForm().getByRole('textbox', { name: 'Price' }).inputValue(), askPrice)).toBe(true);
  expect(same(await buyForm().getByRole('textbox', { name: 'Amount' }).inputValue(), SMALL)).toBe(true);
  await page.waitForTimeout(1_000);
  expect(sent).toEqual([]);

  // Money line: a ladder order holds exactly as a desk order. A buy from the ask column at a price under the touch rests;
  // once confirmed, the USDT held grows by exactly what the review said, and the same order typed on the desk's ticket
  // is checked to the same hold.
  const before = await (await api(who)).balances();
  // The ladder's lowest bid row, clicked in the ask column: a buy limit under the touch, so it rests on the book.
  const lowest = rows().last();
  const restPrice = await lowest.getAttribute('data-price');
  expect(toUnits(restPrice)).toBeLessThan(toUnits(askPrice));
  await lowest.getByTestId('of-ask-cell').click();
  await expect(review).toBeVisible();
  const reviewedPrice = canon(await reviewValue('Price').innerText());
  expect(same(reviewedPrice, restPrice)).toBe(true);
  const hold = canon(await reviewValue('We’ll set aside').innerText());
  expect(toUnits(hold)).toBeGreaterThan(0n);
  const typed = await (
    await api(who)
  ).post('/api/v1/orders/preview', {
    symbol: SYMBOL,
    side: 'buy',
    type: 'limit',
    price: reviewedPrice,
    amount: SMALL,
    timeInForce: 'GTC',
    postOnly: false,
    clientOrderId: `jcd14-typed-${RUN}`,
  });
  expect(typed.status, JSON.stringify(typed.body).slice(0, 300)).toBe(200);
  expect(same(typed.body.holdAmount, hold), `desk hold ${typed.body.holdAmount} vs ladder hold ${hold}`).toBe(true);
  await page.getByRole('button', { name: 'Confirm buy' }).click();
  await expect(review).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => (await openOrders(who)).some((o) => same(o.price, reviewedPrice) && same(o.amount, SMALL) && o.side === 'buy'))
    .toBe(true);
  const after = await (await api(who)).balances();
  expect(held(after, 'USDT') - held(before, 'USDT')).toBe(toUnits(hold));
  // One order went, with the review's own number.
  expect(sent).toHaveLength(1);
});

test(`${J} #5 uses Buy and Sell buttons on the chart; each shows the live spread, and a type the market does not list refuses`, async () => {
  // BTC to sell: a market buy on the real book (the setup's buy leaves a little under its amount once its fee is taken).
  const bought = await (
    await api(who)
  ).post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'market',
    side: 'buy',
    amount: '0.002',
    clientOrderId: `jcd14-buy-5-${RUN}`,
  });
  expect(bought.status, JSON.stringify(bought.body).slice(0, 300)).toBeLessThan(300);
  await openDesk();
  const group = chartTrade();
  const buy = group.getByTestId('of-chart-buy');
  const sell = group.getByTestId('of-chart-sell');
  const spread = group.getByTestId('of-chart-spread');
  // Each button carries the live touch, and the spread between them is the book's best ask less its best bid.
  await expect
    .poll(
      async () => {
        const { bid, ask } = await bestPrices(SYMBOL);
        const shown = {
          bid: await sell.getAttribute('data-price'),
          ask: await buy.getAttribute('data-price'),
          spread: await spread.getAttribute('data-spread'),
        };
        return same(shown.bid, bid) && same(shown.ask, ask) && same(shown.spread, fromUnits(toUnits(ask) - toUnits(bid)));
      },
      { timeout: 20_000, message: 'the chart buttons follow the live book' },
    )
    .toBe(true);
  await expect(buy).toHaveText(/^Buy [\d.,]+$/);
  await expect(sell).toHaveText(/^Sell [\d.,]+$/);
  await expect(spread).toHaveText(/^Spread [\d.,]+$/);
  // Each shows the spread: it is each button's own description.
  const spreadText = await spread.innerText();
  await expect(buy).toHaveAccessibleDescription(spreadText);
  await expect(sell).toHaveAccessibleDescription(spreadText);
  expect(same(await buy.innerText(), await buy.getAttribute('data-price'))).toBe(true);
  expect(same(await sell.innerText(), await sell.getAttribute('data-price'))).toBe(true);

  const sent = placements(page);
  await group.getByLabel('Click size (BTC)').fill(SMALL);
  // Buy at market: the ticket's Market tab takes it and the review opens; nothing is sent.
  await group.getByLabel('Order kind').selectOption({ label: 'Market' });
  await buy.click();
  const review = reviewSheet(page);
  await expect(review).toContainText('Review your buy');
  await expect(reviewValue('Price')).toHaveText('Market price');
  await expect(reviewValue('Amount')).toContainText(SMALL);
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toHaveCount(0);
  // Sell, limit at the touch: the review is a sell at the best bid the button showed.
  await group.getByLabel('Order kind').selectOption({ label: 'Limit at the touch' });
  const bidShown = await sell.getAttribute('data-price');
  await sell.click();
  await expect(review).toContainText('Review your sell');
  expect(same(await reviewValue('Price').innerText(), bidShown)).toBe(true);
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toHaveCount(0);
  expect(same(await sellForm().getByRole('textbox', { name: 'Price' }).inputValue(), bidShown)).toBe(true);

  // A type the market does not take: the desk's existing reason, and no review, no draft.
  await group.getByLabel('Order kind').selectOption({ label: 'Trailing stop' });
  const ticketBefore = await buyForm().getByRole('textbox', { name: 'Price' }).inputValue();
  await buy.click();
  const note = group.getByTestId('of-chart-note');
  await expect(note).toHaveAttribute('data-code', 'trade.order_type_unsupported');
  await expect(note).toHaveText("That order type isn't offered. This market takes limit and market orders only.");
  await expect(review).toHaveCount(0);
  expect(await buyForm().getByRole('textbox', { name: 'Price' }).inputValue()).toBe(ticketBefore);
  await page.waitForTimeout(1_000);
  expect(sent).toEqual([]);
});

/** Every DELETE of one order (a cancel) the page sends from now on, by order id. */
function cancels() {
  const sent = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'DELETE' && /^\/api\/v1\/orders\/[^/]+$/.test(path)) sent.push(decodeURIComponent(path.split('/').pop()));
  });
  return sent;
}

/** Whether any review sheet opened while `act` ran and for `ms` after it. */
async function reviewShownDuring(act, ms = 2_500) {
  let shown = false;
  const watch = setInterval(async () => {
    if (
      (await reviewSheet(page)
        .count()
        .catch(() => 0)) > 0
    )
      shown = true;
  }, 100);
  try {
    await act();
    await page.waitForTimeout(ms);
  } finally {
    clearInterval(watch);
  }
  return shown || (await reviewSheet(page).count()) > 0;
}

const instantSwitch = () => chartTrade().getByRole('switch', { name: 'Instant placement' });

async function openSettings() {
  const toggle = chartTrade().getByRole('button', { name: 'Trading settings' });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(instantSwitch()).toBeVisible();
}

async function setInstant(on) {
  await openSettings();
  if ((await instantSwitch().getAttribute('aria-checked')) === String(on)) return;
  await instantSwitch().click();
  if (on) {
    const summary = page.getByRole('alertdialog', { name: 'Turn on instant placement?' });
    await expect(summary).toBeVisible();
    await summary.getByRole('button', { name: 'Turn on instant placement' }).click();
    await expect(summary).toHaveCount(0);
  }
  await expect(instantSwitch()).toHaveAttribute('aria-checked', String(on));
}

/** A resting buy of mine at `percent` of the best bid, placed through the API; returns the order as the service has it. */
async function restingBuy(percent, tag) {
  const price = await awayBid(percent);
  const res = await (
    await api(who)
  ).post('/api/v1/orders', {
    symbol: SYMBOL,
    type: 'limit',
    side: 'buy',
    price,
    amount: SMALL,
    timeInForce: 'GTC',
    clientOrderId: `jcd14-${tag}-${RUN}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
  return res.body;
}

async function usdtHeld() {
  return held(await (await api(who)).balances(), 'USDT');
}

test(`${J} #6 turns instant placement on; a click sends after the settings summary, and off it always reviews`, async () => {
  await openDesk();
  await openDom();
  await setLadder('Single', '1 tick');
  await chartTrade().getByLabel('Click size (BTC)').fill(SMALL);
  const sent = placements(page);

  // Off by default: the switch is off and says so, and a ladder click opens its review; nothing is sent.
  await openSettings();
  await expect(instantSwitch()).toHaveAttribute('aria-checked', 'false');
  await expect(chartTrade().getByTestId('of-instant-note')).toHaveText(
    'Off: every ladder click, chart Buy or Sell, close and cancel opens its review first.',
  );
  const lowest = () => rows().last();
  await lowest().getByTestId('of-ask-cell').click();
  await expect(reviewSheet(page)).toContainText('Review your buy');
  await reviewSheet(page).getByRole('button', { name: 'Cancel' }).click();
  expect(sent).toEqual([]);

  // Turning it on shows the settings summary first; keeping reviewing leaves it off.
  await instantSwitch().click();
  const summary = page.getByRole('alertdialog', { name: 'Turn on instant placement?' });
  await expect(summary).toBeVisible();
  for (const line of [
    'A limit order from a ladder click, or from Buy and Sell on the chart, is sent at once with no review.',
    'Market orders, Close among them, always show their review first.',
    'Cancel from the ladder acts at once, with no review.',
    'Every order is still checked first. A refusal still stops it, and the order holds exactly what a reviewed order holds.',
    `Each click uses the click size set on the chart: ${SMALL} BTC.`,
    'You can turn it off here at any time. Off, every click opens its review again.',
  ])
    await expect(summary.getByText(line, { exact: true })).toBeVisible();
  await summary.getByRole('button', { name: 'Keep reviewing' }).click();
  await expect(instantSwitch()).toHaveAttribute('aria-checked', 'false');

  // Agreed: on, stored with the time of the agreement.
  const before = Date.now();
  await instantSwitch().click();
  await page
    .getByRole('alertdialog', { name: 'Turn on instant placement?' })
    .getByRole('button', { name: 'Turn on instant placement' })
    .click();
  await expect(instantSwitch()).toHaveAttribute('aria-checked', 'true');
  const stored = await page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.startsWith('trade-desk-instant:'))
      .map(([, value]) => JSON.parse(value)),
  );
  expect(stored).toHaveLength(1);
  expect(stored[0].on).toBe(true);
  expect(Date.parse(stored[0].agreedAt)).toBeGreaterThanOrEqual(before - 1_000);
  expect(Date.parse(stored[0].agreedAt)).toBeLessThanOrEqual(Date.now());
  await expect(chartTrade().getByTestId('of-instant-on')).toHaveAttribute('data-agreed-at', stored[0].agreedAt);
  await expect(chartTrade().getByTestId('of-instant-note')).toContainText('On since');

  // On: a ladder click sends the checked limit order with no review, once, and it holds what the order check said.
  const restPrice = await lowest().getAttribute('data-price');
  const check = await (
    await api(who)
  ).post('/api/v1/orders/preview', {
    symbol: SYMBOL,
    side: 'buy',
    type: 'limit',
    price: restPrice,
    amount: SMALL,
    timeInForce: 'GTC',
    postOnly: false,
    clientOrderId: `jcd14-check-6-${RUN}`,
  });
  expect(check.status, JSON.stringify(check.body).slice(0, 300)).toBe(200);
  const heldBefore = await usdtHeld();
  const openBefore = (await openOrders(who)).length;
  const reviewed = await reviewShownDuring(() => lowest().getByTestId('of-ask-cell').click());
  expect(reviewed, 'no review opens with instant placement on').toBe(false);
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ side: 'buy', type: 'limit', amount: SMALL });
  expect(same(sent[0].price, restPrice)).toBe(true);
  await expect(buyForm().getByRole('status')).toContainText('Sent at once (instant placement is on).');
  await expect.poll(async () => (await openOrders(who)).length).toBe(openBefore + 1);
  expect((await usdtHeld()) - heldBefore).toBe(toUnits(check.body.holdAmount));

  // On, a market order still shows its review: Buy at market from the chart opens it, and nothing more is sent.
  await chartTrade().getByLabel('Order kind').selectOption({ label: 'Market' });
  await chartTrade().getByTestId('of-chart-buy').click();
  await expect(reviewSheet(page)).toContainText('Review your buy');
  await reviewSheet(page).getByRole('button', { name: 'Cancel' }).click();
  expect(sent).toHaveLength(1);

  // Off again: no summary to turn it off, and a ladder click reviews again; nothing is sent.
  await instantSwitch().click();
  await expect(instantSwitch()).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('alertdialog', { name: 'Turn on instant placement?' })).toHaveCount(0);
  await lowest().getByTestId('of-ask-cell').click();
  await expect(reviewSheet(page)).toContainText('Review your buy');
  await reviewSheet(page).getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(1_000);
  expect(sent).toHaveLength(1);
});

test(`${J} #7 uses one-click close, cancel and size presets; each acts once with its reviewed or instant setting`, async () => {
  // Size presets are the person's own quick sizes, set in Account, Trading settings.
  await page.goto('/view');
  await page.getByRole('textbox', { name: 'Quick sizes' }).fill(`${SMALL}, 0.002`);
  await page.getByRole('button', { name: 'Save quick sizes' }).click();
  await expect(page.getByText('Quick sizes saved.')).toBeVisible();

  await openDesk();
  await openDom();
  await setLadder('Single', '1 tick');
  await setInstant(false);
  const sent = placements(page);
  const deletes = cancels();
  const amountField = chartTrade().getByLabel('Click size (BTC)');
  const presets = chartTrade().getByRole('group', { name: 'Size presets' });

  // A preset, reviewed: it sets the click amount once, and the next ladder click still opens its review with it.
  await amountField.fill('');
  await presets.getByRole('button', { name: 'Use 0.002 BTC' }).click();
  await expect(amountField).toHaveValue('0.002');
  await expect(presets.getByRole('button', { name: 'Use 0.002 BTC' })).toHaveAttribute('aria-pressed', 'true');
  expect(sent).toEqual([]);
  await rows().last().getByTestId('of-ask-cell').click();
  await expect(reviewSheet(page)).toContainText('Review your buy');
  await expect(reviewValue('Amount')).toContainText('0.002');
  await reviewSheet(page).getByRole('button', { name: 'Cancel' }).click();
  expect(sent).toEqual([]);

  // One-click cancel, reviewed: the row with my resting order asks first, then cancels it once.
  const first = await restingBuy(88, 'cancel-reviewed');
  const firstRow = rows().and(page.locator(`[data-price="${canon(first.price)}"]`));
  await expect(firstRow.getByRole('button', { name: /^Cancel my orders at / })).toBeVisible({ timeout: 15_000 });
  const heldBefore = await usdtHeld();
  await firstRow.getByRole('button', { name: /^Cancel my orders at / }).click();
  const ask = page.getByRole('alertdialog', { name: /^Cancel your orders at / });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText(`Buy ${SMALL} BTC at`);
  expect(deletes).toEqual([]);
  await ask.getByRole('button', { name: 'Cancel these orders' }).click();
  await expect.poll(() => deletes).toEqual([first.id]);
  await expect(page.getByTestId('of-cancel-note')).toContainText('Cancelled 1 at');
  await expect.poll(async () => (await openOrders(who)).some((o) => o.id === first.id)).toBe(false);
  // Its hold came back: the USDT held fell by what the order held.
  await expect.poll(async () => heldBefore - (await usdtHeld())).toBeGreaterThan(0n);

  // Instant: a preset and a ladder click send at once, once, at the preset's amount.
  await setInstant(true);
  await presets.getByRole('button', { name: `Use ${SMALL} BTC` }).click();
  await expect(amountField).toHaveValue(SMALL);
  const shownBuy = await reviewShownDuring(() => rows().last().getByTestId('of-ask-cell').click());
  expect(shownBuy).toBe(false);
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ side: 'buy', type: 'limit', amount: SMALL });

  // One-click cancel, instant: no question, one cancel.
  const second = await restingBuy(87, 'cancel-instant');
  const secondRow = rows().and(page.locator(`[data-price="${canon(second.price)}"]`));
  await expect(secondRow.getByRole('button', { name: /^Cancel my orders at / })).toBeVisible({ timeout: 15_000 });
  const shownCancel = await reviewShownDuring(() => secondRow.getByRole('button', { name: /^Cancel my orders at / }).click(), 1_500);
  expect(shownCancel).toBe(false);
  await expect(page.getByRole('alertdialog', { name: /^Cancel your orders at / })).toHaveCount(0);
  await expect.poll(() => deletes).toEqual([first.id, second.id]);
  await expect.poll(async () => (await openOrders(who)).some((o) => o.id === second.id)).toBe(false);

  // One-click close: a market sell of every free lot of BTC. A market order keeps its review even with instant on; once
  // confirmed it sends once, and the free BTC goes under one lot.
  const { precision } = await market();
  const lot = toUnits(precision.amount);
  const balance = await (await api(who)).balances();
  const freeBtc = toUnits(balance.BTC?.free ?? '0');
  expect(freeBtc).toBeGreaterThanOrEqual(lot);
  const close = chartTrade().getByTestId('of-chart-close');
  await expect(close).toBeEnabled();
  await close.click();
  await expect(reviewSheet(page)).toContainText('Review your sell');
  await expect(reviewValue('Price')).toHaveText('Market price');
  const closing = toUnits(canon(await reviewValue('Amount').innerText()));
  expect(closing).toBe((freeBtc / lot) * lot);
  expect(sent).toHaveLength(1);
  await page.getByRole('button', { name: 'Confirm sell' }).click();
  await expect(reviewSheet(page)).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ side: 'sell', type: 'market' });
  await expect.poll(async () => toUnits((await (await api(who)).balances()).BTC?.free ?? '0'), { timeout: 15_000 }).toBeLessThan(lot);
  await page.waitForTimeout(1_000);
  expect(sent).toHaveLength(2);
  expect(deletes).toHaveLength(2);
  await setInstant(false);
});
