// World: restart
import { test, expect } from './journey.mjs';
import { EDGE } from './stack.mjs';
import { atTick, shownText } from './charts-desk-studies.mjs';
import { venueForThisFile } from './venue.mjs';

// J-charts-desk-04 #6 "Adds open interest, funding and an on-chain series" (docs/roadmap/journeys.json), apart from the
// other steps because it needs svc-trade's user-venue door on (LOCAL_STACK_USER_VENUE=on, which starts the TEST venue):
// funding is published by the venue for its listed perpetual on the chart's asset. Expected values are read from the
// public funding route the chart reads (`/api/v1/venue/funding-history`), not from the page.

const MARKET = 'BTC-USDT';
const MARKET_NAME = 'BTC/USDT';
const CHART = `/charts/${MARKET}`;

venueForThisFile(test);

async function openChart(page, path = CHART) {
  await page.goto(path);
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
  await openChart(page, `/charts/${otherPair}`);
  // The workbench keeps its studies across markets; a workbench that kept none gets the funding study added here.
  if ((await page.locator('[data-study^="funding-"]').count()) === 0) await addStudy(page, 'funding', 'Funding rate');
  const fundingId = (await page.locator('[data-study^="funding-"]').first().getAttribute('data-study')) ?? '';
  await expect(row(page, fundingId)).toContainText(`Funding rate is not published for ${other}.`);
  await expect(row(page, fundingId).locator('[data-series]')).toHaveCount(0);
  await expect
    .poll(async () => (await drawnStudies(page)).filter((x) => /^(funding|open-interest|on-chain)-\d+(:|$)/.test(x.key)))
    .toEqual([]);
});
