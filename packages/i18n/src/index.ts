/**
 * @intafaced/i18n — every user-facing string, keyed (§9, §14.4).
 *
 * The contract this package offers the rest of the OS:
 *
 *   - `createTranslator(locale, catalog)` → `t(key, params)`, where the key set
 *     is a closed union and the params are derived from the message itself. A
 *     string that is not in the catalog cannot be rendered.
 *   - `formatMoney(amountString, currency, locale)` — money is a decimal string
 *     and stays one. No float touches a balance on the way to a screen.
 *   - A locale registry with RTL flags, so adding a language is a data change.
 *   - `localeCoverage()` — the measured answer to "which languages do we have",
 *     derived from the catalogs that have words rather than from the locales we
 *     declared. 100+ codes are declared; en/es/fr have distinct copy; the rest
 *     are empty fallbacks so a keyed surface never shows a raw key.
 *
 * Nothing here does I/O. Catalogs are data; loading them is the app's job.
 */
export * from './catalog.js';
export * from './catalogs.js';
export * from './locale-file.js';
export * from './locales.js';
export * from './format.js';
export * from './t.js';
export * from './exchange.js';
