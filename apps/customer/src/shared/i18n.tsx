import { useSyncExternalStore, type JSX } from 'react';
import { createTranslator, type ParamValue } from '@intafaced/i18n/t';
import type { Catalog, PartialCatalog } from '@intafaced/i18n/catalog';
import { currentPreferences, usePreferences, type Preferences } from './preferences';

export type UiLocale = Preferences['language'];
type Parameters<S extends string> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Parameters<Rest> : never;
type Args<S extends string> = [Parameters<S>] extends [never] ? [] : [params: Record<Parameters<S>, ParamValue>];
type Written<T> = Partial<Record<keyof T, string>>;
type CopyProps<T extends Record<string, string>, K extends keyof T & string> = { k: K } &
  ([Parameters<T[K]>] extends [never] ? { params?: never } : { params: Record<Parameters<T[K]>, ParamValue> });
export interface LocaleCopy<T extends Record<string, string>> {
  t<K extends keyof T & string>(key: K, ...args: Args<T[K]>): string;
  languageFor(key: keyof T & string): UiLocale;
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
const registered = new Map<string, { en: Record<string, string>; es?: Partial<Record<string, string>>; fr?: Partial<Record<string, string>> }>();
const listeners = new Set<() => void>();
let revision = 0;

/** Authored UI only. A feature owns its namespace and dictionaries. Domain
 * values enter only through explicit parameters; no DOM/user text is scanned. */
export function defineCopy<const T extends Record<string, string>>(
  namespace: string, en: T, written: { es?: Written<T>; fr?: Written<T> } = {},
): CopyCatalog<T> {
  const placeholders = (value: string) => [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort().join(',');
  for (const [key, source] of Object.entries(en)) {
    if (!source.trim()) throw new Error(`Empty authored UI message: ${namespace}.${key}`);
    for (const locale of ['es', 'fr'] as const) {
      const translated = written[locale]?.[key];
      if (translated !== undefined && (!translated.trim() || placeholders(translated) !== placeholders(source))) {
        throw new Error(`Translation placeholder mismatch: ${namespace}.${key} (${locale})`);
      }
    }
  }
  const messages = { en, ...written };
  registered.set(namespace, messages);
  revision++;
  for (const changed of listeners) changed();
  const expand = (values: Partial<Record<string, string>>) => {
    const entries: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(values)) if (typeof value === 'string') entries.push([namespace + '.' + key, value]);
    return Object.fromEntries(entries);
  };
  const cache = new Map<UiLocale, ReturnType<typeof createTranslator>>();
  function forLocale(locale: UiLocale): LocaleCopy<T> {
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
      return translate(namespace + '.' + key, args[0]);
    }
    function languageFor(key: keyof T & string): UiLocale {
      return typeof messages[locale]?.[key] === 'string' ? locale : 'en';
    }
    return { t, languageFor, requestedLocale: locale };
  }
  function Copy<K extends keyof T & string>(props: CopyProps<T, K>): JSX.Element {
    const { language } = usePreferences();
    const current = forLocale(language);
    return <span lang={current.languageFor(props.k)} data-i18n={namespace + '.' + props.k}>{current.t(props.k, ...((props.params ? [props.params] : []) as Args<T[K]>))}</span>;
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
    const missing = keys.filter((key) => typeof messages[locale]?.[key] !== 'string');
    return { namespace, locale, total: keys.length, translated: keys.length - missing.length, missing };
  }
  return { namespace, t, Copy, useCopy, forLocale, coverage };
}

export function customerCopyCoverage(locale: UiLocale) {
  return [...registered].map(([namespace, catalogs]) => {
    const keys = Object.keys(catalogs.en);
    const missing = keys.filter((key) => typeof catalogs[locale]?.[key] !== 'string');
    return { namespace, total: keys.length, translated: keys.length - missing.length, missing };
  });
}
export function renderedUiLanguage(locale: UiLocale): UiLocale {
  return locale === 'en' || customerCopyCoverage(locale).some((row) => row.translated > 0) ? locale : 'en';
}
export function useCopyRevision() {
  return useSyncExternalStore((notify) => { listeners.add(notify); return () => { listeners.delete(notify); }; }, () => revision);
}
