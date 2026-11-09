/**
 * A notice's title and body in other languages (J-cex-spot-15 #2: changelog notices in the chosen language).
 *
 * The operator writes the notice in its source language, English, and may add their own text for any other language the
 * app offers. Nothing is machine-translated. A read in a language the notice has answers that text and says so; a read
 * in any other language answers the source text, labelled `en`, so the page can say it is not in the chosen language.
 * The publish approval binds the translations (board.ts payloadHash), and a published notice's never change (the
 * notice_published_immutable trigger).
 */
import { isSupportedLocale } from '@intafaced/i18n';
import { NoticeError } from './board.js';

/** The language a notice's own `title` and `body` are written in. */
export const NOTICE_SOURCE_LANGUAGE = 'en';
/** Storage bounds, not owner values: the same as the source text's, and one entry per language the app offers. */
export const NOTICE_TITLE_MAX = 200;
export const NOTICE_BODY_MAX = 8000;

export type NoticeText = { readonly title: string; readonly body: string };
export type NoticeTranslations = Readonly<Record<string, NoticeText>>;

/**
 * The translations a draft may carry: each key a language the app offers other than the source, each text trimmed and
 * non-empty. Anything else refuses `notify.notice_translation_invalid`; none given is none.
 */
export function translationsField(input: Readonly<Record<string, { title: string; body: string }>> | null | undefined): NoticeTranslations {
  if (!input) return {};
  const out: Record<string, NoticeText> = {};
  for (const [language, text] of Object.entries(input)) {
    if (language === NOTICE_SOURCE_LANGUAGE || !isSupportedLocale(language)) throw new NoticeError('notify.notice_translation_invalid');
    const title = text.title.trim();
    const body = text.body.trim();
    if (!title || !body || title.length > NOTICE_TITLE_MAX || body.length > NOTICE_BODY_MAX)
      throw new NoticeError('notify.notice_translation_invalid');
    out[language] = { title, body };
  }
  return out;
}

/** The translations in one stable order, for the approval's payload hash. Empty when there are none. */
export function translationsForHash(translations: NoticeTranslations | undefined): [string, NoticeText][] {
  return Object.entries(translations ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([language, text]) => [language, { title: text.title, body: text.body }]);
}

/** Stored translations, checked on the way out: a malformed column is an error, never a silently dropped language. */
export function translationsFromStored(value: unknown): NoticeTranslations {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new NoticeError('notify.notice_translation_invalid');
  const out: Record<string, NoticeText> = {};
  for (const [language, text] of Object.entries(value as Record<string, unknown>)) {
    const rec = text as Record<string, unknown> | null;
    if (!rec || typeof rec.title !== 'string' || typeof rec.body !== 'string') throw new NoticeError('notify.notice_translation_invalid');
    out[language] = { title: rec.title, body: rec.body };
  }
  return out;
}

/**
 * A notice's text in the chosen language: that language's own text when the notice has it, else the source text. The
 * answer names the language the text is in. A language the app does not offer, or none, reads the source text.
 */
export function inLanguage(
  source: NoticeText,
  translations: NoticeTranslations | undefined,
  language: string | null | undefined,
): NoticeText & { language: string } {
  const own = language ? translations?.[language] : undefined;
  return own
    ? { title: own.title, body: own.body, language: language! }
    : { title: source.title, body: source.body, language: NOTICE_SOURCE_LANGUAGE };
}
