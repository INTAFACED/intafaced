import { test, expect } from '@playwright/test';
import { tableIn, bodyRows } from './tables.mjs';

// J-developer-01, in the running app (docs/roadmap/journeys.json): a signed-out developer reads the portal at /developers
// and finds where to start. One test per step, titled "J-developer-01 #<n>". Nothing here needs an account or money.
// The stack's banner also carries role=status, so a page's own status is found inside main.
const J = 'J-developer-01';
const AUDIENCES = ['Exchange API', 'Institutional', 'Embedded', 'Broker', 'Best practice'];

test.describe.configure({ mode: 'default' });

const card = (page, name) => page.getByRole('region', { name, exact: true });

/** svc-trade's live route inventory, read from the running stack through the edge: `METHOD /path` per row. */
async function liveInventory(page) {
  const response = await page.request.get('/api/v1/capabilities');
  expect(response.ok(), await response.text()).toBe(true);
  const { routes } = await response.json();
  expect(routes.length).toBeGreaterThan(10);
  return routes.map((route) => `${route.method} ${route.path}`);
}

const readDownload = async (download) => Buffer.concat(await (await download.createReadStream()).toArray()).toString('utf8');

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
  // Each endpoint names its host for every protocol: an address the owner set, or "host not set". Available only when all are set.
  for (const option of ['Internet', 'Redundant endpoint']) {
    const row = options.getByRole('row', { name: new RegExp(option) });
    const hosts = row.getByRole('list', { name: option, exact: true }).getByRole('listitem');
    await expect(hosts).toHaveCount(3);
    const states = [];
    for (const [index, protocol] of ['REST', 'WebSocket', 'FIX'].entries()) {
      const host = hosts.nth(index);
      const state = await host.getAttribute('data-host-state');
      states.push(state);
      if (state === 'unset') await expect(host).toHaveText(`${protocol}: host not set`);
      else await expect(host.getByRole('code')).toHaveText(/^[a-z0-9.-]+(:\d+)?$/i);
    }
    await expect(row).toContainText(states.every((state) => state === 'set') ? 'Available' : 'host not set');
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
  for (const rule of [/\/api\/v1\/orders\/:id/, /JSON/, /UTC/, /UUID/, /decimal string/i]) await expect(body).toContainText(rule);
  // The symbol format, by example: spot, a linear perpetual, and the encoded form in a path.
  const SYMBOL = /^[A-Z0-9]+\/[A-Z0-9]+(:[A-Z0-9]+(-\d+)?)?$/;
  for (const example of ['BTC/USDT', 'BTC/USDT:USDT']) {
    expect(example).toMatch(SYMBOL);
    await expect(body).toContainText(example);
  }
  await expect(body).toContainText('/api/v1/ticker/BTC%2FUSDT');
  // Any market the running stack lists is named in that format.
  const markets = await page.request.get('/api/v1/markets');
  expect(markets.ok(), await markets.text()).toBe(true);
  const listed = await markets.json();
  for (const market of Array.isArray(listed) ? listed : (listed.markets ?? [])) expect(market.symbol).toMatch(SYMBOL);

  await page.goto('/developers/reference');
  await expect(page.getByRole('heading', { name: 'API reference', level: 1 })).toBeVisible();
  const product = (tag) => page.getByRole('region', { name: tag[0].toUpperCase() + tag.slice(1), exact: true });
  // Every route in svc-trade's live inventory, read from the running stack, is listed under its product, by method and path.
  const live = await liveInventory(page);
  const spec = await (await page.request.get('/developers/openapi.json')).json();
  const tagOf = new Map(
    Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => [
        `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`,
        operation.tags[0],
      ]),
    ),
  );
  for (const line of live) {
    expect(tagOf.get(line), `${line} is in the live inventory but not in the reference`).toBeDefined();
    await expect(product(tagOf.get(line)).getByRole('rowheader', { name: line, exact: true }), line).toBeVisible();
  }
  // And every route the reference lists sits under the product its file names.
  for (const [line, tag] of tagOf) await expect(product(tag).getByRole('rowheader', { name: line, exact: true }), line).toBeVisible();
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
  const spec = JSON.parse(await readDownload(file));
  expect(spec.openapi).toMatch(/^3\./);
  const operations = Object.values(spec.paths ?? {}).flatMap((methods) => Object.values(methods));
  const lines = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`),
  );
  // The downloaded file carries every route of the live inventory the running stack serves.
  const live = await liveInventory(page);
  for (const line of live) expect(lines, line).toContain(line);
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
  const requests = JSON.parse(await readDownload(collection))
    .item.flatMap((folder) => folder.item)
    .map(({ request }) => `${request.method} /${request.url.path.join('/')}`);
  // The collection is a request for every route of the same live inventory, and for every route in the file.
  for (const line of live) expect(requests, line).toContain(line);
  expect([...requests].sort()).toEqual([...lines].sort());

  // The agent index lists every portal docs page exactly once, each beside its markdown variant. The portal's docs pages
  // are the home page, its base-address table, and each section /developers marks "Page in this portal"; the two of
  // those that read live notices (status, changelog) are listed once by their own address instead.
  const index = await page.request.get('/developers/llms.txt');
  expect(index.ok()).toBe(true);
  const indexText = await index.text();
  // The stack answers a missing file with the app shell, so a 200 alone proves nothing: the file itself must come back.
  expect(indexText).not.toMatch(/<!doctype html/i);
  await page.goto('/developers');
  const written = await page
    .getByRole('main')
    .getByRole('listitem')
    .filter({ hasText: 'Page in this portal' })
    .getByRole('link')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  const livePages = ['/developers/status', '/developers/changelog'];
  for (const href of livePages) {
    expect(written).toContain(href);
    expect(indexText.split(`(${href})`).length - 1, `${href} in llms.txt`).toBe(1);
  }
  const docsPages = ['/developers', '/developers/hosts', ...written.filter((href) => !livePages.includes(href))];
  expect(docsPages.length).toBeGreaterThan(5);
  const listed = indexText.match(/\/developers\/[a-z-]+\.md/g) ?? [];
  for (const href of docsPages) {
    const md = href === '/developers' ? '/developers/index.md' : `${href}.md`;
    expect(
      listed.filter((path) => path === md),
      `${href} in llms.txt`,
    ).toHaveLength(1);
    const variant = await page.request.get(md);
    expect(variant.ok(), md).toBe(true);
    const text = await variant.text();
    expect(text, md).not.toMatch(/<!doctype html/i);
    expect(text, md).toMatch(/^# \S/);
  }
  // Nothing else is listed as a docs page: every markdown line names one of the portal's pages.
  expect(listed.length).toBe(docsPages.length);
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
  // One cell per term column (every header but Product).
  const terms = (await table.getByRole('columnheader').count()) - 1;
  for (const row of await rows.all()) {
    const cells = await row.getByRole('cell').allInnerTexts();
    expect(cells).toHaveLength(terms);
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
