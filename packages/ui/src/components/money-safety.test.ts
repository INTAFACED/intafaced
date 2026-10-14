import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * UI-SPEC 1.1 rule 5 and COMPONENT-PLAN 3.4: money never becomes a float. Floats are
 * allowed only for drawing (sparkline). Everything else in the kit that touches an
 * amount must stay on decimal strings and bigint.
 */
const dir = fileURLToPath(new URL('.', import.meta.url));
const exempt = /sparkline|chart|__gallery__|\.test\./;

describe('no float arithmetic on money in the UI kit', () => {
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !exempt.test(f));

  it('has files to check', () => {
    expect(files).toContain('amount-input-logic.ts');
    expect(files).toContain('numbers.tsx');
  });

  it.each(files)('%s has no parseFloat, Number(), toFixed() or unary +value', (file) => {
    const code = readFileSync(join(dir, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bparseFloat\s*\(/);
    expect(code).not.toMatch(/\bNumber\s*\(/);
    expect(code).not.toMatch(/\.toFixed\s*\(/);
    expect(code).not.toMatch(/=\s*\+[a-zA-Z_]/);
  });
});
