import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The sandbox store holds TEST balances and must never reach the ledger (the lead's ruling of 2026-10-30): no file of
 * the store, and nothing it imports from inside svc-pay, may import ledger-client (its recipes or its client) or any
 * ledger service module. Followed through relative imports, so a helper cannot carry one in.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = [/@intafaced\/ledger-client/, /\bledger[-/]/i, /recipes?\b/];

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

function reach(entry: string, seen = new Set<string>()): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const specs = importsOf(file);
    out.set(file, specs);
    for (const spec of specs) {
      if (spec.startsWith('.')) walk(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
    }
  };
  walk(entry);
  return out;
}

describe('sandbox store isolation from the ledger', () => {
  const sources = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('covers the store, its router and its settings', () => {
    expect(sources.sort()).toEqual(['router.ts', 'settings.ts', 'store.ts']);
  });

  it('imports no ledger-client and no ledger module, directly or through svc-pay helpers', () => {
    const offending: string[] = [];
    for (const source of sources) {
      for (const [file, specs] of reach(join(here, source))) {
        for (const spec of specs) if (FORBIDDEN.some((re) => re.test(spec))) offending.push(`${file}: ${spec}`);
      }
    }
    expect(offending).toEqual([]);
  });
});
