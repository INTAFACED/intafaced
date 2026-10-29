import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { DOCS_PAGES, llmsTxt, markdownOf } from './developers-markdown';
import {
  CALL_COST,
  REST_REFERENCE,
  STREAM_REFERENCE,
  openApiDocument,
  permissionTable,
  requestCollection,
  routeLine,
  scopeFor,
} from './developers-reference';
import { SIGN_WINDOW_SECONDS } from './DocsPages';

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
    const privateRoutes = new Set(mounted(repo('services/svc-trade/src/private-rest.ts')));
    for (const route of REST_REFERENCE.filter((r) => !r.anonymous))
      expect(privateRoutes.has(routeLine(route)), routeLine(route)).toBe(true);
  });

  it('lists every contract stream with its privacy', () => {
    const block = contract.slice(contract.indexOf('export const WS_CHANNELS'), contract.indexOf('export type WsChannel'));
    const channels = [...block.matchAll(/^\s+(\w+): \{ private: (true|false)/gm)].map((match) => ({
      channel: match[1],
      private: match[2] === 'true',
    }));
    expect(channels.length).toBeGreaterThan(0);
    expect(STREAM_REFERENCE.map(({ channel, private: isPrivate }) => ({ channel, private: isPrivate }))).toEqual(channels);
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

  const files: Record<string, string> = {
    'openapi.json': `${JSON.stringify(openApiDocument(), null, 2)}\n`,
    'collection.json': `${JSON.stringify(requestCollection(), null, 2)}\n`,
    'llms.txt': llmsTxt(),
    ...Object.fromEntries(DOCS_PAGES.map((page) => [`${page.slug}.md`, markdownOf(page)])),
  };
  if (WRITE) {
    mkdirSync(publicDir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(new URL(name, publicDir), body);
  }

  it('serves the OpenAPI file and the collection exactly as generated from the route list', () => {
    for (const name of ['openapi.json', 'collection.json'])
      expect(JSON.parse(readFileSync(new URL(name, publicDir), 'utf8')), `${name}: run WRITE_DEVELOPER_DOCS=1`).toEqual(
        JSON.parse(files[name]!),
      );
  });

  it('serves the docs index with each page once, each beside its markdown variant', () => {
    const index = readFileSync(new URL('llms.txt', publicDir), 'utf8');
    expect(index, 'run WRITE_DEVELOPER_DOCS=1').toBe(files['llms.txt']);
    const pages = index.match(/\/developers\/[a-z-/]+\.md/g) ?? [];
    expect(pages).toHaveLength(DOCS_PAGES.length);
    expect(new Set(pages).size).toBe(pages.length);
    for (const page of DOCS_PAGES) {
      const file = new URL(`${page.slug}.md`, publicDir);
      expect(existsSync(file), page.slug).toBe(true);
      expect(readFileSync(file, 'utf8').startsWith(`# ${page.title}\n`)).toBe(true);
    }
    const reference = readFileSync(new URL('reference.md', publicDir), 'utf8');
    for (const route of REST_REFERENCE) expect(reference).toContain(routeLine(route));
    const permissions = readFileSync(new URL('permissions.md', publicDir), 'utf8');
    for (const scope of ['trade:read', 'trade:write', 'trade:withdraw']) expect(permissions).toContain(scope);
  });
});
