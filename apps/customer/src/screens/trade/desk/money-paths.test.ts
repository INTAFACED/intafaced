/**
 * UI-SPEC 2.6: no money value goes through a JS float in the desk. The same scanner the data layer uses, pointed at
 * the desk folder (chart files are exempt: a canvas needs coordinates, see chart/chart-data.ts).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findFloatViolations } from '../../../data/money-paths.test';

describe('no float in the desk', () => {
  it('no desk source file converts a money value to a float', () => {
    const here = new URL('.', import.meta.url).pathname;
    const files = readdirSync(here).filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files
      .map((name) => [name, findFloatViolations(readFileSync(join(here, name), 'utf8'))] as const)
      .filter(([, hits]) => hits.length > 0);
    expect(offenders).toEqual([]);
  });
});
