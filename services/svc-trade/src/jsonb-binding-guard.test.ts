import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * postgres.js serialises a string bound to a jsonb parameter as a JSON *string*, so `${JSON.stringify(x)}::jsonb`
 * stores the text of the object, not the object. The safe forms are `${sql.json(x)}::jsonb` and `${text}::text::jsonb`.
 * The real-driver tests cover each insert path; this guard catches a new one before it ships.
 */
const here = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

describe('svc-trade jsonb binding', () => {
  it('never binds a plain string straight to ::jsonb', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(here)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}::jsonb/g)) {
        if (!/\.json\(/.test(m[1] ?? '')) offenders.push(`${file.slice(here.length + 1)}: \${${m[1]}}::jsonb`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
