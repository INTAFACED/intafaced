import { en, isMessageKey } from '@intafaced/i18n/catalog';
import { createTranslator } from '@intafaced/i18n/t';
import { currentPreferences } from './preferences';
import type { UiLocale } from './i18n';

const translators = new Map<UiLocale, ReturnType<typeof createTranslator>>();
function published(key: string, locale: UiLocale) {
  if (!isMessageKey(key)) return null;
  const source = en[key];
  // Content references supply no interpolation inputs. A template or plural
  // cannot be presented as a complete article by guessing its parameters.
  if (typeof source !== 'string' || /\{\w+\}/.test(source)) return null;
  let translator = translators.get(locale);
  if (!translator) {
    translator = createTranslator(locale, undefined, { mode: 'prod', onMissing: () => {} });
    translators.set(locale, translator);
  }
  const translate = translator.t as unknown as (key: string) => string;
  return { text: translate(key), language: translator.hasOwn(key) ? locale : 'en' as UiLocale };
}
export function publishedCopy(key: string, locale: UiLocale = currentPreferences().language): string | null {
  return published(key, locale)?.text ?? null;
}
export function publishedLanguageFor(key: string, locale: UiLocale = currentPreferences().language): UiLocale | null {
  return published(key, locale)?.language ?? null;
}
