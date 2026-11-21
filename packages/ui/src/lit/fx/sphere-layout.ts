/**
 * Where the sphere's segments sit on screen, without three.js: the page labels them before (and without) the 3D,
 * so the poster tier gets the same callouts as the live object. Kept in step with objects/sphere.ts, which imports
 * SPHERE_SPAN from here; sphere-layout.test.ts checks the projection against three's camera.
 */

/** The lit crescent runs from -SPAN to +SPAN radians around the bottom of the sphere. */
export const SPHERE_SPAN = 1.2;
/** objects/sphere.ts's camera: vertical field of view in degrees, and its default distance. */
const FOV = 30;
const DIST = 5.4;

/** Whole percents (from decimal shares, summing to 100) as the fractions the sphere draws. */
export function sharesFromPercents(percents: readonly bigint[]): number[] {
  return percents.map((p) => Number(p) / 100);
}

/** The point a segment's label points at: the middle of the segment, on the lit rim facing the camera. */
export function sphereCallouts(
  shares: readonly number[],
  width: number,
  height: number,
  options: { dist?: number; y?: number } = {},
): Array<[number, number]> {
  const dist = options.dist ?? DIST;
  const f = 1 / Math.tan(((FOV / 2) * Math.PI) / 180);
  const aspect = width / height;
  let c = 0;
  return shares.map((share) => {
    const a = -SPHERE_SPAN + (c + share / 2) * 2 * SPHERE_SPAN;
    c += share;
    const x0 = Math.sin(a) * 0.93;
    const y0 = -Math.cos(a) * 0.93;
    const z0 = 0.37;
    const n = Math.hypot(x0, y0, z0);
    const [x, y, z] = [x0 / n, y0 / n + (options.y ?? 0), z0 / n];
    const depth = dist - z;
    const ndcX = (x * f) / aspect / depth;
    const ndcY = (y * f) / depth;
    return [(ndcX * 0.5 + 0.5) * width, (-ndcY * 0.5 + 0.5) * height];
  });
}
