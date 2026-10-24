/**
 * The account-level view record (`ui.view`): how a person likes the app to look, saved on the account so a second device shows
 * the same choice. It is a view setting only: it never changes data, prices, permissions or what an action does, and the
 * server authorises every call from the signed principal, never from this record.
 *
 * Stored through the identity preferences door (`preferences.get` / `preferences.set`, compare-and-set on `version`). Every
 * field is optional so a record written by an older build still reads; an unknown field is refused (the record is strict).
 * Nothing here carries a default: a missing field means the person has not chosen, and each screen keeps its own shipped default.
 */
import { z } from 'zod';

export const UI_VIEW_NAMESPACE = 'ui.view' as const;

export const UI_LAYOUT_MODES = ['simple', 'pro'] as const;
export const UI_THEMES = ['dark', 'light', 'system'] as const;
/**
 * USD is the base and BTC is priced from the same book. EUR and GBP are offered because the ledger knows them as fiat, but the
 * platform has no exchange-rate source yet: the bank refuses them (`bank.fx_rate_unset`) and the screens keep USD and say so.
 */
export const UI_DISPLAY_CURRENCIES = ['USD', 'BTC', 'EUR', 'GBP'] as const;
export type UiDisplayCurrency = (typeof UI_DISPLAY_CURRENCIES)[number];

/** `personal`, or `business:<id>` for a business the person is a member of (checked against real memberships by the screen). */
export const UI_ACTIVE_PROFILE_PATTERN = /^(personal|business:[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;

export const uiViewValueSchema = z
  .object({
    layoutMode: z.enum(UI_LAYOUT_MODES).optional(),
    hideBalances: z.boolean().optional(),
    displayCurrency: z.enum(UI_DISPLAY_CURRENCIES).optional(),
    theme: z.enum(UI_THEMES).optional(),
    activeProfile: z.string().regex(UI_ACTIVE_PROFILE_PATTERN).optional(),
  })
  .strict();
export type UiViewValue = z.infer<typeof uiViewValueSchema>;

export const uiViewPreferenceSchema = z
  .object({ namespace: z.literal(UI_VIEW_NAMESPACE), version: z.number().int(), value: uiViewValueSchema.nullable() })
  .strict();
export type UiViewPreference = z.infer<typeof uiViewPreferenceSchema>;

/**
 * The client request id of a write: a business key, never random. One id per (person, version read), so a retry of the same
 * write after a lost reply returns the first stored result, and a write after another device changed the record uses a new id.
 */
export function uiViewRequestId(userId: string, ifVersion: number): string {
  return `ui-view:${userId.toLowerCase()}:${ifVersion}`;
}
