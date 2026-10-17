import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Phantom's rule: no "yet" or coming-soon promises. A feature that is off says what is true now and what blocks it.
 * Reads every source file of the Trade lane (customer screens and features, admin trade-ops) and fails on a promise word.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const appsDir = join(here, '..', '..', '..', '..');
const roots = [
  join(appsDir, 'customer/src/screens/trade'),
  join(appsDir, 'customer/src/features/trade'),
  join(appsDir, 'admin/src/components/trade-ops'),
  join(appsDir, 'admin/src/lib/trade-ops'),
  join(appsDir, 'admin/src/app/(console)/trade-ops'),
  join(appsDir, 'admin/src/app/api/trade-ops'),
];

const banned = /\byet\b|\bcoming soon\b|\bsoon\b|check back|stay tuned|\b(?:later|future) (?:release|version|update)\b/i;

/** The conversion-history text belongs to the fix/convert-history-honest branch; remove this entry when it lands. */
const owned = new Set(['customer/src/screens/trade/convert/copy.ts:Recent parked']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function code(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line));
}

describe('Trade copy makes no "yet" promises', () => {
  it('finds no promise word in any Trade lane source file', () => {
    const hits: string[] = [];
    for (const root of roots) {
      for (const file of files(root)) {
        const rel = relative(appsDir, file);
        code(readFileSync(file, 'utf8')).forEach((line, i) => {
          if (!banned.test(line)) return;
          if ([...owned].some((o) => rel === o.split(':')[0] && line.includes(o.split(':')[1]!))) return;
          hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
