// World: none
import { test, expect } from './journey.mjs';
import { EDGE } from './stack.mjs';
import { atTick, chartBars, expectLines, F, shownText, STEP_MS } from './charts-desk-studies.mjs';

// J-charts-desk-04 "I add advanced studies and market analytics series" (docs/roadmap/journeys.json). One test per step,
// titled "J-charts-desk-04 #<n>". Each test opens the workbench on its own, so the studies it needs are added inside the
// test. Expected values are worked here from the formula on the public candle and trade routes (`/api/v1/ohlcv/:symbol`,
// `/api/v1/trades/:symbol`), not read from the page.

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

/**
 * An open spot market the public tape holds no trade for, read from the public routes (the markets list, then each one's
 * newest trade). The step's other branch needs one; a stack whose every market trades fails here by name.
 */
async function untradedMarket() {
  const res = await fetch(`${EDGE}/api/v1/markets?limit=500`);
  expect(res.status).toBe(200);
  const listed = [];
  for (const m of await res.json()) {
    if (typeof m.symbol !== 'string' || m.symbol.includes(':')) continue;
    // Only a market open for trading: a market that is not open has no chart studies to read.
    const life = await fetch(`${EDGE}/api/v1/market-lifecycle/${encodeURIComponent(m.symbol)}`);
    if (!life.ok || (await life.json()).state !== 'OPEN') continue;
    listed.push(m.symbol);
    const tape = await fetch(`${EDGE}/api/v1/trades/${encodeURIComponent(m.symbol)}?limit=1`);
    if (tape.ok && (await tape.json()).length === 0) return m.symbol;
  }
  throw new Error(`no open spot market is without trades on this stack (open: ${listed.join(', ')})`);
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

test('J-charts-desk-04 #4 adds volume delta and a volume profile: series built from the public tape; on a market with no tape the chart says so and draws neither', async ({
  page,
}) => {
  // Both halves of the step's words run every time: the series on a market with a tape (BTC/USDT, which the TEST stack
  // trades), and the market with no tape (a listed spot market whose public trades route answers none).
  expect((await trades(500)).length, 'the TEST stack has public trades on BTC/USDT').toBeGreaterThan(0);
  await openChart(page);
  await addStudy(page, 'delta', 'Volume delta');
  await addStudy(page, 'profile', 'Volume profile');
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
        const f = await facts(page, 'volume-delta-1');
        const okLine = async (name, v) => atTick(await shownText(page, 'volume-delta-1', name), v, 5);
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
        // Buys and sells summed apart and then added, in tape order, as the study does; the first bin wins a tie.
        const bins = Array.from({ length: 24 }, () => ({ buy: 0, sell: 0 }));
        for (const p of tape) {
          const bin = bins[Math.min(Math.max(width === 0 ? 0 : Math.floor((p.price - lo) / width), 0), 23)];
          if (p.side === 'buy') bin.buy += p.amount;
          else bin.sell += p.amount;
        }
        let poc = 0;
        bins.forEach((bin, i) => {
          if (bin.buy + bin.sell > bins[poc].buy + bins[poc].sell) poc = i;
        });
        const [low, high] = width === 0 ? [lo, hi] : [lo + poc * width, lo + (poc + 1) * width];
        const f = await facts(page, 'volume-profile-1');
        const m = /^(\S+) to (\S+)$/.exec(f['Point of control'] ?? '');
        return [f['Public trades read'] === String(tape.length), !!m && atTick(m[1], low, 2) && atTick(m[2], high, 2)].join(' ');
      },
      { timeout: 30_000 },
    )
    .toBe('true true');

  // With no tape for the market it says so: on a listed market the public tape holds no trade for, both studies name it
  // and draw nothing. That market's chart has no bars either (they are built from the same trades): it says there were no
  // trades, no chart is drawn, and no delta, cumulative delta or profile figure is shown.
  const quiet = await untradedMarket();
  await page.goto(`/charts/${quiet.replace('/', '-')}`);
  await expect(page.getByRole('heading', { name: 'Charts' })).toBeVisible();
  const chart = page.getByTestId('cw').first();
  await expect(chart).toContainText('No trades in this period.');
  await expect(page.getByTestId('studies')).toBeVisible();
  await addStudy(page, 'delta', 'Volume delta');
  await addStudy(page, 'profile', 'Volume profile');
  for (const id of ['volume-delta-1', 'volume-profile-1']) {
    await expect(row(page, id)).toContainText('No public trades for this market.');
    await expect(row(page, id).locator('[data-series]')).toHaveCount(0);
    await expect(row(page, id).locator('.st-fact')).toHaveCount(0);
  }
  await expect(host(page)).toHaveCount(0);
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
    // The chart's last 15m bar is the current quarter hour (a quiet one is filled), so it ends at the next quarter.
    const chartEnd = Math.floor(Date.now() / 900_000) * 900_000 + 900_000;
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
  // The drawn value at a 15m bar is the 20-hour SMA of the hourly closes of the hours closed by that bar's end: the same
  // for every quarter of an hour until the next hour closes. Worked here from the hourly and 15m bars the chart builds,
  // at the last bar (the legend) and at an earlier bar under the pointer (the data window).
  const htfAt = (hourly, barT) => {
    const closed = hourly.filter((h) => h.t + STEP_MS['1h'] <= barT + STEP_MS['15m']);
    return closed.length < 20
      ? null
      : F.sma(
          closed.map((h) => h.c),
          20,
          closed.length - 1,
        );
  };
  await page.getByRole('checkbox', { name: 'Legend always shown' }).check();
  await expect
    .poll(
      async () => {
        const [bars, hourly] = [await chartBars('15m'), await chartBars('1h')];
        const worked = htfAt(hourly, bars.at(-1).t);
        return worked !== null && atTick(await shownText(page, 'htf-sma-1', '1h SMA 20'), worked, 2);
      },
      { timeout: 30_000, message: 'the legend never showed the 1h SMA worked from the hourly bars' },
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Data window' }).click();
  const windowText = page.getByTestId('data-window');
  const box = await page.getByTestId('cw').getByTestId('wc-host').boundingBox();
  // The pointer moves across the chart on each try, so a spot on a bar this check cannot use (in the last hour, or
  // before the bars the route rebuilds) is passed over.
  let spot = 0;
  await expect
    .poll(
      async () => {
        spot = (spot % 5) + 1;
        await page.mouse.move(box.x + box.width * (0.2 + spot * 0.08), box.y + box.height * 0.5);
        await expect(windowText).toContainText('1h SMA 20');
        const cursor = Number(await windowText.getAttribute('data-cursor')) * 1000;
        const [bars, hourly] = [await chartBars('15m'), await chartBars('1h')];
        if (!bars.some((b) => b.t === cursor)) return `hovered time ${cursor} is not a 15m bar of the chart`;
        if (cursor >= bars.at(-1).t - STEP_MS['1h']) return 'the hovered bar is in the last hour';
        const line = (await windowText.locator('li').allTextContents()).find((x) => x.trim().startsWith('1h SMA 20 '));
        const text = line?.trim().slice('1h SMA 20 '.length) ?? '';
        const worked = htfAt(hourly, cursor);
        if (worked === null) return 'fewer than 20 hours closed by the hovered bar';
        return atTick(text, worked, 2) || `shown ${text}, worked ${worked}`;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
});

/** The funding the venue published on its listed perpetual on `base`, from the public route the chart reads. */
async function fundingRoute(base, since) {
  return fetch(`${EDGE}/api/v1/venue/funding-history?base=${base}&since=${encodeURIComponent(since)}`);
}

/**
 * An open spot market that has bars on its public candle route but whose base asset the venue publishes no funding for
 * (the public funding route refuses it `trade.venue.not_offered`): the step's other branch needs one, read from the
 * public routes. A stack where every charted asset has a listed perpetual fails here by name.
 */
async function marketWithoutFunding(since) {
  const res = await fetch(`${EDGE}/api/v1/markets?limit=500`);
  expect(res.status).toBe(200);
  const seen = [];
  for (const m of await res.json()) {
    if (typeof m.symbol !== 'string' || m.symbol.includes(':') || !m.spot || m.paper) continue;
    const life = await fetch(`${EDGE}/api/v1/market-lifecycle/${encodeURIComponent(m.symbol)}`);
    if (!life.ok || (await life.json()).state !== 'OPEN') continue;
    const bars = await fetch(`${EDGE}/api/v1/ohlcv/${encodeURIComponent(m.symbol)}?timeframe=15m&limit=5`);
    if (!bars.ok || (await bars.json()).length === 0) continue;
    const funding = await fundingRoute(m.base, since);
    seen.push(`${m.symbol} ${funding.status}`);
    if (funding.status === 422 && (await funding.json()).intafacedCode === 'trade.venue.not_offered') return m.symbol;
  }
  throw new Error(`every open spot market with bars has published funding on this stack (${seen.join(', ')})`);
}

test('J-charts-desk-04 #6 adds open interest, funding and an on-chain series: drawn where published; otherwise each is refused by name and nothing is drawn', async ({
  page,
}) => {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  // Where published: the venue publishes funding for BTC through its listed perpetual, read here from the public route.
  const published = await fundingRoute('BTC', since);
  expect(published.status).toBe(200);
  const funding = await published.json();
  expect(funding.value.length).toBeGreaterThan(0);
  const perpetual = funding.symbol;
  const per = funding.intervalSeconds % 3600 === 0 ? `${funding.intervalSeconds / 3600}h` : `${funding.intervalSeconds}s`;
  const lineName = `${funding.test ? 'TEST ' : ''}Funding rate ${perpetual} (% per ${per})`;
  const rows = funding.value.map((r) => ({ t: Date.parse(r.fundingAt), rate: r.rate })).sort((a, b) => a.t - b.t);
  // Percent per interval, to two fewer decimals than the rate carries (never fewer than two).
  const digits = Math.max(2, Math.max(...rows.map((r) => (r.rate.split('.')[1] ?? '').length)) - 2);
  const pct = (rate) => Number(rate) * 100;

  await openChart(page);
  await addStudy(page, 'open interest', 'Open interest');
  await addStudy(page, 'funding', 'Funding rate');
  await addStudy(page, 'on chain', 'On-chain series');
  await page.getByRole('checkbox', { name: 'Legend always shown' }).check();

  // Funding is drawn: one line in a pane of its own, its value at the last bar the newest rate settled by that bar's
  // close (the newest the route published), and the legend names the perpetual and its latest settled rate.
  await expect
    .poll(async () => (await drawnStudies(page)).filter((x) => x.key === 'funding-1').map((x) => [x.type, x.pane > 0]))
    .toEqual([['Line', true]]);
  const latest = rows.at(-1);
  await expect
    .poll(async () => atTick(await shownText(page, 'funding-1', lineName), pct(latest.rate), digits), { timeout: 30_000 })
    .toBe(true);
  const shown = await facts(page, 'funding-1');
  expect(shown['Perpetual']).toBe(perpetual);
  expect(Number(shown['Settled rates read'])).toBeGreaterThanOrEqual(rows.length);
  const latestText = shown['Latest settled'];
  const [rateText, at] = latestText.split('% at ');
  expect(atTick(rateText, pct(latest.rate), digits)).toBe(true);
  expect(Date.parse(`${at.replace(' UTC', '').replace(' ', 'T')}:00Z`)).toBeGreaterThanOrEqual(latest.t);
  await expect(row(page, 'funding-1')).not.toContainText('is not published');

  // Open interest and the on-chain series are published by no source the chart reads: each is refused by name on this
  // market and nothing is drawn for either.
  await expect(legend(page)).toContainText(`Open interest is not published for ${MARKET_NAME}.`);
  await expect(legend(page)).toContainText(`On-chain series is not published for ${MARKET_NAME}.`);
  for (const id of ['open-interest-1', 'on-chain-1']) {
    await expect(row(page, id)).toBeVisible();
    await expect(row(page, id).locator('[data-series]')).toHaveCount(0);
  }
  expect((await drawnStudies(page)).filter((x) => /^(open-interest|on-chain)-1(:|$)/.test(x.key))).toEqual([]);

  // Otherwise: on a market whose asset has no published funding, funding too is refused by name and nothing is drawn.
  const other = await marketWithoutFunding(since);
  const otherPair = other.replace('/', '-');
  await page.goto(`/charts/${otherPair}`);
  await expect(page.getByRole('heading', { name: 'Charts' })).toBeVisible();
  await expect(page.getByTestId('studies')).toBeVisible();
  // The workbench keeps its studies across markets; a workbench that kept none gets the funding study added here.
  if ((await page.locator('[data-study^="funding-"]').count()) === 0) await addStudy(page, 'funding', 'Funding rate');
  const fundingId = (await page.locator('[data-study^="funding-"]').first().getAttribute('data-study')) ?? '';
  await expect(row(page, fundingId)).toContainText(`Funding rate is not published for ${other}.`);
  await expect(row(page, fundingId).locator('[data-series]')).toHaveCount(0);
  await expect
    .poll(async () => (await drawnStudies(page)).filter((x) => /^(funding|open-interest|on-chain)-\d+(:|$)/.test(x.key)))
    .toEqual([]);
});
