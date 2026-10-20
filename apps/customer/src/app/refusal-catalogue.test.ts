import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRefusalCatalogued, listedRefusalCodes, refusalCatalogues } from './refusal-catalogue';
import { INTENTIONAL_DOUBLE_WORDING, UNWORDED_SERVICE_CODES } from './refusal-catalogue.baseline';

// Only services whose files this app's tests may already read (`apps/customer` in tooling/ci/test-read-edges.json), so a
// change to one of them runs this test before it merges, and no new read edge is needed.
const SERVICES = [
  { dir: 'svc-trade', prefix: 'trade' },
  { dir: 'svc-pay', prefix: 'pay' },
] as const;
const servicesRoot = new URL('../../../../services/', import.meta.url).pathname;

function errorFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') errorFiles(path, found);
    } else if (/(^|-)errors\.ts$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** Every typed code the services declare in their error files. */
function serviceCodes(): Map<string, string> {
  const codes = new Map<string, string>();
  for (const { dir, prefix } of SERVICES) {
    for (const file of errorFiles(join(servicesRoot, dir, 'src'))) {
      const pattern = new RegExp(`'(${prefix}\\.[a-z0-9_]+)'`, 'g');
      for (const match of readFileSync(file, 'utf8').matchAll(pattern)) codes.set(match[1]!, file.slice(servicesRoot.length));
    }
  }
  return codes;
}

describe('one refusal catalogue', () => {
  it('reads the services the baseline was measured on', () => {
    const codes = serviceCodes();
    expect(codes.size).toBeGreaterThan(250);
    expect([...codes.values()].some((file) => file.startsWith('svc-trade/src/ccxt-errors.ts'))).toBe(true);
    expect([...codes.values()].some((file) => file.startsWith('svc-pay/src/control/errors.ts'))).toBe(true);
  });

  it('has customer words for every code a service declares, apart from the measured baseline', () => {
    const baseline = new Set(UNWORDED_SERVICE_CODES);
    const missing = [...serviceCodes()].filter(([code]) => !isRefusalCatalogued(code) && !baseline.has(code));
    expect(
      missing.map(([code, file]) => `${code} (${file})`),
      'A service declares a refusal code the customer app has no words for. Give it words in the catalogue for its surface ' +
        '(data/refusal-codes.ts, a room table, or the portal table), or, if no customer ever meets it, add it to ' +
        'refusal-catalogue.baseline.ts with the reason in your PR.',
    ).toEqual([]);
  });

  it('keeps the baseline honest: only codes that still exist and still have no words', () => {
    const declared = serviceCodes();
    const stale = UNWORDED_SERVICE_CODES.filter((code) => !declared.has(code));
    const nowWorded = UNWORDED_SERVICE_CODES.filter((code) => isRefusalCatalogued(code));
    expect(stale, 'No service declares these any more: delete them from the baseline.').toEqual([]);
    expect(nowWorded, 'These have words now: delete them from the baseline.').toEqual([]);
    expect(new Set(UNWORDED_SERVICE_CODES).size).toBe(UNWORDED_SERVICE_CODES.length);
  });

  it('lets two surfaces word one code only where that is intended', () => {
    const doubled = [...listedRefusalCodes()]
      // The shared catalogue sorts a code into a kind; a surface may always give a sharper sentence than its kind.
      .map(([code, owners]) => [code, owners.filter((owner) => owner !== 'shared')] as const)
      .filter(([, owners]) => owners.length > 1)
      .map(([code]) => code)
      .sort();
    expect(doubled, 'Two catalogues word the same code. Reuse one, or list it in INTENTIONAL_DOUBLE_WORDING.').toEqual(
      [...INTENTIONAL_DOUBLE_WORDING].sort(),
    );
  });

  it('answers for prefix and suffix rules as well as for named codes', () => {
    expect(refusalCatalogues('denied.region')).toEqual(['shared']);
    expect(refusalCatalogues('trade.some_new_thing_unset')).toEqual(['shared']);
    expect(refusalCatalogues('TRADE.COPY_SELF_FOLLOW ')).toEqual(['copyBots']);
    expect(refusalCatalogues('trade.not_a_real_code')).toEqual([]);
  });
});
