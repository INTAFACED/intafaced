import { z } from 'zod';

/**
 * Asset id (`USDC`, `BTC`): branded so an account id, a user id or any other
 * string cannot be passed where an asset id is wanted. The brand is type-only:
 * it accepts exactly what `z.string()` accepts. Chain any rule a field needs
 * (`assetIdSchema.min(1)`, `.regex(...)`); every `assetId` field starts here.
 */
export const assetIdSchema = z.string().brand<'AssetId'>();
export type AssetId = z.infer<typeof assetIdSchema>;

/**
 * The one way to name a string already known to be an asset id (a column read
 * from our own table, a configured fee asset, a constant) as an `AssetId`. It
 * parses with `assetIdSchema`, which accepts every string, so it never refuses
 * what the code passed before; it throws only on a value that was never a string.
 */
export function asAssetId(value: string): AssetId {
  return assetIdSchema.parse(value);
}
