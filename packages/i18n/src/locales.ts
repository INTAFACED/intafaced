/**
 * The supported-locale registry — the locales this OS is willing to be asked
 * for. §9 wants "100+ languages = translation files, not refactors"; this table
 * is generated ISO codes (129 rows). Untranslated locales still
 * resolve through English so a keyed surface never shows a raw key.
 *
 * A row here declares a code and reserves it. Words live in `CATALOGS`.
 * Three locales (en, es, fr) carry distinct copy; the rest are empty
 * fallback catalogs. Adding literary translation is a content change, not a
 * refactor.
 *
 * `code` is what the app stores and puts in a URL. `intlTag` is what we hand to
 * `Intl.*` — sometimes region-qualified, because number and date conventions
 * are regional even when the language is not.
 *
 * Generated from Intl.DisplayNames; do not restore a vendor `zh` locale
 * without a matching lang file.
 */

export interface LocaleDescriptor {
  /** Canonical app locale code (BCP-47 subset). Stored on the account, used in routes. */
  readonly code: string;
  /** Name in English — for admin surfaces and support tooling. */
  readonly englishName: string;
  /** Name in the language itself — for the language picker. Users pick their own name, not ours. */
  readonly nativeName: string;
  /** Right-to-left script. Drives `dir` on the document element and mirrored layout. */
  readonly rtl: boolean;
  /** Tag handed to `Intl.NumberFormat` / `DateTimeFormat` / `PluralRules` / `RelativeTimeFormat`. */
  readonly intlTag: string;
}

/**
 * The declared set — 129 codes we will accept and negotiate against.
 * Untranslated codes fall back to English. Growth here is cheap; growth in
 * catalog *words* is what a user notices.
 */
export const SUPPORTED_LOCALES = [
  { code: 'en', englishName: 'English', nativeName: 'English', rtl: false, intlTag: 'en-US' },
  { code: 'es', englishName: 'Spanish', nativeName: 'español', rtl: false, intlTag: 'es-ES' },
  { code: 'pt-BR', englishName: 'Brazilian Portuguese', nativeName: 'português (Brasil)', rtl: false, intlTag: 'pt-BR' },
  { code: 'fr', englishName: 'French', nativeName: 'français', rtl: false, intlTag: 'fr-FR' },
  { code: 'de', englishName: 'German', nativeName: 'Deutsch', rtl: false, intlTag: 'de-DE' },
  { code: 'it', englishName: 'Italian', nativeName: 'italiano', rtl: false, intlTag: 'it-IT' },
  { code: 'nl', englishName: 'Dutch', nativeName: 'Nederlands', rtl: false, intlTag: 'nl-NL' },
  { code: 'pl', englishName: 'Polish', nativeName: 'polski', rtl: false, intlTag: 'pl-PL' },
  { code: 'ru', englishName: 'Russian', nativeName: 'русский', rtl: false, intlTag: 'ru-RU' },
  { code: 'uk', englishName: 'Ukrainian', nativeName: 'українська', rtl: false, intlTag: 'uk-UA' },
  { code: 'tr', englishName: 'Turkish', nativeName: 'Türkçe', rtl: false, intlTag: 'tr-TR' },
  { code: 'ar', englishName: 'Arabic', nativeName: 'العربية', rtl: true, intlTag: 'ar-EG' },
  { code: 'he', englishName: 'Hebrew', nativeName: 'עברית', rtl: true, intlTag: 'he-IL' },
  { code: 'fa', englishName: 'Persian', nativeName: 'فارسی', rtl: true, intlTag: 'fa-IR' },
  { code: 'ur', englishName: 'Urdu', nativeName: 'اردو', rtl: true, intlTag: 'ur-PK' },
  { code: 'hi', englishName: 'Hindi', nativeName: 'हिन्दी', rtl: false, intlTag: 'hi-IN' },
  { code: 'bn', englishName: 'Bangla', nativeName: 'বাংলা', rtl: false, intlTag: 'bn-BD' },
  { code: 'id', englishName: 'Indonesian', nativeName: 'Indonesia', rtl: false, intlTag: 'id-ID' },
  { code: 'ms', englishName: 'Malay', nativeName: 'Melayu', rtl: false, intlTag: 'ms-MY' },
  { code: 'th', englishName: 'Thai', nativeName: 'ไทย', rtl: false, intlTag: 'th-TH' },
  { code: 'vi', englishName: 'Vietnamese', nativeName: 'Tiếng Việt', rtl: false, intlTag: 'vi-VN' },
  { code: 'ja', englishName: 'Japanese', nativeName: '日本語', rtl: false, intlTag: 'ja-JP' },
  { code: 'ko', englishName: 'Korean', nativeName: '한국어', rtl: false, intlTag: 'ko-KR' },
  { code: 'zh-Hans', englishName: 'Simplified Chinese', nativeName: '简体中文', rtl: false, intlTag: 'zh-Hans-CN' },
  { code: 'zh-Hant', englishName: 'Traditional Chinese', nativeName: '繁體中文', rtl: false, intlTag: 'zh-Hant-TW' },
  { code: 'fil', englishName: 'Filipino', nativeName: 'Filipino', rtl: false, intlTag: 'fil-PH' },
  { code: 'sw', englishName: 'Swahili', nativeName: 'Kiswahili', rtl: false, intlTag: 'sw-KE' },
  { code: 'ha', englishName: 'Hausa', nativeName: 'Hausa', rtl: false, intlTag: 'ha-NG' },
  { code: 'af', englishName: 'Afrikaans', nativeName: 'Afrikaans', rtl: false, intlTag: 'af' },
  { code: 'am', englishName: 'Amharic', nativeName: 'አማርኛ', rtl: false, intlTag: 'am' },
  { code: 'as', englishName: 'Assamese', nativeName: 'অসমীয়া', rtl: false, intlTag: 'as' },
  { code: 'az', englishName: 'Azerbaijani', nativeName: 'azərbaycan', rtl: false, intlTag: 'az' },
  { code: 'be', englishName: 'Belarusian', nativeName: 'беларуская', rtl: false, intlTag: 'be' },
  { code: 'bg', englishName: 'Bulgarian', nativeName: 'български', rtl: false, intlTag: 'bg' },
  { code: 'bm', englishName: 'Bambara', nativeName: 'bamanakan', rtl: false, intlTag: 'bm' },
  { code: 'bo', englishName: 'Tibetan', nativeName: 'བོད་སྐད་', rtl: false, intlTag: 'bo' },
  { code: 'br', englishName: 'Breton', nativeName: 'brezhoneg', rtl: false, intlTag: 'br' },
  { code: 'bs', englishName: 'Bosnian', nativeName: 'bosanski', rtl: false, intlTag: 'bs' },
  { code: 'ca', englishName: 'Catalan', nativeName: 'català', rtl: false, intlTag: 'ca' },
  { code: 'ce', englishName: 'Chechen', nativeName: 'нохчийн', rtl: false, intlTag: 'ce' },
  { code: 'cs', englishName: 'Czech', nativeName: 'čeština', rtl: false, intlTag: 'cs' },
  { code: 'cy', englishName: 'Welsh', nativeName: 'Cymraeg', rtl: false, intlTag: 'cy' },
  { code: 'da', englishName: 'Danish', nativeName: 'dansk', rtl: false, intlTag: 'da' },
  { code: 'dz', englishName: 'Dzongkha', nativeName: 'རྫོང་ཁ', rtl: false, intlTag: 'dz' },
  { code: 'ee', englishName: 'Ewe', nativeName: 'eʋegbe', rtl: false, intlTag: 'ee' },
  { code: 'el', englishName: 'Greek', nativeName: 'Ελληνικά', rtl: false, intlTag: 'el' },
  { code: 'eo', englishName: 'Esperanto', nativeName: 'Esperanto', rtl: false, intlTag: 'eo' },
  { code: 'et', englishName: 'Estonian', nativeName: 'eesti', rtl: false, intlTag: 'et' },
  { code: 'eu', englishName: 'Basque', nativeName: 'euskara', rtl: false, intlTag: 'eu' },
  { code: 'ff', englishName: 'Fula', nativeName: 'Pulaar', rtl: false, intlTag: 'ff' },
  { code: 'fi', englishName: 'Finnish', nativeName: 'suomi', rtl: false, intlTag: 'fi' },
  { code: 'fo', englishName: 'Faroese', nativeName: 'føroyskt', rtl: false, intlTag: 'fo' },
  { code: 'fy', englishName: 'Western Frisian', nativeName: 'Frysk', rtl: false, intlTag: 'fy' },
  { code: 'ga', englishName: 'Irish', nativeName: 'Gaeilge', rtl: false, intlTag: 'ga' },
  { code: 'gd', englishName: 'Scottish Gaelic', nativeName: 'Gàidhlig', rtl: false, intlTag: 'gd' },
  { code: 'gl', englishName: 'Galician', nativeName: 'galego', rtl: false, intlTag: 'gl' },
  { code: 'gu', englishName: 'Gujarati', nativeName: 'ગુજરાતી', rtl: false, intlTag: 'gu' },
  { code: 'gv', englishName: 'Manx', nativeName: 'Gaelg', rtl: false, intlTag: 'gv' },
  { code: 'hr', englishName: 'Croatian', nativeName: 'hrvatski', rtl: false, intlTag: 'hr' },
  { code: 'hu', englishName: 'Hungarian', nativeName: 'magyar', rtl: false, intlTag: 'hu' },
  { code: 'hy', englishName: 'Armenian', nativeName: 'հայերեն', rtl: false, intlTag: 'hy' },
  { code: 'ia', englishName: 'Interlingua', nativeName: 'interlingua', rtl: false, intlTag: 'ia' },
  { code: 'ig', englishName: 'Igbo', nativeName: 'Igbo', rtl: false, intlTag: 'ig' },
  { code: 'is', englishName: 'Icelandic', nativeName: 'íslenska', rtl: false, intlTag: 'is' },
  { code: 'jv', englishName: 'Javanese', nativeName: 'Jawa', rtl: false, intlTag: 'jv' },
  { code: 'ka', englishName: 'Georgian', nativeName: 'ქართული', rtl: false, intlTag: 'ka' },
  { code: 'ki', englishName: 'Kikuyu', nativeName: 'Gikuyu', rtl: false, intlTag: 'ki' },
  { code: 'kk', englishName: 'Kazakh', nativeName: 'қазақ тілі', rtl: false, intlTag: 'kk' },
  { code: 'km', englishName: 'Khmer', nativeName: 'ខ្មែរ', rtl: false, intlTag: 'km' },
  { code: 'kn', englishName: 'Kannada', nativeName: 'ಕನ್ನಡ', rtl: false, intlTag: 'kn' },
  { code: 'ks', englishName: 'Kashmiri', nativeName: 'کٲشُر', rtl: true, intlTag: 'ks' },
  { code: 'ku', englishName: 'Kurdish', nativeName: 'kurdî (kurmancî)', rtl: false, intlTag: 'ku' },
  { code: 'kw', englishName: 'Cornish', nativeName: 'kernewek', rtl: false, intlTag: 'kw' },
  { code: 'ky', englishName: 'Kyrgyz', nativeName: 'кыргызча', rtl: false, intlTag: 'ky' },
  { code: 'lb', englishName: 'Luxembourgish', nativeName: 'Lëtzebuergesch', rtl: false, intlTag: 'lb' },
  { code: 'lg', englishName: 'Ganda', nativeName: 'Luganda', rtl: false, intlTag: 'lg' },
  { code: 'ln', englishName: 'Lingala', nativeName: 'lingála', rtl: false, intlTag: 'ln' },
  { code: 'lo', englishName: 'Lao', nativeName: 'ລາວ', rtl: false, intlTag: 'lo' },
  { code: 'lt', englishName: 'Lithuanian', nativeName: 'lietuvių', rtl: false, intlTag: 'lt' },
  { code: 'lu', englishName: 'Luba-Katanga', nativeName: 'Tshiluba', rtl: false, intlTag: 'lu' },
  { code: 'lv', englishName: 'Latvian', nativeName: 'latviešu', rtl: false, intlTag: 'lv' },
  { code: 'mg', englishName: 'Malagasy', nativeName: 'Malagasy', rtl: false, intlTag: 'mg' },
  { code: 'mi', englishName: 'Māori', nativeName: 'Māori', rtl: false, intlTag: 'mi' },
  { code: 'mk', englishName: 'Macedonian', nativeName: 'македонски', rtl: false, intlTag: 'mk' },
  { code: 'ml', englishName: 'Malayalam', nativeName: 'മലയാളം', rtl: false, intlTag: 'ml' },
  { code: 'mn', englishName: 'Mongolian', nativeName: 'монгол', rtl: false, intlTag: 'mn' },
  { code: 'mr', englishName: 'Marathi', nativeName: 'मराठी', rtl: false, intlTag: 'mr' },
  { code: 'mt', englishName: 'Maltese', nativeName: 'Malti', rtl: false, intlTag: 'mt' },
  { code: 'my', englishName: 'Burmese', nativeName: 'မြန်မာ', rtl: false, intlTag: 'my' },
  { code: 'nb', englishName: 'Norwegian Bokmål', nativeName: 'norsk bokmål', rtl: false, intlTag: 'nb' },
  { code: 'nd', englishName: 'North Ndebele', nativeName: 'isiNdebele', rtl: false, intlTag: 'nd' },
  { code: 'ne', englishName: 'Nepali', nativeName: 'नेपाली', rtl: false, intlTag: 'ne' },
  { code: 'nn', englishName: 'Norwegian Nynorsk', nativeName: 'norsk nynorsk', rtl: false, intlTag: 'nn' },
  { code: 'om', englishName: 'Oromo', nativeName: 'Oromoo', rtl: false, intlTag: 'om' },
  { code: 'or', englishName: 'Odia', nativeName: 'ଓଡ଼ିଆ', rtl: false, intlTag: 'or' },
  { code: 'os', englishName: 'Ossetic', nativeName: 'ирон', rtl: false, intlTag: 'os' },
  { code: 'pa', englishName: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', rtl: false, intlTag: 'pa' },
  { code: 'ps', englishName: 'Pashto', nativeName: 'پښتو', rtl: true, intlTag: 'ps' },
  { code: 'qu', englishName: 'Quechua', nativeName: 'Runasimi', rtl: false, intlTag: 'qu' },
  { code: 'rm', englishName: 'Romansh', nativeName: 'rumantsch', rtl: false, intlTag: 'rm' },
  { code: 'rn', englishName: 'Rundi', nativeName: 'Ikirundi', rtl: false, intlTag: 'rn' },
  { code: 'ro', englishName: 'Romanian', nativeName: 'română', rtl: false, intlTag: 'ro' },
  { code: 'rw', englishName: 'Kinyarwanda', nativeName: 'Ikinyarwanda', rtl: false, intlTag: 'rw' },
  { code: 'se', englishName: 'Northern Sami', nativeName: 'davvisámegiella', rtl: false, intlTag: 'se' },
  { code: 'sg', englishName: 'Sango', nativeName: 'Sängö', rtl: false, intlTag: 'sg' },
  { code: 'si', englishName: 'Sinhala', nativeName: 'සිංහල', rtl: false, intlTag: 'si' },
  { code: 'sk', englishName: 'Slovak', nativeName: 'slovenčina', rtl: false, intlTag: 'sk' },
  { code: 'sl', englishName: 'Slovenian', nativeName: 'slovenščina', rtl: false, intlTag: 'sl' },
  { code: 'sn', englishName: 'Shona', nativeName: 'chiShona', rtl: false, intlTag: 'sn' },
  { code: 'so', englishName: 'Somali', nativeName: 'Soomaali', rtl: false, intlTag: 'so' },
  { code: 'sq', englishName: 'Albanian', nativeName: 'shqip', rtl: false, intlTag: 'sq' },
  { code: 'sr', englishName: 'Serbian', nativeName: 'српски', rtl: false, intlTag: 'sr' },
  { code: 'sv', englishName: 'Swedish', nativeName: 'svenska', rtl: false, intlTag: 'sv' },
  { code: 'ta', englishName: 'Tamil', nativeName: 'தமிழ்', rtl: false, intlTag: 'ta' },
  { code: 'te', englishName: 'Telugu', nativeName: 'తెలుగు', rtl: false, intlTag: 'te' },
  { code: 'tg', englishName: 'Tajik', nativeName: 'тоҷикӣ', rtl: false, intlTag: 'tg' },
  { code: 'ti', englishName: 'Tigrinya', nativeName: 'ትግርኛ', rtl: false, intlTag: 'ti' },
  { code: 'tk', englishName: 'Turkmen', nativeName: 'türkmen dili', rtl: false, intlTag: 'tk' },
  { code: 'to', englishName: 'Tongan', nativeName: 'lea fakatonga', rtl: false, intlTag: 'to' },
  { code: 'tt', englishName: 'Tatar', nativeName: 'татар', rtl: false, intlTag: 'tt' },
  { code: 'ug', englishName: 'Uyghur', nativeName: 'ئۇيغۇرچە', rtl: true, intlTag: 'ug' },
  { code: 'uz', englishName: 'Uzbek', nativeName: 'o‘zbek', rtl: false, intlTag: 'uz' },
  { code: 'wo', englishName: 'Wolof', nativeName: 'Wolof', rtl: false, intlTag: 'wo' },
  { code: 'xh', englishName: 'Xhosa', nativeName: 'IsiXhosa', rtl: false, intlTag: 'xh' },
  { code: 'yi', englishName: 'Yiddish', nativeName: 'ייִדיש', rtl: true, intlTag: 'yi' },
  { code: 'yo', englishName: 'Yoruba', nativeName: 'Èdè Yorùbá', rtl: false, intlTag: 'yo' },
  { code: 'zu', englishName: 'Zulu', nativeName: 'isiZulu', rtl: false, intlTag: 'zu' },
  { code: 'sd', englishName: 'Sindhi', nativeName: 'سنڌي', rtl: true, intlTag: 'sd' },
  { code: 'ak', englishName: 'Akan', nativeName: 'Akan', rtl: false, intlTag: 'ak' },
] as const satisfies readonly LocaleDescriptor[];

/** Every locale code the app is allowed to be in. */
export type LocaleCode = (typeof SUPPORTED_LOCALES)[number]['code'];

/**
 * The languages the customer app has written copy in: what it offers as a choice, and what identity accepts as an
 * account's display language (`account.display`, J-identity-10 #2). The rest of the catalogue would show English under a
 * foreign name. `apps/customer/src/shared/customer-copy-locales.test.ts` keeps this list equal to the copy that exists.
 */
export const CUSTOMER_COPY_LOCALES = ['en', 'es', 'fr'] as const;

/** The source-of-truth language. Also the fallback when a key is untranslated. */
export const DEFAULT_LOCALE: LocaleCode = 'en';

export type Direction = 'ltr' | 'rtl';

const BY_CODE = new Map<string, LocaleDescriptor>(SUPPORTED_LOCALES.map((l) => [l.code.toLowerCase(), l]));

/**
 * Legacy and region tags people actually send in `Accept-Language`, mapped to
 * the code we store. Extend as real traffic shows up — guessing is worse.
 */
const ALIASES: Readonly<Record<string, LocaleCode>> = {
  'zh-cn': 'zh-Hans',
  'zh-sg': 'zh-Hans',
  'zh-my': 'zh-Hans',
  'zh-tw': 'zh-Hant',
  'zh-hk': 'zh-Hant',
  'zh-mo': 'zh-Hant',
  zh: 'zh-Hans',
  pt: 'pt-BR',
  'pt-pt': 'pt-BR',
  in: 'id',
  iw: 'he',
  tl: 'fil',
};

/** Look up a locale by code. Case-insensitive; aliases resolved. */
export function locale(code: string): LocaleDescriptor | undefined {
  const key = code.trim().toLowerCase();
  const direct = BY_CODE.get(key);
  if (direct) return direct;
  const alias = ALIASES[key];
  return alias ? BY_CODE.get(alias.toLowerCase()) : undefined;
}

export function isSupportedLocale(code: string): code is LocaleCode {
  return locale(code) !== undefined;
}

/** Right-to-left? Unknown codes are treated as LTR — English is LTR. */
export function isRtl(code: string): boolean {
  return locale(code)?.rtl ?? false;
}

/** The `dir` attribute for the document element. */
export function dir(code: string): Direction {
  return isRtl(code) ? 'rtl' : 'ltr';
}

/** The tag to hand `Intl`. Unknown codes pass through — `Intl` has its own fallback chain. */
export function intlTagFor(code: string): string {
  return locale(code)?.intlTag ?? code;
}

/** Every RTL locale — useful for layout test matrices. */
export function rtlLocales(): readonly LocaleDescriptor[] {
  return SUPPORTED_LOCALES.filter((l) => l.rtl);
}

/**
 * Pick the best supported locale for a request.
 *
 * Accepts either raw `Accept-Language` values or plain tags, in priority order.
 * Falls back through the primary subtag (`pt-PT` → `pt-BR`) before giving up,
 * because serving English to a Portuguese speaker over a region mismatch is a
 * self-inflicted wound.
 */
export function negotiateLocale(requested: readonly string[], fallback: LocaleCode = DEFAULT_LOCALE): LocaleCode {
  for (const raw of requested) {
    const tag = raw.split(';')[0]?.trim();
    if (!tag) continue;

    const exact = locale(tag);
    if (exact) return exact.code as LocaleCode;

    const primary = tag.split('-')[0]?.toLowerCase();
    if (!primary) continue;

    const byPrimary = locale(primary) ?? SUPPORTED_LOCALES.find((l) => l.code.toLowerCase().split('-')[0] === primary);
    if (byPrimary) return byPrimary.code as LocaleCode;
  }
  return fallback;
}

/** Parse an `Accept-Language` header into tags in descending quality order. */
export function parseAcceptLanguage(header: string): string[] {
  return header
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.split(';').map((s) => s.trim());
      const q = params.find((p) => p.startsWith('q='));
      const quality = q ? Number.parseFloat(q.slice(2)) : 1;
      return { tag, quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((entry) => entry.tag.length > 0 && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality)
    .map((entry) => entry.tag);
}
