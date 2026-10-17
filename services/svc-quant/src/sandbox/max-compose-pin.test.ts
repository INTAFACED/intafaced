/**
 * Unit card — quant sandbox ceilings are owner-published; blank refuses
 *
 * 1. Promise: SANDBOX_MAX_OPS and SANDBOX_MAX_SOURCE from host `.env` reach
 *    the container. Unset / blank do not become 50000 / 8000. sandbox.run
 *    refuses quant.sandbox_max_ops_unset / quant.sandbox_max_source_unset.
 *    Never invent a ceiling. Isolate does not interpret without a pin.
 * 2. Break: compose `:-50000` / `:-8000` or env.ts `.default(50_000)` /
 *    `.default(8_000)` looks published when the operator never set a cap.
 * 3. Done bar: docker-compose.apps.yml svc-quant has
 *    SANDBOX_MAX_OPS: ${SANDBOX_MAX_OPS:-}
 *    SANDBOX_MAX_SOURCE: ${SANDBOX_MAX_SOURCE:-}
 *    env.ts preprocess blank → undefined, union undefined | int range,
 *    no `.default(50_000)` / `.default(8_000)`
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-quant block only), env.ts,
 *    sandbox/max.ts, isolate runIsolate
 * 6. RED: pin fails if capacity default is 50000/8000, compose bakes those,
 *    or sibling quant keys are restamped
 * 7. Collision: SANDBOX_TIMEOUT_MS stays default 500 (hang fuse). QUANT_VENUE_VAULT
 *    stays empty pass-through. HTTP_PORT stays 4021.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUANT_SANDBOX_MAX_OPS_UNSET, QUANT_SANDBOX_MAX_SOURCE_UNSET } from '../errors.js';
import { assertPublishedSandboxMaxOps, assertPublishedSandboxMaxSource } from './max.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);

function quantServiceBlock(source: string): string {
  const match = source.match(/^  svc-quant:\n(?:.*\n)*?(?=^  [a-z]|\Z)/m);
  if (!match) throw new Error('svc-quant service block missing from docker-compose.apps.yml');
  return match[0];
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

const OPS = /^\s+SANDBOX_MAX_OPS:\s*\$\{SANDBOX_MAX_OPS:-\}\s*$/gm;
const SOURCE = /^\s+SANDBOX_MAX_SOURCE:\s*\$\{SANDBOX_MAX_SOURCE:-\}\s*$/gm;
const VAULT = /^\s+QUANT_VENUE_VAULT:\s*\$\{QUANT_VENUE_VAULT:-\}\s*$/gm;

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('SANDBOX_MAX_OPS', undefined);
  vi.stubEnv('SANDBOX_MAX_SOURCE', undefined);
  vi.stubEnv('EDGE_PRINCIPAL_SECRET', SECRET);
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
  const module = await import('../env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compose SANDBOX_MAX_OPS / SANDBOX_MAX_SOURCE for svc-quant', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-quant/src/env.ts'), 'utf8');
  const helperTs = readFileSync(join(HERE, 'max.ts'), 'utf8');
  const block = quantServiceBlock(compose);

  it('env.ts refuses blank ceilings — no 50000 / 8000 default; timeout stays 500', () => {
    expect(envTs).not.toMatch(/SANDBOX_MAX_OPS:[\s\S]{0,400}\.default\(50_000\)/);
    expect(envTs).not.toMatch(/SANDBOX_MAX_OPS:[\s\S]{0,400}\.default\(50000\)/);
    expect(envTs).not.toMatch(/SANDBOX_MAX_SOURCE:[\s\S]{0,400}\.default\(8_000\)/);
    expect(envTs).not.toMatch(/SANDBOX_MAX_SOURCE:[\s\S]{0,400}\.default\(8000\)/);
    expect(envTs).toMatch(
      /SANDBOX_MAX_OPS:\s*z\.preprocess\(\s*\(v\) => \(v === undefined \|\| \(typeof v === 'string' && v\.trim\(\) === ''\) \? undefined : v\),\s*z\.union\(\[z\.undefined\(\), z\.coerce\.number\(\)\.int\(\)\.min\(100\)\.max\(1_000_000\)\]\),\s*\)/,
    );
    expect(envTs).toMatch(
      /SANDBOX_MAX_SOURCE:\s*z\.preprocess\(\s*\(v\) => \(v === undefined \|\| \(typeof v === 'string' && v\.trim\(\) === ''\) \? undefined : v\),\s*z\.union\(\[z\.undefined\(\), z\.coerce\.number\(\)\.int\(\)\.min\(32\)\.max\(64_000\)\]\),\s*\)/,
    );
    expect(envTs).toMatch(/SANDBOX_TIMEOUT_MS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(50\)\.max\(10_000\)\.default\(500\)/);
  });

  it('compose svc-quant block is the unique home; ceilings are empty pass-through', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-quant/);
    expect(block.match(OPS)).toHaveLength(1);
    expect(block.match(SOURCE)).toHaveLength(1);
    expect(block).not.toMatch(/SANDBOX_MAX_OPS:\s*\$\{SANDBOX_MAX_OPS:-50000\}/);
    expect(block).not.toMatch(/SANDBOX_MAX_SOURCE:\s*\$\{SANDBOX_MAX_SOURCE:-8000\}/);
    expect(countAssignments(block, 'SANDBOX_MAX_OPS')).toBe(1);
    expect(countAssignments(block, 'SANDBOX_MAX_SOURCE')).toBe(1);
    expect(compose.match(/^\s+SANDBOX_MAX_OPS:/gm) ?? []).toHaveLength(1);
    expect(compose.match(/^\s+SANDBOX_MAX_SOURCE:/gm) ?? []).toHaveLength(1);
  });

  it('does not restamp timeout/vault/port or invent ceilings', () => {
    expect(block).not.toMatch(/SANDBOX_TIMEOUT_MS:/);
    expect(block.match(VAULT)).toHaveLength(1);
    expect(block).toMatch(/HTTP_PORT:\s*'4021'/);
    expect(helperTs).toMatch(/quant\.sandbox_max_ops_unset/);
    expect(helperTs).toMatch(/quant\.sandbox_max_source_unset/);
  });
});

describe('svc-quant SANDBOX_MAX_OPS refuse-closed', () => {
  // First resetModules import of env.ts is cold; the 5s default trips when the suite runs in parallel.
  it('unset SANDBOX_MAX_OPS is unpublished (no invent 50000)', async () => {
    const parsed = await loadWith({ SANDBOX_MAX_OPS: undefined });
    expect(parsed.SANDBOX_MAX_OPS).toBeUndefined();
  }, 20_000);

  it('blank SANDBOX_MAX_OPS is unpublished', async () => {
    const parsed = await loadWith({ SANDBOX_MAX_OPS: '' });
    expect(parsed.SANDBOX_MAX_OPS).toBeUndefined();
  });

  it('whitespace SANDBOX_MAX_OPS is unpublished', async () => {
    const parsed = await loadWith({ SANDBOX_MAX_OPS: '   ' });
    expect(parsed.SANDBOX_MAX_OPS).toBeUndefined();
  });

  it('below-min SANDBOX_MAX_OPS refuses (no invent 100)', async () => {
    await expect(loadWith({ SANDBOX_MAX_OPS: '99' })).rejects.toThrow(/SANDBOX_MAX_OPS/);
  });

  it('explicit owner pin 50000 is accepted (not invented)', async () => {
    const parsed = await loadWith({ SANDBOX_MAX_OPS: '50000' });
    expect(parsed.SANDBOX_MAX_OPS).toBe(50_000);
  });
});

describe('svc-quant SANDBOX_MAX_SOURCE refuse-closed', () => {
  it('unset SANDBOX_MAX_SOURCE is unpublished (no invent 8000)', async () => {
    const parsed = await loadWith({ SANDBOX_MAX_SOURCE: undefined });
    expect(parsed.SANDBOX_MAX_SOURCE).toBeUndefined();
  });

  it('blank SANDBOX_MAX_SOURCE is unpublished', async () => {
    const parsed = await loadWith({ SANDBOX_MAX_SOURCE: '' });
    expect(parsed.SANDBOX_MAX_SOURCE).toBeUndefined();
  });

  it('whitespace SANDBOX_MAX_SOURCE is unpublished', async () => {
    const parsed = await loadWith({ SANDBOX_MAX_SOURCE: '   ' });
    expect(parsed.SANDBOX_MAX_SOURCE).toBeUndefined();
  });

  it('below-min SANDBOX_MAX_SOURCE refuses (no invent 32)', async () => {
    await expect(loadWith({ SANDBOX_MAX_SOURCE: '31' })).rejects.toThrow(/SANDBOX_MAX_SOURCE/);
  });

  it('explicit owner pin 8000 is accepted (not invented)', async () => {
    const parsed = await loadWith({ SANDBOX_MAX_SOURCE: '8000' });
    expect(parsed.SANDBOX_MAX_SOURCE).toBe(8_000);
  });
});

describe('assertPublishedSandboxMaxOps / MaxSource', () => {
  it('unset / NaN / out of range refuse by name — never invent 50000', () => {
    for (const value of [undefined, Number.NaN, 0, 99, 1_000_001] as const) {
      try {
        assertPublishedSandboxMaxOps(value);
        expect.unreachable('expected refuse');
      } catch (err) {
        expect(err).toMatchObject({ code: QUANT_SANDBOX_MAX_OPS_UNSET });
      }
    }
  });

  it('unset / NaN / out of range refuse by name — never invent 8000', () => {
    for (const value of [undefined, Number.NaN, 0, 31, 64_001] as const) {
      try {
        assertPublishedSandboxMaxSource(value);
        expect.unreachable('expected refuse');
      } catch (err) {
        expect(err).toMatchObject({ code: QUANT_SANDBOX_MAX_SOURCE_UNSET });
      }
    }
  });

  it('owner-published 50000 / 8000 are ceilings', () => {
    expect(assertPublishedSandboxMaxOps(50_000)).toBe(50_000);
    expect(assertPublishedSandboxMaxSource(8_000)).toBe(8_000);
  });
});
