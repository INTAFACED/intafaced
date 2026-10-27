import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * UI-SPEC 1.1 rule 5 and COMPONENT-PLAN 3.4: money never becomes a float. Floats are
 * allowed only for drawing (sparklines, charts, the light objects in `lit/fx/`) and for
 * the design values in `theme/` (spacing, type and radius sizes). Everything else in the
 * kit that touches an amount must stay on decimal strings and bigint.
 *
 * The scan walks every folder under `src/`, so a component in a subfolder (`coins/`, `lit/`
 * and its templates) is checked the moment it is added.
 */
const src = fileURLToPath(new URL('..', import.meta.url));
const exempt = /sparkline|chart|__gallery__|\.test\.|(^|\/)theme\/|(^|\/)lit\/fx\//i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [relative(src, path)] : [];
  });
}

describe('no float arithmetic on money in the UI kit', () => {
  const files = sourceFiles(src).filter((f) => !exempt.test(f));

  it('has files to check, in subfolders too', () => {
    expect(files).toContain('components/amount-input-logic.ts');
    expect(files).toContain('components/numbers.tsx');
    expect(files).toContain('primitives.tsx');
    expect(files.some((f) => f.startsWith('components/coins/'))).toBe(true);
  });

  it('leaves out only drawing code and design values', () => {
    expect(exempt.test('lit/fx/sphere.ts')).toBe(true);
    expect(exempt.test('theme/tokens.ts')).toBe(true);
    expect(exempt.test('lit/templates/balance.tsx')).toBe(false);
    expect(exempt.test('components/numbers.tsx')).toBe(false);
  });

  it.each(files)('%s has no parseFloat, Number(), toFixed() or unary +value', (file) => {
    const code = readFileSync(join(src, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bparseFloat\s*\(/);
    expect(code).not.toMatch(/\bNumber\s*\(/);
    expect(code).not.toMatch(/\.toFixed\s*\(/);
    expect(code).not.toMatch(/=\s*\+[a-zA-Z_]/);
  });
});
