/**
 * Colour measures for the look's own checks and for the kit page, which prints them from the values the browser
 * resolved: WCAG 2 contrast and the CIEDE2000 colour difference. Pure; takes `#rrggbb` or `rgb()`/`rgba()` as a browser
 * reports it (an alpha below 1 is laid over `base`, black when none is given).
 */
type Rgb = readonly [number, number, number];
const rgbOf = (c: readonly number[]): Rgb => [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];

/** A plain decimal as a browser prints it in a colour ("12", "0.5", ".5"), read without float parsing of money's kind. */
const decimal = (text: string): number => {
  const [whole = '', fraction = ''] = text.split('.');
  return (whole ? parseInt(whole, 10) : 0) + (fraction ? parseInt(fraction, 10) / 10 ** fraction.length : 0);
};

export function parseColour(value: string, base?: string): Rgb {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return rgbOf([0, 2, 4].map((i) => parseInt((hex[1] ?? '').slice(i, i + 2), 16)));
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(v);
  if (!fn) throw new Error(`not a colour this reads: ${value}`);
  const rgb = rgbOf([fn[1], fn[2], fn[3]].map((c) => decimal(c ?? '0')));
  const a = fn[4] === undefined ? 1 : decimal(fn[4]) / (fn[5] ? 100 : 1);
  if (a >= 1) return rgb;
  const under: Rgb = base ? parseColour(base) : [0, 0, 0];
  return rgbOf(rgb.map((c, i) => Math.round(c * a + (under[i] ?? 0) * (1 - a))));
}

export function toHex(value: string, base?: string): string {
  return (
    '#' +
    parseColour(value, base)
      .map((c) => Math.round(c).toString(16).padStart(2, '0').toUpperCase())
      .join('')
  );
}

const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function luminance(value: string): number {
  const [r, g, b] = rgbOf(parseColour(value).map(linear));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function lab(value: string): Rgb {
  const [r, g, b] = rgbOf(parseColour(value).map(linear));
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 difference: about 2 is just noticeable; 20 and more reads as another colour. */
export function deltaE2000(a: string, b: string): number {
  const [L1, a1, b1] = lab(a);
  const [L2, a2, b2] = lab(b);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1 = (Math.atan2(b1, a1p) / rad + 360) % 360;
  const h2 = (Math.atan2(b2, a2p) / rad + 360) % 360;
  let dh = h2 - h1;
  if (Math.abs(dh) > 180) dh -= 360 * Math.sign(dh);
  const dL = L2 - L1;
  const dC = C2p - C1p;
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad);
  const Lm = (L1 + L2) / 2;
  const Cmp = (C1p + C2p) / 2;
  const hm = Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : (h1 + h2 + 360) / 2;
  const T =
    1 -
    0.17 * Math.cos((hm - 30) * rad) +
    0.24 * Math.cos(2 * hm * rad) +
    0.32 * Math.cos((3 * hm + 6) * rad) -
    0.2 * Math.cos((4 * hm - 63) * rad);
  const SL = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const SC = 1 + 0.045 * Cmp;
  const SH = 1 + 0.015 * Cmp * T;
  const RT = -2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

/** HSL hue in degrees (chartreuse sits near 70, lemon near 58, warning amber near 40). */
export function hue(value: string): number {
  const [r, g, b] = rgbOf(parseColour(value).map((c) => c / 255));
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const x = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (x * 60 + 360) % 360;
}
