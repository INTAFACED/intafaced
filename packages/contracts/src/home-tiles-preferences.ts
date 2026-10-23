/**
 * The account-level Home layout (`home.tiles`, HM-widgets-01): which Home tiles a person hides and the order they put them
 * in, saved on the account so a second device shows the same Home. It is a view choice only: hiding a tile removes no room,
 * route or control, and the tile can always be switched back on.
 *
 * Stored through the identity preferences door (`preferences.get` / `preferences.set`, compare-and-set on `version`). The
 * customer app names the tiles; this record only holds ids, so an id the app no longer has is ignored there, never an error.
 * Nothing here carries a default: an empty record means the person has not chosen, and Home shows its shipped order.
 */
import { z } from 'zod';

export const HOME_TILES_NAMESPACE = 'home.tiles' as const;

/** Most tiles a stored layout may name. */
export const HOME_TILES_MAX = 40;

const tileId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'tile id');
const uniqueIds = z
  .array(tileId)
  .max(HOME_TILES_MAX)
  .refine((ids) => new Set(ids).size === ids.length, 'each tile once');

export const homeTilesValueSchema = z
  .object({
    /** The person's order, first to last. Tiles not named keep their shipped place after these. */
    order: uniqueIds,
    /** Tiles the person hid. */
    hidden: uniqueIds,
  })
  .strict();
export type HomeTilesValue = z.infer<typeof homeTilesValueSchema>;

export const homeTilesPreferenceSchema = z
  .object({ namespace: z.literal(HOME_TILES_NAMESPACE), version: z.number().int(), value: homeTilesValueSchema.nullable() })
  .strict();
export type HomeTilesPreference = z.infer<typeof homeTilesPreferenceSchema>;

/**
 * The client request id of a write: a business key, never random. One id per (person, version read, layout written), so a
 * retry after a lost reply returns the first stored result, while a different layout written by another device at the same
 * version gets its own id and meets a version conflict instead of another write's receipt.
 */
export function homeTilesRequestId(userId: string, ifVersion: number, value: HomeTilesValue): string {
  return `home-tiles:${userId.toLowerCase()}:${ifVersion}:${layoutDigest(value)}`;
}

/** A short, stable digest of a layout (FNV-1a, 64 bits), so the id stays well under the 200 characters the door allows. */
function layoutDigest(value: HomeTilesValue): string {
  const text = `${value.order.join(',')}|${value.hidden.join(',')}`;
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}
