/**
 * Source guards for the ticket folder, like `../money-paths.test.ts` for the desk: no money value goes through a float, and the
 * Preview order types can never send anything.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findFloatViolations } from '../../../../data/money-paths.test';
import { ADVANCED_KINDS, FIELDS, isPreviewKind, LIVE_ADVANCED_KINDS } from './advanced';

const here = new URL('.', import.meta.url).pathname;
const sources = readdirSync(here).filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name));
const read = (name: string) => readFileSync(join(here, name), 'utf8');

describe('no float in the ticket', () => {
  it('no ticket source file converts a money value to a float', () => {
    expect(sources.length).toBeGreaterThan(8);
    const offenders = sources.map((name) => [name, findFloatViolations(read(name))] as const).filter(([, hits]) => hits.length > 0);
    expect(offenders).toEqual([]);
  });
});

describe('Preview order types', () => {
  it('every Advanced type is a Preview today: none is live and each has a form', () => {
    expect(LIVE_ADVANCED_KINDS).toEqual([]);
    expect(ADVANCED_KINDS).toEqual(['stop', 'stop-limit', 'tp-sl', 'trailing', 'oco', 'iceberg', 'twap']);
    for (const kind of ADVANCED_KINDS) {
      expect(isPreviewKind(kind)).toBe(true);
      expect(FIELDS[kind].length).toBeGreaterThan(1);
    }
  });

  it('the Preview ticket never touches the trade client, the session, the data layer or the order marker', () => {
    const source = read('PreviewTicket.tsx') + read('advanced.ts');
    for (const forbidden of [
      /trade-api/,
      /useSession/,
      /useDeskApi/,
      /\.rest\(/,
      /\.preview\(/,
      /\.place\(/,
      /fetch\(/,
      /pending/,
      /data\/hooks/,
      /crypto\.randomUUID/,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
  });
});
