import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MESSAGE_KEYS, coverage, defineCatalog, en, isMessageKey, type Catalog, type PartialCatalog } from './catalog.js';
import { CATALOGS, TRANSLATED_LOCALES, UNTRANSLATED_LOCALES, catalogFor, hasCatalog, localeCoverage } from './catalogs.js';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  dir,
  intlTagFor,
  isRtl,
  isSupportedLocale,
  negotiateLocale,
  parseAcceptLanguage,
  rtlLocales,
} from './locales.js';
import { AmountFormatError, formatDate, formatMoney, formatNumber, formatPercent, formatRelativeTime } from './format.js';
import {
  MissingMessageError,
  MissingParamError,
  createTranslator,
  pluralCategoriesFor,
  resetMissingReportCache,
  type MissingReport,
  type ParamValue,
} from './t.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A partial Russian catalog. Russian selects `one` / `few` / `many` on integers
 * — a `n === 1 ? a : b` ternary is wrong for 2, 3, 4, 22, 23 …
 */
const ru: PartialCatalog = {
  'wallet.assets': {
    one: '{count} актив',
    few: '{count} актива',
    many: '{count} активов',
    other: '{count} актива',
  },
  'auth.login.title': 'Войти',
  'trade.filled': 'Исполнено {qty} {symbol}',
};

/** Arabic uses all six CLDR categories. Markers are ASCII so the assertions stay legible. */
const ar: PartialCatalog = {
  'wallet.assets': {
    zero: 'ZERO {count}',
    one: 'ONE {count}',
    two: 'TWO {count}',
    few: 'FEW {count}',
    many: 'MANY {count}',
    other: 'OTHER {count}',
  },
};

function collect(): { reports: MissingReport[]; onMissing: (r: MissingReport) => void } {
  const reports: MissingReport[] = [];
  return { reports, onMissing: (r) => reports.push(r) };
}

beforeEach(() => {
  resetMissingReportCache();
});

// ── Catalog ─────────────────────────────────────────────────────────────────

describe('catalog — the key set is closed and complete', () => {
  it('carries a realistic starter set across every launch surface', () => {
    expect(MESSAGE_KEYS.length).toBeGreaterThanOrEqual(60);
    // Stage-2 product surfaces (support KB, agents refuse copy) expand the set;
    // still capped so the catalog cannot silently balloon.
    // Agents COPY_KEYS parity added a full refusal/session surface (W5 #1337).
    // Ceiling is a drift alarm, not a hard product law — raise when a real surface lands.
    // Limit-unset refuse keys (kb_search / tickers / markets) landed at 202.
    // Four real guest enquiry templates add eight title/body keys.
    expect(MESSAGE_KEYS.length).toBeLessThanOrEqual(218);

    for (const surface of ['common.', 'auth.', 'trade.', 'wallet.', 'p2p.', 'notify.', 'error.', 'support.', 'agents.', 'admin.']) {
      expect(
        MESSAGE_KEYS.some((k) => k.startsWith(surface)),
        surface,
      ).toBe(true);
    }
  });

  it('exposes exactly the keys declared in English', () => {
    expect([...MESSAGE_KEYS].sort()).toEqual(Object.keys(en).sort());
    expect(isMessageKey('trade.order.submit')).toBe(true);
    expect(isMessageKey('trade.order.doesNotExist')).toBe(false);
  });

  it('makes every key reachable and renderable with no leftover placeholders', () => {
    const t = createTranslator('en', en, { mode: 'dev' });
    const anyParam = new Proxy({} as Record<string, ParamValue>, {
      get: (_target, prop) => (prop === 'count' ? 2 : 'X'),
      has: () => true,
    });

    for (const key of MESSAGE_KEYS) {
      const rendered = t.tUnsafe(key, anyParam);
      expect(rendered.length, key).toBeGreaterThan(0);
      expect(rendered, key).not.toContain('{');
      expect(rendered, key).not.toContain('undefined');
    }
  });

  it('reports translation coverage honestly', () => {
    const full = coverage(en);
    expect(full.missing).toEqual([]);
    expect(full.translated).toBe(full.total);

    const partial = coverage(ru);
    expect(partial.translated).toBe(3);
    expect(partial.missing.length).toBe(MESSAGE_KEYS.length - 3);
  });

  it('accepts a complete catalog through defineCatalog', () => {
    const clone = defineCatalog(structuredClone(en) as unknown as Catalog);
    expect(coverage(clone).missing).toEqual([]);
  });

  it('rejects an incomplete catalog at compile time', () => {
    // @ts-expect-error — a catalog missing keys does not compile. This is the
    // entire point of keying from day one: no `undefined` ever reaches a screen.
    const incomplete: Catalog = { 'auth.login.title': 'Войти' };
    expect(incomplete['auth.login.title']).toBe('Войти');
  });

  it('rejects an unknown key and a missing param at compile time', () => {
    const t = createTranslator('en', en, { mode: 'dev' });
    // @ts-expect-error — key is not in the catalog.
    expect(() => t.t('trade.order.invented')).toThrow(MissingMessageError);
    // @ts-expect-error — `trade.filled` requires { qty, symbol }.
    expect(() => t.t('trade.filled', { qty: '1' })).toThrow(MissingParamError);
  });
});

// ── Interpolation ───────────────────────────────────────────────────────────

describe('interpolation', () => {
  it('substitutes named params', () => {
    const t = createTranslator('en', en, { mode: 'dev' });
    expect(t.t('trade.filled', { qty: '1.5', symbol: 'BTC/USDT' })).toBe('Filled 1.5 BTC/USDT');
    expect(t.t('trade.convert.rate', { from: 'BTC', to: 'USDT', rate: '64000.5' })).toBe('1 BTC = 64000.5 USDT');
  });

  it('localises numeric params rather than pasting raw digits', () => {
    const t = createTranslator('ru', ru, { mode: 'prod', onMissing: () => {} });
    // ru groups with a no-break space; the point is that Intl decided, not us.
    expect(t.t('wallet.assets', { count: 21 })).toBe('21 актив');
  });

  it('throws in dev when a param is missing — never renders "undefined"', () => {
    const t = createTranslator('en', en, { mode: 'dev' });
    // @ts-expect-error — deliberately omitting `symbol` to prove the runtime guard.
    expect(() => t.t('trade.filled', { qty: '1.5' })).toThrow(MissingParamError);
  });

  it('leaves the placeholder visible and reports in prod when a param is missing', () => {
    const { reports, onMissing } = collect();
    const t = createTranslator('en', en, { mode: 'prod', onMissing });

    // @ts-expect-error — deliberately omitting `symbol`.
    const rendered = t.t('trade.filled', { qty: '1.5' });

    expect(rendered).toBe('Filled 1.5 {symbol}');
    expect(rendered).not.toContain('undefined');
    expect(reports).toEqual([{ kind: 'missing-param', key: 'trade.filled', locale: 'en', param: 'symbol' }]);
  });
});

// ── Pluralisation ───────────────────────────────────────────────────────────

describe('pluralisation via Intl.PluralRules', () => {
  it('selects Russian one / few / many — the case a ternary gets wrong', () => {
    const t = createTranslator('ru', ru, { mode: 'prod', onMissing: () => {} });

    expect(t.t('wallet.assets', { count: 1 })).toBe('1 актив');
    expect(t.t('wallet.assets', { count: 2 })).toBe('2 актива');
    expect(t.t('wallet.assets', { count: 5 })).toBe('5 активов');
    expect(t.t('wallet.assets', { count: 21 })).toBe('21 актив');
    expect(t.t('wallet.assets', { count: 22 })).toBe('22 актива');

    // English would have produced the plural form for every count above 1.
    const enT = createTranslator('en', en, { mode: 'dev' });
    expect(enT.t('wallet.assets', { count: 1 })).toBe('1 asset');
    expect(enT.t('wallet.assets', { count: 2 })).toBe('2 assets');
    expect(enT.t('wallet.assets', { count: 21 })).toBe('21 assets');
  });

  it('selects all six Arabic categories', () => {
    const t = createTranslator('ar', ar, { mode: 'prod', onMissing: () => {} });

    expect(t.t('wallet.assets', { count: 0 })).toMatch(/^ZERO /);
    expect(t.t('wallet.assets', { count: 1 })).toMatch(/^ONE /);
    expect(t.t('wallet.assets', { count: 2 })).toMatch(/^TWO /);
    expect(t.t('wallet.assets', { count: 3 })).toMatch(/^FEW /);
    expect(t.t('wallet.assets', { count: 11 })).toMatch(/^MANY /);
    expect(t.t('wallet.assets', { count: 100 })).toMatch(/^OTHER /);
  });

  it('knows how many plural forms each language actually has', () => {
    expect(pluralCategoriesFor('ar').length).toBe(6);
    expect(pluralCategoriesFor('ru')).toEqual(expect.arrayContaining(['one', 'few', 'many']));
    expect(pluralCategoriesFor('ja')).toEqual(['other']);
    expect(pluralCategoriesFor('en')).toEqual(expect.arrayContaining(['one', 'other']));
  });

  it('falls back to English for a category the translation has not filled in', () => {
    const { reports, onMissing } = collect();
    const thin: PartialCatalog = { 'wallet.assets': { other: '{count} активов' } };
    const t = createTranslator('ru', thin, { mode: 'prod', onMissing });

    expect(t.t('wallet.assets', { count: 1 })).toBe('1 asset');
    expect(reports.some((r) => r.kind === 'missing-plural-form' && r.category === 'one')).toBe(true);
  });
});

// ── Missing keys ────────────────────────────────────────────────────────────

describe('missing key policy', () => {
  it('throws loudly in dev', () => {
    const t = createTranslator('en', en, { mode: 'dev' });
    expect(() => t.tUnsafe('surface.that.was.never.keyed')).toThrow(MissingMessageError);
    expect(() => t.tUnsafe('surface.that.was.never.keyed')).toThrow(/catalog\.ts/);
  });

  it('falls back and reports in prod — never a blank UI', () => {
    const { reports, onMissing } = collect();
    const t = createTranslator('en', en, { mode: 'prod', onMissing });

    const rendered = t.tUnsafe('surface.that.was.never.keyed');

    expect(rendered).toBe('surface.that.was.never.keyed');
    expect(rendered.length).toBeGreaterThan(0);
    expect(reports).toEqual([{ kind: 'missing-key', key: 'surface.that.was.never.keyed', locale: 'en' }]);
  });

  it('treats an untranslated key as normal — English is served, not an exception', () => {
    const { reports, onMissing } = collect();
    const t = createTranslator('ru', ru, { mode: 'dev', onMissing });

    expect(t.t('wallet.deposit')).toBe('Deposit');
    expect(t.t('auth.login.title')).toBe('Войти');
    expect(reports).toEqual([{ kind: 'untranslated', key: 'wallet.deposit', locale: 'ru' }]);
    expect(t.hasOwn('auth.login.title')).toBe(true);
    expect(t.hasOwn('wallet.deposit')).toBe(false);
  });

  it('does not let a locale with no catalog pass itself off as translated', () => {
    // THE REGRESSION THIS LOCKS. `catalog` used to default to English, so this
    // translator resolved every key out of the English catalog as though it were
    // Arabic's own: `hasOwn` said true, no report ever fired, and coverage for a
    // language nobody has written a word of came back at 100%. The words on
    // screen were right; the instrument we would have measured by was lying.
    const { reports, onMissing } = collect();
    const t = createTranslator('ar', undefined, { mode: 'dev', onMissing });

    expect(t.hasCatalog).toBe(false);
    expect(t.hasOwn('wallet.deposit')).toBe(false);
    expect(reports[0]).toEqual({ kind: 'no-catalog', key: '', locale: 'ar' });

    // English is still served — a declared-but-empty locale must never blank a
    // screen or echo a key. Only the accounting changed.
    expect(t.t('wallet.deposit')).toBe('Deposit');
    expect(reports).toContainEqual({ kind: 'untranslated', key: 'wallet.deposit', locale: 'ar' });
  });

  it('does not mirror the layout of an RTL locale that is rendering English', () => {
    // `dir` used to follow the REQUESTED locale. Arabic has no catalog, so the
    // strings are English — and `dir: 'rtl'` around left-to-right words is a
    // defect a user sees on the first screen, not a subtle one.
    expect(isRtl('ar')).toBe(true);
    expect(hasCatalog('ar')).toBe(false);

    const t = createTranslator('ar', undefined, { mode: 'prod', onMissing: () => {} });
    expect(t.dir).toBe('ltr');
    expect(t.renderedLocale).toBe('en');
    // The requested locale is still readable — we did not silently rewrite it.
    expect(t.locale).toBe('ar');

    // The day a catalog lands, both flip back with no code change here. The
    // marker is ASCII on purpose — same as the `ar` fixture above, and this repo
    // does not carry invented translations even in a test.
    const withCatalog = createTranslator('ar', { 'wallet.deposit': 'AR-DEPOSIT' }, { mode: 'prod', onMissing: () => {} });
    expect(withCatalog.dir).toBe('rtl');
    expect(withCatalog.renderedLocale).toBe('ar');
  });

  it('defaults its mode from NODE_ENV', () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(createTranslator('en', en).tUnsafe('never.keyed')).toBe('never.keyed');
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();

      process.env.NODE_ENV = 'development';
      expect(() => createTranslator('en', en).tUnsafe('never.keyed')).toThrow(MissingMessageError);
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});

// ── Money ───────────────────────────────────────────────────────────────────

describe('formatMoney — decimal strings, never floats', () => {
  const LEDGER_PRECISION = '1234.123456789012345678';

  it('preserves all 18 decimal places the ledger carries', () => {
    expect(formatMoney(LEDGER_PRECISION, 'USD', 'en', { maxFractionDigits: 18 })).toBe('$1,234.123456789012345678');
  });

  it('proves the float path would have destroyed those digits', () => {
    // This is the bug the signature exists to prevent — kept as an executable
    // reminder rather than a comment.
    expect(String(Number(LEDGER_PRECISION))).toBe('1234.1234567890124');
    expect(String(Number(LEDGER_PRECISION))).not.toContain('123456789012345678');
    expect(formatMoney(LEDGER_PRECISION, 'USD', 'en', { maxFractionDigits: 18 })).toContain('123456789012345678');
  });

  it('contains no float conversion anywhere in its source', () => {
    const source = readFileSync(fileURLToPath(new URL('./format.ts', import.meta.url)), 'utf8');
    // Comments may name the hazard — they do, at length. The code may not call
    // it: `Number` survives only as its static guards (`Number.isNaN`).
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const pattern of [/parseFloat\s*\(/, /parseInt\s*\(/, /(?<![.\w])Number\s*\(/]) {
      expect(code, String(pattern)).not.toMatch(pattern);
    }
  });

  it('rounds display precision half-up on the digit string, not through a float', () => {
    // (2.675).toFixed(2) === '2.67' because 2.675 is not representable. Ours is exact.
    expect((2.675).toFixed(2)).toBe('2.67');
    expect(formatMoney('2.675', 'USD', 'en')).toBe('$2.68');
    expect(formatMoney('0.005', 'USD', 'en')).toBe('$0.01');
    expect(formatMoney('0.994999999999999999', 'USD', 'en')).toBe('$0.99');
    expect(formatMoney('9.999', 'USD', 'en')).toBe('$10.00');
  });

  it('defaults to the ISO minor units from the config fiat registry', () => {
    expect(formatMoney('1234.5', 'USD', 'en')).toBe('$1,234.50');
    expect(formatMoney('1234.5', 'JPY', 'en')).toBe('¥1,235');
    expect(formatMoney('1234.5678', 'KWD', 'en')).toMatch(/^KWD\s1,234\.568$/);
  });

  it('follows each locale for grouping, separator and symbol placement', () => {
    expect(formatMoney('1234567.89', 'EUR', 'de')).toContain('1.234.567,89');
    expect(formatMoney('1234567.89', 'USD', 'en')).toBe('$1,234,567.89');
    expect(formatMoney('1234.5', 'USD', 'fr')).toMatch(/1[\s\u202f\u00a0]234,50/);
  });

  it('keeps the sign on a negative sub-unit amount, where BigInt has no -0', () => {
    expect(formatMoney('-0.5', 'USD', 'en')).toBe('-$0.50');
    expect(formatMoney('-1234.5', 'USD', 'en')).toBe('-$1,234.50');
    expect(formatMoney('-0.00', 'USD', 'en')).toBe('$0.00');
  });

  it('transliterates into the locale numbering system without losing a digit', () => {
    const rendered = formatMoney(LEDGER_PRECISION, 'USD', 'ar', { maxFractionDigits: 18 });
    const glyphs = Array.from({ length: 10 }, (_, d) => new Intl.NumberFormat(intlTagFor('ar')).format(d));
    const asciiDigits = [...rendered]
      .map((ch) => glyphs.indexOf(ch))
      .filter((i) => i >= 0)
      .join('');
    expect(asciiDigits).toBe('1234123456789012345678');
  });

  it('renders assets outside ISO 4217 with their ticker', () => {
    expect(formatMoney('1234.12345678', 'USDT', 'en')).toBe('1,234.12345678 USDT');
    expect(formatMoney('0.5', 'BTC', 'en')).toBe('0.5 BTC');
    expect(formatMoney('1234.5', 'USD', 'en', { display: 'none' })).toBe('1,234.50');
    expect(formatMoney('1234.5', 'USD', 'en', { display: 'code' })).toContain('USD');
  });

  it('refuses anything that is not a decimal string', () => {
    expect(() => formatMoney('1.2e3', 'USD', 'en')).toThrow(AmountFormatError);
    expect(() => formatMoney('', 'USD', 'en')).toThrow(AmountFormatError);
    expect(() => formatMoney('abc', 'USD', 'en')).toThrow(AmountFormatError);
  });
});

// ── Other formatters ────────────────────────────────────────────────────────

describe('formatNumber / formatPercent / dates', () => {
  it('keeps every digit of a decimal string by default', () => {
    expect(formatNumber('1234.123456789012345678', 'en')).toBe('1,234.123456789012345678');
    expect(formatNumber('1234.5', 'de')).toBe('1.234,5');
    expect(formatNumber(1234.5, 'en')).toBe('1,234.5');
    expect(formatNumber(9007199254740993n, 'en')).toBe('9,007,199,254,740,993');
  });

  it('shifts the decimal point for percentages instead of multiplying', () => {
    expect(formatPercent('0.0432', 'en')).toBe('4.32%');
    expect(formatPercent('0.123456789012345678', 'en', { maxFractionDigits: 16 })).toBe('12.3456789012345678%');
    expect(formatPercent('-0.05', 'en', { minFractionDigits: 2 })).toBe('-5.00%');
    expect(formatPercent('0.05', 'en', { signDisplay: true })).toBe('+5%');
    expect(formatPercent('0.05', 'tr')).toBe('%5');
  });

  it('formats dates and relative time through Intl', () => {
    const when = new Date('2026-03-14T09:30:00Z');
    expect(formatDate(when, 'en', { dateStyle: 'medium', timeZone: 'UTC' })).toBe('Mar 14, 2026');
    expect(formatDate(when, 'de', { dateStyle: 'medium', timeZone: 'UTC' })).toContain('2026');

    const now = new Date('2026-03-14T09:33:00Z');
    expect(formatRelativeTime(when, 'en', { now })).toBe('3 minutes ago');
    expect(formatRelativeTime(new Date('2026-03-15T09:33:00Z'), 'en', { now })).toBe('tomorrow');
    expect(formatRelativeTime(when, 'es', { now })).toContain('3');
  });
});

// ── Locales ─────────────────────────────────────────────────────────────────

describe('locale registry', () => {
  it('declares 100+ locales — codes, not literary coverage', () => {
    expect(SUPPORTED_LOCALES.length).toBeGreaterThanOrEqual(100);
    const codes = SUPPORTED_LOCALES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(codes).toEqual(expect.arrayContaining(['en', 'es', 'fr']));
  });

  it('flags RTL languages correctly', () => {
    for (const code of ['ar', 'he', 'fa', 'ur']) {
      expect(isRtl(code), code).toBe(true);
      expect(dir(code), code).toBe('rtl');
    }
    for (const code of ['en', 'ja', 'ru', 'sw', 'zh-Hans']) {
      expect(isRtl(code), code).toBe(false);
      expect(dir(code), code).toBe('ltr');
    }
    expect(
      rtlLocales()
        .map((l) => l.code)
        .sort(),
    ).toEqual(expect.arrayContaining(['ar', 'fa', 'he', 'ur']));
    expect(rtlLocales().every((l) => l.rtl)).toBe(true);
    // `isRtl`/`dir` answer for the LANGUAGE. A translator answers for the text
    // it is actually holding, which is English until Hebrew has a catalog — so
    // these two deliberately disagree today, and will agree the day a catalog
    // lands. See `renderedLocale` in t.ts.
    expect(createTranslator('he', { 'auth.logout': 'HE-SIGN-OUT' }).dir).toBe('rtl');
    expect(createTranslator('he', undefined, { onMissing: () => {} }).dir).toBe('ltr');
    expect(createTranslator('en').dir).toBe('ltr');
  });

  it('carries a native name for every language, in that language', () => {
    for (const l of SUPPORTED_LOCALES) {
      expect(l.nativeName.length, l.code).toBeGreaterThan(0);
      expect(l.englishName.length, l.code).toBeGreaterThan(0);
    }
  });

  it('hands Intl a tag Intl actually resolves', () => {
    for (const l of SUPPORTED_LOCALES) {
      const resolved = new Intl.NumberFormat(l.intlTag).resolvedOptions().locale;
      expect(resolved.toLowerCase().startsWith(l.code.split('-')[0]!.toLowerCase()), `${l.code} → ${resolved}`).toBe(true);
    }
  });

  it('negotiates the closest supported locale', () => {
    expect(isSupportedLocale('pt-BR')).toBe(true);
    expect(isSupportedLocale('kl')).toBe(false);
    expect(negotiateLocale(['pt-PT', 'en'])).toBe('pt-BR');
    expect(negotiateLocale(['zh-TW'])).toBe('zh-Hant');
    expect(negotiateLocale(['zh-CN'])).toBe('zh-Hans');
    expect(negotiateLocale(['kl', 'xx'])).toBe('en');
    expect(negotiateLocale(['de-AT'])).toBe('de');
    expect(parseAcceptLanguage('fr-CH, fr;q=0.9, en;q=0.8, *;q=0.5')).toEqual(['fr-CH', 'fr', 'en', '*']);
    expect(negotiateLocale(parseAcceptLanguage('he-IL,he;q=0.9,en;q=0.4'))).toBe('he');
  });
});

// ── The catalog registry — declared vs written ──────────────────────────────

describe('catalog registry — what we declare vs what we have written', () => {
  it('registers every declared locale in CATALOGS, with three written catalogs', () => {
    const catalogCodes = Object.keys(CATALOGS).sort();
    const supportedCodes = SUPPORTED_LOCALES.map((l) => l.code).sort();
    expect(catalogCodes).toEqual(supportedCodes);
    expect(SUPPORTED_LOCALES.length).toBeGreaterThanOrEqual(100);
    expect([...TRANSLATED_LOCALES].sort()).toEqual(['en', 'es', 'fr']);
    expect(UNTRANSLATED_LOCALES.length).toBe(SUPPORTED_LOCALES.length - 3);
    expect(TRANSLATED_LOCALES.length + UNTRANSLATED_LOCALES.length).toBe(SUPPORTED_LOCALES.length);
    expect(CATALOGS.en['auth.login.title']).not.toBe(CATALOGS.es['auth.login.title']);
    expect(CATALOGS.es['auth.login.title']).not.toBe(CATALOGS.fr['auth.login.title']);
    expect(CATALOGS.fr['auth.login.title']).not.toBe(CATALOGS.en['auth.login.title']);
  });

  it('resolves a catalog through locale aliases, and does not claim empty rows as written', () => {
    expect(catalogFor('en')).toBe(en);
    expect(hasCatalog('en')).toBe(true);
    expect(hasCatalog('es')).toBe(true);
    expect(hasCatalog('fr')).toBe(true);
    // Alias path: a browser sending `zh-CN` resolves to `zh-Hans`, which is
    // declared and empty — so hasCatalog is honest "no", while catalogFor
    // still returns the fallback row so $t never raw-keys.
    expect(hasCatalog('zh-CN')).toBe(false);
    expect(catalogFor('zh-CN')).toBeDefined();
    expect(Object.keys(catalogFor('zh-CN')!)).toEqual([]);
    // Not a locale we know at all.
    expect(hasCatalog('kl')).toBe(false);
    expect(catalogFor('kl')).toBeUndefined();
  });

  it('reports every declared locale in the coverage table, including the empty ones', () => {
    const rows = localeCoverage();
    expect(rows.length).toBe(SUPPORTED_LOCALES.length);

    const english = rows.find((r) => r.code === 'en')!;
    expect(english.hasCatalog).toBe(true);
    expect(english.translated).toBe(MESSAGE_KEYS.length);
    expect(english.missing).toEqual([]);

    for (const code of ['es', 'fr'] as const) {
      const row = rows.find((r) => r.code === code)!;
      expect(row.hasCatalog, code).toBe(true);
      expect(row.translated, code).toBeGreaterThan(0);
      expect(row.translated, code).toBeLessThan(MESSAGE_KEYS.length);
    }

    // The rows that make the table worth having: declared, present, and zero.
    const written = new Set(['en', 'es', 'fr']);
    for (const row of rows.filter((r) => !written.has(r.code))) {
      expect(row.hasCatalog, row.code).toBe(false);
      expect(row.translated, row.code).toBe(0);
      expect(row.total, row.code).toBe(MESSAGE_KEYS.length);
      expect(row.missing.length, row.code).toBe(MESSAGE_KEYS.length);
    }
  });
});
