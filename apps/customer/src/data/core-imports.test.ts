import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = normalize(join(dirname(from), spec)).replace(/\.js$/, '');
  for (const file of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')])
    if (existsSync(file) && statSync(file).isFile()) return file;
  return null;
}

/** Comments blanked out, so a quote or the word `from` inside one cannot hide an import. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

/** The app files a module pulls in through static imports (dynamic `import()` excluded). */
function reach(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [join(src, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of withoutComments(readFileSync(file, 'utf8')).matchAll(IMPORT)) {
      const next = spec ? resolve(file, spec) : null;
      if (next && /\.tsx?$/.test(next)) queue.push(next);
    }
  }
  return [...seen].map((file) => file.slice(src.length + 1));
}

// The session and the shared data layer load with every page, so the big per-area copy catalogs stay out of them.
describe.each(['features/session/session.tsx', 'data/index.ts', 'screens/home/index.tsx'])('%s', (entry) => {
  const files = reach(entry);
  it.each(['features/trade/copy.tsx', 'features/trade/trade-api.ts', 'features/money/copy.ts', 'features/money/contracts.ts'])(
    'leaves out %s',
    (file) => expect(files).not.toContain(file),
  );
});
