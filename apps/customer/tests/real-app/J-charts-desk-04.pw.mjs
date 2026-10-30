import { test, expect } from '@playwright/test';
import { EDGE } from './stack.mjs';
import { chartBars, expectLines, F, STEP_MS } from './charts-desk-studies.mjs';

// J-charts-desk-04 "I add advanced studies and market analytics series" (docs/roadmap/journeys.json). One test per step,
// titled "J-charts-desk-04 #<n>". This is a DRAFT: it has not been run against the local stack. Each test opens the
// workbench on its own, so the studies it needs are added inside the test. Expected values are worked here from the
// formula on the public candle and trade routes (`/api/v1/ohlcv/:symbol`, `/api/v1/trades/:symbol`), not read from the page.

const MARKET = 'BTC-USDT';
const MARKET_NAME = 'BTC/USDT';
// The public routes name the pair with a slash, url-encoded in the path.
const MARKET_PATH = encodeURIComponent(MARKET_NAME);
const CHART = `/charts/${MARKET}`;

async function candles(timeframe, limit) {
  const res = await fetch(`${EDGE}/api/v1/ohlcv/${MARKET_PATH}?timeframe=${timeframe}&limit=${limit}`);
  if (!res.ok) throw new Error(`the public candle route answered ${res.status}`);
  return res.json();
}

async function trades(limit = 500) {
  const res = await fetch(`${EDGE}/api/v1/trades/${MARKET_PATH}?limit=${limit}`);
  if (!res.ok) throw new Error(`the public trades route answered ${res.status}`);
  return res.json();
}

async function openChart(page, query = '') {
  await page.goto(`${CHART}${query}`);
  await expect(page.getByRole('heading', { name: 'Charts' })).toBeVisible();
  await expect(page.getByTestId('studies')).toBeVisible();
}

async function addStudy(page, search, name) {
  await page.getByRole('button', { name: 'Indicators' }).click();
  await page.getByRole('searchbox', { name: 'Search indicators' }).fill(search);
  await page.getByRole('button', { name: `Add ${name}`, exact: true }).click();
}

const legend = (page) => page.getByTestId('study-legend');
const row = (page, id) => page.locator(`[data-study="${id}"]`);
const host = (page) => page.getByTestId('cw').getByTestId('wc-host');
/** The study series the chart library draws (key, pane, type, colour), as the chart writes them back. */
const drawnStudies = async (page) => JSON.parse((await host(page).getAttribute('data-study-series')) ?? '[]');
/** A study's facts as the legend lists them: { name: text }. */
async function facts(page, id) {
  const texts = await row(page, id).locator('.st-fact').allTextContents();
  return Object.fromEntries(texts.map((t) => [t.slice(0, t.indexOf(':')).trim(), t.slice(t.indexOf(':') + 1).trim()]));
}
/** A shown number is the worked value to the tick (within half a unit of its last digit). */
const atTick = (text, value, digits) =>
  typeof text === 'string' &&
  new RegExp(`^-?\\d+\\.\\d{${digits}}$`).test(text) &&
  Math.abs(Number(text) - value) <= 0.5 * 10 ** -digits + 1e-9;

/** The public tape the volume studies read (the newest 500 prints), oldest first, as the studies take them. */
async function prints() {
  return (await trades(500)).map((r) => ({ t: r.timestamp, side: r.side, amount: Number(r.amount), price: Number(r.price) }));
}

test('J-charts-desk-04 #1 adds Ichimoku with 40 bars loaded: the lines that need 52 bars are absent and the legend says so', async ({
  page,
}) => {
  // The 52-bar rule is about the loaded bars. The TEST history covers a few days, so the 2h interval loads between 26
  // and 52 bars (the base line draws, span B cannot); the count is read from the public route, not assumed.
  const loaded = await candles('2h', 240);
  expect(loaded.length).toBeGreaterThanOrEqual(26);
  expect(loaded.length).toBeLessThan(52);
  await openChart(page, '?interval=2h');
  await addStudy(page, 'ichimoku', 'Ichimoku Cloud');
  await expect(row(page, 'ichimoku-1')).toContainText('Leading B: Needs 52 bars');
  // The lines that can be worked are drawn and the one that cannot is absent: the library holds Conversion, Base,
  // Lagging and Leading A for the study, and no Leading B, so there is no span B and no cloud between A and B.
  await expect
    .poll(async () => (await drawnStudies(page)).filter((x) => x.key.startsWith('ichimoku-1:')).map((x) => x.key))
    .toEqual(['ichimoku-1:t', 'ichimoku-1:k', 'ichimoku-1:l', 'ichimoku-1:a']);
  await expect(row(page, 'ichimoku-1').locator('[data-series="Leading B"]')).toHaveCount(0);
  // The lines that are drawn carry their formula's values at the last bar: the midpoints over 9 and 26 bars.
  await page.getByRole('checkbox', { name: 'Legend always shown' }).check();
  await expectLines(
    page,
    'ichimoku-1',
    2,
    (bars) => ({ Conversion: F.midpoint(bars, 9, bars.length - 1), Base: F.midpoint(bars, 26, bars.length - 1) }),
    '2h',
  );
});

test('J-charts-desk-04 #2 adds pivot points and auto levels on the daily interval: the levels come from the prior day by the stated formula', async ({
  page,
}) => {
  const daily = await candles('1d', 3);
  // Prior day = the bar before the last one: high, low and close as the route sends them.
  const [, , prevHigh, prevLow, prevClose] = daily[daily.length - 2];
  const H = Number(prevHigh);
  const L = Number(prevLow);
  const C = Number(prevClose);
  const P = (H + L + C) / 3;
  await openChart(page, '?interval=1d');
  await addStudy(page, 'pivot', 'Pivot points');
  await addStudy(page, 'auto', 'Auto levels');
  // Values show with the legend always shown (or under the pointer); the last bar's levels come from the prior day.
  await page.getByRole('checkbox', { name: 'Legend always shown' }).check();
  await expect(row(page, 'pivots-1')).toContainText(`${H.toFixed(2)} / ${L.toFixed(2)} / ${C.toFixed(2)}`);
  // Every level at the last bar by the classic formula from the prior day (P, R1-R3, S1-S3), and the auto levels are the
  // prior day's high, low and close, worked from the daily bars the chart holds.
  const priorOf = (bars) => {
    const b = bars[bars.length - 2];
    return { high: b.h, low: b.l, close: b.c };
  };
  expect(priorOf(await chartBars('1d'))).toEqual({ high: H, low: L, close: C });
  await expectLines(page, 'pivots-1', 2, (bars) => F.pivots(priorOf(bars)), '1d');
  await expect(row(page, 'pivots-1')).toContainText(P.toFixed(2));
  await expectLines(
    page,
    'auto-levels-1',
    2,
    (bars) => {
      const p = priorOf(bars);
      return { 'Prior high': p.high, 'Prior low': p.low, 'Prior close': p.close };
    },
    '1d',
  );
});

test('J-charts-desk-04 #3 reads the technical rating: the rating with its inputs and its counts', async ({ page }) => {
  await openChart(page);
  await addStudy(page, 'rating', 'Technical rating');
  const rating = row(page, 'rating-1');
  // The inputs and the rating: each of the nine signals at the last bar, worked here by its stated rule from the bars the
  // chart holds, and the counts of buy, neutral, sell and no value are those signals counted.
  const word = (v) => (v === null ? 'No value' : v === 1 ? 'Buy' : v === -1 ? 'Sell' : 'Neutral');
  const against = (value, compare) => {
    if (value === null || compare === null || value === undefined || compare === undefined) return null;
    const eps = 1e-9 * Math.max(1, Math.abs(compare));
    return value - compare > eps ? 1 : compare - value > eps ? -1 : 0;
  };
  const worked = (bars) => {
    const closes = bars.map((b) => b.c);
    const i = closes.length - 1;
    const out = {};
    for (const p of [20, 50, 200]) {
      out[`SMA ${p}`] = against(closes[i], F.sma(closes, p, i));
      out[`EMA ${p}`] = against(closes[i], F.emaLine(closes, p)[i]);
    }
    const r = F.rsiLine(closes, 14)[i];
    out['RSI 14'] = r === null ? null : r < 30 ? 1 : r > 70 ? -1 : 0;
    const k = F.stochK(bars, 14, i);
    out['Stochastic %K 14'] = k === null ? null : k < 20 ? 1 : k > 80 ? -1 : 0;
    const m = F.macd(closes, 12, 26, 9);
    out['MACD 12 26 9'] = against(m.line[i], m.signal[i]);
    const counts = { Buy: 0, Neutral: 0, Sell: 0, 'No value': 0 };
    for (const v of Object.values(out)) counts[word(v)] += 1;
    return {
      ...Object.fromEntries(Object.entries(out).map(([n, v]) => [n, word(v)])),
      ...Object.fromEntries(Object.entries(counts).map(([n, c]) => [n, String(c)])),
    };
  };
  await expect
    .poll(async () => JSON.stringify(await facts(page, 'rating-1')) === JSON.stringify(worked(await chartBars('15m'))), { timeout: 30_000 })
    .toBe(true);
  const shown = await facts(page, 'rating-1');
  expect(Object.keys(shown)).toHaveLength(13);
  expect(['Buy', 'Neutral', 'Sell', 'No value'].reduce((n, k) => n + Number(shown[k]), 0)).toBe(9);
  // No weights are entered, so there is no score: the rating says why, and shows no number for it.
  await expect(rating).toContainText('Enter every rating weight to see a score.');
  await expect(rating).not.toContainText('Score');
});

test('J-charts-desk-04 #4 adds volume delta and a volume profile: series from the public tape, or a refusal when there is no tape', async ({
  page,
}) => {
  const tape = await trades(500);
  await openChart(page);
  await addStudy(page, 'delta', 'Volume delta');
  await addStudy(page, 'profile', 'Volume profile');
  if (tape.length === 0) {
    await expect(legend(page)).toContainText('No public trades for this market.');
    return;
  }
  await page.getByRole('checkbox', { name: 'Legend always shown' }).check();
  // Volume delta from the public tape: at the last bar, buys minus sells of the prints in its bucket, and the running total
  // over the bars the tape covers (from its first whole bucket); the facts name how many prints were read.
  const step = STEP_MS['15m'];
  await expect
    .poll(
      async () => {
        const [tape, bars] = [await prints(), await chartBars('15m')];
        const first = Math.min(...tape.map((p) => p.t));
        const coveredFrom = Math.floor(first / step) * step === first ? first : Math.floor(first / step) * step + step;
        const delta = bars.map((b) => {
          const mine = tape.filter((p) => Math.floor(p.t / step) * step === b.t);
          if (mine.length === 0 || b.t < coveredFrom) return null;
          return mine.reduce((sum, p) => sum + (p.side === 'buy' ? p.amount : -p.amount), 0);
        });
        let total = 0;
        const cumulative = delta.map((d) => (d === null ? null : (total += d)));
        const last = bars.length - 1;
        const text = async (name) =>
          (await row(page, 'volume-delta-1').locator(`[data-series="${name}"] .st-value-text`).textContent()).trim();
        const f = await facts(page, 'volume-delta-1');
        const okLine = async (name, v) => (v === null ? (await text(name)) === '—' : atTick(await text(name), v, 5));
        return [
          f['Public trades read'] === String(tape.length),
          f['Bars covered by the trades'] === String(bars.filter((b) => b.t >= coveredFrom).length),
          await okLine('Delta', delta[last]),
          await okLine('Cumulative delta', cumulative[last]),
        ].join(' ');
      },
      { timeout: 30_000 },
    )
    .toBe('true true true true');
  // The volume profile: the prints' amounts in 24 equal price bins from the lowest to the highest print; the point of
  // control is the bin with the most volume, named by its price range.
  await expect
    .poll(
      async () => {
        const tape = await prints();
        const [lo, hi] = [Math.min(...tape.map((p) => p.price)), Math.max(...tape.map((p) => p.price))];
        const width = (hi - lo) / 24;
        const totals = Array.from({ length: 24 }, () => 0);
        for (const p of tape) totals[Math.min(Math.max(width === 0 ? 0 : Math.floor((p.price - lo) / width), 0), 23)] += p.amount;
        const poc = totals.indexOf(Math.max(...totals));
        const [low, high] = width === 0 ? [lo, hi] : [lo + poc * width, lo + (poc + 1) * width];
        const f = await facts(page, 'volume-profile-1');
        const m = /^(\S+) to (\S+)$/.exec(f['Point of control'] ?? '');
        return [f['Public trades read'] === String(tape.length), !!m && atTick(m[1], low, 2) && atTick(m[2], high, 2)].join(' ');
      },
      { timeout: 30_000 },
    )
    .toBe('true true');
});

test('J-charts-desk-04 #5 adds a higher-timeframe study: the study at a coarser interval, aligned to the chart', async ({ page }) => {
  await openChart(page, '?interval=15m');
  await addStudy(page, 'htf', 'Higher-timeframe moving average');
  await page.getByRole('button', { name: 'Settings for Higher-timeframe moving average' }).click();
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: /^Interval/ })
    .selectOption('1h');
  await page.getByRole('button', { name: 'Apply' }).click();
  // The study reads only the hourly bars that end by the chart's last 15m bar (no look-ahead past the chart). In the last
  // quarter of an hour that includes the forming hour, which ends with the forming 15m bar. Worked from the public routes
  // at the moment of each check: a bar that closes while the test runs changes the count on the page and on the route.
  await expect(async () => {
    const quarter = await candles('15m', 1);
    const chartEnd = Number(quarter[quarter.length - 1][0]) + 900_000;
    // The hourly bars as the chart builds them: one per hour from the first that traded (the last 240), a quiet hour
    // filled from the one before, so an hour with no trade still counts.
    const hourly = await candles('1h', 240);
    const firstHour = Math.max(
      Math.min(...hourly.map((bar) => Number(bar[0]))),
      Math.floor(Date.now() / 3_600_000) * 3_600_000 - 239 * 3_600_000,
    );
    let closed = 0;
    for (let t = firstHour; t + 3_600_000 <= chartEnd; t += 3_600_000) closed += 1;
    await expect(row(page, 'htf-sma-1')).toContainText(`Higher bars read: ${closed}`, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
});

test('J-charts-desk-04 #6 adds open interest, funding and an on-chain series: each is refused by name on a spot market, nothing drawn', async ({
  page,
}) => {
  await openChart(page);
  await addStudy(page, 'open interest', 'Open interest');
  await addStudy(page, 'funding', 'Funding rate');
  await addStudy(page, 'on chain', 'On-chain series');
  await expect(legend(page)).toContainText(`Open interest is not published for ${MARKET_NAME}.`);
  await expect(legend(page)).toContainText(`Funding rate is not published for ${MARKET_NAME}.`);
  await expect(legend(page)).toContainText(`On-chain series is not published for ${MARKET_NAME}.`);
  // Nothing drawn: the library holds no series for any of the three (only the workbench's other studies, if any).
  const ids = ['open-interest-1', 'funding-1', 'on-chain-1'];
  for (const id of ids) await expect(row(page, id)).toBeVisible();
  await expect
    .poll(async () => (await drawnStudies(page)).filter((x) => ids.some((id) => x.key === id || x.key.startsWith(`${id}:`))))
    .toEqual([]);
  for (const id of ids) await expect(row(page, id).locator('[data-series]')).toHaveCount(0);
});
