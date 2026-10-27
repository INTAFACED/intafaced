/**
 * INTAFACED customer-app design tokens (UI-SPEC §2). The only file in the
 * redesign that may contain a hex colour.
 *
 * Provenance: values were measured from okx.com on 2026-10-13 (1440x900, Chromium, logged out) and live in
 * MEASURED-TOKENS.md (intafaced-evidence/living-world-2026-10-13). The "MT" citations below are section and
 * line numbers in that file. Where a value is NOT measured it says "derived" or "DESIGN.md" instead.
 *
 * Authority: DESIGN.md (named-look, v0.1) wins when it conflicts with a measured value. Black, lime and
 * Inter agree in both. The conflicts that remain are listed in packages/ui docs (docs/ui-kit.md, "Known conflicts").
 *
 * To change a value: edit it here, run `pnpm exec tsx src/theme/generate.ts` in packages/ui, and commit both
 * files. Screens do not change because they only use token names.
 *
 * `tokens.css` is generated from this file; `tokens.test.ts` fails if the two
 * drift. This is the customer app's one token source: the app loads no other
 * token stylesheet. The older orange tokens in `../tokens.ts` are the founder
 * console's (apps/admin) and are not loaded by the customer app.
 *
 * Names are stable; values belong to a look. The values written below are the
 * default look. Another look sets new values for the same names in `looks`,
 * and is switched on with `data-look="<id>"` on the root element.
 */

/** Colour tokens. Key = `--if-<key>` and the Tailwind colour name. */
export const colors = {
  /** MT §1 L20: page background; L21: desk panels paint black. */
  bg: '#000000',
  /** MT §1 L24: card colour on markets and price pages (desk panels are `bg`, see L21). */
  panel: '#121212',
  /** MT §1 L27: white at 13% on black. */
  field: '#212121',
  /** MT §1 L26: table row hover and selected list row. */
  hover: '#1D1D1D',
  /** MT §1 L29: raised converter row. */
  raised: '#2C2C2C',
  'pill-active': '#383838',
  /** MT §1 L22: the 3 px gutters between desk panels. */
  line: '#2E2E2E',
  'line-strong': '#383838',
  /** Outlined cards. */
  'line-stronger': '#4D4D4D',
  /** Border of menus and popovers: white at 13%, OKX's own hairline. */
  'line-popup': 'rgba(255, 255, 255, 0.13)',
  /** MT §3 L57. DESIGN.md says #F5F5F5; kept white (recorded conflict C1). */
  fg: '#FFFFFF',
  /** MT §3 L60: table headers and labels. DESIGN.md says #A3A3A3 (recorded conflict C1). */
  'fg-2': '#909090',
  /**
   * Faint text. Was #6C6C6C (measured), which is 4.0:1 on black and 3.57:1 on `panel`, under WCAG AA; raised on
   * 26 Oct 2026 to the darkest neutral grey that clears 4.5:1 on bg, panel, hover and field (tokens.test.ts checks
   * it). It still fails on raised, menu and pill fills, so text there should use fg-2 or fg. It now sits close to fg-2; the
   * next look decides the text ramp.
   */
  'fg-3': '#888888',
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
  /** MT §4 L72: trading up. */
  up: '#25A750',
  /** Gains as text on black. Same as `up` by default; split out so red-up mode can lighten it. */
  'up-text': '#25A750',
  'on-up': '#0B0B0B',
  /** MT §4 L73: trading down. */
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
  /** Error text and borders on black (kit addition, MT §4 declared status colours: danger #FF5D73, text #F57A8A). */
  error: '#FF5D73',
  'error-text': '#F57A8A',
  lime: '#C8F64A',
  'lime-hover': '#D4FA6E',
  'lime-press': '#B5E03A',
  'on-lime': '#0B0B0B',
  'lime-soft': 'rgba(200, 246, 74, 0.16)',
  /** MT §4 L87: declared status warning surface. */
  warn: '#F5A915',
  /** Warning text on black (MT §4 L87). */
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

/**
 * Spacing scale for gaps, padding and margins (`--if-space-<step>`). Steps follow the 4 px unit agents know from
 * Tailwind (`space-3` = 3 units = 12 px today; `-0-5`, `-1-5`, `-2-5`, `-3-5` are the half steps). The names are
 * stable; a look may retune the values. tooling/scripts/look-codemod.mjs moves hand-typed px onto this scale.
 */
export const space = {
  '0-5': '2px',
  '1': '4px',
  '1-5': '6px',
  '2': '8px',
  '2-5': '10px',
  '3': '12px',
  '3-5': '14px',
  '4': '16px',
  '5': '20px',
  '6': '24px',
  '7': '28px',
  '8': '32px',
  '10': '40px',
  '12': '48px',
  '14': '56px',
  '16': '64px',
  '24': '96px',
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
  /** Kit density, comfortable: 44 px control height. DESIGN.md "main controls are 44px targets"; OKX declares lg 44 too (MT §8 L159). */
  'ctl-h': '44px',
  /** Kit density, dense (pro desk): 32 px control height, OKX declared sm (MT §8 L159). */
  'ctl-h-dense': '32px',
  /** Table row, comfortable. DESIGN.md 44 px target; the measured 60 px markets row stays as `row-h` for two-line list rows (conflict C3). */
  'table-row-h': '44px',
  /** Table row, dense. Derived (OKX declared control sm 32), not measured. */
  'table-row-h-dense': '32px',
  /** Table header row, comfortable: MT §9 L172 (39 px). */
  'table-head-h': '39px',
  /** Table header row, dense: MT §9 L173 (28 px list column header). */
  'table-head-h-dense': '28px',
} as const;

/**
 * Names kept alive for older code by pointing at a current token (never a second value).
 * `--if-base` is the legacy src/tokens.ts name for the page background; `--if-bg` is the one the kit reads.
 * The legacy stylesheet (src/tokens.css) points the other way, so whichever file loads last, both names
 * resolve to the same black and there is no reference cycle.
 */
export const aliases = {
  base: 'var(--if-bg)',
  /** The keyboard focus ring (2 px solid). Its own name so a look can change it without changing the accent. */
  focus: 'var(--if-lime)',
  /**
   * The accent used as text (links, active tabs, live labels, check marks). Its own name so a light theme can darken
   * text without darkening accent fills, which stay `--if-lime`.
   */
  'accent-text': 'var(--if-lime)',
} as const;

/**
 * The customer app's older names. They lived in apps/customer/src/shared/tokens.css until 26 Oct 2026 and are
 * generated into `customer-legacy.css` (customer app only, so they never reach the founder console), with
 * today's values, so that file could go. Where a value is a kit token's in the same role (page background,
 * accent) it points at that token, so a look change reaches it; the rest keep their own value until their
 * uses move to `--if-*` names area by area. Write no new uses.
 */
export const legacyVars = {
  '--color-background': 'var(--if-bg)',
  '--color-shell': '#111111',
  '--color-surface': '#0D0D0D',
  '--color-surface-raised': '#171717',
  '--color-selected': '#202020',
  '--color-accent': 'var(--if-lime)',
  '--color-text': '#F5F5F5',
  '--color-muted': '#A3A3A3',
  '--color-unavailable-text': '#B8B8B8',
  '--color-mix-secondary': '#858585',
  '--color-divider': '#262626',
  '--color-border': '#303030',
  '--color-destination-border': '#30352B',
  '--font-sans': 'Inter',
  '--text-14': '14px',
  '--text-15': '15px',
  '--text-18': '18px',
  '--font-weight-regular': '400',
  '--font-weight-medium': '500',
  '--font-weight-semibold': '600',
  '--leading-22': '22px',
  '--leading-32': '32px',
  '--spacing-2': '2px',
  '--spacing-4': '4px',
  '--spacing-8': '8px',
  '--spacing-12': '12px',
  '--spacing-28': '28px',
  '--spacing-44': '44px',
  '--spacing-72': '72px',
  '--radius-28': '28px',
} as const;

/** Control heights in px (UI-SPEC §2.4). */
export const controlHeights = [28, 32, 40, 48, 56] as const;

/** Every custom property emitted into tokens.css, in order. */
export function cssVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) out[`--if-${k}`] = v;
  for (const [k, v] of Object.entries(aliases)) out[`--if-${k}`] = v;
  out['--if-font-ui'] = fonts.ui;
  out['--if-font-mono'] = fonts.mono;
  for (const [k, t] of Object.entries(textStyles)) {
    out[`--if-text-${k}`] = t.size;
    out[`--if-leading-${k}`] = t.line;
    out[`--if-weight-${k}`] = t.weight;
  }
  out['--if-tracking-tight'] = trackingTight;
  for (const [k, v] of Object.entries(radii)) out[`--if-r-${k}`] = v;
  // Smallest first: integer-like keys would otherwise be listed before the half steps.
  for (const [k, v] of Object.entries(space).sort((x, y) => parseFloat(x[1]) - parseFloat(y[1]))) out[`--if-space-${k}`] = v;
  for (const [k, v] of Object.entries(sizes)) out[`--if-${k}`] = v;
  out['--if-shadow-menu'] = shadows.menu;
  out['--if-ease'] = motion.ease;
  out['--if-t-fast'] = motion.fast;
  out['--if-t-menu'] = motion.menu;
  out['--if-t-tab'] = motion.tab;
  out['--if-t-flash'] = motion.flash;
  return out;
}

/** A custom property name; `tokens.test.ts` checks that every name a look sets is one `cssVars()` emits (never an older name). */
export type TokenName = `--${string}`;

/**
 * Looks: one value map per look, under the same names. The default look's values are the ones written above,
 * so its entry is empty. A new look lists only the names whose value it changes; `tokens.test.ts` fails if it
 * names a token that does not exist. Each entry is emitted as `:root:where([data-look='<id>'])`: same weight as
 * `:root` and written before the red-for-up block, so user preferences (red for up, the light theme) still win.
 */
export const looks = {
  /** Black, lime and Inter, measured from okx.com on 2026-10-13 (see the provenance note at the top). */
  'black-lime': {},
} as const satisfies Record<string, Partial<Record<TokenName, string>>>;

export type LookId = keyof typeof looks;
export const defaultLook: LookId = 'black-lime';

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
  const all = looks as Record<string, Record<string, string>>;
  if (Object.keys(all[defaultLook] ?? {}).length > 0) {
    throw new Error(`look ${defaultLook} is the default: write its values in the token maps above, not in looks`);
  }
  const lookBlocks = Object.entries(all)
    .filter(([id, vars]) => id !== defaultLook && Object.keys(vars).length > 0)
    .map(([id, vars]) => `\n/* Look "${id}": same names, its own values. */\n:root:where([data-look='${id}']) {\n${decl(vars)}\n}\n`)
    .join('');
  return `/**
 * INTAFACED customer-app design tokens (UI-SPEC section 2).
 * GENERATED from src/theme/tokens.ts by src/theme/generate.ts.
 * Do not edit by hand: theme/tokens.test.ts fails if the two drift.
 * Values are measured from okx.com (MEASURED-TOKENS.md) unless tokens.ts says otherwise.
 */

:root {
${decl(cssVars())}
}
${lookBlocks}
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

/** The exact text of customer-legacy.css: the customer app's older names, loaded by the customer app only. */
export function renderLegacyCss(): string {
  return `/**
 * The customer app's older token names, loaded by the customer app only (app/redesign.css).
 * GENERATED from src/theme/tokens.ts (legacyVars) by src/theme/generate.ts.
 * Do not edit by hand: theme/tokens.test.ts fails if the two drift. Write no new uses: use --if-* names.
 */

:root {
${decl(legacyVars)}
}
`;
}
