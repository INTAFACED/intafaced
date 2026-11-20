import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recipes, type RecipeName } from './index.js';
import { FEE_REVENUE_PATHS, RECIPES_TOUCHING_HOUSE_FEES, type FeeRevenueClosure } from './fee-revenue-map.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

/** Recipe source files (not tests) under this directory. */
function recipeSourceFiles(): string[] {
  return readdirSync(HERE)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'fee-revenue-map.ts')
    .map((name) => join(HERE, name));
}

/**
 * Re-derive which exported recipe functions mention `houseFees(` in source.
 * A new fee-touching recipe that is not on the matrix fails the suite —
 * that is the closed-matrix gate (D26-P0-09).
 */
function recipesTouchingHouseFeesFromSource(): RecipeName[] {
  const registry = new Set(Object.keys(recipes) as RecipeName[]);
  const found = new Set<RecipeName>();

  for (const file of recipeSourceFiles()) {
    const src = readFileSync(file, 'utf8');
    // Strip block comments so chargeback's "why not houseFees" prose does not count.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const fnNames = [...code.matchAll(/export function ([a-zA-Z][a-zA-Z0-9]*)\s*\(/g)].map((m) => m[1]!);
    for (const name of fnNames) {
      if (!registry.has(name as RecipeName)) continue;
      // Function body: from this export to the next export function/const, or EOF.
      // Match the whole name: `feeGiveBackOwe` must not find `feeGiveBackOwedAccount` first.
      const start = code.search(new RegExp(`export function ${name}\\s*\\(`));
      if (start < 0) continue;
      const rest = code.slice(start);
      const next = rest.slice(`export function ${name}`.length).search(/\nexport (?:function|const|type|interface|async)/);
      const body = next < 0 ? rest : rest.slice(0, `export function ${name}`.length + next);
      if (/\bhouseFees\s*\(/.test(body)) found.add(name as RecipeName);
    }
  }

  return [...found].sort();
}

function trackerIds(): Set<string> {
  const featuresPath = join(REPO_ROOT, 'tooling', 'tracker', 'features.mjs');
  const src = readFileSync(featuresPath, 'utf8');
  return new Set([...src.matchAll(/\bf\(\s*'([^']+)'/g)].map((m) => m[1]!));
}

describe('D26-P0-09 fee + revenue recipe map', () => {
  it('every matrix recipe closure names a registry key (no invented recipes)', () => {
    const registry = new Set(Object.keys(recipes) as RecipeName[]);
    for (const [pathId, closure] of Object.entries(FEE_REVENUE_PATHS) as [string, FeeRevenueClosure][]) {
      if (closure.kind !== 'recipe') continue;
      expect(registry.has(closure.recipe), `${pathId} → recipe '${closure.recipe}' must exist in recipes registry`).toBe(true);
    }
  });

  it('every recipe that posts houseFees is on the matrix (closed or named)', () => {
    const fromSource = recipesTouchingHouseFeesFromSource();
    expect(fromSource).toEqual([...RECIPES_TOUCHING_HOUSE_FEES].sort());

    const covered = new Set<RecipeName>();
    for (const closure of Object.values(FEE_REVENUE_PATHS) as FeeRevenueClosure[]) {
      if (closure.kind === 'recipe') covered.add(closure.recipe);
    }

    for (const name of fromSource) {
      expect(covered.has(name), `recipe '${name}' touches houseFees but is missing from FEE_REVENUE_PATHS`).toBe(true);
    }
  });

  it('every §13 / tracker socket id exists in features.mjs', () => {
    const ids = trackerIds();
    for (const [pathId, closure] of Object.entries(FEE_REVENUE_PATHS) as [string, FeeRevenueClosure][]) {
      if (closure.kind !== 'socket') continue;
      if (closure.socket.startsWith('DIRECTION§')) continue;
      expect(ids.has(closure.socket), `${pathId} → socket '${closure.socket}' missing from features.mjs`).toBe(true);
    }
  });

  it('matrix is non-empty and every path has a non-empty note', () => {
    const entries = Object.entries(FEE_REVENUE_PATHS);
    expect(entries.length).toBeGreaterThanOrEqual(14);
    for (const [pathId, closure] of entries as [string, FeeRevenueClosure][]) {
      expect(closure.note.trim().length, `${pathId} needs a note`).toBeGreaterThan(8);
      expect(closure.kind === 'recipe' || closure.kind === 'socket').toBe(true);
    }
  });

  it('no matrix recipe row invents a name outside the registry export', () => {
    // Belt: RECIPES_TOUCHING_HOUSE_FEES itself must be a subset of registry.
    for (const name of RECIPES_TOUCHING_HOUSE_FEES) {
      expect(typeof recipes[name]).toBe('function');
    }
  });
});
