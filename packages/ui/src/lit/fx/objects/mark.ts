import { Shape } from 'three';

/**
 * INTAFACED stand-in mark: three slanted panes stepping down (inter-face). Replaced by the brand kit's one vector path
 * when it arrives; the logo object and `markPath` both read it from here.
 */
export function markShapes(): Shape[] {
  const pane = (x: number, y: number, w: number, h: number, sl: number, r: number): Shape => {
    const sh = new Shape();
    const p: Array<[number, number]> = [
      [x, y],
      [x + w, y],
      [x + w + sl, y + h],
      [x + sl, y + h],
    ];
    sh.moveTo(p[0]![0] + r, p[0]![1]);
    for (let i = 0; i < 4; i++) {
      const a = p[(i + 1) % 4]!;
      const b = p[(i + 2) % 4]!;
      const pa = p[i]!;
      const da = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const dp = Math.hypot(a[0] - pa[0], a[1] - pa[1]);
      sh.lineTo(a[0] - ((a[0] - pa[0]) / dp) * r, a[1] - ((a[1] - pa[1]) / dp) * r);
      sh.quadraticCurveTo(a[0], a[1], a[0] + ((b[0] - a[0]) / da) * r, a[1] + ((b[1] - a[1]) / da) * r);
    }
    return sh;
  };
  return [pane(-0.62, -0.5, 0.34, 1.0, 0.3, 0.06), pane(-0.16, -0.5, 0.34, 0.72, 0.21, 0.06), pane(0.3, -0.5, 0.34, 0.42, 0.13, 0.06)];
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
