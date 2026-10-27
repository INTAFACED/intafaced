/**
 * The look gate's rules, as pure functions the runner (look-gate.mjs) and its self-test share. Nothing here opens a
 * browser: contrast maths, the rendered-font verdict, and when a failure blocks a merge.
 */

/**
 * The gate reports and never blocks for two weeks from the day it lands (lane B0, 2026-10-26). From this date on, a
 * failing run blocks only a pull request that changes a path below.
 */
export const BLOCKING_FROM = '2026-11-09';

/** Paths whose change makes a failing look gate block, once BLOCKING_FROM has passed. */
export const BLOCKING_PATHS = [/^packages\/ui\/src\/lit\//, /(?:^|\/)look-baselines\//];

/** A migrated room is a folder under apps/customer/src/{screens,features}/ whose files import the lit kit. */
export function migratedRoomOf(path, importsLit) {
  const m = /^(apps\/customer\/src\/(?:screens|features)\/[^/]+)\//.exec(path);
  return m && importsLit(m[1]) ? m[1] : null;
}

/**
 * Whether this run's failures block. `failures` counts only blockable ones: those on the kit gallery and on pages that
 * render the new look (`[data-look="lit"]`), so an old room's known debt never blocks a kit change.
 * 'report' before BLOCKING_FROM, or when the pull request changes no blocking path.
 */
export function verdict({ failures, changed, today, importsLit = () => false }) {
  if (failures === 0) return { mode: 'pass', blocking: [] };
  // The changed paths could not be read (no base to diff against): never a silent pass once the gate blocks.
  if (changed === null)
    return today < BLOCKING_FROM
      ? { mode: 'report', why: `report-only until ${BLOCKING_FROM}; the changed paths could not be read`, blocking: [] }
      : { mode: 'block', why: 'the changed paths could not be read, so every failure counts', blocking: [] };
  const blocking = changed.filter((f) => BLOCKING_PATHS.some((re) => re.test(f)) || migratedRoomOf(f, importsLit));
  if (today < BLOCKING_FROM) return { mode: 'report', why: `report-only until ${BLOCKING_FROM}`, blocking };
  if (blocking.length === 0) return { mode: 'report', why: 'no blocking path changed', blocking };
  return { mode: 'block', blocking };
}

/** WCAG relative luminance of an sRGB colour given as 0-255 channels. */
export function luminance([r, g, b]) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two opaque colours. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The text colour over one background pixel, when the text colour has alpha below 1. */
export function over([r, g, b, a], [br, bg, bb]) {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}

/** WCAG 2.2 AA minimum for text: 3 for large text (24px, or 18.66px bold), 4.5 otherwise. */
export function minimumFor({ fontSize, fontWeight }) {
  return fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700) ? 3 : 4.5;
}

/**
 * The worst contrast of one text box against every background pixel under it (the shot taken with all text hidden).
 * `pixels` is a flat RGBA array; returns { ratio, at } where `at` is the worst pixel's [r,g,b].
 */
export function worstContrast(text, pixels) {
  let worst = { ratio: Infinity, at: null };
  const seen = new Set();
  for (let i = 0; i < pixels.length; i += 4) {
    // Glass is many pixels of few colours: each colour is judged once.
    const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    if (seen.has(key)) continue;
    seen.add(key);
    const bg = [pixels[i], pixels[i + 1], pixels[i + 2]];
    const fg = text[3] === undefined || text[3] >= 1 ? text.slice(0, 3) : over(text, bg);
    const ratio = contrast(fg, bg);
    if (ratio < worst.ratio) worst = { ratio, at: bg };
  }
  return worst;
}

/** The first family of a computed font-family list, unquoted. */
export function firstFamily(fontFamily) {
  return (
    String(fontFamily ?? '')
      .split(',')[0]
      ?.trim()
      .replace(/^['"]|['"]$/g, '') ?? ''
  );
}

/**
 * The rendered-font verdict for one text node. A Geist→Arial swap, a font the policy blocked, or a font file that never
 * loaded all fail: the first declared family must be a web font the page declares (@font-face), and every glyph must
 * come from a web font, never a system fallback.
 * @param {{ fontFamily: string, declared: string[], platform: {familyName: string, isCustomFont: boolean, glyphCount: number}[] }} n
 */
export function judgeFont({ fontFamily, declared, platform }) {
  const first = firstFamily(fontFamily);
  const known = new Set(declared.map((f) => f.toLowerCase()));
  if (!known.has(first.toLowerCase()))
    return `first family "${first}" is not a web font the kit loads (${[...known].join(', ') || 'none loaded'})`;
  const fallback = platform.filter((p) => !p.isCustomFont && p.glyphCount > 0);
  if (fallback.length > 0)
    return `rendered in ${fallback.map((p) => `${p.familyName} (${p.glyphCount} glyphs)`).join(', ')} instead of ${first}`;
  if (platform.length === 0) return 'no glyphs were rendered';
  return null;
}

/**
 * Compare two same-sized RGBA images. A pixel differs when any channel moves by more than `tolerance`; the images
 * match only when no pixel differs (both come from the one pinned image, so rendering is deterministic).
 */
export function pixelDiff(a, b, { width, height }, tolerance = 2, mark = null) {
  if (a.length !== b.length || a.length !== width * height * 4) return { sizeChanged: true, differing: width * height };
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i] - b[i]) > tolerance ||
      Math.abs(a[i + 1] - b[i + 1]) > tolerance ||
      Math.abs(a[i + 2] - b[i + 2]) > tolerance ||
      Math.abs(a[i + 3] - b[i + 3]) > tolerance
    ) {
      differing++;
      // `mark`, a copy of the new shot, gets every differing pixel painted for the diff image.
      if (mark) mark.set([255, 0, 80, 255], i);
    }
  }
  return { sizeChanged: false, differing };
}

/** A seeded random number generator (mulberry32), installed in the page in place of Math.random. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
