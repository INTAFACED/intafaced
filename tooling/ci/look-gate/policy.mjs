/**
 * The look gate's rules, as pure functions the runner (look-gate.mjs) and its self-test share. Nothing here opens a
 * browser: contrast maths, the rendered-font verdict, the legal-slot verdict, and when a failure blocks a merge.
 */

/**
 * The gate reports and never blocks for two weeks from the day it lands (lane B0, 2026-10-26). From this date on, a
 * failing run blocks only a pull request that changes a path below.
 */
export const BLOCKING_FROM = '2026-11-09';

/** Paths whose change makes a failing look gate block, once BLOCKING_FROM has passed. */
export const BLOCKING_PATHS = [/^packages\/ui\/src\/lit\//, /(?:^|\/)look-baselines\//, /^packages\/ui\/src\/.*legal/i];

/** A migrated room is a folder under apps/customer/src/{screens,features}/ whose files import the lit kit. */
export function migratedRoomOf(path, importsLit) {
  const m = /^(apps\/customer\/src\/(?:screens|features)\/[^/]+)\//.exec(path);
  return m && importsLit(m[1]) ? m[1] : null;
}

/**
 * Whether this run's failures block. `failures` counts only blockable ones: those on the kit gallery and on pages that
 * render the new look (`[data-look="lit"]`) or a legal slot, so an old room's known debt never blocks a kit change.
 * 'report' before BLOCKING_FROM, or when the pull request changes no blocking path.
 */
export function verdict({ failures, changed, today, importsLit = () => false }) {
  if (failures === 0) return { mode: 'pass', blocking: [] };
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
  for (let i = 0; i < pixels.length; i += 4) {
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

/** The exact text a registry entry renders, or null when the wording is not fixed (lawyer, not applicable). */
export function legalText(entry, region) {
  const wording = entry?.[region];
  if (!wording || wording.status !== 'fixed') return null;
  return wording.runs.map((r) => r.text).join('');
}

/** Whether rendered text is the registry wording, a `{placeholder}` standing for any filled-in value. */
export function legalMatches(rendered, wording) {
  const parts = squash(wording).split(/\{\w+\}/);
  const re = new RegExp(`^${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\S.*?')}$`);
  return re.test(squash(rendered));
}

/** Collapse whitespace the way rendered text does, for comparing a slot's text with its registry wording. */
export const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * The legal-slot verdict for one slot measured in the page (see look-gate.mjs `measureLegal`). RULES-AND-TRUST
 * section B: the exact registry wording, at least body size, bold, an opaque background with no blur or
 * transparency anywhere above it, pinned to the top, contrast 4.5:1, never clipped. A refused slot (wording unset)
 * only has to be visible and unclipped.
 */
export function judgeLegal(slot, registry, { bodySize = 16 } = {}) {
  const out = [];
  const region = slot.jurisdiction || 'uk';
  const entry = registry?.[slot.key];
  if (!entry) out.push(`no registry entry "${slot.key}"`);
  if (slot.clipped) out.push('clipped');
  if (!slot.visible) out.push('not visible');
  if (slot.missing) return out;
  const want = entry ? legalText(entry, region) : null;
  if (entry && want === null)
    out.push(`registry wording for ${region} is ${entry[region]?.status ?? 'missing'}, so the slot must show its refusal`);
  if (want !== null && !legalMatches(slot.text, want)) out.push(`text differs from the registry: "${squash(slot.text).slice(0, 80)}"`);
  if (slot.fontSize < bodySize) out.push(`font ${slot.fontSize}px is below body size ${bodySize}px`);
  if ((slot.type || entry?.type) === 'risk-band') {
    if (!slot.bold) out.push(`weight ${slot.fontWeight} is not bold`);
    if (!slot.opaque) out.push(`background not opaque: ${slot.opaqueWhy}`);
    if (!slot.pinnedTop) out.push(`not sticky or fixed at the top (${slot.position}, top ${slot.top})`);
  }
  if (slot.contrast !== null && slot.contrast < 4.5) out.push(`worst-pixel contrast ${slot.contrast.toFixed(2)} < 4.5`);
  return out;
}

/**
 * Compare two same-sized RGBA images. A pixel differs when any channel moves by more than `tolerance`; the images
 * match only when no pixel differs (both come from the one pinned image, so rendering is deterministic).
 */
export function pixelDiff(a, b, { width, height }, tolerance = 2) {
  if (a.length !== b.length || a.length !== width * height * 4) return { sizeChanged: true, differing: width * height };
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i] - b[i]) > tolerance ||
      Math.abs(a[i + 1] - b[i + 1]) > tolerance ||
      Math.abs(a[i + 2] - b[i + 2]) > tolerance ||
      Math.abs(a[i + 3] - b[i + 3]) > tolerance
    )
      differing++;
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
