import { test, expect } from '@playwright/test';
import { tableIn, bodyRows } from './tables.mjs';

// J-developer-01, in the running app (docs/roadmap/journeys.json): a signed-out developer reads the portal at /developers
// and finds where to start. One test per step, titled "J-developer-01 #<n>". Nothing here needs an account or money.
// The stack's banner also carries role=status, so a page's own status is found inside main.
const J = 'J-developer-01';
const AUDIENCES = ['Exchange API', 'Institutional', 'Embedded', 'Broker', 'Best practice'];

test.describe.configure({ mode: 'default' });

const card = (page, name) => page.getByRole('region', { name, exact: true });

test(`${J} #1 opens /developers: sections per audience with an access statement each, no section hidden, and an unbuilt section names its blocker`, async ({
  page,
}) => {
  await page.goto('/developers');
  await expect(page.getByRole('heading', { name: 'Developers', level: 1 })).toBeVisible();
  await expect(card(page, 'Who gets access')).toBeVisible();
  for (const audience of AUDIENCES) {
    await expect(card(page, audience).getByRole('heading', { name: audience })).toBeVisible();
    await expect(card(page, audience).getByRole('link').first()).toBeVisible();
  }
  // Every section the portal plans is listed, published or not: none is hidden.
  for (const section of [
    'REST conventions',
    'API reference',
    'Errors',
    'Authentication',
    'Sandbox',
    'Quickstart',
    'Machine-readable specs',
  ]) {
    await expect(page.getByRole('link', { name: section, exact: true })).toBeVisible();
  }

  // Each audience says who may use it.
  for (const audience of AUDIENCES) await expect(card(page, audience).getByTestId('developers-access')).toBeVisible();
  // A section with no page names what it waits for, not only that nothing is published.
  await page.getByRole('link', { name: 'FIX', exact: true }).click();
  await expect(page).toHaveURL(/\/developers\/fix$/);
  // The blocker is named by its slice id (DV-fix-01), not only "waits".
  await expect(page.getByRole('main').getByRole('status')).toContainText(/waits for [A-Z]{2}-[a-z]+-\d{2}/i);
});

test(`${J} #2 opens the base-URL table: one row per protocol, environment and region, an unset host reads "host not set", and the regional rule waits for the owner`, async ({
  page,
}) => {
  await page.goto('/developers');
  await page.getByRole('link', { name: /Open the table of base addresses/ }).click();
  await expect(page).toHaveURL(/\/developers\/hosts$/);
  await expect(page.getByRole('heading', { name: 'Base addresses', level: 1 })).toBeVisible();
  const rows = bodyRows(page.getByRole('table'));
  await expect(rows).toHaveCount(9);
  for (const protocol of ['REST', 'WebSocket', 'FIX']) {
    for (const environment of ['Production', 'Sandbox', 'Regional']) {
      const row = rows.filter({ has: page.getByRole('cell', { name: protocol, exact: true }) }).filter({
        has: page.getByRole('cell', { name: environment, exact: true }),
      });
      await expect(row).toHaveCount(1);
      // A host the owner set shows its address; one not set says so, and nothing is guessed.
      const state = await row.getAttribute('data-host-state');
      if (state === 'unset') await expect(row).toContainText('host not set');
      else await expect(row.getByRole('cell').nth(2)).toHaveText(/^[a-z0-9.-]+(:\d+)?$/i);
    }
  }
  await expect(page.getByText('The regional host rule is stated here once the owner sets it.')).toBeVisible();
});

test(`${J} #3 opens the connectivity options: internet and redundant endpoints with their hosts, a probe with offset and round trip, and colocation parked with the hardware notice`, async ({
  page,
}) => {
  await page.goto('/developers/connectivity');
  await expect(page.getByRole('heading', { name: 'Connectivity', level: 1 })).toBeVisible();
  const options = tableIn(page, 'Connectivity options');
  for (const option of ['Internet', 'Redundant endpoint']) {
    await expect(options.getByRole('row', { name: new RegExp(option) })).toContainText(/Available|host not set/);
  }
  await expect(options.getByRole('row', { name: /Colocation/ })).toContainText('Parked');
  await expect(options.getByRole('row', { name: /Colocation/ })).toContainText(/hardware/i);

  await page.getByRole('button', { name: 'Check my clock' }).click();
  const probe = page.getByTestId('developers-time-probe');
  await expect(probe).toContainText(/Offset\s*-?\d+ ms/);
  await expect(probe).toContainText(/Round trip\s*\d+ ms/);
});

test(`${J} #4 reads the REST conventions and the trading API reference index: URLs, JSON, UTC times, UUIDs and symbol formats; every public endpoint and stream under its product`, async ({
  page,
}) => {
  await page.goto('/developers/rest');
  await expect(page.getByRole('heading', { name: 'REST conventions', level: 1 })).toBeVisible();
  const body = page.getByRole('main');
  for (const rule of [/\/api\/v1\/orders\/:id/, /JSON/, /UTC/, /UUID/, /symbol/i, /decimal string/i])
    await expect(body).toContainText(rule);

  await page.goto('/developers/reference');
  await expect(page.getByRole('heading', { name: 'API reference', level: 1 })).toBeVisible();
  const product = (tag) => page.getByRole('region', { name: tag[0].toUpperCase() + tag.slice(1), exact: true });
  // Every route in the published OpenAPI file is listed under its own product (the file's tag), by method and path.
  const spec = await (await page.request.get('/developers/openapi.json')).json();
  const routes = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      line: `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`,
      tag: operation.tags[0],
    })),
  );
  expect(routes.length).toBeGreaterThan(0);
  for (const { line, tag } of routes) {
    await expect(product(tag).getByRole('rowheader', { name: line, exact: true }), line).toBeVisible();
  }
  // Every stream in the reference's markdown variant is listed under the product its section names.
  const markdown = await (await page.request.get('/developers/reference.md')).text();
  const streams = markdown
    .split(/^## /m)
    .slice(1)
    .flatMap((section) => {
      const tag = section.split('\n')[0].trim().toLowerCase();
      const table = section.split('| WebSocket stream |')[1] ?? '';
      return [...table.matchAll(/^\| `([a-z]+)`/gm)].map(([, channel]) => ({ channel, tag }));
    });
  expect(streams.length).toBeGreaterThan(0);
  for (const { channel, tag } of streams) {
    await expect(product(tag).getByRole('rowheader', { name: channel, exact: true }), channel).toBeVisible();
  }
});

test(`${J} #5 downloads the OpenAPI file and a collection, and opens the agent docs index: every route with scope, cost and errors; each page once with a markdown variant`, async ({
  page,
}) => {
  await page.goto('/developers/openapi');
  await expect(page.getByRole('heading', { name: 'Machine-readable specs', level: 1 })).toBeVisible();
  const download = page.getByRole('link', { name: /Download the OpenAPI file/ });
  await expect(download).toBeVisible();
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  const spec = JSON.parse(await (await file.createReadStream()).toArray().then((parts) => Buffer.concat(parts).toString('utf8')));
  expect(spec.openapi).toMatch(/^3\./);
  const operations = Object.values(spec.paths ?? {}).flatMap((methods) => Object.values(methods));
  expect(operations.length).toBeGreaterThan(0);
  for (const operation of operations) {
    expect(operation.security ?? operation['x-scope'], JSON.stringify(operation).slice(0, 200)).toBeDefined();
    expect(operation['x-cost'], JSON.stringify(operation).slice(0, 200)).toBeDefined();
    expect(Object.keys(operation.responses ?? {}).some((status) => /^[45]/.test(status))).toBe(true);
  }
  const [collection] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: /Download the collection/ }).click(),
  ]);
  expect(collection.suggestedFilename()).toMatch(/\.json$/);

  // The agent index lists each docs page once, and each has a markdown variant beside it.
  const index = await page.request.get('/developers/llms.txt');
  expect(index.ok()).toBe(true);
  const indexText = await index.text();
  // The stack answers a missing file with the app shell, so a 200 alone proves nothing: the file itself must come back.
  expect(indexText).not.toMatch(/<!doctype html/i);
  const pages = indexText.match(/\/developers\/[a-z-/]+\.md/g) ?? [];
  expect(pages.length).toBeGreaterThan(0);
  expect(new Set(pages).size).toBe(pages.length);
  for (const path of pages) {
    const variant = await page.request.get(path);
    expect(variant.ok(), path).toBe(true);
    expect(await variant.text(), path).toMatch(/^# \S/);
  }
});

test(`${J} #6 reads which data products I may use and on what terms: redistribution, retention and entitlement per product, "not set" where unset`, async ({
  page,
}) => {
  await page.goto('/developers/data-terms');
  await expect(page.getByRole('heading', { name: /Market data terms/, level: 1 })).toBeVisible();
  const table = tableIn(page, /data products/i);
  for (const column of ['Product', 'Entitlement', 'Redistribution', 'Retention']) {
    await expect(table.getByRole('columnheader', { name: column })).toBeVisible();
  }
  const rows = bodyRows(table);
  expect(await rows.count()).toBeGreaterThan(0);
  // A term the owner has not set reads "not set", never an invented value or a blank.
  for (const row of await rows.all()) {
    const cells = await row.getByRole('cell').allInnerTexts();
    expect(cells).toHaveLength(3);
    const unset = (await row.getAttribute('data-terms-state')) === 'unset';
    for (const cell of cells) expect(cell.trim()).toMatch(unset ? /^not set$/ : /\S/);
  }
});

test(`${J} #7 searches the docs for something that does not exist: the empty search state`, async ({ page }) => {
  await page.goto('/developers');
  const search = page.getByRole('searchbox', { name: /Search the developer docs/ });
  await expect(search).toBeVisible();
  await search.fill('zz-no-such-developer-topic');
  await search.press('Enter');
  await expect(page.getByRole('main').getByRole('status')).toContainText(
    'Nothing in the developer docs matches “zz-no-such-developer-topic”.',
  );
});
