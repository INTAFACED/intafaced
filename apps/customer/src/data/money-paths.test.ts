/**
 * UI-SPEC §2.6 / principle 5: money stays exact. This is the grep-style check
 * that fails if any non-test file in `data/` pushes a money value through a JS
 * float. The scanner can be pointed at other folders (the spec asks for the same
 * check over `screens/**`, minus files named *chart* or *sparkline*).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Remove comments and the text inside string/template literals so prose cannot trigger or hide a hit. */
function stripNoise(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
    } else if (c === "'" || c === '"') {
      i += 1;
      while (i < source.length && source[i] !== c) i += source[i] === '\\' ? 2 : 1;
      i += 1;
      out += '""';
    } else if (c === '`') {
      i += 1;
      let depth = 0;
      while (i < source.length && (source[i] !== '`' || depth > 0)) {
        if (source[i] === '$' && source[i + 1] === '{') {
          depth += 1;
          i += 2;
          continue;
        }
        if (source[i] === '}' && depth > 0) depth -= 1;
        i += source[i] === '\\' ? 2 : 1;
      }
      i += 1;
      out += '""';
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const FORBIDDEN: Array<[name: string, pattern: RegExp]> = [
  ['parseFloat(', /\bparseFloat\s*\(/],
  ['Number(', /\bNumber\s*\(/],
  ['.toFixed(', /\.toFixed\s*\(/],
  ['unary +value', /[=(,:?]\s*\+\s*[A-Za-z_$]/],
];

export function findFloatViolations(source: string): string[] {
  const clean = stripNoise(source);
  return FORBIDDEN.filter(([, pattern]) => pattern.test(clean)).map(([name]) => name);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name.startsWith('__') ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/chart|sparkline/i.test(name) ? [path] : [];
  });
}

describe('no float in money paths', () => {
  it('the scanner catches what the spec lists', () => {
    expect(findFloatViolations('const x = parseFloat(price);')).toEqual(['parseFloat(']);
    expect(findFloatViolations('const x = Number(total) * 2;')).toEqual(['Number(']);
    expect(findFloatViolations('return value.toFixed(2);')).toEqual(['.toFixed(']);
    expect(findFloatViolations('const n = +value;')).toEqual(['unary +value']);
    expect(findFloatViolations('f(+amount)')).toEqual(['unary +value']);
  });

  it('the scanner ignores comments, strings and ordinary additions', () => {
    expect(findFloatViolations('// never use parseFloat(x) or Number(x)')).toEqual([]);
    expect(findFloatViolations('/* .toFixed(2) */ const a = 1;')).toEqual([]);
    expect(findFloatViolations("const s = 'Number(x)'; const t = `parseFloat(${a + b})`;")).toEqual([]);
    expect(findFloatViolations('const total = a + b;')).toEqual([]);
    expect(findFloatViolations('Number.isFinite(ms)')).toEqual([]);
  });

  it('no data/ source file converts a money value to a float', () => {
    const files = sourceFiles(new URL('.', import.meta.url).pathname);
    expect(files.length).toBeGreaterThan(8);
    const offenders = files
      .map((file) => [file, findFloatViolations(readFileSync(file, 'utf8'))] as const)
      .filter(([, hits]) => hits.length > 0);
    expect(offenders).toEqual([]);
  });
});
