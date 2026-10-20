/**
 * THE CATALOG REGISTRY — which of the declared locales actually has words.
 *
 * `locales.ts` declares 100+ codes. Every code has a CATALOGS entry so `$t`
 * never echoes a raw key: untranslated locales are empty catalogs and fall
 * through to English. Words are still measured honestly — an empty catalog
 * is not "translated".
 *
 * Three locales carry distinct copy (en, es, fr). Adding a language with real
 * words means dropping `src/locales/<code>.json` and running
 * `node scripts/build-locale-index.mjs` — not a refactor.
 */
import { coverage, en, isMessageKey, type MessageKey, type PartialCatalog } from './catalog.js';
import { LOCALE_FILES } from './locale-files.generated.js';
import type { LocaleFile, Provenance } from './locale-file.js';
import { SUPPORTED_LOCALES, locale as findLocale, type LocaleCode } from './locales.js';

/**
 * Language files dropped into `src/locales/<code>.json` (see `scripts/build-locale-index.mjs`). A key the English source does not
 * have is left out here, and the package test fails naming the file and key.
 */
export function catalogsFromFiles(files: Readonly<Record<string, LocaleFile>>): Partial<Record<LocaleCode, PartialCatalog>> {
  const written: Partial<Record<LocaleCode, PartialCatalog>> = {};
  for (const [code, file] of Object.entries(files)) {
    const descriptor = findLocale(code);
    if (!descriptor || descriptor.code === 'en') continue;
    const messages = Object.fromEntries(Object.entries(file.messages).filter(([key]) => isMessageKey(key)));
    written[descriptor.code as LocaleCode] = messages as PartialCatalog;
  }
  return written;
}

const WRITTEN: Readonly<Partial<Record<LocaleCode, PartialCatalog>>> = {
  ...catalogsFromFiles(LOCALE_FILES),
  en,
};

/** Who wrote a locale's words (`human` or `machine`), or `null` for English (the source) and for a locale with no file. */
export function localeProvenance(code: string): Provenance | null {
  const descriptor = findLocale(code);
  if (!descriptor || descriptor.code === 'en') return null;
  return LOCALE_FILES[descriptor.code]?.meta.provenance ?? null;
}

/** An empty catalog: every key falls through to English and is reported `untranslated`. */
const NO_CATALOG: PartialCatalog = Object.freeze({});

/**
 * Every declared locale has an entry. Untranslated locales get `NO_CATALOG` so
 * lookup never returns `undefined` for a supported code. Coverage still counts
 * empty catalogs as zero words — `hasCatalog` means "has words", not "is listed".
 */
export const CATALOGS: Readonly<Record<LocaleCode, PartialCatalog>> = Object.freeze(
  Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l.code, WRITTEN[l.code as LocaleCode] ?? NO_CATALOG])) as Record<
    LocaleCode,
    PartialCatalog
  >,
);

/** True when the catalog object actually holds at least one message. */
export function catalogHasWords(catalog: PartialCatalog | undefined): boolean {
  if (catalog === undefined) return false;
  for (const key of Object.keys(catalog)) {
    if ((catalog as Record<string, unknown>)[key] !== undefined) return true;
  }
  return false;
}

/**
 * The catalog for a locale, or `undefined` when the tag is not a declared
 * locale at all. Aliases resolve (`zh-CN` → `zh-Hans`). A declared-but-empty
 * locale returns the empty catalog, not `undefined`.
 */
export function catalogFor(code: string): PartialCatalog | undefined {
  const descriptor = findLocale(code);
  return descriptor ? CATALOGS[descriptor.code as LocaleCode] : undefined;
}

/**
 * The catalog to translate with — never `undefined`, so a caller cannot
 * accidentally reach for English and thereby claim the locale is translated.
 * A locale with no words gets an empty one: same English text on screen,
 * but every key now travels the fallback path and is counted.
 */
export function catalogOrEmpty(code: string): PartialCatalog {
  return catalogFor(code) ?? NO_CATALOG;
}

/** Does this locale have any translated messages at all? Empty registry rows do not count. */
export function hasCatalog(code: string): boolean {
  return catalogHasWords(catalogFor(code));
}

/** Locales with written words. The honest denominator for "languages we ship copy in". */
export const TRANSLATED_LOCALES: readonly LocaleCode[] = SUPPORTED_LOCALES.filter((l) => hasCatalog(l.code)).map(
  (l) => l.code as LocaleCode,
);

/** Locales declared but not written. Requesting one of these serves English. */
export const UNTRANSLATED_LOCALES: readonly LocaleCode[] = SUPPORTED_LOCALES.filter((l) => !hasCatalog(l.code)).map(
  (l) => l.code as LocaleCode,
);

export interface LocaleCoverage {
  readonly code: LocaleCode;
  readonly englishName: string;
  /** `false` means every string in this locale is served from English. */
  readonly hasCatalog: boolean;
  readonly translated: number;
  readonly total: number;
  readonly missing: readonly MessageKey[];
}

/**
 * The full picture, one row per declared locale — what the "language dashboard"
 * in §9 should render. A locale with no words is `translated: 0`, not absent
 * from the table.
 */
export function localeCoverage(): readonly LocaleCoverage[] {
  return SUPPORTED_LOCALES.map((descriptor) => {
    const catalog = CATALOGS[descriptor.code as LocaleCode];
    const { translated, total, missing } = coverage(catalog ?? NO_CATALOG);
    return {
      code: descriptor.code as LocaleCode,
      englishName: descriptor.englishName,
      hasCatalog: catalogHasWords(catalog),
      translated,
      total,
      missing,
    };
  });
}
