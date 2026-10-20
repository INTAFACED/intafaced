import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coverage, isMessageKey } from './catalog.js';
import { CATALOGS, catalogsFromFiles, localeCoverage, localeProvenance } from './catalogs.js';
import { PROVENANCES } from './locale-file.js';
import { LOCALE_FILES } from './locale-files.generated.js';
import { locale as findLocale } from './locales.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'locales');
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.json'))
  .sort();

describe('drop-in language files', () => {
  it('has a generated index that holds exactly the files on disk', () => {
    const onDisk = Object.fromEntries(files.map((name) => [name.slice(0, -5), JSON.parse(readFileSync(join(dir, name), 'utf8'))]));
    expect(LOCALE_FILES).toEqual(onDisk);
  });

  it.each(files)('%s: names a declared locale, a known provenance and only keys English has', (name) => {
    const code = name.slice(0, -5);
    const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    expect(findLocale(code), `${name}: not a declared locale`).toBeDefined();
    expect(code, `${name}: English is the source and has no file`).not.toBe('en');
    expect(PROVENANCES, `${name}: provenance must be human or machine`).toContain(parsed.meta?.provenance);
    expect(parsed.meta.reviewedAt === null || /^\d{4}-\d{2}-\d{2}$/.test(parsed.meta.reviewedAt), `${name}: reviewedAt`).toBe(true);
    for (const [key, text] of Object.entries(parsed.messages as Record<string, unknown>)) {
      expect(isMessageKey(key), `${name}: key ${key} is not in catalog.ts`).toBe(true);
      expect(typeof text === 'string' || (typeof text === 'object' && text !== null), `${name}: ${key} has no text`).toBe(true);
    }
  });

  it('keeps es and fr as they were: four words each, now read from their files', () => {
    for (const code of ['es', 'fr'] as const) {
      expect(coverage(CATALOGS[code]).translated).toBe(4);
      expect(localeProvenance(code)).toBe('machine');
    }
    expect(CATALOGS.es['auth.logout']).toBe('Cerrar sesión');
    expect(CATALOGS.fr['common.action.cancel']).toBe('Annuler');
  });

  it('reports provenance beside coverage, and none for English or a locale with no file', () => {
    expect(localeProvenance('en')).toBeNull();
    expect(localeProvenance('de')).toBeNull();
    expect(localeProvenance('not-a-locale')).toBeNull();
    const rows = localeCoverage();
    expect(rows.find((row) => row.code === 'es')?.translated).toBe(4);
    expect(rows.find((row) => row.code === 'de')?.translated).toBe(0);
  });

  it('turns a dropped-in file into a catalog and leaves out a key English does not have', () => {
    const made = catalogsFromFiles({
      de: {
        meta: { provenance: 'machine', reviewedAt: null },
        messages: { 'auth.logout': 'Abmelden', 'common.action.cancel': 'Abbrechen', 'no.such.key': 'x' },
      },
      en: { meta: { provenance: 'human', reviewedAt: null }, messages: { 'auth.logout': 'ignored' } },
    });
    expect(coverage(made.de ?? {}).translated).toBe(2);
    expect(Object.keys(made.de ?? {})).toEqual(['auth.logout', 'common.action.cancel']);
    expect(made.en).toBeUndefined();
  });
});
