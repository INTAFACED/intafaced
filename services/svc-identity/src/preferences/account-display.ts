/**
 * Display language and display currency, saved on the account so a second device shows the same choice.
 * The language must be one the i18n catalogue ships. The currency must be one the owner lists
 * (IDENTITY_DISPLAY_CURRENCIES); an empty list means only "no choice", which shows USD.
 */
import { z } from 'zod';
import { locale } from '@intafaced/i18n/locales';
import { PREFERENCES_VALUE_INVALID } from './trade-views.js';

export const ACCOUNT_DISPLAY_NAMESPACE = 'account.display' as const;

export type AccountDisplayValue = { locale: string | null; displayCurrency: string | null };

const shape = z
  .object({
    locale: z.string().min(1).max(32).nullable(),
    displayCurrency: z.string().min(1).max(10).nullable(),
  })
  .strict();

function invalid(): never {
  const error = new Error(PREFERENCES_VALUE_INVALID);
  (error as Error & { code: string }).code = PREFERENCES_VALUE_INVALID;
  throw error;
}

/** Stores the canonical catalogue code, never an alias or a guess. */
export function parseAccountDisplay(value: unknown, listedCurrencies: readonly string[]): AccountDisplayValue {
  const parsed = shape.safeParse(value);
  if (!parsed.success) return invalid();
  const canonical = parsed.data.locale === null ? null : (locale(parsed.data.locale)?.code ?? null);
  if (parsed.data.locale !== null && canonical === null) return invalid();
  const currency = parsed.data.displayCurrency;
  if (currency !== null && !listedCurrencies.includes(currency)) return invalid();
  return { locale: canonical, displayCurrency: currency };
}

/** Comma-separated ISO-style codes from the owner. Blank lists nothing. */
export function parseDisplayCurrencyList(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const codes = raw.split(',').map((code) => code.trim().toUpperCase());
  if (codes.some((code) => !/^[A-Z]{3,10}$/.test(code)))
    throw new Error('IDENTITY_DISPLAY_CURRENCIES must be comma-separated currency codes');
  return [...new Set(codes)];
}
