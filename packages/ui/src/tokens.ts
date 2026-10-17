/**
 * DESIGN TOKENS — the brand (§3 Phase 0 deliverable).
 *
 * Black, with a restrained orange identity accent. These values are the brand;
 * components read them and nothing hard-codes a hex outside this file. A colour
 * that is not here does not exist in the product.
 *
 * The CSS custom properties in tokens.css are generated from these same values
 * — see tokens.test.ts, which fails if the two ever drift apart.
 *
 * ── Why black, and why orange ───────────────────────────────────────────────
 *
 * True black, not a tinted near-black. A trading screen is mostly numbers on a
 * background, and any hue in that background competes with the only two colours
 * that carry meaning — the green and the red. Neutral greys keep the surface
 * out of the way.
 *
 * Orange is the single identity pin (#FF6B00): primary actions, active nav,
 * focus. Catalog titles stay text. It must never read as market direction.
 */

export const color = {
  /**
   * Surface ramp. Pure black at the base, neutral greys above it. No blue
   * cast: a tinted background makes every red look slightly wrong.
   */
  base: '#000000',
  surface: '#0C0C0E',
  surfaceRaised: '#16161A',
  surfaceOverlay: '#232329',

  /**
   * Restrained identity accent — matches member `--ix-orange: #ff6b00`.
   *
   * Deliberately NOT used for market direction. Named slots only.
   */
  accent: '#FF6B00',
  accentBright: '#FF8A2B',
  accentDim: '#C24F00',
  accentGlow: 'rgba(255, 107, 0, 0.24)',

  /** Secondary — links, informational chips, chart axes. */
  azure: '#3BB3E4',
  azureDim: '#049DDC',

  /** Borders as alpha over the surface, so they hold on every ramp step. */
  border: 'rgba(255, 255, 255, 0.09)',
  borderStrong: 'rgba(255, 255, 255, 0.18)',
  borderAccent: 'rgba(255, 107, 0, 0.50)',

  text: '#F7F7F8',
  textMuted: '#A2A2AC',
  textFaint: 'rgba(247, 247, 248, 0.40)',
  /** For use ON the orange accent. White on #FF6B00 fails contrast. */
  textOnAccent: '#1A0A00',

  /**
   * Market semantics. Load-bearing: these two are the only way a trader reads
   * direction at a glance, so nothing else in the palette may claim them.
   */
  long: '#00C46A',
  longDim: '#00994F',
  short: '#FF3B5C',
  shortDim: '#D42B47',

  warn: '#FFB020',
  danger: '#FF3B5C',
  info: '#3BB3E4',
} as const;

export const font = {
  /** Display / HUD — ranks, tickers, headings. */
  display: "'Orbitron', 'Rajdhani', system-ui, sans-serif",
  /** Body — everything a user reads in sentences. */
  body: "'Inter', system-ui, -apple-system, sans-serif",
  /** Numerics — order books, balances. Tabular figures are non-negotiable. */
  mono: "'JetBrains Mono', 'SF Mono', ui-monospace, monospace",
} as const;

/** 4px base. Every gap in the OS is a multiple of it. */
export const space = {
  px: '1px',
  0.5: '2px',
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  5: '20px',
  6: '24px',
  8: '32px',
  10: '40px',
  12: '48px',
  16: '64px',
} as const;

export const radius = {
  none: '0',
  sm: '2px',
  md: '4px',
  lg: '8px',
  pill: '999px',
} as const;

export const border = {
  hairline: `1px solid ${color.border}`,
  strong: `1px solid ${color.borderStrong}`,
  accent: `1px solid ${color.borderAccent}`,
} as const;

export const blur = {
  panel: 'blur(12px)',
  heavy: 'blur(24px)',
} as const;

export const shadow = {
  /** Accent bloom — focus and live states only, never decoration. */
  glow: `0 0 12px ${color.accentGlow}`,
  glowStrong: `0 0 24px ${color.accentGlow}`,
  /** Elevation. Two steps only: a panel is raised or it is not. */
  panel: '0 4px 16px rgba(0, 0, 0, 0.4)',
  modal: '0 16px 48px rgba(0, 0, 0, 0.6)',
} as const;

export const motion = {
  fast: '120ms cubic-bezier(0.4, 0, 0.2, 1)',
  base: '200ms cubic-bezier(0.4, 0, 0.2, 1)',
  slow: '320ms cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

export const zIndex = {
  base: 0,
  panel: 10,
  overlay: 100,
  modal: 1000,
  toast: 2000,
} as const;

export const tokens = { color, font, space, radius, border, blur, shadow, motion, zIndex } as const;

/**
 * The CSS custom-property names components use. Kept as data so the token test
 * can assert that every declared token is actually emitted in tokens.css.
 */
export const CSS_VARS = {
  '--if-base': color.base,
  /** Alias for the redesign kit's name (theme/tokens.ts). Points at `--if-base`, so the black exists once per file. */
  '--if-bg': 'var(--if-base)',
  '--if-surface': color.surface,
  '--if-surface-raised': color.surfaceRaised,
  '--if-surface-overlay': color.surfaceOverlay,
  '--if-accent': color.accent,
  '--if-accent-bright': color.accentBright,
  '--if-accent-dim': color.accentDim,
  '--if-accent-glow': color.accentGlow,
  '--if-azure': color.azure,
  '--if-azure-dim': color.azureDim,
  '--if-border': color.border,
  '--if-border-strong': color.borderStrong,
  '--if-border-accent': color.borderAccent,
  '--if-text': color.text,
  '--if-text-muted': color.textMuted,
  '--if-text-faint': color.textFaint,
  '--if-text-on-accent': color.textOnAccent,
  '--if-long': color.long,
  '--if-long-dim': color.longDim,
  '--if-short': color.short,
  '--if-short-dim': color.shortDim,
  '--if-warn': color.warn,
  '--if-danger': color.danger,
  '--if-info': color.info,
  '--if-font-display': font.display,
  '--if-font-body': font.body,
  '--if-font-mono': font.mono,
  '--if-radius-md': radius.md,
  '--if-radius-lg': radius.lg,
  '--if-blur-panel': blur.panel,
  '--if-shadow-glow': shadow.glow,
  '--if-shadow-panel': shadow.panel,
  '--if-shadow-modal': shadow.modal,
  '--if-motion-base': motion.base,
} as const;
