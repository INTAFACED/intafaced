# @intafaced/i18n

Every user-facing string in the Sovereign OS is a key. This package holds the keys, the
translations, and the formatters — and the types that make skipping any of it a build failure.

> **§9** — "i18n: all surfaces keyed from day one; 100+ languages = translation files, not
> refactors."
> **§14.4** — "Every user-facing string i18n-keyed."

It exists before the surfaces do because retrofitting i18n is one of the most expensive refactors
there is. Keying a screen while you write it costs minutes. Keying it afterwards means re-reading
every component in the repo and hoping you found them all.

---

## What is actually built, as of 2026-08-03

Read this before quoting §9 at anyone. The ambition is 100+ languages. The state is:

|                                         |                                                                  |
| --------------------------------------- | ---------------------------------------------------------------- |
| Locales **declared** (`locales.ts`)     | **28**                                                           |
| Locales with a **catalog**              | **1** — English. See `CATALOGS` in `catalogs.ts`                 |
| Message keys in English                 | 118                                                              |
| Services rendering through this package | **1** — `svc-notify`, for out-of-app email / SMS / push copy     |
| Surfaces rendering through this package | **0** — `apps/web` hardcodes 164 English strings across 15 files |

So §9's "all surfaces keyed from day one" is **not true of any surface**, and "100+ languages" is a
target, not a description. `localeCoverage()` returns the table above as data, so a dashboard shows
the 27 empty rows rather than reporting "1 language, 100% covered".

**Requesting one of the 27 empty locales serves English** — never a blank, never a dotted key — and
reports `no-catalog` once plus `untranslated` per key, so the gap is counted. `dir` and the outbound
`locale` label follow the language the text is really in, not the one that was asked for: an English
string stamped `ar` makes a renderer mirror the layout around left-to-right words.

Adding a language is an **owner decision with a content cost**. The mechanics are a drop-in: put
`src/locales/<code>.json` in the shape `{ "meta": { "provenance": "human" | "machine", "reviewedAt": null | "YYYY-MM-DD" },
"messages": { "<key>": "<text>" } }` there and run `pnpm --filter @intafaced/i18n locales`; the test fails on a key English does
not have. `localeProvenance(code)` says who wrote a locale's words and `pnpm --filter @intafaced/i18n coverage` (after a build)
prints translated, total, missing and provenance per locale. Words a program wrote carry `provenance: machine` and are never
presented as reviewed: a mistranslated "confirm withdrawal" in a money product is a loss, not a typo. `es` and `fr` are machine
files of four words each, and nothing money-related relies on them.

The old `apps/web` bypass scan was retired with the Vue front end (the scan is deleted; see git history).

---

## The one rule

**No user-facing string is ever inlined.** Not in a component, not in an API response, not in an
error message that reaches a screen. If a human reads it, it has a key in `src/catalog.ts`.

```tsx
// No.
<button>Place order</button>
<input placeholder="Amount" />

// Yes.
<button>{t('trade.order.submit')}</button>
<input placeholder={t('common.label.amount')} />
```

Developer-facing text — thrown `Error` messages, log lines, code comments — is **not** covered by
this rule and must not be keyed. An engineer reading a stack trace is not a user.

---

## Using it

```ts
import { createTranslator, negotiateLocale, parseAcceptLanguage } from '@intafaced/i18n';

const locale = negotiateLocale(parseAcceptLanguage(request.headers['accept-language'] ?? ''));
const { t, dir, renderedLocale } = createTranslator(locale);

t('trade.order.submit'); // "Place order"
t('trade.filled', { qty: '1.5', symbol: 'BTC/USDT' }); // interpolation
t('wallet.assets', { count: 5 }); // plural, chosen by Intl.PluralRules
```

Every one of those returns **English today**, whatever `locale` says, because English is the only
catalog. This README used to show that first call returning Russian. It never did, and a doc that
demonstrates coverage we do not have is the thing this package exists to prevent.

Omit the catalog argument and it is looked up in the registry (`catalogFor`). A locale with no
catalog gets an **empty** catalog, not English-under-its-own-name — so every key falls through the
English fallback where it is reported and counted. That distinction is the whole reason
`localeCoverage()` can be trusted:

```ts
createTranslator('ar').hasCatalog; // false — Arabic is declared, not written
createTranslator('ar').renderedLocale; // 'en' — put THIS on the payload, not 'ar'
createTranslator('ar').dir; // 'ltr' — the text is English; do not mirror it
```

Pass an explicit catalog and it is taken as given — that is how a translation file under review, or
a test fixture, gets in. Loading and caching real language files is the app's job, not this
package's.

`t` is fully typed:

- a key that is not in the catalog does not compile;
- a message with `{qty}` and `{symbol}` will not compile without both;
- a plural message will not compile without `count`;
- passing params to a message that has no placeholders does not compile.

`dir` is `'ltr'` or `'rtl'` — put it on the document element.

---

## Adding a key

1. Add it to `en` in `src/catalog.ts`, dot-namespaced by surface:
   `<surface>.<area>.<thing>` — `trade.order.submit`, `auth.login.title`, `error.insufficientFunds`.
2. That is it. `MessageKey` widens automatically, `t()` accepts the new key, and every complete
   catalog declared with `defineCatalog` now **fails to compile** until it carries the new key. The
   compiler is the reminder; nobody has to remember.

For a message that varies with a count, write a `PluralMessage` rather than two keys:

```ts
'wallet.assets': { one: '{count} asset', other: '{count} assets' },
```

Never `n === 1 ? a : b`. English has two plural forms, Russian has three, Arabic has six, Japanese
has one. A ternary is wrong in most of the languages §9 promises, in a way nobody notices until a
native speaker files a bug.

---

## Adding a language

**This is an owner decision, not an engineering one.** A language costs a human writing 118 strings
of money copy and someone competent reviewing them. Do not machine-translate it, and do not add a
row "to make the list look better" — a declared locale with no catalog is now visibly zero, which is
the honest outcome, but it is still a promise the picker will show a user.

1. Add a row to `SUPPORTED_LOCALES` in `src/locales.ts` — code, English name, native name, RTL
   flag, and the tag handed to `Intl`. Set `rtl: true` for Arabic-, Hebrew-, Persian- and
   Urdu-script languages; the layout mirrors off that flag.
2. Add a catalog file that exports either `defineCatalog({...})` (complete) or
   `definePartialCatalog({...})` (in progress). Both are checked against the English key set — a
   partial catalog may omit keys, but it may not invent one.
3. Register it in `CATALOGS` in `src/catalogs.ts`. Until this line exists, the language is declared
   and not written, and every count in this package will say so.
4. There is no step four. No component changes, no route changes, no build changes.

A translation that lags is normal and safe: `createTranslator` serves the English string for any key
the language has not reached yet and reports it as `untranslated`. Wire that report to the
observability stack (§9) and translation coverage becomes a measured number — `localeCoverage()`
returns the whole table, `coverage(catalog)` a single language — instead of a claim.

---

## Missing keys: dev throws, prod falls back

| Situation                                 | Dev                                                                | Prod                              |
| ----------------------------------------- | ------------------------------------------------------------------ | --------------------------------- |
| Key exists nowhere                        | `MissingMessageError`                                              | Renders the key, reports          |
| Key exists in English, not in this locale | English string, reports                                            | English string, reports           |
| **Locale is declared but has no catalog** | English string, reports `no-catalog` once + `untranslated` per key | same                              |
| Message needs `{qty}`, caller omitted it  | `MissingParamError`                                                | Renders `{qty}` verbatim, reports |

Dev throws at the call site so the person who caused it fixes it. Production never throws and never
renders blank, because an untranslated string is a small problem and an empty button is a big one.
The placeholder is left visible on purpose — an obviously broken string gets reported; a silent
`undefined` gets shipped.

The third row is the state 27 of the 28 locales are in, so it does **not** throw in dev either —
shipping one language is a decision, not a bug. What it must never do is go unreported, which is
what happened when the catalog argument defaulted to English.

**The prod key echo is real and you should know where it lands.** `tUnsafe` with a key that exists
nowhere renders the dotted key itself — greppable and not blank, which is the right call on a
delivery path that must not throw during a margin call. The gate that stops it reaching a user is a
test, not a runtime check: `svc-notify`'s "has a catalog entry for every title and body key the
consumers use" walks the real event wiring, so a consumer added without copy fails CI rather than
emailing somebody `notify.bank.margin_call.title`.

Mode is taken from `NODE_ENV` and can be forced with `createTranslator(locale, catalog, { mode })`.
Reports go to `onMissing`.

---

## Money is never a float

`formatMoney` takes a **decimal string** and returns a formatted string. It never converts to
`number`, and there is a test asserting the source contains no `Number(`, `parseFloat(` or
`parseInt(` outside of comments.

```ts
formatMoney('1234.123456789012345678', 'USD', 'en', { maxFractionDigits: 18 });
// "$1,234.123456789012345678" — all 18 places the ledger carries

Number('1234.123456789012345678');
// 1234.1234567890124 — four digits gone, silently
```

The ledger stores `numeric(38,18)` and reconciles to the last digit (§4.2,
`packages/ledger-client/src/money.ts`). A float destroys that at the last step before a user reads
their own balance. So the formatting path works on digits:

1. split the string into sign / integer digits / fraction digits;
2. round the fraction with string and `BigInt` arithmetic when display precision is shorter than the
   value — half-up, exact, and correct in the cases `toFixed` gets wrong (`(2.675).toFixed(2)` is
   `'2.67'`; ours is `2.68`);
3. format the **integer part** with `Intl.NumberFormat` over a `BigInt`, via `formatToParts`, so
   locale grouping, currency placement and sign position come from `Intl` and not from us;
4. splice the fraction digits back in, transliterated into the locale's numbering system and
   separated by the locale's decimal separator — both asked of `Intl`, never hardcoded.

Display precision defaults to the currency's ISO minor units, read from the fiat registry in
`@intafaced/config` (§6.2). Currency metadata is not duplicated here; the registry helpers are
re-exported. Assets outside ISO 4217 (`BTC`, `USDT`, `IFC`) render as a number with the ticker,
because `Intl` only knows CLDR currency codes.

`formatNumber` and `formatPercent` take the same exact path for string input — `formatPercent`
shifts the decimal point rather than multiplying by 100. `formatDate`, `formatDateTime` and
`formatRelativeTime` are thin, cached wrappers over `Intl`.

---

## The scanner

The heuristic JSX-literal scanner (`pnpm scan:i18n`) was retired on 2026-10-19: it was advisory and could not fail a build.
The gate that actually holds is the type system in this package.

---

## Layout

| File           | What it is                                                             |
| -------------- | ---------------------------------------------------------------------- |
| `catalog.ts`   | English source of truth, catalog types, placeholder type extraction    |
| `catalogs.ts`  | Which locales actually have a catalog — `catalogFor`, `localeCoverage` |
| `locales.ts`   | Supported-locale registry, RTL flags, `Accept-Language` negotiation    |
| `format.ts`    | Money, number, percent, date and relative-time formatting              |
| `t.ts`         | `createTranslator`, interpolation, pluralisation, missing-key policy   |
| `i18n.test.ts` | The tests — including the compile-time assertions                      |

Nothing here does I/O. Catalogs are data; loading them is the app's job.

Copy in this package obeys Doctrine §0.7: user-facing strings name only _Identity Blueprint_,
_Sovereign Intelligence_, and _Neural Engine_ — never a third-party system.
