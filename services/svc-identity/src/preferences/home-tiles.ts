/**
 * The account-level Home layout (`home.tiles`): the order of a person's Home tiles and the ones they hid.
 * The shape lives in `@intafaced/contracts/home-tiles-preferences` so the customer app and this door check the same record.
 * It is a view setting only: nothing here is read by an authorisation or a money path.
 */
import { HOME_TILES_NAMESPACE, homeTilesValueSchema, type HomeTilesValue } from '@intafaced/contracts/home-tiles-preferences';
import { PREFERENCES_VALUE_INVALID } from './trade-views.js';

export { HOME_TILES_NAMESPACE };
export type { HomeTilesValue };

/** Strict: an unknown field, a repeated id or an id outside the tile-id form is refused, never trimmed or guessed. */
export function parseHomeTiles(value: unknown): HomeTilesValue {
  const parsed = homeTilesValueSchema.safeParse(value);
  if (!parsed.success) {
    const error = new Error(PREFERENCES_VALUE_INVALID);
    (error as Error & { code: string }).code = PREFERENCES_VALUE_INVALID;
    throw error;
  }
  return parsed.data;
}
