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
  /** Outlined cards. */
  'line-stronger': '#4D4D4D',
  /** Border of menus and popovers: white at 13%, OKX's own hairline. */
  'line-popup': 'rgba(255, 255, 255, 0.13)',
  fg: '#FFFFFF',
  'fg-2': '#909090',
  'fg-3': '#6C6C6C',
  /** Disabled text only. */
  'fg-disabled': '#5B5B5B',
  /** Hover, press and disabled fills for fields and chips on any surface. */
  'overlay-hover': 'rgba(255, 255, 255, 0.16)',
  'overlay-press': 'rgba(255, 255, 255, 0.22)',
  'overlay-disabled': 'rgba(255, 255, 255, 0.08)',
  /** Popup surfaces. Tooltips sit on `raised` (T3-C); `menu` is kept for a later menu call. */
  menu: '#343434',
  tooltip: '#4D4D4D',
  popover: '#171717',
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
  /** Hover fills for the buy and sell buttons (replace a brightness filter). */
  'up-hover': '#1A8D40',
  'down-hover': '#B43255',
  /** 20% depth bars in the order book (M2). */
  'up-bg-soft': '#072110',
  lime: '#C8F64A',
  'lime-hover': '#D4FA6E',
  'lime-press': '#B5E03A',
  'on-lime': '#0B0B0B',
  'lime-soft': 'rgba(200, 246, 74, 0.16)',
  /** Warning surface (OKX measured). */
  warn: '#F5A915',
  /** Warning text on black. */
  'warn-text': '#FFC452',
  scrim: 'rgba(0, 0, 0, 0.68)',
  'ma-1': '#FFA726',
  'ma-2': '#EC407A',
  'ma-3': '#27C6DA',
  /** Chart (M2): volume bars and grid lines. */
  'vol-up': '#135428',
  'vol-down': '#652032',
  grid: '#171717',
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
  'up-hover': '#B43255',
  'down-hover': '#1A8D40',
};

export const fonts = {
  ui: "'Inter Variable', Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
  /** Addresses, account IDs and transaction references only. Never prices. */
  mono: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
} as const;

/** Type scale (UI-SPEC §2.3): size / line-height / weight. */
export const textStyles = {
  '2xs': { size: '12px', line: '16px', weight: '500' },
  xs: { size: '12px', line: '16px', weight: '400' },
  sm: { size: '13px', line: '18px', weight: '400' },
  base: { size: '14px', line: '20px', weight: '400' },
  md: { size: '16px', line: '24px', weight: '500' },
  lg: { size: '20px', line: '28px', weight: '600' },
  xl: { size: '24px', line: '28px', weight: '600' },
  '2xl': { size: '28px', line: '34px', weight: '700' },
  'hero-pro': { size: '32px', line: '40px', weight: '700' },
  hero: { size: '48px', line: '58px', weight: '700' },
} as const;

export type TextToken = keyof typeof textStyles;

/**
 * Letter-spacing -0.02em on the 48 px hero only. Inter at 24 and 28 px with -0.02em looks pinched
 * next to body text, and OKX measures `normal` everywhere (critic round 1, tokens table).
 */
export const trackingTight = '-0.02em';
export const tightTextTokens: readonly TextToken[] = ['hero'];

/** Radius (UI-SPEC §2.4). */
export const radii = {
  /** Reserved for OKX-style 2 px corners (measured tooltip radius); tooltips use `xs` (T3-C). */
  '2xs': '2px',
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

/**
 * Layout sizes in px (critic round 1, from MEASURED-TOKENS). Emitted as `--if-<key>`.
 * Plain custom properties for CSS (`var(--if-topbar-h)`), not Tailwind keys.
 */
export const sizes = {
  'topbar-h': '48px',
  'tab-gap': '24px',
  'nav-gap': '24px',
  'row-h': '60px',
  'book-row-h': '22px',
  /** Select and dropdown option rows. */
  'menu-item-h': '36px',
  /** Navigation menu rows. */
  'nav-menu-item-h': '56px',
  'container-max': '1224px',
  gutter: '24px',
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
  for (const [k, v] of Object.entries(sizes)) out[`--if-${k}`] = v;
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
