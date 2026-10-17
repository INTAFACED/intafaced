import { useSyncExternalStore, type JSX } from 'react';
import { createTranslator, type ParamValue } from '@intafaced/i18n/t';
import type { Catalog, PartialCatalog } from '@intafaced/i18n/catalog';
import { currentPreferences, usePreferences } from './preferences';
import { canonicalUiLocale, uiDirection, type UiLocale } from './locale';

export type { UiLocale } from './locale';
type Parameters<S extends string> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Parameters<Rest> : never;
type Args<S extends string> = [Parameters<S>] extends [never] ? [] : [params: Record<Parameters<S>, ParamValue>];
type Written<T> = Partial<Record<keyof T, string>>;
type CopyProps<T extends Record<string, string>, K extends keyof T & string> = { k: K } & ([Parameters<T[K]>] extends [never]
  ? { params?: never }
  : { params: Record<Parameters<T[K]>, ParamValue> });
export interface LocaleCopy<T extends Record<string, string>> {
  t<K extends keyof T & string>(key: K, ...args: Args<T[K]>): string;
  languageFor(key: keyof T & string): UiLocale;
  directionFor(key: keyof T & string): 'ltr' | 'rtl';
  renderedLocale: UiLocale;
  requestedLocale: UiLocale;
}
export interface CopyCatalog<T extends Record<string, string>> {
  namespace: string;
  t: LocaleCopy<T>['t'];
  Copy<K extends keyof T & string>(props: CopyProps<T, K>): JSX.Element;
  useCopy(): LocaleCopy<T> & { Copy: CopyCatalog<T>['Copy'] };
  forLocale(locale: UiLocale): LocaleCopy<T>;
  coverage(locale: UiLocale): { namespace: string; locale: UiLocale; total: number; translated: number; missing: string[] };
}
type Dictionaries<T> = Partial<Record<Exclude<UiLocale, 'en'>, Written<T>>>;
type Registered = { en: Record<string, string> } & Partial<Record<UiLocale, Partial<Record<string, string>>>>;
const registered = new Map<string, Registered>();
const listeners = new Set<() => void>();
let revision = 0;
let renderingLanguages: Set<UiLocale> | undefined;

/** Match the enumerable own entries validated and expanded at registration. */
function hasWrittenEntry(values: Partial<Record<string, string>> | undefined, key: string): boolean {
  return values !== undefined && Object.prototype.propertyIsEnumerable.call(values, key) && typeof values[key] === 'string';
}

/** Explicit authored render callbacks carry provenance through plain .t text.
 * No output/user/provider text is searched or saved. Mixed/unknown prose is und. */
export function renderAuthoredCopy<T>(render: () => T): { value: T; language: UiLocale | 'und' } {
  const previous = renderingLanguages;
  const languages = new Set<UiLocale>();
  renderingLanguages = languages;
  try {
    const value = render();
    return { value, language: languages.size === 1 ? ([...languages][0] ?? 'und') : 'und' };
  } finally {
    renderingLanguages = previous;
    for (const language of languages) previous?.add(language);
  }
}

/** Authored UI only. A feature owns its namespace and dictionaries. Domain
 * values enter only through explicit parameters; no DOM/user text is scanned. */
export function defineCopy<const T extends Record<string, string>>(
  namespace: string,
  en: T,
  written: Dictionaries<T> = {},
): CopyCatalog<T> {
  const placeholders = (value: string) => [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort().join(',');
  for (const [key, source] of Object.entries(en)) {
    if (!source.trim()) throw new Error(`Empty authored UI message: ${namespace}.${key}`);
  }
  for (const [code, dictionary] of Object.entries(written)) {
    if (canonicalUiLocale(code) !== code || code === 'en') throw new Error(`Unsupported authored UI locale: ${code}`);
    for (const [key, translated] of Object.entries(dictionary ?? {})) {
      if (!Object.hasOwn(en, key)) throw new Error(`Unknown authored UI key: ${namespace}.${key}`);
      if (
        typeof translated !== 'string' ||
        !hasWrittenEntry(dictionary, key) ||
        !translated.trim() ||
        placeholders(translated) !== placeholders(en[key]!)
      ) {
        throw new Error(`Translation placeholder mismatch: ${namespace}.${key} (${code})`);
      }
    }
  }
  const messages: Registered = { en, ...written };
  registered.set(namespace, messages);
  revision++;
  for (const changed of listeners) changed();
  const expand = (values: Partial<Record<string, string>>) => {
    const entries: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(values))
      if (typeof value === 'string' && hasWrittenEntry(values, key)) entries.push([namespace + '.' + key, value]);
    return Object.fromEntries(entries);
  };
  const cache = new Map<UiLocale, ReturnType<typeof createTranslator>>();
  function forLocale(locale: UiLocale): LocaleCopy<T> {
    const canonical = canonicalUiLocale(locale);
    if (!canonical) throw new Error(`Unsupported interface language: ${locale}`);
    locale = canonical;
    let translator = cache.get(locale);
    if (!translator) {
      translator = createTranslator(locale, expand(messages[locale] ?? {}) as PartialCatalog, {
        fallback: expand(en) as unknown as Catalog,
        mode: import.meta.env.DEV ? 'dev' : 'prod',
        // Coverage is exposed explicitly below; avoid one console warning per
        // known fallback on every mounted feature/page.
        onMissing: () => {},
      });
      cache.set(locale, translator);
    }
    const translate = translator.t as unknown as (key: string, params?: Record<string, ParamValue>) => string;
    function t<K extends keyof T & string>(key: K, ...args: Args<T[K]>): string {
      renderingLanguages?.add(languageFor(key));
      return translate(namespace + '.' + key, args[0]);
    }
    function languageFor(key: keyof T & string): UiLocale {
      return hasWrittenEntry(messages[locale], key) ? locale : 'en';
    }
    return {
      t,
      languageFor,
      requestedLocale: locale,
      renderedLocale: locale === 'en' || Object.keys(en).some((key) => hasWrittenEntry(messages[locale], key)) ? locale : 'en',
      directionFor: (key) => uiDirection(languageFor(key)),
    };
  }
  function Copy<K extends keyof T & string>(props: CopyProps<T, K>): JSX.Element {
    const { language } = usePreferences();
    const current = forLocale(language);
    return (
      <span lang={current.languageFor(props.k)} dir={current.directionFor(props.k)} data-i18n={namespace + '.' + props.k}>
        {current.t(props.k, ...((props.params ? [props.params] : []) as Args<T[K]>))}
      </span>
    );
  }
  function useCopy() {
    const { language } = usePreferences();
    return { ...forLocale(language), Copy };
  }
  function t<K extends keyof T & string>(key: K, ...args: Args<T[K]>): string {
    return forLocale(currentPreferences().language).t(key, ...args);
  }
  function coverage(locale: UiLocale) {
    const keys = Object.keys(en);
    const missing = keys.filter((key) => !hasWrittenEntry(messages[locale], key));
    return { namespace, locale, total: keys.length, translated: keys.length - missing.length, missing };
  }
  return { namespace, t, Copy, useCopy, forLocale, coverage };
}

export function customerCopyCoverage(locale: UiLocale) {
  return [...registered].map(([namespace, catalogs]) => {
    const keys = Object.keys(catalogs.en);
    const missing = keys.filter((key) => !hasWrittenEntry(catalogs[locale], key));
    return { namespace, total: keys.length, translated: keys.length - missing.length, missing };
  });
}
/** Every registered catalog with its written text per language. For tests that guard customer wording; the UI never calls it. */
export function registeredCopy(): Array<{ namespace: string; messages: Record<string, Partial<Record<string, string>>> }> {
  return [...registered].map(([namespace, catalogs]) => ({
    namespace,
    messages: catalogs as Record<string, Partial<Record<string, string>>>,
  }));
}
export function renderedUiLanguage(locale: UiLocale): UiLocale {
  return locale === 'en' || customerCopyCoverage(locale).some((row) => row.translated > 0) ? locale : 'en';
}
export function useCopyRevision() {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    () => revision,
  );
}
