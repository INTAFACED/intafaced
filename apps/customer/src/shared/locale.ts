import { SUPPORTED_LOCALES, locale, dir, type LocaleCode } from '@intafaced/i18n/locales';

export type UiLocale = LocaleCode;
export const uiLocales = SUPPORTED_LOCALES;

/** Store the published canonical code, never a guessed language or default. */
export function canonicalUiLocale(value: unknown): UiLocale | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return locale(value)?.code as UiLocale | undefined;
  } catch {
    // Malformed inputs must remain refused even if the published alias lookup throws.
    return undefined;
  }
}

export function uiLocaleDescriptor(code: UiLocale) {
  return locale(code)!;
}

export const uiDirection = dir;
