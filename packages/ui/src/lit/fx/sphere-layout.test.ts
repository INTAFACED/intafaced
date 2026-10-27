import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { SPHERE_SPAN, sharesFromPercents, sphereCallouts } from './sphere-layout.js';

describe('sphere callouts', () => {
  it("match three's projection of the segment middles at t = 0", () => {
    const [w, h, dist, y] = [390, 260, 5.9, 0.02];
    const shares = sharesFromPercents([41n, 30n, 19n, 10n]);
    const camera = new PerspectiveCamera(30, w / h, 0.1, 100);
    camera.position.set(0, 0, dist);
    camera.updateMatrixWorld();
    let c = 0;
    const expected = shares.map((share) => {
      const a = -SPHERE_SPAN + (c + share / 2) * 2 * SPHERE_SPAN;
      c += share;
      const v = new Vector3(Math.sin(a) * 0.93, -Math.cos(a) * 0.93, 0.37).normalize();
      v.y += y;
      v.project(camera);
      return [(v.x * 0.5 + 0.5) * w, (-v.y * 0.5 + 0.5) * h];
    });
    const got = sphereCallouts(shares, w, h, { dist, y });
    got.forEach(([px, py], i) => {
      expect(px).toBeCloseTo(expected[i]![0]!, 6);
      expect(py).toBeCloseTo(expected[i]![1]!, 6);
    });
  });

  it('turns whole percents into fractions that add up to 1', () => {
    expect(sharesFromPercents([59n, 41n])).toEqual([0.59, 0.41]);
  });
});
