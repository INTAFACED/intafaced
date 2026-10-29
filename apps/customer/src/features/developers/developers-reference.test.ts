import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { DOCS_PAGES, llmsTxt, markdownOf } from './developers-markdown';
import {
  CALL_COST,
  REST_REFERENCE,
  SIGN_WINDOW_SECONDS,
  STREAM_DOOR_PATH,
  STREAM_REFERENCE,
  openApiDocument,
  permissionTable,
  requestCollection,
  routeLine,
  scopeFor,
} from './developers-reference';

const repo = (path: string) => readFileSync(new URL(`../../../../../${path}`, import.meta.url), 'utf8');
const publicDir = new URL('../../../public/developers/', import.meta.url);
const WRITE = process.env.WRITE_DEVELOPER_DOCS === '1';

/** `app.get('/api/v1/...'` and friends, generics and all; a route registered through a variable is not matched. */
const mounted = (source: string) =>
  [...source.matchAll(/app\.(get|post|put|delete|patch)(?:<[^(]*?>)?\(\s*'(\/api\/v1\/[^']*)'/g)].map(
    (match) => `${match[1]!.toUpperCase()} ${match[2]}`,
  );

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
      expect([ours!.method, ours!.path, ours!.anonymous]).toEqual([row.method, row.path, row.scope === null]);
      if (row.scope) expect(scopeFor(ours!.method)).toBe(row.scope);
    }
  });

  it('lists every public route svc-trade mounts, and calls only those public', () => {
    const publicRoutes = new Set(mounted(repo('services/svc-trade/src/public-rest.ts')));
    expect(publicRoutes.has('GET /api/v1/time')).toBe(true);
    expect(new Set(REST_REFERENCE.filter((route) => route.anonymous).map(routeLine))).toEqual(publicRoutes);
  });

  it('lists only private routes svc-trade mounts', () => {
    const preview = repo('services/svc-trade/src/spot/order-preview-rest.ts').match(/SPOT_ORDER_PREVIEW_PATH = '([^']+)'/)![1];
    const privateRoutes = new Set([
      ...mounted(repo('services/svc-trade/src/private-rest.ts')),
      ...mounted(repo('services/svc-trade/src/statements/statement-rest.ts')),
      `POST ${preview}`,
    ]);
    for (const route of REST_REFERENCE.filter((r) => !r.anonymous))
      expect(privateRoutes.has(routeLine(route)), routeLine(route)).toBe(true);
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

  it('states the scope rule, the call cost and the signing window the edge enforces', () => {
    const gateway = repo('services/svc-edge/src/gateway-plane.ts');
    expect(gateway).toMatch(/const write = verb !== 'GET' && verb !== 'HEAD' && verb !== 'OPTIONS';/);
    expect(gateway).toMatch(/if \(door === 'trade'\) return write \? 'trade:write' : 'trade:read';/);
    expect(gateway).toContain("PERMISSION_TABLE_DOCS = '/developers/permissions'");
    expect(repo('services/svc-edge/src/hardening.ts')).toContain(`export const EDGE_RATE_COST = ${CALL_COST} as const;`);
    for (const file of ['services/svc-edge/src/api-key-request-sign.ts', 'services/svc-identity/src/auth/api-key-request-sign.ts'])
      expect(repo(file)).toContain(`export const REQUEST_SIGN_WINDOW_SECONDS = ${SIGN_WINDOW_SECONDS};`);
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
      expect(operation.security).toBeDefined();
      expect(operation['x-scope']).toMatch(/^trade:(read|write)$/);
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

  it('permission table: one row per key scope, every route once', () => {
    const rows = permissionTable();
    expect(rows.map((row) => row.scope)).toEqual(['trade:read', 'trade:write']);
    expect(rows.flatMap((row) => row.routes)).toHaveLength(REST_REFERENCE.length);
    expect(rows[1]!.routes.map(routeLine)).toContain('POST /api/v1/orders');
  });

  /**
   * Each file exactly as it is committed: generated, then put through the repo's own Prettier settings for its type, so
   * `prettier --check` passes on a fresh write. A text file Prettier has no parser for (llms.txt) is kept as generated.
   * `WRITE_DEVELOPER_DOCS=1` writes them.
   */
  const files: Record<string, string> = {};
  beforeAll(async () => {
    const prettier = await import('prettier');
    const generated: Record<string, string> = {
      'openapi.json': JSON.stringify(openApiDocument()),
      'collection.json': JSON.stringify(requestCollection()),
      'llms.txt': llmsTxt(),
      ...Object.fromEntries(DOCS_PAGES.map((page) => [`${page.slug}.md`, markdownOf(page)])),
    };
    for (const [name, body] of Object.entries(generated)) {
      const filepath = fileURLToPath(new URL(name, publicDir));
      const info = await prettier.getFileInfo(filepath);
      files[name] = info.inferredParser ? await prettier.format(body, { ...(await prettier.resolveConfig(filepath)), filepath }) : body;
    }
    if (WRITE) {
      mkdirSync(publicDir, { recursive: true });
      for (const [name, body] of Object.entries(files)) writeFileSync(new URL(name, publicDir), body);
    }
  });

  it('serves every file exactly as generated from the route list, the copy and the host table', () => {
    expect(Object.keys(files).sort()).toEqual(
      ['collection.json', 'llms.txt', 'openapi.json', ...DOCS_PAGES.map((page) => `${page.slug}.md`)].sort(),
    );
    for (const [name, body] of Object.entries(files)) {
      const file = new URL(name, publicDir);
      expect(existsSync(file), `${name}: run WRITE_DEVELOPER_DOCS=1`).toBe(true);
      expect(readFileSync(file, 'utf8'), `${name}: run WRITE_DEVELOPER_DOCS=1`).toBe(body);
    }
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
