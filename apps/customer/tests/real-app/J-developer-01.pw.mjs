import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN } from './stack.mjs';

// J-developer-01, in the running app (docs/roadmap/journeys.json): read the developer portal and find where to start.
// One test per step, titled "J-developer-01 #<n>", each signed out, as the journey starts. Nothing is written.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #3: there is no connectivity page (endpoints, probe, colocation).
// - #4: the REST conventions and API reference sections publish no page in this build.
// - #5: no OpenAPI file, collection or agent docs index is served.
// - #6: there is no data products page with its terms.
// - #7: the portal has no search.
const J = 'J-developer-01';
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

const AUDIENCES = ['Exchange API', 'Institutional', 'Embedded', 'Broker', 'Best practice'];
const card = (page, name) => page.getByRole('region', { name, exact: true });

test(`${J} #1 opens /developers: sections per audience, each with its access statement; none hidden; an unbuilt one names its blocker`, async ({
  page,
}) => {
  await page.goto('/developers');
  await expect(page.getByRole('heading', { name: 'Developers', level: 1 })).toBeVisible();
  await expect(card(page, 'Who gets access')).toContainText('Access follows the account and the permissions on its key.');
  for (const audience of AUDIENCES) {
    const section = card(page, audience);
    await expect(section, audience).toBeVisible();
    // The audience's own line says who it is for; every section under it is listed, built or not.
    await expect(section.locator('p').first()).not.toBeEmpty();
    const items = section.getByRole('listitem');
    expect(await items.count(), audience).toBeGreaterThan(0);
    for (const item of await items.all()) {
      await expect(item.getByRole('link')).toHaveAttribute('href', /^\/developers\/[a-z-]+$/);
      await expect(item).toContainText(/Published|No page is published for this section in this build\./);
    }
  }
});

test(`${J} #2 opens the base-address table: one row per protocol, environment and region; an unset host reads "host not set"`, async ({
  page,
}) => {
  await page.goto('/developers');
  await page.getByRole('link', { name: 'Open the table of base addresses' }).click();
  await expect(page).toHaveURL(/\/developers\/hosts$/);
  await expect(page.getByRole('heading', { name: 'Base addresses', level: 1 })).toBeVisible();
  const rows = page.getByRole('table').getByRole('row');
  // A header row, then three protocols by three environments (production, sandbox, regional).
  await expect(rows).toHaveCount(10);
  for (const protocol of ['REST', 'WebSocket', 'FIX'])
    for (const environment of ['Production', 'Sandbox', 'Regional']) {
      const row = page.getByRole('row', { name: new RegExp(`^${protocol} ${environment} `) });
      await expect(row, `${protocol} ${environment}`).toHaveCount(1);
      // A host the owner set, or the words for one not set; never an invented address.
      await expect(row.getByRole('cell').nth(2)).toHaveText(/^(host not set|[a-z0-9.-]+\.[a-z]{2,}(:\d+)?)$/);
    }
  await expect(page.getByText('The regional host rule is stated here once the owner sets it.')).toBeVisible();
});

test(`${J} #3 opens the connectivity options: internet and redundant endpoints, a probe with offset and round trip, colocation parked`, async ({
  page,
}) => {
  await page.goto('/developers');
  await page.getByRole('link', { name: 'Connectivity' }).click(UNBUILT);
  await expect(page.getByRole('heading', { name: 'Connectivity', level: 1 })).toBeVisible();
  const endpoints = page.getByRole('table', { name: 'Endpoints' });
  for (const name of ['Internet', 'Redundant']) await expect(endpoints.getByRole('row', { name: new RegExp(`^${name}`) })).toBeVisible();
  await page.getByRole('button', { name: 'Run the probe' }).click();
  const probe = page.getByRole('region', { name: 'Probe' });
  await expect(probe.getByText(/Clock offset: -?\d+ ms/)).toBeVisible();
  await expect(probe.getByText(/Round trip: \d+ ms/)).toBeVisible();
  const colo = page.getByRole('region', { name: 'Colocation' });
  await expect(colo).toContainText('Parked');
  await expect(colo).toContainText(/hardware/i);
});

test(`${J} #4 reads the REST conventions and the trading API reference index`, async ({ page }) => {
  await page.goto('/developers/rest');
  await expect(page.getByRole('heading', { name: 'REST conventions', level: 1 })).toBeVisible();
  const body = page.getByRole('main');
  // The page itself, not the "No page is published" notice.
  await expect(body.getByRole('heading', { name: 'Resource URLs' })).toBeVisible(UNBUILT);
  for (const topic of ['JSON', 'Times are UTC', 'Identifiers are UUIDs', 'Symbols'])
    await expect(body.getByRole('heading', { name: topic })).toBeVisible();
  await expect(body).toContainText('BTC/USDT');

  // The reference index: every public endpoint and stream, under its product.
  await page.goto('/developers/reference');
  for (const product of ['Spot', 'Account', 'Market data', 'Streams'])
    await expect(page.getByRole('region', { name: product, exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Market data', exact: true })).toContainText('GET /api/v1/orderbook/{symbol}');
  await expect(page.getByRole('region', { name: 'Spot', exact: true })).toContainText('POST /api/v1/orders');
});

test(`${J} #5 downloads the OpenAPI file and a collection, and opens the agent docs index`, async ({ page }) => {
  await page.goto('/developers/openapi');
  const link = page.getByRole('link', { name: 'Download the OpenAPI file' });
  await expect(link).toBeVisible(UNBUILT);
  const href = await link.getAttribute('href');
  const spec = await fetch(new URL(href, ORIGIN)).then((res) => res.json());
  const operations = Object.values(spec.paths ?? {}).flatMap((p) => Object.values(p));
  expect(operations.length).toBeGreaterThan(0);
  // Every route says its scope, its cost and its errors.
  for (const op of operations) {
    expect(op['x-scope'], op.operationId).toBeTruthy();
    expect(op['x-cost'], op.operationId).toBeDefined();
    expect(
      Object.keys(op.responses ?? {}).some((code) => code.startsWith('4')),
      op.operationId,
    ).toBe(true);
  }
  await expect(page.getByRole('link', { name: 'Download a collection' })).toBeVisible();

  // The agent docs index: each page once, each with a markdown variant.
  const index = await fetch(`${ORIGIN}/developers/llms.txt`).then((res) => res.text());
  const pages = [...index.matchAll(/\((\/developers\/[^)\s]+\.md)\)/g)].map((m) => m[1]);
  expect(pages.length).toBeGreaterThan(0);
  expect(new Set(pages).size).toBe(pages.length);
  const md = await fetch(`${ORIGIN}${pages[0]}`);
  expect(md.status).toBe(200);
});

test(`${J} #6 reads which data products may be used and on what terms`, async ({ page }) => {
  await page.goto('/developers');
  await page.getByRole('link', { name: 'Data products' }).click(UNBUILT);
  const table = page.getByRole('table', { name: 'Data products' });
  for (const column of ['Product', 'Redistribution', 'Retention', 'Entitlement'])
    await expect(table.getByRole('columnheader', { name: column })).toBeVisible();
  // A term the owner hasn't set reads "not set"; nothing is filled in for it.
  const cells = await table.getByRole('cell').allInnerTexts();
  expect(cells.length).toBeGreaterThan(0);
  expect(cells.every((c) => c.trim().length > 0)).toBe(true);
});

test(`${J} #7 searches the docs for something that doesn't exist: the empty search state`, async ({ page }) => {
  await page.goto('/developers');
  const search = page.getByRole('searchbox', { name: 'Search the developer docs' });
  await search.fill('zzq-no-such-thing', UNBUILT);
  await search.press('Enter');
  await expect(page.getByText('Nothing in the developer docs matches “zzq-no-such-thing”.')).toBeVisible();
  // The search reads the docs on the server; no host is guessed for it.
  expect(EDGE).toMatch(/^http/);
});
