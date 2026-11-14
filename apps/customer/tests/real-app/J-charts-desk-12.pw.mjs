// World: none
import { readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { EDGE, journeyState, signOutBrowser } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-charts-desk-12, in the running app (docs/roadmap/journeys.json): a person screens the market on /trade/screener for
// what fits their rules, picks the columns and the change column's timeframe, saves the screen and updates it, reads the
// same results as a table and as charts, and screens one watchlist and exports the rows. One test per step, titled
// "J-charts-desk-12 #<n>", run in order on one TEST account (the run file keeps it). Every expected row and figure is
// worked from what Edge serves (its markets, tickers and candles), never typed from the page.
const J = 'J-charts-desk-12';
const ROOM = '/trade/screener';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

const filters = (page) => page.getByRole('form', { name: 'Screen filters' });
const results = (page) => page.getByRole('table', { name: 'Screener results' });
const charts = (page) => page.getByRole('list', { name: 'Screener charts' });
const count = (page) => page.getByTestId('screener-count');
const rows = (page) => results(page).locator('tbody tr[data-symbol]');

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** The room with its reads finished: the markets and tickers it screens, and the person's saved screens and lists. */
async function openRoom(page) {
  await page.goto(ROOM);
  await expect(filters(page)).toBeVisible();
  await expect(page.getByTestId('screener-room')).toHaveAttribute('data-status', /^(ready|error)$/);
  expect(await page.getByTestId('screener-room').getAttribute('data-status'), 'the markets, tickers and saved screens were read').toBe(
    'ready',
  );
}

/** Set the filter form as a person would and press Apply. A key left out is cleared (blank: not set). */
async function apply(
  page,
  { quote = 'Any quote', changeMin = '', changeMax = '', volumeMin = '', lastMin = '', lastMax = '', over = 'All markets' } = {},
) {
  const form = filters(page);
  await form.getByRole('combobox', { name: 'Screen over' }).selectOption({ label: over });
  await form.getByRole('combobox', { name: 'Quote' }).selectOption({ label: quote });
  await form.getByRole('textbox', { name: 'Change 24h above (%)' }).fill(changeMin);
  await form.getByRole('textbox', { name: 'Change 24h below (%)' }).fill(changeMax);
  await form.getByRole('textbox', { name: 'Volume 24h above' }).fill(volumeMin);
  await form.getByRole('textbox', { name: 'Last price from' }).fill(lastMin);
  await form.getByRole('textbox', { name: 'Last price to' }).fill(lastMax);
  await form.getByRole('button', { name: 'Apply' }).click();
}

/** The symbols the table shows, top to bottom. */
const shownSymbols = (page) => rows(page).evaluateAll((trs) => trs.map((tr) => tr.dataset.symbol));

/** A shown percent ("+5.12%", "−0.10%" with the typographic minus) as a number of percent points; NaN when none. */
const percentPoints = (text) => {
  const plain = String(text)
    .replace(/−/g, '-')
    .replace(/[,%+\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(plain) ? Number(plain) : NaN;
};

async function edgeJson(path) {
  const res = await fetch(`${EDGE}/api/v1${path}`);
  expect(res.status, `${path} answers`).toBe(200);
  return res.json();
}

/** The markets the screener screens, as Edge publishes them: real spot markets that take orders and are open. */
async function edgeMarkets() {
  const body = await edgeJson('/markets?limit=500');
  const list = Array.isArray(body) ? body : Object.values(body).find(Array.isArray);
  return list.filter((m) => m.spot && !m.paper && m.orderable && (m.lifecycle ? m.lifecycle.state === 'OPEN' : true));
}

/** A ticker's 24 h change in percent points, the way the app works it: from the open and the last, else the served percent. */
function changePoints(ticker) {
  const open = Number(ticker?.open);
  const last = Number(ticker?.last);
  if (ticker?.open != null && ticker?.last != null && open > 0) return ((last - open) / open) * 100;
  return ticker?.percentage == null ? null : Number(ticker.percentage);
}

/**
 * What Edge says a screen of "change above `min` percent, quote `quote`" should hold, and the markets too close to the
 * bound to judge (a quote that ticks between the two reads may cross it).
 */
async function edgeScreen({ quote, changeMin }) {
  const [markets, tickers] = await Promise.all([edgeMarkets(), edgeJson('/tickers?limit=500')]);
  const match = new Set();
  const edge = new Set();
  for (const market of markets) {
    if (quote && market.quote !== quote) continue;
    const change = changePoints(tickers[market.symbol]);
    if (change === null) continue;
    if (Math.abs(change - changeMin) < 0.05) edge.add(market.symbol);
    else if (change > changeMin) match.add(market.symbol);
  }
  return { match, edge, markets, tickers };
}

test(`${J} #1 applies "change above 5 percent and quote USDT": the rows match both, with a count, and no match shows the empty state`, async ({
  page,
}) => {
  const who = await signUp(page, 'scr');
  run.reset({ account: who });
  await signOutBrowser(page.context());
  await signIn(page, who);
  await openRoom(page);

  // The step's own screen: every row Edge says has quote USDT and a 24 h change above 5 %, and no other, with the count.
  await apply(page, { quote: 'USDT', changeMin: '5' });
  await expect(page.getByTestId('screener-applied')).toContainText('Change 24h above 5%');
  await expect(page.getByTestId('screener-applied')).toContainText('Quote USDT');
  // The rows are exactly Edge's open USDT markets with a change above the bound, leaving out only a market so close to the
  // bound that a tick between the two reads could move it across.
  const judge = async (changeMin) => {
    const agrees = async () => {
      const { match, edge } = await edgeScreen({ quote: 'USDT', changeMin });
      const shown = await shownSymbols(page);
      return { shown: shown.filter((s) => !edge.has(s)).sort(), wanted: [...match].sort() };
    };
    await expect
      .poll(
        async () => {
          const { shown, wanted } = await agrees();
          return JSON.stringify(shown) === JSON.stringify(wanted);
        },
        { message: `the rows are exactly Edge's USDT markets with a change above ${changeMin}%` },
      )
      .toBe(true);
    return { shown: await shownSymbols(page) };
  };
  const five = await judge(5);
  if (five.shown.length > 0) {
    await expect(count(page)).toHaveText(`${five.shown.length} ${five.shown.length === 1 ? 'market matches' : 'markets match'}`);
    for (const symbol of five.shown) {
      const row = results(page).locator(`tr[data-symbol="${symbol}"]`);
      expect(symbol.split('/')[1], `${symbol} is quoted in USDT`).toBe('USDT');
      expect(percentPoints(await row.locator('td[data-column="change"]').innerText()), `${symbol} change`).toBeGreaterThan(4.95);
    }
  } else {
    await expect(page.getByText('No market fits this screen', { exact: true })).toBeVisible();
  }

  // Rows and their count, on a bound some USDT markets clear: the lowest USDT change on Edge, less one point, so every
  // USDT market matches and every market quoted in anything else is screened out by the quote alone.
  const { markets, tickers } = await edgeScreen({ quote: 'USDT', changeMin: 0 });
  const usdtChanges = markets
    .filter((m) => m.quote === 'USDT')
    .map((m) => changePoints(tickers[m.symbol]))
    .filter((c) => c !== null);
  expect(usdtChanges.length, 'Edge serves USDT markets with a 24 h change').toBeGreaterThan(0);
  const low = Math.floor(Math.min(...usdtChanges)) - 1;
  await apply(page, { quote: 'USDT', changeMin: String(low) });
  const loose = await judge(low);
  expect(loose.shown.length).toBeGreaterThan(0);
  await expect(count(page)).toHaveText(`${loose.shown.length} ${loose.shown.length === 1 ? 'market matches' : 'markets match'}`);
  for (const symbol of loose.shown) {
    expect(symbol.endsWith('/USDT'), `${symbol} is quoted in USDT`).toBe(true);
    const change = percentPoints(await results(page).locator(`tr[data-symbol="${symbol}"] td[data-column="change"]`).innerText());
    expect(Math.abs(change - changePoints(tickers[symbol])), `${symbol} change agrees with Edge`).toBeLessThan(0.1);
  }

  // No match: a bound no market clears shows the empty state, naming the filter that removed every row.
  await apply(page, { quote: 'USDT', changeMin: '900' });
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText('No market fits this screen', { exact: true })).toBeVisible();
  await expect(page.getByText('Change 24h above 900% removed every market.')).toBeVisible();
});

test(`${J} #2 picks the columns and the change column's timeframe; the columns change`, async ({ page }) => {
  await signIn(page, account());
  await openRoom(page);
  await apply(page, { quote: 'USDT' });
  const headers = () => results(page).locator('thead th').allInnerTexts();
  await expect.poll(headers).toEqual(['Market', 'Last', 'Change 24h', 'Volume 24h']);

  // Columns: drop Volume, add High and Low.
  const columns = page.getByRole('group', { name: 'Columns' });
  await columns.getByRole('checkbox', { name: 'Volume 24h' }).uncheck();
  await columns.getByRole('checkbox', { name: 'High 24h' }).check();
  await columns.getByRole('checkbox', { name: 'Low 24h' }).check();
  await expect.poll(headers).toEqual(['Market', 'Last', 'Change 24h', 'High 24h', 'Low 24h']);
  const [markets, tickers] = await Promise.all([edgeMarkets(), edgeJson('/tickers?limit=500')]);
  const symbol = (await shownSymbols(page))[0];
  expect(symbol, 'a USDT market to read').toBeTruthy();
  expect(markets.some((m) => m.symbol === symbol)).toBe(true);
  const row = results(page).locator(`tr[data-symbol="${symbol}"]`);
  await expect(row.locator('td[data-column="volume"]')).toHaveCount(0);
  for (const [column, field] of [
    ['high', 'high'],
    ['low', 'low'],
  ]) {
    const served = Number(tickers[symbol][field]);
    const shown = Number((await row.locator(`td[data-column="${column}"]`).innerText()).replace(/[^0-9.]/g, ''));
    expect(Math.abs(shown - served) / served, `${symbol} ${column} agrees with Edge`).toBeLessThan(0.005);
  }

  // The change column's own timeframe: 1h measures from the close of the hour bar before the current one, as Edge's
  // candles give it, and the header names the timeframe.
  await page.getByRole('combobox', { name: 'Change timeframe' }).selectOption({ label: '1 hour' });
  await expect.poll(headers).toEqual(['Market', 'Last', 'Change 1h', 'High 24h', 'Low 24h']);
  const cell = row.locator('td[data-column="change"]');
  await expect(cell).toHaveAttribute('data-state', /^(value|no-history)$/);
  await expect
    .poll(
      async () => {
        const [candles, ticker] = await Promise.all([
          edgeJson(`/ohlcv/${encodeURIComponent(symbol)}?timeframe=1h&limit=2`),
          edgeJson(`/ticker/${encodeURIComponent(symbol)}`),
        ]);
        const barStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;
        const before = candles.filter((c) => c[0] < barStart).at(-1);
        const text = await cell.innerText();
        if (!before) return text === 'no history';
        const want = ((Number(ticker.last) - Number(before[4])) / Number(before[4])) * 100;
        return Math.abs(percentPoints(text) - want) < 0.1;
      },
      { message: `${symbol}: the 1h change agrees with Edge's hour candles` },
    )
    .toBe(true);
  // Back to 24h: the header and the figure return to the ticker's own.
  await page.getByRole('combobox', { name: 'Change timeframe' }).selectOption({ label: '24 hours' });
  await expect.poll(headers).toEqual(['Market', 'Last', 'Change 24h', 'High 24h', 'Low 24h']);
});

test(`${J} #3 saves the screen and updates it later; it appears in the list and reopens with its filters`, async ({ page }) => {
  await signIn(page, account());
  await openRoom(page);
  await apply(page, { quote: 'USDT', changeMin: '-50' });
  const columns = page.getByRole('group', { name: 'Columns' });
  await columns.getByRole('checkbox', { name: 'High 24h' }).check();
  await columns.getByRole('checkbox', { name: 'Volume 24h' }).uncheck();
  await page.getByRole('combobox', { name: 'Change timeframe' }).selectOption({ label: '1 day' });

  const saved = page.getByRole('combobox', { name: 'Saved screens' });
  await page.getByRole('textbox', { name: 'Screen name' }).fill('Momentum');
  await page.getByRole('button', { name: 'Save screen' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved Momentum' })).toBeVisible();
  await expect(saved.locator('option', { hasText: 'Momentum' })).toHaveCount(1);

  // A second save with the same name asks before it replaces.
  await page.getByRole('textbox', { name: 'Screen name' }).fill('Momentum');
  await page.getByRole('button', { name: 'Save screen' }).click();
  await expect(page.getByText('A screen named Momentum is saved already. Replace it?')).toBeVisible();
  await page.getByRole('button', { name: 'Keep the saved one' }).click();
  await expect(saved.locator('option', { hasText: 'Momentum' })).toHaveCount(1);

  // Reopened on a fresh load: its filters, columns and timeframe return.
  const form = filters(page);
  const reopen = async () => {
    await page.reload();
    await openRoom(page);
    await expect(form.getByRole('textbox', { name: 'Change 24h above (%)' })).toHaveValue('');
    await saved.selectOption({ label: 'Momentum' });
    await expect(page.getByTestId('screener-applied')).toContainText('Screen Momentum');
  };
  await reopen();
  await expect(form.getByRole('combobox', { name: 'Quote' })).toHaveValue('USDT');
  await expect(form.getByRole('textbox', { name: 'Change 24h above (%)' })).toHaveValue('-50');
  await expect(form.getByRole('textbox', { name: 'Volume 24h above' })).toHaveValue('');
  await expect(form.getByRole('textbox', { name: 'Last price from' })).toHaveValue('');
  await expect(page.getByTestId('screener-applied')).toContainText('Last price from not set');
  await expect(columns.getByRole('checkbox', { name: 'High 24h' })).toBeChecked();
  await expect(columns.getByRole('checkbox', { name: 'Volume 24h' })).not.toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Change timeframe' })).toHaveValue('1d');
  await expect(results(page).locator('thead th')).toHaveText(['Market', 'Last', 'Change 1d', 'High 24h']);

  // Updated later: a new bound saved over the open screen, and it reopens with that bound.
  await form.getByRole('textbox', { name: 'Change 24h above (%)' }).fill('-40');
  await form.getByRole('button', { name: 'Apply' }).click();
  await page.getByRole('button', { name: 'Update Momentum' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Updated Momentum' })).toBeVisible();
  await reopen();
  await expect(form.getByRole('textbox', { name: 'Change 24h above (%)' })).toHaveValue('-40');
  await expect(saved.locator('option', { hasText: 'Momentum' })).toHaveCount(1);
});

test(`${J} #4 switches between table and chart view; each shows the same results`, async ({ page }) => {
  await signIn(page, account());
  await openRoom(page);
  await page.getByRole('combobox', { name: 'Saved screens' }).selectOption({ label: 'Momentum' });
  await expect(rows(page).first()).toBeVisible();
  const inTable = await shownSymbols(page);
  const tableCount = await count(page).innerText();
  const view = page.getByRole('group', { name: 'View' });
  await view.getByRole('button', { name: 'Chart' }).click();
  await expect(view.getByRole('button', { name: 'Chart' })).toHaveAttribute('aria-pressed', 'true');
  await expect(results(page)).toHaveCount(0);
  const cards = charts(page).getByRole('listitem');
  await expect(cards).toHaveCount(inTable.length);
  expect(await cards.evaluateAll((items) => items.map((item) => item.dataset.symbol))).toEqual(inTable);
  await expect(count(page)).toHaveText(tableCount);
  // Each card draws its market's chart, or says it has no history to draw.
  for (const symbol of inTable) {
    const card = charts(page).locator(`li[data-symbol="${symbol}"]`);
    await expect(card.getByRole('heading', { name: symbol })).toBeVisible();
    await expect(card.locator('[data-chart]')).toHaveAttribute('data-chart', /^(drawn|no-history)$/);
  }
  await view.getByRole('button', { name: 'Table' }).click();
  await expect(rows(page)).toHaveCount(inTable.length);
  expect(await shownSymbols(page)).toEqual(inTable);
});

test(`${J} #5 screens one watchlist only, and exports the results as a file of the rows`, async ({ page }) => {
  await signIn(page, account());
  // The person's watchlist, kept on the account from the chart workbench's Watchlists panel (J-charts-desk-11).
  await page.goto('/charts/BTC-USDT');
  const panel = page.getByRole('region', { name: 'Watchlists' });
  await expect(panel).toHaveAttribute('data-status', 'ready');
  for (const [query, symbol] of [
    ['eth', 'ETH/USDT'],
    ['btc', 'BTC/USDT'],
  ]) {
    await panel.getByRole('searchbox', { name: 'Add a market' }).fill(query);
    const saved = page.waitForResponse((res) => /preferences/.test(res.url()) && res.request().method() !== 'GET' && res.ok());
    await panel.getByRole('button', { name: `Add ${symbol}` }).click();
    await saved;
  }
  await expect(panel.locator('tr[data-symbol="ETH/USDT"]')).toBeVisible();

  await openRoom(page);
  await apply(page, {});
  const everyMarket = (await edgeMarkets()).map((m) => m.symbol);
  expect(everyMarket.length, 'the listing has markets beyond the watchlist').toBeGreaterThan(2);
  await expect.poll(async () => (await shownSymbols(page)).length).toBe(everyMarket.length);
  await apply(page, { over: 'Watchlist: Watchlist' });
  await expect.poll(async () => (await shownSymbols(page)).sort()).toEqual(['BTC/USDT', 'ETH/USDT']);
  await expect(count(page)).toHaveText('2 markets match');
  await expect(page.getByTestId('screener-applied')).toContainText('Over Watchlist');

  // Export: a file of exactly the rows shown, each with the last price Edge serves for it.
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^screen-.*\.csv$/);
  const lines = readFileSync(await download.path(), 'utf8')
    .trim()
    .split('\n');
  expect(lines[0]).toBe('symbol,last,change_pct_24h,volume_24h');
  const body = lines.slice(1).map((line) => line.split(','));
  expect(body.map((cells) => cells[0])).toEqual(await shownSymbols(page));
  for (const cells of body) {
    const served = Number((await edgeJson(`/ticker/${encodeURIComponent(cells[0])}`)).last);
    expect(Math.abs(Number(cells[1]) - served) / served, `${cells[0]} last in the file`).toBeLessThan(0.005);
  }
});
