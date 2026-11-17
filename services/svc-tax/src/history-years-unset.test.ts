/**
 * Unit card — tax history years is owner-published; blank refuses
 *
 * 1. Promise: TAX_HISTORY_YEARS from host `.env` reaches the container.
 *    Unset / blank does not become 10. Export refuses tax.history_years_unset.
 *    Never invent a window. Owner may set 10 explicitly.
 * 2. Break: compose `:-10` or env.ts `.default(10)` / `const HISTORY_YEARS = 10`
 *    looks published when the operator never set a window.
 * 3. Done bar: docker-compose.apps.yml svc-tax has
 *    TAX_HISTORY_YEARS: ${TAX_HISTORY_YEARS:-}
 *    env.ts preprocess blank → undefined, union undefined | 1..100,
 *    no `.default(10)`, no hardcoded HISTORY_YEARS = 10
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-tax block only), env.ts, tax-service.ts
 * 6. RED: pin fails if years default is 10, compose bakes 10, or sibling tax
 *    keys are restamped
 * 7. Collision: jurisdiction map / lake / indexer / /ready honesty — this pin
 *    does not restamp TAX_JURISDICTION_MAP_JSON, CONNECT_DATA_LAKE_TSDB_URL,
 *    INDEXER_URL, or taxReadyHonesty
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);

function taxServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-tax');
}

const LINE = /^\s+TAX_HISTORY_YEARS:\s*\$\{TAX_HISTORY_YEARS:-\}\s*$/gm;
const MAP = /^\s+TAX_JURISDICTION_MAP_JSON:\s*\$\{TAX_JURISDICTION_MAP_JSON:-\}\s*$/gm;
const LAKE = /^\s+CONNECT_DATA_LAKE_TSDB_URL:\s*\$\{CONNECT_DATA_LAKE_TSDB_URL:-\}\s*$/gm;
const INDEXER = /^\s+INDEXER_URL:\s*\$\{INDEXER_URL:-\}\s*$/gm;

const YEARS_SHAPE =
  /TAX_HISTORY_YEARS:\s*z\.preprocess\(\s*\(v\) => \(v === undefined \|\| \(typeof v === 'string' && v\.trim\(\) === ''\) \? undefined : v\),\s*z\.union\(\[z\.undefined\(\), z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\]\),\s*\)/;

const BASE_ENV = {
  EDGE_PRINCIPAL_SECRET: SECRET,
  INTERNAL_SERVICE_SECRET: SECRET,
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('TAX_HISTORY_YEARS', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compose TAX_HISTORY_YEARS for svc-tax', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
  const serviceTs = readFileSync(join(HERE, 'tax-service.ts'), 'utf8');
  const block = taxServiceBlock(compose);

  it('env.ts refuses blank years — no 10 default; map still empty pass-through', () => {
    expect(envTs).not.toMatch(/TAX_HISTORY_YEARS:[\s\S]{0,400}\.default\(10\)/);
    expect(envTs).toMatch(YEARS_SHAPE);
    expect(serviceTs).not.toMatch(/const HISTORY_YEARS = 10/);
    expect(envTs).toMatch(/TAX_JURISDICTION_MAP_JSON:\s*z\.string\(\)\.default\(''\)/);
  });

  it('compose svc-tax block is the unique home; years is empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-tax/);
    expect(block.match(LINE)).toHaveLength(1);
    expect(block).not.toMatch(/TAX_HISTORY_YEARS:\s*\$\{TAX_HISTORY_YEARS:-10\}/);
    const hits = compose.match(/^\s+TAX_HISTORY_YEARS:/gm) ?? [];
    expect(hits, 'TAX_HISTORY_YEARS must appear once (svc-tax only)').toHaveLength(1);
  });

  it('does not restamp jurisdiction map / lake / indexer', () => {
    expect(block.match(MAP)).toHaveLength(1);
    expect(block.match(LAKE)).toHaveLength(1);
    expect(block.match(INDEXER)).toHaveLength(1);
  });
});

describe('svc-tax TAX_HISTORY_YEARS refuse-closed', () => {
  it('unset TAX_HISTORY_YEARS is unpublished (no invent 10)', async () => {
    const parsed = await loadWith({ TAX_HISTORY_YEARS: undefined });
    expect(parsed.TAX_HISTORY_YEARS).toBeUndefined();
  });

  it('blank TAX_HISTORY_YEARS is unpublished', async () => {
    const parsed = await loadWith({ TAX_HISTORY_YEARS: '' });
    expect(parsed.TAX_HISTORY_YEARS).toBeUndefined();
  });

  it('whitespace TAX_HISTORY_YEARS is unpublished', async () => {
    const parsed = await loadWith({ TAX_HISTORY_YEARS: '   ' });
    expect(parsed.TAX_HISTORY_YEARS).toBeUndefined();
  });

  it('zero TAX_HISTORY_YEARS refuses (no invent 1 year)', async () => {
    await expect(loadWith({ TAX_HISTORY_YEARS: '0' })).rejects.toThrow(/TAX_HISTORY_YEARS/);
  });

  it('explicit owner pin 10 is accepted (not invented)', async () => {
    const parsed = await loadWith({ TAX_HISTORY_YEARS: '10' });
    expect(parsed.TAX_HISTORY_YEARS).toBe(10);
  });
});
