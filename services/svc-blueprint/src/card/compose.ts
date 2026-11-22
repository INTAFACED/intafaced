import type { BlueprintProfile, CardSize } from '@intafaced/contracts';
import { CARD_DIMENSIONS } from '@intafaced/contracts/blueprint';
import { color, font } from '@intafaced/ui/tokens';
import { assertZeroPiiSurface } from '../attestations/zero-pii.js';

/**
 * THE SHARE CARD (§7.1, §7.2).
 *
 * §7.1 calls this "the acquisition artifact, treat it as a product", and §7.2
 * makes it an exit criterion: "Card renders pixel-perfect at share sizes
 * (1080×1350, 1200×630); no third-party system names anywhere in output".
 *
 * This file is the whole card. It is a **pure function**: profile and crew in,
 * SVG out. No clock, no randomness, no network, no database. That is not
 * fastidiousness — it is what makes every claim below testable:
 *
 *   · "pixel-perfect at 1080×1350" is an assertion about two integers in the
 *     output, not about what a rasterizer felt like doing.
 *   · "no third-party system names anywhere in output" is a copy-scan over a
 *     string this process produced, which is why `brand.test.ts` — which walks
 *     every file in this package — is a real check on the shipped artifact and
 *     not merely on the source that builds it.
 *   · The same Blueprint always yields a byte-identical card, so re-sharing is
 *     idempotent and a diff in CI means somebody changed the design.
 *
 * ── Why SVG, when §7.1 says PNG ─────────────────────────────────────────────
 *
 * §7.1 names the vendor path — a rasterizer, then a PNG. Doctrine §0.4 makes
 * that rasterizer a *rail*: an adapter, behind an interface, that the platform
 * "never depends on to function". So the split is deliberate:
 *
 *   composition (this file)  = ours, always works, needs nothing
 *   rasterization (adapter)  = external, may be absent, refuses loudly
 *
 * The SVG is not a preview or a fallback. It is a complete, resolution-
 * independent card that a user can download, print, or post. What needs the
 * rasterizer is a *hosted PNG* at a URL, because that is what a social platform
 * fetches for an unfurl — and when there is no renderer we say so rather than
 * inventing a URL.
 *
 * ── What is deliberately NOT on this card ───────────────────────────────────
 *
 * **No personal data. None.** No name, no handle, no avatar, no birth data, no
 * user id, no dates that could pin a person down. Everything drawn here is
 * either derived by the Neural Engine (the five axes) or a crew's public name.
 *
 * That is a design decision with two consequences worth stating, because both
 * are the reason for it:
 *
 *  1. A card carrying no personal data is safe to make public by default. The
 *     acquisition artifact is the one object in this service explicitly meant to
 *     leave it, and §10 isolation is much easier to guarantee for a thing that
 *     never had anything to isolate.
 *
 *  2. It is unspoofable-by-omission. A card with a caller-supplied display name
 *     would be a public image endpoint that renders arbitrary text in INTAFACED
 *     branding — which is a defacement surface, not a share feature. Whether
 *     users may put their own name on a card is a product call with an abuse
 *     dimension, and it belongs to the owner, not to this file.
 */

/** Everything the card draws. Nothing here is user-typed. */
export interface CardSubject {
  readonly profile: BlueprintProfile;
  /**
   * The crew's name — derived from its id in `matching/crew-matching.ts`, from a
   * fixed vocabulary. Never free text, which is why it is safe on a public
   * artifact. Null when the user has not been placed.
   */
  readonly crewName: string | null;
  readonly season: number | null;
}

/**
 * Human-readable labels for the enum values.
 *
 * The engine returns machine tokens (`hands_on`); a card is read by a person.
 * Kept here rather than in an i18n catalogue on purpose: this is the ONE
 * artifact whose text is baked into an image at compose time, so it cannot be
 * re-rendered per viewer the way a page can. Localising it is a real feature
 * (`infra.i18n`), not a `t()` call — the layout has to survive longer strings —
 * and pretending otherwise by wiring a lookup that only ever returns English
 * would make the card *look* localised in the code and never be.
 */
const AXIS_LABELS: Readonly<Record<string, string>> = {
  analytical: 'Analytical',
  intuitive: 'Intuitive',
  collaborative: 'Collaborative',
  decisive: 'Decisive',

  guarded: 'Guarded',
  measured: 'Measured',
  assertive: 'Assertive',
  bold: 'Bold',

  dawn: 'Dawn',
  steady: 'Steady',
  surge: 'Surge',
  nocturnal: 'Nocturnal',

  visual: 'Visual',
  narrative: 'Narrative',
  hands_on: 'Hands-on',
  systematic: 'Systematic',

  anchor: 'Anchor',
  scout: 'Scout',
  builder: 'Builder',
  catalyst: 'Catalyst',

  foundations: 'Foundations',
  markets: 'Markets',
  sovereign: 'Sovereign',

  direct: 'Direct',
  warm: 'Warm',
  socratic: 'Socratic',
  terse: 'Terse',
};

/**
 * Label an enum token, falling back to the token itself.
 *
 * The fallback is not laziness: `curriculumPath` and `crewRole` share the value
 * `builder`, and a future axis may add a value before this table does. Drawing
 * the raw token is ugly; drawing nothing, or throwing while rendering someone's
 * card, is worse. `compose.test.ts` asserts the table covers every value the
 * contract currently allows, so the fallback stays unreachable in practice.
 */
function label(token: string): string {
  return AXIS_LABELS[token] ?? token;
}

/**
 * XML text escaping.
 *
 * Every string that reaches the SVG goes through here, without exception —
 * including the ones that "cannot" contain a special character. The card is a
 * public artifact assembled by string concatenation, which is the exact shape
 * of an injection bug, and the defence has to be structural rather than a
 * per-call judgement about whether today's input is trusted.
 *
 * Both quote forms are escaped as well as the three XML criticals, because this
 * output is also interpolated into attribute values.
 */
export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * The brand, read from the design system rather than restated.
 *
 * `packages/ui/src/tokens.ts` says it plainly: "nothing hard-codes a hex outside
 * this file. A colour that is not here does not exist in the product." An
 * acquisition artifact is the last place to invent one — a card whose orange is
 * a shade off is a card that looks like someone else's product.
 *
 * The `/tokens` subpath export carries no React import; `primitives.tsx` is a
 * separate entry point and is never loaded by this service.
 */
const PALETTE = {
  base: color.base,
  surface: color.surface,
  raised: color.surfaceRaised,
  accent: color.accent,
  accentBright: color.accentBright,
  glow: color.accentGlow,
  border: color.borderStrong,
  text: color.text,
  muted: color.textMuted,
  onAccent: color.textOnAccent,
} as const;

/**
 * The font stacks, taken from the same tokens.
 *
 * A rasterizer resolves these against the fonts it actually has. The brand
 * display face may not be one of them, which is why the token stacks end in
 * `system-ui` / `sans-serif` — the card degrades to a system face rather than to
 * nothing. Font provisioning is the renderer's job and is called out in the
 * adapter; it is not something this file can assert.
 */
const FONT_DISPLAY = font.display;
const FONT_BODY = font.body;

/** The five axes, in the order §7.1 lists them. */
function axisRows(profile: BlueprintProfile): ReadonlyArray<{ label: string; value: string }> {
  return [
    { label: 'Decision', value: label(profile.decisionStyle) },
    { label: 'Risk', value: label(profile.riskTemperament) },
    { label: 'Rhythm', value: label(profile.energyRhythm) },
    { label: 'Learning', value: label(profile.learningMode) },
    { label: 'Path', value: label(profile.curriculumPath) },
  ];
}

/**
 * Shared definitions: the background wash and the grid.
 *
 * Ids are namespaced (`ifc-`) because a card is frequently inlined into a page
 * next to other SVGs, and SVG ids are document-global — an unprefixed `grid`
 * would be a live collision with whatever else on the page also called
 * something `grid`, and the symptom is one image silently adopting another's
 * gradient.
 */
function defs(width: number, height: number): string {
  return [
    '<defs>',
    `<radialGradient id="ifc-glow" cx="50%" cy="0%" r="85%">`,
    `<stop offset="0%" stop-color="${PALETTE.accent}" stop-opacity="0.28"/>`,
    `<stop offset="60%" stop-color="${PALETTE.accent}" stop-opacity="0.05"/>`,
    `<stop offset="100%" stop-color="${PALETTE.base}" stop-opacity="0"/>`,
    '</radialGradient>',
    `<linearGradient id="ifc-rule" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0%" stop-color="${PALETTE.accent}"/>`,
    `<stop offset="100%" stop-color="${PALETTE.accent}" stop-opacity="0"/>`,
    '</linearGradient>',
    '<pattern id="ifc-grid" width="60" height="60" patternUnits="userSpaceOnUse">',
    `<path d="M60 0H0V60" fill="none" stroke="${PALETTE.border}" stroke-width="1"/>`,
    '</pattern>',
    '</defs>',
    `<rect width="${width}" height="${height}" fill="${PALETTE.base}"/>`,
    `<rect width="${width}" height="${height}" fill="url(#ifc-grid)"/>`,
    `<rect width="${width}" height="${height}" fill="url(#ifc-glow)"/>`,
  ].join('');
}

function text(
  content: string,
  attrs: { x: number; y: number; size: number; fill: string; family?: string; weight?: number; spacing?: number; anchor?: string },
): string {
  const parts = [
    `x="${attrs.x}"`,
    `y="${attrs.y}"`,
    `font-family="${escapeXml(attrs.family ?? FONT_BODY)}"`,
    `font-size="${attrs.size}"`,
    `fill="${attrs.fill}"`,
  ];
  if (attrs.weight !== undefined) parts.push(`font-weight="${attrs.weight}"`);
  if (attrs.spacing !== undefined) parts.push(`letter-spacing="${attrs.spacing}"`);
  if (attrs.anchor !== undefined) parts.push(`text-anchor="${attrs.anchor}"`);
  return `<text ${parts.join(' ')}>${escapeXml(content)}</text>`;
}

/** The crew line, or an honest absence. A blank space would read as a bug. */
function crewLine(subject: CardSubject): string {
  if (!subject.crewName) return 'Unplaced';
  return subject.season === null ? subject.crewName : `${subject.crewName} · Season ${subject.season}`;
}

/**
 * PORTRAIT — 1080×1350. The feed and story canvas, and the primary artifact.
 *
 * Laid out on a 90px margin with the crew role as the hero. Coordinates are
 * literals rather than a layout engine: there are two canvases, both fixed, and
 * a solver would add a dependency and a class of bug (a reflow nobody looked at)
 * in exchange for flexibility this card does not want.
 */
function portrait(subject: CardSubject): string {
  const { width, height } = CARD_DIMENSIONS.portrait;
  const margin = 90;
  const rows = axisRows(subject.profile);

  const axes = rows
    .map((row, index) => {
      const y = 700 + index * 108;
      return [
        `<rect x="${margin}" y="${y - 52}" width="${width - margin * 2}" height="84" rx="14" fill="${PALETTE.raised}" stroke="${PALETTE.border}"/>`,
        text(row.label.toUpperCase(), { x: margin + 32, y, size: 26, fill: PALETTE.muted, weight: 600, spacing: 3 }),
        text(row.value, {
          x: width - margin - 32,
          y,
          size: 38,
          fill: PALETTE.text,
          family: FONT_DISPLAY,
          weight: 700,
          anchor: 'end',
        }),
      ].join('');
    })
    .join('');

  return [
    defs(width, height),

    // Eyebrow — the product name, in the approved vocabulary (§0.7).
    text('IDENTITY BLUEPRINT', { x: margin, y: 150, size: 30, fill: PALETTE.accent, weight: 700, spacing: 10 }),
    `<rect x="${margin}" y="182" width="${width - margin * 2}" height="3" fill="url(#ifc-rule)"/>`,

    // Hero — the crew role. The one word a person shares this card to say.
    text(label(subject.profile.crewRole).toUpperCase(), {
      x: margin,
      y: 400,
      size: 168,
      fill: PALETTE.text,
      family: FONT_DISPLAY,
      weight: 800,
      spacing: -2,
    }),
    text(crewLine(subject), { x: margin, y: 470, size: 38, fill: PALETTE.accentBright, weight: 600 }),

    // Tone register, as a chip. svc-agents reads this field; the card shows the
    // user the same thing their agent was told about how to speak to them.
    `<rect x="${margin}" y="530" width="330" height="66" rx="33" fill="${PALETTE.glow}" stroke="${PALETTE.accent}"/>`,
    text(`${label(subject.profile.toneRegister)} voice`, { x: margin + 40, y: 574, size: 32, fill: PALETTE.accentBright, weight: 600 }),

    axes,

    // Footer — the wordmark and the second approved term.
    `<rect x="${margin}" y="${height - 190}" width="${width - margin * 2}" height="1" fill="${PALETTE.border}"/>`,
    text('INTAFACED', { x: margin, y: height - 120, size: 46, fill: PALETTE.text, family: FONT_DISPLAY, weight: 800, spacing: 8 }),
    text('Sovereign Intelligence', { x: margin, y: height - 72, size: 28, fill: PALETTE.muted }),
    text('Built by the Neural Engine', {
      x: width - margin,
      y: height - 72,
      size: 26,
      fill: PALETTE.muted,
      anchor: 'end',
    }),
  ].join('');
}

/**
 * LANDSCAPE — 1200×630. The Open Graph canvas a link unfurls into.
 *
 * Not a squashed portrait. 630px of height cannot hold five stacked rows at a
 * legible size, and an unfurl is read at thumbnail scale, so the axes become a
 * two-column grid and the hero shrinks. Same content, different composition —
 * which is why both layouts are written out rather than parameterised.
 */
function landscape(subject: CardSubject): string {
  const { width, height } = CARD_DIMENSIONS.landscape;
  const margin = 70;
  const rows = axisRows(subject.profile);

  const axes = rows
    .map((row, index) => {
      const columnX = index < 3 ? margin : width / 2 + 20;
      const y = 330 + (index % 3) * 78;
      return [
        text(row.label.toUpperCase(), { x: columnX, y, size: 20, fill: PALETTE.muted, weight: 600, spacing: 2 }),
        text(row.value, { x: columnX, y: y + 34, size: 32, fill: PALETTE.text, family: FONT_DISPLAY, weight: 700 }),
      ].join('');
    })
    .join('');

  return [
    defs(width, height),

    text('IDENTITY BLUEPRINT', { x: margin, y: 100, size: 24, fill: PALETTE.accent, weight: 700, spacing: 8 }),
    `<rect x="${margin}" y="126" width="${width - margin * 2}" height="3" fill="url(#ifc-rule)"/>`,

    text(label(subject.profile.crewRole).toUpperCase(), {
      x: margin,
      y: 236,
      size: 96,
      fill: PALETTE.text,
      family: FONT_DISPLAY,
      weight: 800,
      spacing: -1,
    }),
    text(crewLine(subject), { x: margin, y: 282, size: 28, fill: PALETTE.accentBright, weight: 600 }),

    axes,

    `<rect x="${margin}" y="${height - 92}" width="${width - margin * 2}" height="1" fill="${PALETTE.border}"/>`,
    text('INTAFACED', { x: margin, y: height - 40, size: 34, fill: PALETTE.text, family: FONT_DISPLAY, weight: 800, spacing: 6 }),
    text('Sovereign Intelligence', { x: width - margin, y: height - 40, size: 22, fill: PALETTE.muted, anchor: 'end' }),
  ].join('');
}

/**
 * Compose the card.
 *
 * `width`/`height` are set as attributes AND as the viewBox. The attributes are
 * what makes the raster "pixel-perfect at share sizes" — a rasterizer told only
 * a viewBox picks its own output resolution, and §7.2's numbers would then
 * depend on renderer defaults rather than on us.
 */
export function composeCard(subject: CardSubject, size: CardSize): string {
  assertZeroPiiSurface('card.subject', subject);
  const { width, height } = CARD_DIMENSIONS[size];
  const body = size === 'portrait' ? portrait(subject) : landscape(subject);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" aria-label="Identity Blueprint card">` +
    body +
    '</svg>'
  );
}
