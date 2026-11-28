import { layered } from './layered.js';

/**
 * A test's stand-in class with `layers` applied (layered.ts): `layeredStandIn(Door, withVenueHaltPlace)` is a subclass
 * of `Door` carrying the layer, typed as `Door` so the test keeps calling what its stand-in declares. A stand-in has only
 * the members the layer reads, so it is no `typeof TradeService`; the two casts sit here once instead of in each test.
 */
export function layeredStandIn<S, B>(standIn: S, ...layers: ReadonlyArray<(c: B) => B>): S {
  return layered(standIn as unknown as B, ...layers) as unknown as S;
}
