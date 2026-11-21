import { Shape } from 'three';
import { BRAND_GEOMETRY } from '../../../brand/geometry.generated.js';

/**
 * The INTAFACED mark (the kit's eight-blade aperture, master drawing) as three.js shapes, one per blade, centred and
 * one unit across with y up. The geometry is the brand set's (`../../../brand/geometry.generated.ts`), so the 3D logo
 * follows a kit swap.
 */
export function markShapes(): Shape[] {
  return BRAND_GEOMETRY.mark.master
    .split('Z')
    .map((blade) => blade.replace('M', '').trim())
    .filter(Boolean)
    .map((blade) => {
      const points = blade.split(/\s*L\s*/).map((p) => p.trim().split(/\s+/).map(Number) as [number, number]);
      const sh = new Shape();
      points.forEach(([x, y], i) => {
        const px = (x - 500) / 1000;
        const py = (500 - y) / 1000;
        if (i === 0) sh.moveTo(px, py);
        else sh.lineTo(px, py);
      });
      sh.closePath();
      return sh;
    });
}

export function roundedRect(s: number, r: number): Shape {
  const sh = new Shape();
  const h = s / 2;
  sh.moveTo(-h + r, -h);
  sh.lineTo(h - r, -h);
  sh.quadraticCurveTo(h, -h, h, -h + r);
  sh.lineTo(h, h - r);
  sh.quadraticCurveTo(h, h, h - r, h);
  sh.lineTo(-h + r, h);
  sh.quadraticCurveTo(-h, h, -h, h - r);
  sh.lineTo(-h, -h + r);
  sh.quadraticCurveTo(-h, -h, -h + r, -h);
  return sh;
}
