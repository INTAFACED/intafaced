import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = normalize(join(dirname(from), spec));
  for (const file of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')])
    if (existsSync(file) && statSync(file).isFile()) return file;
  return null;
}

/** Every app file the first download carries: the static imports reachable from main.tsx (dynamic `import()` excluded). */
function firstPaintFiles(): Set<string> {
  const seen = new Set<string>();
  const queue = [join(src, 'main.tsx')];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const next = spec ? resolve(file, spec) : null;
      if (next && /\.tsx?$/.test(next)) queue.push(next);
    }
  }
  return new Set([...seen].map((file) => file.slice(src.length + 1)));
}

describe('the first download', () => {
  const files = firstPaintFiles();

  it('is found from main.tsx', () => {
    expect(files.has('app/App.tsx')).toBe(true);
  });

  // Rooms outside the signed-in doors, and the merchant portal, load on demand (Home's speed budget).
  it.each([
    'features/public/PublicRoutes',
    'features/public/AuthForm',
    'features/protocol/ProtocolRoutes',
    'app/Web3Shell',
    'app/DevFeatures',
    'features/account/AccountRoutes',
    'features/pay/portal/access/',
    'features/pay/portal/chrome/Chrome',
    'features/pay/portal/home-layout/Navigation',
  ])('leaves out %s', (prefix) => {
    expect([...files].filter((file) => file.startsWith(prefix))).toEqual([]);
  });
});
