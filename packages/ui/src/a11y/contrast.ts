/**
 * WCAG 2.2 contrast, measured at the worst pixel.
 *
 * axe-core does not sample backgrounds behind blur or images (it reports them
 * "incomplete"), and glass is exactly that: on the take-four prototype the
 * median text contrast was 9 to 16:1 but the worst pixel 3.0 to 4.3:1. So the
 * look gate hides the text, screenshots what is behind it, and asks this module
 * for the lowest ratio any backdrop pixel gives against the text colour.
 *
 * SC 1.4.3 needs 4.5:1 for body text and 3:1 for large text (24 px, or 18.67 px
 * bold); SC 1.4.11 needs 3:1 for a control's boundary and state. No rounding:
 * 4.499:1 fails.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Rgba extends Rgb {
  /** 0 to 1. */
  readonly a: number;
}

/** Minimum ratios, by what the colour is used for. */
export const CONTRAST_MIN = {
  /** SC 1.4.3, text under 24 px (18.67 px bold). */
  text: 4.5,
  /** SC 1.4.3, text at 24 px or more (18.67 px bold). */
  largeText: 3,
  /** SC 1.4.11, a control's boundary, a focus ring, an icon that carries meaning. */
  nonText: 3,
} as const;

export type ContrastUse = keyof typeof CONTRAST_MIN;

/** Large text by SC 1.4.3: 18 pt (24 px), or 14 pt (18.67 px) at weight 700 or more. */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= 24 || (fontSizePx >= 56 / 3 && fontWeight >= 700);
}

/** A CSS number such as "245" or "0.64", read digit by digit: the kit keeps parseFloat out of its source. */
function cssNumber(text: string): number {
  const [whole = '', frac = ''] = text.split('.');
  return parseInt(whole || '0', 10) + (frac ? parseInt(frac, 10) / 10 ** frac.length : 0);
}

/** A CSS number ("245", "0.64", ".5"); "." and "1.2.3" don't match, so they reach the one refusal below. */
const NUMBER = String.raw`(?:\d+(?:\.\d*)?|\.\d+)`;
const RGB_FUNCTION = new RegExp(String.raw`^rgba?\(\s*(${NUMBER})[\s,]+(${NUMBER})[\s,]+(${NUMBER})(?:\s*[,/]\s*(${NUMBER}%?))?\s*\)$`);

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` (comma or space syntax). Throws on anything else, out-of-range channels included. */
export function parseColor(input: string): Rgba {
  const text = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    const digits = hex[1] ?? '';
    const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
    const channel = (i: number): number => parseInt(full.slice(i, i + 2), 16);
    return { r: channel(0), g: channel(2), b: channel(4), a: full.length === 8 ? channel(6) / 255 : 1 };
  }
  const fn = RGB_FUNCTION.exec(text);
  if (fn) {
    const alphaText = fn[4];
    const alpha = alphaText === undefined ? 1 : alphaText.endsWith('%') ? cssNumber(alphaText.slice(0, -1)) / 100 : cssNumber(alphaText);
    const color = { r: cssNumber(fn[1] ?? '0'), g: cssNumber(fn[2] ?? '0'), b: cssNumber(fn[3] ?? '0'), a: alpha };
    const inRange = [color.r, color.g, color.b].every((c) => c >= 0 && c <= 255) && color.a >= 0 && color.a <= 1;
    if (inRange) return color;
  }
  throw new Error(`Not a colour this check reads: "${input}"`);
}

/** A translucent colour over an opaque one, in sRGB (what the browser paints). */
export function composite(top: Rgba, under: Rgb): Rgb {
  const mix = (t: number, u: number): number => t * top.a + u * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b) };
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function luminance(color: Rgb): number {
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function meetsContrast(ratio: number, use: ContrastUse): boolean {
  return ratio >= CONTRAST_MIN[use];
}

export interface WorstPixel {
  /** The lowest ratio found. */
  readonly ratio: number;
  /** Where, in the image's own pixels. */
  readonly x: number;
  readonly y: number;
  /** The backdrop colour there. */
  readonly backdrop: Rgb;
  /** Pixels read. */
  readonly sampled: number;
}

export interface PixelImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes a pixel, row by row (what a canvas or a decoded PNG gives). */
  readonly data: Uint8ClampedArray | Uint8Array;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The lowest contrast any backdrop pixel inside `box` gives against `text`.
 *
 * `image` is a screenshot taken with the text hidden (`color: transparent`)
 * so only what sits behind the glyphs is read. A translucent `text` colour is
 * composited over each pixel first, as the browser would paint it. Every
 * pixel counts: one bright glow behind one word fails the whole box.
 */
export function worstPixelContrast(text: Rgba, image: PixelImage, box?: Box): WorstPixel {
  if (box && ![box.x, box.y, box.width, box.height].every(Number.isFinite))
    throw new Error('The box has a measurement that is not a number');
  const x0 = Math.max(0, Math.floor(box?.x ?? 0));
  const y0 = Math.max(0, Math.floor(box?.y ?? 0));
  const x1 = Math.min(image.width, Math.ceil((box?.x ?? 0) + (box?.width ?? image.width)));
  const y1 = Math.min(image.height, Math.ceil((box?.y ?? 0) + (box?.height ?? image.height)));
  if (x1 <= x0 || y1 <= y0) throw new Error('The box holds no pixels of this image');

  let worst: WorstPixel | null = null;
  let sampled = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      const backdrop = { r: image.data[i] ?? 0, g: image.data[i + 1] ?? 0, b: image.data[i + 2] ?? 0 };
      const painted = text.a < 1 ? composite(text, backdrop) : text;
      const ratio = contrastRatio(painted, backdrop);
      sampled += 1;
      if (!worst || ratio < worst.ratio) worst = { ratio, x, y, backdrop, sampled: 0 };
    }
  }
  return { ...(worst as WorstPixel), sampled };
}
