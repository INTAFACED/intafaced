import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { tableIn, bodyRows } from './tables.mjs';
import { tool } from './stack.mjs';

// J-developer-01, in the running app (docs/roadmap/journeys.json): a signed-out developer reads the portal at /developers
// and finds where to start. One test per step, titled "J-developer-01 #<n>". Nothing here needs an account or money.
// The stack's banner also carries role=status, so a page's own status is found inside main.
const J = 'J-developer-01';
const AUDIENCES = ['Exchange API', 'Institutional', 'Embedded', 'Broker', 'Best practice'];

test.describe.configure({ mode: 'default' });

const card = (page, name) => page.getByRole('region', { name, exact: true });

/** svc-trade's live route inventory, read from the running stack through the edge: `METHOD /path` per row. */
async function capabilities(page) {
  const response = await page.request.get('/api/v1/capabilities');
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

/** svc-trade's published developer values (`hosts` or `data-terms`), read through the edge the way the page reads them. */
async function published(page, kind) {
  const response = await page.request.get(`/api/trade/developer-portal/${kind}`);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

/** The one refusal svc-trade answers while that developer value is blank. */
async function refusedBlank(page, kind, code) {
  const response = await page.request.get(`/api/trade/developer-portal/${kind}`);
  expect(response.status(), await response.text()).toBe(503);
  expect((await response.json()).code).toBe(code);
}

/**
 * Restart svc-trade with one developer value blank (`HOSTS`, `REGIONAL_RULE` or `DATA_TERMS`), or with every TEST value
 * back (null).
 * tooling/scripts/local-stack-services/trade.mjs leaves a value out when `LOCAL_STACK_TRADE_DEVELOPER_<name>=off`.
 */
function tradeDeveloperValues(blank) {
  const names = ['HOSTS', 'REGIONAL_RULE', 'DATA_TERMS'].map((name) => `LOCAL_STACK_TRADE_DEVELOPER_${name}`);
  const before = names.map((name) => process.env[name]);
  for (const name of names) delete process.env[name];
  if (blank) process.env[`LOCAL_STACK_TRADE_DEVELOPER_${blank}`] = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    names.forEach((name, index) => (before[index] === undefined ? delete process.env[name] : (process.env[name] = before[index])));
  }
}

const PROTOCOL_NAMES = { rest: 'REST', websocket: 'WebSocket', fix: 'FIX' };
const ENVIRONMENT_NAMES = { production: 'Production', sandbox: 'Sandbox', regional: 'Regional' };

async function liveInventory(page) {
  const { routes } = await capabilities(page);
  expect(routes.length).toBeGreaterThan(10);
  return routes.map((route) => `${route.method} ${route.path}`);
}

/**
 * The `/api/v1` routes svc-trade's own router code registers, `METHOD /path` per row. The edge forwards the whole
 * `/api/v1` prefix to svc-trade (services/svc-edge/src/routes.ts), so each of these is a route a developer can call.
 * Read from the registration calls themselves (a literal path, or a path constant declared in the same file), never
 * from a list kept beside them; it is a lower bound, since a path built at run time is not seen here.
 */
function registeredTradeRoutes() {
  const root = fileURLToPath(new URL('../../../../services/svc-trade/src/', import.meta.url));
  const files = readdirSync(root, { recursive: true }).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  const routes = new Set();
  for (const file of files) {
    const source = readFileSync(`${root}${file}`, 'utf8');
    const constants = new Map([...source.matchAll(/const (\w+) = '(\/api\/v1[^']*)'/g)].map(([, name, path]) => [name, path]));
    for (const [, method, literal, name] of source.matchAll(
      /\.(get|post|put|delete|patch)(?:<[^()']*?>)?\(\s*(?:'(\/api\/v1[^']*)'|(\w+),)/g,
    )) {
      const path = literal ?? constants.get(name);
      if (path) routes.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return [...routes].sort();
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
  test.setTimeout(240_000);
  await page.goto('/developers');
  await page.getByRole('link', { name: /Open the table of base addresses/ }).click();
  await expect(page).toHaveURL(/\/developers\/hosts$/);
  await expect(page.getByRole('heading', { name: 'Base addresses', level: 1 })).toBeVisible();
  const rows = bodyRows(page.getByRole('table'));
  await expect(rows).toHaveCount(9);
  const rowOf = (protocol, environment) =>
    rows.filter({ has: page.getByRole('cell', { name: PROTOCOL_NAMES[protocol], exact: true }) }).filter({
      has: page.getByRole('cell', { name: ENVIRONMENT_NAMES[environment], exact: true }),
    });
  // The stack's TEST hosts (tooling/profiles/test-owner-values/trade.json) publish production and sandbox and leave
  // regional out, so both kinds of row are on this page. Each set row shows the service's host exactly.
  const { hosts } = await published(page, 'hosts');
  expect(hosts.filter((row) => row.host === null).map((row) => `${row.protocol} ${row.environment}`)).toEqual([
    'rest regional',
    'websocket regional',
    'fix regional',
  ]);
  for (const { protocol, environment, host } of hosts.filter((row) => row.host !== null)) {
    const row = rowOf(protocol, environment);
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-host-state', 'set');
    await expect(row.getByRole('code')).toHaveText(host);
  }
  // An unset host reads "host not set" and no address is guessed.
  for (const { protocol, environment } of hosts.filter((row) => row.host === null)) {
    const row = rowOf(protocol, environment);
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-host-state', 'unset');
    await expect(row.getByRole('cell').nth(2)).toHaveText('host not set');
    await expect(row.getByRole('code')).toHaveCount(0);
  }
  // The regional host rule appears once the owner sets it: the stack's TEST rule is read back from svc-trade and the page
  // states exactly that text.
  const rule = page.getByTestId('developers-regional-rule');
  const { rule: publishedRule } = await published(page, 'regional-rule');
  expect(publishedRule).toMatch(/^TEST: /);
  await expect(rule).toHaveAttribute('data-rule-state', 'set');
  await expect(rule).toHaveText(publishedRule);

  // Until the owner sets it, svc-trade refuses with its one code and the page says the rule waits for the owner, with
  // that code and no rule text.
  try {
    tradeDeveloperValues('REGIONAL_RULE');
    await refusedBlank(page, 'regional-rule', 'trade.developer_regional_rule_unset');
    await page.reload();
    await expect(rule).toHaveAttribute('data-rule-state', 'unset');
    await expect(rule).toHaveAttribute('data-code', 'trade.developer_regional_rule_unset');
    await expect(rule).toHaveText('The regional host rule is stated here once the owner sets it.');
    await expect(rows).toHaveCount(9);
  } finally {
    tradeDeveloperValues(null);
  }
  await page.reload();
  await expect(rule).toHaveText(publishedRule);
});

test(`${J} #3 opens the connectivity options: internet and redundant endpoints with their hosts, a probe with offset and round trip, and colocation parked with the hardware notice`, async ({
  page,
}) => {
  await page.goto('/developers/connectivity');
  await expect(page.getByRole('heading', { name: 'Connectivity', level: 1 })).toBeVisible();
  const options = tableIn(page, 'Connectivity options');
  const OPTION_KEYS = { Internet: 'internet', 'Redundant endpoint': 'redundant', Colocation: 'colocation' };
  const endpoint = (option) => options.locator(`tbody tr[data-option="${OPTION_KEYS[option]}"]`);
  const endpointHosts = (option) => endpoint(option).getByRole('list', { name: option, exact: true }).getByRole('listitem');
  // Each endpoint names its host for every protocol, read back from svc-trade and compared exactly. The stack's TEST
  // hosts publish every production host, so Internet is Available with them; regional is left out, so the redundant
  // endpoint reads "host not set" for each protocol with no address written or guessed.
  const { hosts } = await published(page, 'hosts');
  const production = ['rest', 'websocket', 'fix'].map((protocol) =>
    hosts.find((row) => row.protocol === protocol && row.environment === 'production'),
  );
  expect(production.map((row) => row.host === null)).toEqual([false, false, false]);
  await expect(endpoint('Internet')).toHaveAttribute('data-option-state', 'available');
  await expect(endpoint('Internet').getByRole('cell').nth(0)).toHaveText('Available');
  await expect(endpointHosts('Internet')).toHaveCount(3);
  for (const [index, { protocol, host }] of production.entries()) {
    const item = endpointHosts('Internet').nth(index);
    await expect(item).toHaveAttribute('data-protocol', protocol);
    await expect(item).toHaveAttribute('data-host-state', 'set');
    await expect(item).toHaveText(`${PROTOCOL_NAMES[protocol]}: ${host}`);
    await expect(item.getByRole('code')).toHaveText(host);
  }
  const redundantUnset = async () => {
    await expect(endpointHosts('Redundant endpoint')).toHaveCount(3);
    for (const [index, protocol] of ['rest', 'websocket', 'fix'].entries()) {
      const item = endpointHosts('Redundant endpoint').nth(index);
      await expect(item).toHaveAttribute('data-protocol', protocol);
      await expect(item).toHaveAttribute('data-host-state', 'unset');
      await expect(item).toHaveText(`${PROTOCOL_NAMES[protocol]}: host not set`);
      await expect(item.getByRole('code')).toHaveCount(0);
    }
    await expect(endpoint('Redundant endpoint')).toHaveAttribute('data-option-state', 'host_unset');
    await expect(endpoint('Redundant endpoint')).not.toContainText('Available');
  };
  expect(hosts.filter((row) => row.environment === 'regional').map((row) => row.host)).toEqual([null, null, null]);
  await redundantUnset();
  await expect(page.getByTestId('developers-connectivity-unset')).toHaveCount(0);
  await expect(endpoint('Colocation')).toContainText('Parked');
  await expect(endpoint('Colocation')).toContainText(/hardware/i);

  // With the owner's hosts blank, svc-trade refuses with its one code, the page says so with that code, and both
  // endpoints read "host not set" for every protocol.
  try {
    tradeDeveloperValues('HOSTS');
    await refusedBlank(page, 'hosts', 'trade.developer_hosts_unset');
    await page.reload();
    await expect(page.getByTestId('developers-connectivity-unset')).toHaveAttribute('data-code', 'trade.developer_hosts_unset');
    await expect(page.getByTestId('developers-connectivity-unset')).toHaveText(
      'No API host is published yet, so every host reads host not set.',
    );
    await expect(endpoint('Internet')).toHaveAttribute('data-option-state', 'host_unset');
    await expect(endpointHosts('Internet')).toHaveText(['REST: host not set', 'WebSocket: host not set', 'FIX: host not set']);
    await expect(endpoint('Internet').getByRole('code')).toHaveCount(0);
    await expect(endpoint('Internet')).not.toContainText('Available');
    await redundantUnset();
  } finally {
    tradeDeveloperValues(null);
  }
  await page.reload();
  await expect(endpoint('Internet')).toHaveAttribute('data-option-state', 'available');

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
  // The list takes an explicit window (a blank one refuses with trade.markets_limit_unset), so ask for the published maximum.
  const markets = await page.request.get('/api/v1/markets?limit=500');
  expect(markets.ok(), await markets.text()).toBe(true);
  // The stack lists its default markets (BTC/USDT, ETH/USDT and others), so the list is never empty here.
  const listedMarkets = await markets.json();
  expect(Array.isArray(listedMarkets) && listedMarkets.length > 0, JSON.stringify(listedMarkets).slice(0, 200)).toBe(true);
  for (const market of listedMarkets) expect(market.symbol).toMatch(SYMBOL);

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

  // The streams half stays red until a running service publishes its channel inventory: the live inventory lists routes
  // only, and the local stack has no WebSocket upstream (ws.upstream_unset). When `streams` arrives, it is compared here.
  const { streams: liveStreams } = await capabilities(page);
  expect(
    liveStreams,
    'BLOCKED: no running service publishes its stream inventory (GET /api/v1/capabilities has no streams; the stack has no WebSocket upstream, ws.upstream_unset)',
  ).toBeDefined();
  for (const { channel } of liveStreams)
    expect(
      streams.map((stream) => stream.channel),
      channel,
    ).toContain(channel);
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
  // evaluateAll does not wait, so wait for the rendered list first.
  const portalLinks = page.getByRole('main').getByRole('listitem').filter({ hasText: 'Page in this portal' }).getByRole('link');
  await expect(portalLinks.first()).toBeVisible();
  const written = await portalLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href')));
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

  // "Every route": the live inventory, the file and the collection above agree with each other, but the inventory itself
  // is a matrix kept by hand in svc-trade, so it is checked last against the routes svc-trade's router registers. Until
  // svc-trade serves an inventory read from its mounted routes, the routes it leaves out stay red here by name.
  const registered = registeredTradeRoutes();
  expect(registered.length).toBeGreaterThan(10);
  const missing = registered.filter((route) => !live.includes(route) || !lines.includes(route));
  expect(
    missing,
    `BLOCKED: GET /api/v1/capabilities (and so the OpenAPI file and the collection) omits ${missing.length} of the ${registered.length} /api/v1 routes svc-trade registers and the edge forwards; svc-trade's inventory is a hand-kept matrix, not read from its router:\n${missing.join('\n')}`,
  ).toEqual([]);
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
  const PRODUCTS = ['ticker', 'depth_l1', 'depth_l2', 'candles', 'trades', 'index'];
  const TERMS = ['entitlement', 'redistribution', 'retention', 'privacy', 'commercial'];
  await expect(table.getByRole('columnheader')).toHaveText([
    'Product',
    'Entitlement',
    'Redistribution',
    'Retention',
    'Privacy',
    'Commercial terms',
  ]);
  await expect(rows).toHaveCount(PRODUCTS.length);
  const rowOf = (product) => table.locator(`tbody tr[data-product="${product}"]`);
  // Each product's terms, read back from svc-trade and compared cell by cell. The stack's TEST terms publish five
  // products and leave index out, so a set row and an unset one are both on this page.
  const { products } = await published(page, 'data-terms');
  expect(products.map((row) => row.product)).toEqual(PRODUCTS);
  expect(products.filter((row) => row.terms === null).map((row) => row.product)).toEqual(['index']);
  for (const { product, terms } of products.filter((row) => row.terms !== null)) {
    await expect(rowOf(product)).toHaveAttribute('data-terms-state', 'set');
    await expect(rowOf(product).getByRole('cell')).toHaveText(TERMS.map((term) => terms[term]));
  }
  // A term the owner has not set reads "not set", never an invented value or a blank.
  const unsetRow = async (product) => {
    await expect(rowOf(product)).toHaveAttribute('data-terms-state', 'unset');
    await expect(rowOf(product).getByRole('cell')).toHaveText(TERMS.map(() => 'not set'));
  };
  await unsetRow('index');
  await expect(page.getByTestId('developers-data-terms-unset')).toHaveCount(0);

  // With the owner's terms blank, svc-trade refuses with its one code, the page says so with that code, and every
  // product reads "not set" for every term.
  try {
    tradeDeveloperValues('DATA_TERMS');
    await refusedBlank(page, 'data-terms', 'trade.developer_data_terms_unset');
    await page.reload();
    await expect(page.getByTestId('developers-data-terms-unset')).toHaveAttribute('data-code', 'trade.developer_data_terms_unset');
    await expect(page.getByTestId('developers-data-terms-unset')).toHaveText(
      'No term is published yet: each one reads not set until the owner sets it.',
    );
    for (const product of PRODUCTS) await unsetRow(product);
  } finally {
    tradeDeveloperValues(null);
  }
  await page.reload();
  await expect(rowOf('ticker')).toHaveAttribute('data-terms-state', 'set');
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
