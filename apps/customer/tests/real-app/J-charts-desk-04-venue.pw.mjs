// World: gates, restart
import { test, expect } from './journey.mjs';
import { EDGE } from './stack.mjs';
import { MINUTE, minuteStart } from './clock.mjs';
import { atTick, facts, shownText } from './charts-desk-studies.mjs';
import { ownSpotMarket } from './own-market.mjs';
import { testVenue, venueForThisFile } from './venue.mjs';

// J-charts-desk-04 #6 "Adds open interest, funding and an on-chain series" (docs/roadmap/journeys.json), apart from the
// other steps because it needs svc-trade's user-venue door on (LOCAL_STACK_USER_VENUE=on, which starts the TEST venue):
// funding is published by the venue for its listed perpetual on the chart's asset, and with the venue door on the chart
// workbench reads listed venue markets and candles. Expected values are read from the public funding route the chart
// reads (`/api/v1/venue/funding-history`), not from the page.

const MARKET = 'BTC-USDC';
const MARKET_NAME = 'BTC-USDC';
const CHART = `/charts/${MARKET}`;

venueForThisFile(test);

async function openChart(page, path = CHART) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Charts', exact: true })).toBeVisible();
  await expect(page.getByTestId('studies')).toBeVisible();
}

async function addStudy(page, search, name) {
  await page.getByRole('button', { name: 'Indicators', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search indicators', exact: true }).fill(search);
  await page.getByRole('button', { name: `Add ${name}`, exact: true }).click();
}

const row = (page, id) => page.locator(`[data-study="${id}"]`);
const host = (page) => page.getByTestId('cw').getByTestId('wc-host');
/** The study series the chart library draws (key, pane, type, colour), as the chart writes them back. */
const drawnStudies = async (page) => JSON.parse((await host(page).getAttribute('data-study-series')) ?? '[]');

/** The funding the venue published on its listed perpetual on `base`, from the public route the chart reads. */
async function fundingRoute(base, since) {
  return fetch(`${EDGE}/api/v1/venue/funding-history?base=${base}&since=${encodeURIComponent(since)}`);
}

/** Seed past TEST venue prints across the last 24 hours so the chart has bars spanning the funding history window. */
async function seedRecentVenueBars(symbol, basePrice) {
  const nowMin = minuteStart(Date.now());
  const entries = [];
  for (let i = 0; i < 25; i += 1) {
    const t = nowMin - (24 - i) * 60 * MINUTE;
    entries.push({
      tradedAt: new Date(t).toISOString(),
      price: String(basePrice + i),
      amount: '0.02',
      takerSide: i % 2 === 0 ? 'buy' : 'sell',
    });
  }
  const seeded = await testVenue('/test/seed-prints', { symbol, entries });
  expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
}

/**
 * A listed spot market on the TEST venue that has bars on its venue candle feed but whose base asset has no listed
 * perpetual (the public funding route refuses it `trade.venue.not_offered`).
 */
async function marketWithoutFunding(since) {
  const fresh = await ownSpotMarket('J-charts-desk-04', 'JCD4', 'F');
  await seedRecentVenueBars(fresh.symbol, 100);
  const funding = await fundingRoute(fresh.base, since);
  expect(funding.status).toBe(422);
  expect((await funding.json()).intafacedCode).toBe('trade.venue.not_offered');
  return fresh.symbol;
}

test('J-charts-desk-04 #6 adds open interest, funding and an on-chain series: drawn where published; otherwise each is refused by name and nothing is drawn', async ({
  page,
  stepPicture,
}) => {
  await seedRecentVenueBars(MARKET, 60000);
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
  await page.getByRole('checkbox', { name: 'Legend always shown', exact: true }).check();

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
  // market with its typed refusal code and nothing is drawn for either.
  await expect(row(page, 'open-interest-1').locator('[data-code="trade.study.series_unpublished"]')).toContainText(
    `Open interest is not published for ${MARKET_NAME}.`,
  );
  await expect(row(page, 'on-chain-1').locator('[data-code="trade.study.series_unpublished"]')).toContainText(
    `On-chain series is not published for ${MARKET_NAME}.`,
  );
  for (const id of ['open-interest-1', 'on-chain-1']) {
    await expect(row(page, id)).toBeVisible();
    await expect(row(page, id).locator('[data-series]')).toHaveCount(0);
  }
  expect((await drawnStudies(page)).filter((x) => /^(open-interest|on-chain)-1(:|$)/.test(x.key))).toEqual([]);

  // Otherwise: on a market whose asset has no published funding, funding too is refused by name with its typed code and nothing is drawn.
  const other = await marketWithoutFunding(since);
  const otherPair = other.replace('/', '-');
  await openChart(page, `/charts/${otherPair}`);
  // The workbench keeps its studies across markets; a workbench that kept none gets the funding study added here.
  if ((await page.locator('[data-study^="funding-"]').count()) === 0) await addStudy(page, 'funding', 'Funding rate');
  const fundingId = (await page.locator('[data-study^="funding-"]').first().getAttribute('data-study')) ?? '';
  await expect(row(page, fundingId).locator('[data-code="trade.study.series_unpublished"]')).toContainText(
    `Funding rate is not published for ${other}.`,
  );
  await expect(row(page, fundingId).locator('[data-series]')).toHaveCount(0);
  await expect
    .poll(async () => (await drawnStudies(page)).filter((x) => /^(funding|open-interest|on-chain)-\d+(:|$)/.test(x.key)))
    .toEqual([]);
  await stepPicture();
});
