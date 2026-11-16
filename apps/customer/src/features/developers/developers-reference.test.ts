import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { developerFiles } from './developers-files';
import { DOCS_PAGES, llmsTxt, markdownOf } from './developers-markdown';
import { SECTIONS } from './developers-model';
import {
  AUTH_REQUIRED,
  CALL_COST,
  NEVER_ON_A_KEY,
  REST_REFERENCE,
  STREAM_DOOR_PATH,
  STREAM_REFERENCE,
  neverOnAKeyTable,
  openApiDocument,
  permissionTable,
  requestCollection,
  routeLine,
  scopeFor,
  scopesOf,
  signedOutOf,
  type Method,
} from './developers-reference';
import {
  declarationKey,
  isRouteSource,
  tradeDeclarations as parseTradeDeclarations,
} from '../../../../../services/svc-trade/src/route-declarations.test-harness';

const repo = (path: string) => readFileSync(new URL(`../../../../../${path}`, import.meta.url), 'utf8');

const ROUTE_LIST = new URL('../../../../../services/svc-trade/src/published-routes.txt', import.meta.url);
const TRADE_SRC = new URL('../../../../../services/svc-trade/src/', import.meta.url);

/** svc-trade's sources, walked here; the parser is svc-trade's own, which its published-route-list.test.ts also runs. */
function tradeDeclarations() {
  const files = (readdirSync(TRADE_SRC, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.ts') && isRouteSource(file))
    .map((file) => ({ file, text: readFileSync(new URL(file, TRADE_SRC), 'utf8') }));
  return parseTradeDeclarations(files);
}

describe('the published route list matches what the services really mount', () => {
  const contract = repo('packages/exchange-contract/src/api.ts');

  it('carries every contract route with its method, path and scope', () => {
    const block = contract.slice(contract.indexOf('export const REST_ROUTES'), contract.indexOf('export type RestRouteName'));
    const table = [...block.matchAll(/^\s+(\w+): \{ method: '(\w+)', path: '([^']+)', scope: (null|'[^']+') \}/gm)].map((match) => ({
      name: match[1]!,
      method: match[2]!,
      path: match[3]!,
      scope: match[4] === 'null' ? null : match[4]!.slice(1, -1),
    }));
    expect(table.length).toBeGreaterThan(0);
    expect(table).toHaveLength(block.match(/method: '/g)!.length);
    for (const row of table) {
      const ours = REST_REFERENCE.find((route) => route.name === row.name);
      expect(ours, row.name).toBeDefined();
      expect([ours!.method, ours!.path, ours!.access === 'public', scopeFor(ours!.method)]).toEqual([
        row.method,
        row.path,
        row.scope === null,
        row.scope ?? scopeFor(row.method as Method),
      ]);
    }
  });

  it('lists every /api/v1 route svc-trade declares, each exactly once, with its access and its scopes', () => {
    const declared = tradeDeclarations();
    // Every registration resolved to a real /api/v1 path; none is left as a variable name.
    for (const route of declared) expect(route.path, `${route.method} ${route.path} in ${route.file}`).toMatch(/^\/api\/v1\//);
    const ours = REST_REFERENCE.map((route) => declarationKey({ ...route, scopes: scopesOf(route) }));
    // The whole list, pinned in its own file one route per line, sorted: as strict as an exact count (a route that
    // leaves both the service and the reference still fails here), and two changes adding different routes edit
    // different lines. `WRITE_ROUTE_LIST=1` rewrites it after a deliberate change.
    const listed = [...ours].sort();
    if (process.env.WRITE_ROUTE_LIST === '1') writeFileSync(ROUTE_LIST, `${listed.join('\n')}\n`);
    const pinned = readFileSync(ROUTE_LIST, 'utf8').split('\n').filter(Boolean);
    expect(listed, 'services/svc-trade/src/published-routes.txt: run WRITE_ROUTE_LIST=1 after a deliberate route change').toEqual(pinned);
    expect(new Set(ours).size).toBe(ours.length);
    expect([...ours].sort()).toEqual([...new Set(declared.map(declarationKey))].sort());
  });

  it('registers a route twice only where the resting refusal stands in for futures matching, and marks both sets', () => {
    const declared = tradeDeclarations();
    const lines = declared.map((route) => `${route.method} ${route.path}`);
    const twice = [...new Set(lines.filter((line, i) => lines.indexOf(line) !== i))].sort();
    const inFile = (file: string) => declared.filter((route) => route.file === file).map((route) => `${route.method} ${route.path}`);
    const matched = inFile('futures/matched-orders-rest.ts');
    const resting = inFile('futures/conditional-orders/rest.ts').filter((line) => / \/api\/v1\/futures\/orders(\/:id)?$/.test(line));
    expect(resting.sort()).toEqual(['DELETE /api/v1/futures/orders/:id', 'GET /api/v1/futures/orders', 'POST /api/v1/futures/orders']);
    expect(twice).toEqual(resting);
    expect(
      REST_REFERENCE.filter((route) => route.signedOutWithoutMatching)
        .map(routeLine)
        .sort(),
    ).toEqual(resting);
    expect(
      REST_REFERENCE.filter((route) => route.onlyWithFuturesMatching)
        .map(routeLine)
        .sort(),
    ).toEqual(matched.filter((line) => !resting.includes(line)).sort());
  });

  it('lists every route in svc-trade’s live inventory, the one GET /api/v1/capabilities serves', () => {
    const matrix = repo('services/svc-trade/src/ccxt-capability-matrix.ts');
    const rows = matrix.slice(matrix.indexOf('export const CCXT_CAPABILITY_MATRIX'));
    const literal = [...rows.matchAll(/method: '(\w+)',\s*path: '([^']+)'/g)].map((match) => `${match[1]} ${match[2]}`);
    const fromContract = [...rows.matchAll(/route\(\s*'(\w+)'/g)].map((match) => match[1]!);
    expect(literal.length).toBeGreaterThan(10);
    expect(fromContract.length).toBeGreaterThan(10);
    const ours = new Set(REST_REFERENCE.map(routeLine));
    for (const line of literal) expect(ours.has(line), line).toBe(true);
    for (const name of fromContract)
      expect(
        REST_REFERENCE.some((route) => route.name === name),
        name,
      ).toBe(true);
  });

  it('lists every channel svc-ws serves, door by door, each once, with its privacy and its door path', () => {
    /** The quoted names in `export const <name> ... = [...]`, or the one in `export const <name> = '...'`. */
    const served = (file: string, name: string) => {
      const match = new RegExp(`export const ${name}\\b[^=]*= (\\[[^\\]]*\\]|'[^']*')`).exec(repo(`services/svc-ws/src/${file}`));
      expect(match, `${name} in ${file}`).not.toBeNull();
      return [...match![1]!.matchAll(/'([^']+)'/g)].map((quoted) => quoted[1]!);
    };
    const marketPath = served('ws/gateway.ts', 'STREAM_PATH')[0];
    const doors = {
      market: { channels: served('ws/gateway.ts', 'STREAM_CHANNELS'), path: marketPath, private: false },
      mux: {
        channels: [...served('mux/protocol.ts', 'MUX_CHANNELS'), ...served('mux/protocol.ts', 'FUTURES_MARK_PREFIX')],
        path: marketPath,
        private: false,
      },
      private: {
        channels: served('private/gateway.ts', 'PRIVATE_CHANNELS'),
        path: served('private/gateway.ts', 'PRIVATE_STREAM_PATH')[0],
        private: true,
      },
      'drop-copy': {
        channels: served('drop-copy/hub.ts', 'DROP_COPY_CHANNEL'),
        path: served('drop-copy/gateway.ts', 'DROP_COPY_STREAM_PATH')[0],
        private: true,
      },
    };
    const expected = Object.entries(doors).flatMap(([door, entry]) =>
      entry.channels.map((channel) => ({ door, channel, private: entry.private })),
    );
    expect(expected).toHaveLength(11);
    expect(STREAM_REFERENCE.map(({ door, channel, private: isPrivate }) => ({ door, channel, private: isPrivate }))).toEqual(expected);
    expect(STREAM_DOOR_PATH).toEqual(Object.fromEntries(Object.entries(doors).map(([door, entry]) => [door, entry.path])));
    // Each stream sits under the product svc-ws gives it (`STREAM_PRODUCTS`, served on every `/streams` entry).
    const products = /export const STREAM_PRODUCTS\b[^=]*= \{([^}]*)\}/.exec(repo('services/svc-ws/src/stream-inventory.ts'));
    expect(products, 'STREAM_PRODUCTS in stream-inventory.ts').not.toBeNull();
    const productOf = Object.fromEntries([...products![1]!.matchAll(/'([^']+)': '([^']+)'/g)].map((m) => [m[1]!, m[2]!]));
    expect(Object.keys(productOf)).toEqual(expected.map(({ door, channel }) => `${door} ${channel}`));
    expect(STREAM_REFERENCE.map(({ door, channel, product }) => `${door} ${channel} ${product}`)).toEqual(
      Object.entries(productOf).map(([key, product]) => `${key} ${product}`),
    );
  });

  it('states the scope rule and the call cost the edge enforces, and reads the signing window from identity', () => {
    const gateway = repo('services/svc-edge/src/gateway-plane.ts');
    expect(gateway).toMatch(/const write = verb !== 'GET' && verb !== 'HEAD' && verb !== 'OPTIONS';/);
    expect(gateway).toMatch(/if \(door === 'trade'\) return write \? 'trade:write' : 'trade:read';/);
    expect(gateway).toContain("PERMISSION_TABLE_DOCS = '/developers/permissions'");
    expect(repo('services/svc-edge/src/hardening.ts')).toContain(`export const EDGE_RATE_COST = ${CALL_COST} as const;`);
    // The window is an owner value identity publishes: the pages read it live and never hold a number of their own.
    expect(repo('services/svc-identity/src/auth/api-key-request-sign.ts')).not.toMatch(/REQUEST_SIGN_WINDOW_SECONDS = \d/);
    expect(repo('apps/customer/src/features/developers/developers-signing.ts')).toContain("'requestSigningPolicy'");
    expect(repo('apps/customer/src/features/developers/developers-reference.ts')).not.toMatch(/WINDOW_SECONDS = \d/);
  });

  it('names only refusals the capability matrix has, at its status', () => {
    const matrix = repo('services/svc-trade/src/ccxt-capability-matrix.ts');
    for (const route of REST_REFERENCE)
      for (const refusal of route.refusals ?? [])
        for (const code of refusal.codes)
          expect(matrix, code).toMatch(
            new RegExp(`httpStatus: ${refusal.status},\\s*ccxtCode: '\\w+',\\s*intafacedCode: '${code.replace('.', '\\.')}'`),
          );
  });
});

describe('the machine-readable files', () => {
  it('gives every operation a scope, a cost and a refusal, and names no server', () => {
    const doc = openApiDocument();
    expect(doc.openapi).toMatch(/^3\./);
    expect('servers' in doc).toBe(false);
    const operations = Object.values(doc.paths).flatMap((methods) => Object.values(methods)) as Record<string, unknown>[];
    expect(operations).toHaveLength(REST_REFERENCE.length);
    for (const operation of operations) {
      const route = REST_REFERENCE.find((r) => r.name === operation.operationId)!;
      expect(operation.security).toBeDefined();
      expect([operation['x-access'], operation['x-scopes']]).toEqual([route.access, scopesOf(route)]);
      expect(operation['x-cost']).toBe(CALL_COST);
      expect(Object.keys(operation.responses as object).some((status) => /^[45]/.test(status))).toBe(true);
    }
    expect(JSON.stringify(doc)).not.toMatch(/https?:\/\/(?!schema)/);
  });

  it('puts every route in the collection with a blank base address', () => {
    const collection = requestCollection();
    expect(collection.item.flatMap((folder) => folder.item)).toHaveLength(REST_REFERENCE.length);
    expect(collection.variable.find((v) => v.key === 'baseUrl')?.value).toBe('');
  });

  it('gives every signed-in route its signed-out refusal and every key route its 403', () => {
    const operations = Object.values(openApiDocument().paths).flatMap((methods) => Object.values(methods)) as {
      operationId: string;
      'x-signed-out': unknown;
      responses: Record<string, unknown>;
    }[];
    for (const operation of operations) {
      const route = REST_REFERENCE.find((r) => r.name === operation.operationId)!;
      expect([operation['x-signed-out'], '401' in operation.responses, '403' in operation.responses], route.name).toEqual([
        signedOutOf(route),
        route.access !== 'public',
        route.access !== 'internal',
      ]);
    }
  });

  it("the grid bot and algo routes answer signed out as svc-trade's requirePrincipal does: 401 auth.required", () => {
    // svc-trade's route-inventory test pins every private route, these included, to 401 intafacedCode auth.required; the
    // reference said trade.unauthenticated for them (J-developer-01 #5 on main after #7008 and #6976).
    const routes = REST_REFERENCE.filter((r) => /^\/api\/v1\/(bots\/grid|algo)(\/|$)/.test(r.path));
    expect(routes.map((r) => r.name)).toHaveLength(10);
    for (const route of routes) expect(signedOutOf(route), route.name).toEqual(AUTH_REQUIRED);
  });

  it('permission table: one row per scope a key can hold, each key-callable route under its method scope once', () => {
    const rows = permissionTable();
    const staff = ['GET /api/v1/admin/orders/open', 'GET /api/v1/admin/fees'];
    const keyCallable = REST_REFERENCE.filter((route) => route.access !== 'internal' && !staff.includes(routeLine(route)));
    expect(rows.map((row) => row.scope)).toEqual(['trade:read', 'trade:write', 'copy:lead']);
    expect(rows[2]!.routes.map(routeLine)).toEqual(['POST /api/v1/copy/lead/orders']);
    expect([...rows[0]!.routes, ...rows[1]!.routes].map(routeLine).sort()).toEqual(keyCallable.map(routeLine).sort());
    expect(rows[1]!.routes.map(routeLine)).toContain('POST /api/v1/orders');
    expect(rows.flatMap((row) => row.routes).map(routeLine)).not.toContain('POST /api/v1/outcomes/settle');
  });

  it('a scope no key can hold is never offered to a key: admin:read and trade:withdraw read "Never on a key"', () => {
    // The interactive-only list, read from packages/auth itself: a scope the page says no key holds must be on it.
    const source = repo('packages/auth/src/scopes.ts');
    const list = source.slice(source.indexOf('export const INTERACTIVE_ONLY_SCOPES'));
    const interactiveOnly = [...list.slice(0, list.indexOf('];')).matchAll(/'([a-z]+:[a-z]+)'/g)].map((match) => match[1]);
    expect([...NEVER_ON_A_KEY].filter((scope) => !interactiveOnly.includes(scope))).toEqual([]);
    // Every scope a route takes is either one a key can hold (a key row) or on the never-on-a-key list.
    const routeScopes = [...new Set(REST_REFERENCE.flatMap((route) => scopesOf(route)))].sort();
    const keyRows = permissionTable().map((row) => row.scope as string);
    expect(routeScopes.filter((scope) => interactiveOnly.includes(scope)).sort()).toEqual(
      routeScopes.filter((scope) => !keyRows.includes(scope)).sort(),
    );
    expect(neverOnAKeyTable().map((row) => ({ scope: row.scope, routes: row.routes.map(routeLine) }))).toEqual([
      { scope: 'admin:read', routes: ['GET /api/v1/admin/orders/open', 'GET /api/v1/admin/fees'] },
      { scope: 'trade:withdraw', routes: [] },
    ]);
    const permissions = markdownOf(DOCS_PAGES.find((page) => page.slug === 'permissions')!);
    expect(permissions).toMatch(/\| `admin:read` +\| Never on a key: only a staff session holds it/);
    expect(permissions).toMatch(/\| `trade:withdraw` +\| Never on a key: withdrawing is interactive only/);
  });

  /**
   * The files the build writes into `dist/developers/` and `vite dev` serves (vite.config.ts `developerDocs`), as
   * generated from the route list, the copy and the host table. They are not committed, so there is no copy to drift.
   */
  const files = developerFiles();

  it('generates every file from the route list, the copy and the host table', () => {
    expect(Object.keys(files).sort()).toEqual(
      ['collection.json', 'llms.txt', 'openapi.json', ...DOCS_PAGES.map((page) => `${page.slug}.md`)].sort(),
    );
    expect(JSON.parse(files['openapi.json']!)).toEqual(openApiDocument());
    expect(JSON.parse(files['collection.json']!)).toEqual(requestCollection());
    expect(files['llms.txt']).toBe(llmsTxt());
    for (const page of DOCS_PAGES) expect(files[`${page.slug}.md`]).toBe(markdownOf(page));
  });

  it('gives every written page of the portal a markdown variant, except the live pages', () => {
    const written = SECTIONS.filter((section) => section.page && !['status', 'changelog'].includes(section.id)).map(
      (section) => section.id,
    );
    expect(written.filter((id) => !DOCS_PAGES.some((page) => page.slug === id))).toEqual([]);
  });

  it('lists each page once in the docs index, each beside its markdown variant', () => {
    const pages = files['llms.txt']!.match(/\/developers\/[a-z-/]+\.md/g) ?? [];
    expect(pages).toEqual(DOCS_PAGES.map((page) => `/developers/${page.slug}.md`));
    for (const page of DOCS_PAGES) expect(files[`${page.slug}.md`]!.startsWith(`# ${page.title}\n`)).toBe(true);
    for (const route of REST_REFERENCE) expect(files['reference.md']).toContain(routeLine(route));
    for (const scope of ['trade:read', 'trade:write', 'trade:withdraw']) expect(files['permissions.md']).toContain(scope);
    // Live pages and sections published elsewhere are named by their real address, never by a markdown file.
    for (const href of ['/developers/status', '/developers/changelog', '/pay/developer/webhooks'])
      expect(files['llms.txt']).toContain(href);
  });
});
