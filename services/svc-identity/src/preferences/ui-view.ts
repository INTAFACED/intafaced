/**
 * The account-level view record (`ui.view`): layout mode, hide balances, display currency, theme and the active profile.
 * The shape lives in `@intafaced/contracts/ui-view-preferences` so the customer app and this door check the same record.
 * It is a view setting only: nothing here is read by an authorisation or a money path.
 */
import { UI_VIEW_NAMESPACE, uiViewValueSchema, type UiViewValue } from '@intafaced/contracts/ui-view-preferences';
import { PREFERENCES_VALUE_INVALID } from './trade-views.js';

export { UI_VIEW_NAMESPACE };
export type { UiViewValue };

function invalid(): never {
  const error = new Error(PREFERENCES_VALUE_INVALID);
  (error as Error & { code: string }).code = PREFERENCES_VALUE_INVALID;
  throw error;
}

/** Strict: an unknown field, a wrong type or a value outside the lists is refused, never trimmed or guessed. */
export function parseUiView(value: unknown): UiViewValue {
  const parsed = uiViewValueSchema.safeParse(value);
  if (!parsed.success) return invalid();
  return parsed.data;
}
