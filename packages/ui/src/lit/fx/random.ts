/**
 * Seeded randomness for the light objects. Every object draws its points from this instead of `Math.random`, so the
 * same seed gives the same frame: screenshots repeat and the poster equals the first live frame.
 */
export type Rand = () => number;

/** mulberry32: small, fast, and good enough for scattering points. Returns numbers in [0, 1). */
export function seededRandom(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seed every object uses unless a caller passes its own. */
export const FX_SEED = 20261026;
