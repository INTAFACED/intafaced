/**
 * INTAFACED customer-app design tokens (UI-SPEC §2). The only file in the
 * redesign that may contain a hex colour.
 *
 * Every value is PROVISIONAL until measured from okx.com CSS (UI-SPEC §2).
 * When the measuring run lands, edit the values here, run
 * `pnpm exec tsx src/theme/generate.ts` in packages/ui, and commit both files:
 * screens do not change because they only use token names.
 *
 * `tokens.css` is generated from this file; `tokens.test.ts` fails if the two
 * drift. The older orange tokens in `../tokens.ts` (used by apps/admin) are a
 * different system and are not touched.
 */

/** Colour tokens. Key = `--if-<key>` and the Tailwind colour name. */
export const colors = {
  bg: '#000000',
  panel: '#121212',
  field: '#212121',
  hover: '#1D1D1D',
  raised: '#2C2C2C',
  'pill-active': '#383838',
  line: '#2E2E2E',
  'line-strong': '#383838',
  fg: '#FFFFFF',
  'fg-2': '#909090',
  'fg-3': '#6C6C6C',
  up: '#25A750',
  /** Gains as text on black. Same as `up` by default; split out so red-up mode can lighten it. */
  'up-text': '#25A750',
  'on-up': '#0B0B0B',
  down: '#CA3F64',
  'down-text': '#E0567A',
  /** Text on a `down` fill (sell button). */
  'on-down': '#FFFFFF',
  'up-bg': '#0B361A',
  'down-bg': '#280D14',
  lime: '#C8F64A',
  'lime-hover': '#D4FA6E',
  'lime-press': '#B5E03A',
  'on-lime': '#0B0B0B',
  'lime-soft': 'rgba(200, 246, 74, 0.12)',
  warn: '#F5A524',
  scrim: 'rgba(0, 0, 0, 0.64)',
  'ma-1': '#FFA726',
  'ma-2': '#EA3F79',
  'ma-3': '#27C6DA',
  'alloc-1': '#C8F64A',
  'alloc-2': '#E6E6E6',
  'alloc-3': '#A6A6A6',
  'alloc-4': '#737373',
  'alloc-5': '#4D4D4D',
  'alloc-6': '#2E2E2E',
} as const;

export type ColorToken = keyof typeof colors;

/**
 * "Red for up" preference: the up/down pair swaps at the token level so
 * components never branch on it. Applied under `[data-up-color="red"]`.
 * Text colours keep >= 4.5:1 on black (see tokens.test.ts).
 */
export const redUpOverrides: Partial<Record<ColorToken, string>> = {
  up: '#CA3F64',
  'up-text': '#E0567A',
  'on-up': '#FFFFFF',
  down: '#25A750',
  'down-text': '#25A750',
  'on-down': '#0B0B0B',
  'up-bg': '#280D14',
  'down-bg': '#0B361A',
};

export const fonts = {
  ui: "'Inter Variable', Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
  /** Addresses, account IDs and transaction references only. Never prices. */
  mono: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
} as const;

/** Type scale (UI-SPEC §2.3): size / line-height / weight. */
export const textStyles = {
  '2xs': { size: '11px', line: '14px', weight: '500' },
  xs: { size: '12px', line: '16px', weight: '400' },
  sm: { size: '13px', line: '18px', weight: '400' },
  base: { size: '14px', line: '20px', weight: '400' },
  md: { size: '16px', line: '24px', weight: '500' },
  lg: { size: '20px', line: '28px', weight: '600' },
  xl: { size: '24px', line: '32px', weight: '700' },
  '2xl': { size: '28px', line: '36px', weight: '700' },
  'hero-pro': { size: '32px', line: '40px', weight: '700' },
  hero: { size: '48px', line: '56px', weight: '700' },
} as const;

export type TextToken = keyof typeof textStyles;

/** Letter-spacing -0.02em at 24 px and above. */
export const trackingTight = '-0.02em';
export const tightTextTokens: readonly TextToken[] = ['xl', '2xl', 'hero-pro', 'hero'];

/** Radius (UI-SPEC §2.4). */
export const radii = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  pill: '999px',
} as const;

export const shadows = {
  /** Menus, popovers and dialogs. No other shadow exists. */
  menu: '0 8px 24px rgba(0, 0, 0, 0.5)',
} as const;

/** Motion (UI-SPEC §2.5). All collapse to 0 ms under prefers-reduced-motion. */
export const motion = {
  ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  fast: '120ms',
  menu: '160ms',
  tab: '150ms',
  flash: '600ms',
} as const;

/** Control heights in px (UI-SPEC §2.4). */
export const controlHeights = [28, 32, 40, 48, 56] as const;

/** Every custom property emitted into tokens.css, in order. */
export function cssVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) out[`--if-${k}`] = v;
  out['--if-font-ui'] = fonts.ui;
  out['--if-font-mono'] = fonts.mono;
  for (const [k, t] of Object.entries(textStyles)) {
    out[`--if-text-${k}`] = t.size;
    out[`--if-leading-${k}`] = t.line;
    out[`--if-weight-${k}`] = t.weight;
  }
  out['--if-tracking-tight'] = trackingTight;
  for (const [k, v] of Object.entries(radii)) out[`--if-r-${k}`] = v;
  out['--if-shadow-menu'] = shadows.menu;
  out['--if-ease'] = motion.ease;
  out['--if-t-fast'] = motion.fast;
  out['--if-t-menu'] = motion.menu;
  out['--if-t-tab'] = motion.tab;
  out['--if-t-flash'] = motion.flash;
  return out;
}

/** CSS is written with lowercase hex (what prettier produces), TS keeps the spec's uppercase. */
export const cssValue = (v: string): string => v.replace(/#[0-9A-Fa-f]{3,8}\b/g, (m) => m.toLowerCase());

const decl = (vars: Record<string, string>, indent = '  ') =>
  Object.entries(vars)
    .map(([k, v]) => `${indent}${k}: ${cssValue(v)};`)
    .join('\n');

/** The exact text of tokens.css. */
export function renderTokensCss(): string {
  const redUp: Record<string, string> = {};
  for (const [k, v] of Object.entries(redUpOverrides)) redUp[`--if-${k}`] = v;
  return `/**
 * INTAFACED customer-app design tokens (UI-SPEC section 2).
 * GENERATED from src/theme/tokens.ts by src/theme/generate.ts.
 * Do not edit by hand: theme/tokens.test.ts fails if the two drift.
 * Values are PROVISIONAL until measured from okx.com CSS.
 */

:root {
${decl(cssVars())}
}

/* "Red for up" preference: the up/down pair swaps here, components never branch on it. */
[data-up-color='red'] {
${decl(redUp)}
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --if-t-fast: 0ms;
    --if-t-menu: 0ms;
    --if-t-tab: 0ms;
    --if-t-flash: 0ms;
  }
}
`;
}
