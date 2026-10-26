/**
 * Lit glass: role token values. Names and meanings are in `./contracts.ts`; this file holds the values.
 *
 * Four value sets, emitted into `lit.css` by `renderLitCss()` (run `pnpm exec tsx src/lit/generate.ts` in
 * packages/ui and commit both files; `lit.test.ts` fails if they drift):
 *
 * - `flat`: the look switched off. Every role resolves to today's `--if-*` tokens, so a room built on a template
 *   shows its new layout in today's skin, with no glass, glow or blur. Hex values never appear here.
 * - `lit`: the Lit glass skin, dark, blue (the default accent). Each material is measured from the owner's
 *   reference set (kept outside this repo). PROVISIONAL until the blue re-light is judged against those
 *   references; names won't change, values may.
 * - `litLight`: light values for the same roles. Not shipped (dark first, 26 Oct 2026); written now so contrast
 *   tests run on both schemes.
 * - `accentSets` and `solid`: per-accent light colours, and the Solid surfaces mode (no translucency, no blur).
 *
 * Budgets the values keep: money and text sit on opaque content panels (`solid-bg`), glass
 * and blur are only on the nav and sheet layers, and text roles meet 4.5:1 on every solid surface.
 */
import { cssValue } from '../theme/tokens.js';
import { accents, LIT_LOOK, roleNames, roleVar, type Accent, type Role, type TypeRole } from './contracts.js';

type RoleMap = Record<Role, string>;

const v = (name: string) => `var(--if-${name})`;

/** The look switched off: today's skin, flat. */
export const flat: RoleMap = {
  page: v('bg'),
  'page-2': v('bg'),
  field: 'none',
  'text-1': v('fg'),
  'text-2': v('fg-2'),
  'text-3': v('fg-3'),
  'text-disabled': v('fg-disabled'),
  line: v('line'),
  'line-strong': v('line-strong'),
  accent: v('lime'),
  'accent-hot': v('lime-hover'),
  'accent-deep': v('lime-press'),
  'accent-pair': v('lime'),
  'accent-text': v('accent-text'),
  'accent-fill': v('lime'),
  'accent-fill-2': v('lime-press'),
  'on-accent': v('on-lime'),
  up: v('up'),
  down: v('down'),
  'up-text': v('up-text'),
  'down-text': v('down-text'),
  'solid-bg': v('panel'),
  'solid-bg-raised': v('raised'),
  'solid-bg-sunken': v('field'),
  'solid-lip': '0 0 0 0 transparent',
  'solid-rim': v('line'),
  'solid-rim-dim': v('line'),
  'solid-wall': 'transparent',
  'solid-shadow': 'none',
  sheen: 'linear-gradient(transparent, transparent)',
  'fill-shadow': 'none',
  'corner-glow': 'transparent',
  'glass-bg': v('popover'),
  'glass-blur': 'none',
  'glass-rim': v('line-popup'),
  'glass-rim-dim': v('line-popup'),
  'glass-shadow': v('shadow-menu'),
  scrim: v('scrim'),
  veil: v('scrim'),
  'primary-bg': v('lime'),
  'primary-fg': v('on-lime'),
  'primary-shadow': 'none',
  'secondary-bg': v('field'),
  'secondary-fg': v('fg'),
  'secondary-shadow': 'none',
  'key-bg': v('field'),
  'key-shadow': 'none',
  'key-lit-bg': v('lime'),
  'key-lit-shadow': 'none',
  'control-bg': v('field'),
  'control-rim': v('line-strong'),
  'control-rim-active': v('fg-2'),
  focus: v('focus'),
  'legal-bg': v('panel'),
  'legal-fg': v('fg'),
  'legal-border': v('line-stronger'),
  'refusal-bg': v('panel'),
  'refusal-fg': v('fg'),
  'refusal-border': v('line-strong'),
  'warn-text': v('warn-text'),
  'error-text': v('error-text'),
  'test-tag-bg': v('field'),
  'test-tag-fg': v('fg-2'),
  'status-pending': v('warn-text'),
  'status-failed': v('error-text'),
  'status-done': v('up-text'),
  'status-unknown': v('fg-2'),
  'status-stale': v('warn-text'),
  'font-ui': v('font-ui'),
  'font-mono': v('font-mono'),
  'font-figure': v('font-ui'),
  'radius-panel': v('r-lg'),
  'radius-tile': v('r-md'),
  'radius-key': v('r-md'),
  'radius-control': v('r-sm'),
  ease: v('ease'),
  'ease-spring': v('ease'),
  't-quick': v('t-fast'),
  't-base': v('t-tab'),
  't-slow': v('t-flash'),
  'gap-section': v('space-6'),
  'gap-item': v('space-3'),
  'pad-panel': v('space-4'),
  'row-h': v('row-h'),
  'control-h': v('ctl-h'),
  'legal-band-min-h': '44px',
  'topbar-h': v('topbar-h'),
  'dock-h': '0px',
};

/** Lit glass, dark, with the light colours of the default accent (blue). */
export const lit: RoleMap = {
  page: '#04050A',
  'page-2': '#08090F',
  field:
    'radial-gradient(120% 80% at 50% -10%, color-mix(in srgb, var(--lit-accent) 16%, transparent), transparent 60%), radial-gradient(90% 60% at 50% 110%, color-mix(in srgb, var(--lit-accent-deep) 40%, transparent), transparent 70%)',
  'text-1': '#F4F5F8',
  'text-2': '#A9AEBB',
  'text-3': '#8C92A0',
  'text-disabled': '#4E5360',
  line: 'rgba(255, 255, 255, 0.07)',
  'line-strong': 'rgba(255, 255, 255, 0.14)',
  accent: '#3F7DFF',
  'accent-hot': '#C7DBFF',
  'accent-deep': '#0B1F4D',
  'accent-pair': '#FF7A3D',
  'accent-text': '#6D9BFF',
  'accent-fill': '#2F5CBD',
  'accent-fill-2': '#213F85',
  'on-accent': '#FFFFFF',
  up: '#43D9A3',
  down: '#FF5C5C',
  'up-text': '#43D9A3',
  'down-text': '#FF7A7A',
  'solid-bg': '#0D0F15',
  'solid-bg-raised': '#151821',
  'solid-bg-sunken': '#08090D',
  'solid-lip': 'inset 0 1px 0 rgba(255, 255, 255, 0.07)',
  'solid-rim': 'rgba(255, 255, 255, 0.26)',
  'solid-rim-dim': 'rgba(255, 255, 255, 0.04)',
  'solid-wall': '#0A0C11',
  'solid-shadow': '0 4px 0 0 var(--lit-solid-wall), 0 5px 0 0 rgba(0, 0, 0, 0.5), 0 34px 60px -26px rgba(0, 0, 0, 0.95)',
  sheen: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.012) 70%)',
  'fill-shadow':
    'inset 0 1px 0 rgba(255, 255, 255, 0.36), 0 3px 0 0 var(--lit-accent-fill-2), 0 0 14px color-mix(in srgb, var(--lit-accent) 40%, transparent), 0 0 40px color-mix(in srgb, var(--lit-accent) 16%, transparent)',
  'corner-glow': 'color-mix(in srgb, var(--lit-accent) 30%, transparent)',
  'glass-bg': 'linear-gradient(180deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.015) 70%), rgba(13, 15, 21, 0.7)',
  'glass-blur': 'blur(24px) saturate(150%)',
  'glass-rim': 'rgba(255, 255, 255, 0.26)',
  'glass-rim-dim': 'rgba(255, 255, 255, 0.04)',
  'glass-shadow':
    'inset 0 1px 0 rgba(255, 255, 255, 0.07), 0 3px 0 0 #0A0C11, 0 4px 0 0 rgba(0, 0, 0, 0.5), 0 24px 48px -20px rgba(0, 0, 0, 0.9)',
  scrim: 'rgba(2, 3, 6, 0.72)',
  veil: 'rgba(4, 5, 10, 0.6)',
  'primary-bg': 'linear-gradient(90deg, #A8A8A8 0%, #DCDCDC 20%, #F7F7F7 45%, #EBEBEB 56%, #D2D2D2 78%, #ACACAC 100%)',
  'primary-fg': '#0B0B0B',
  'primary-shadow':
    'inset 0 1px 0 rgba(255, 255, 255, 0.95), inset 0 -1px 0 rgba(0, 0, 0, 0.4), inset 0 -3px 5px rgba(0, 0, 0, 0.14), 0 10px 30px -12px rgba(255, 255, 255, 0.22)',
  'secondary-bg': 'linear-gradient(180deg, #14151A, #0A0B0E)',
  'secondary-fg': '#F4F5F8',
  'secondary-shadow':
    'inset 0 1px 0 rgba(255, 255, 255, 0.1), inset 0 0 0 1px rgba(255, 255, 255, 0.06), 0 2px 0 -1px rgba(255, 255, 255, 0.04)',
  'key-bg': 'linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.015) 70%), #11131A',
  'key-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.07), 0 3px 0 0 #0A0C11, 0 4px 0 0 rgba(0, 0, 0, 0.5)',
  'key-lit-bg':
    'radial-gradient(60% 60% at 50% 50%, color-mix(in srgb, var(--lit-accent) 34%, transparent), transparent 75%), linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.015) 70%), #11131A',
  'key-lit-shadow':
    'inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 3px 0 0 #0A0C11, 0 0 22px color-mix(in srgb, var(--lit-accent) 45%, transparent), 0 0 60px color-mix(in srgb, var(--lit-accent) 18%, transparent)',
  'control-bg': '#0A0C11',
  'control-rim': 'rgba(255, 255, 255, 0.36)',
  'control-rim-active': 'rgba(255, 255, 255, 0.56)',
  focus: '#FFFFFF',
  'legal-bg': '#16181D',
  'legal-fg': '#FFFFFF',
  'legal-border': '#B9BDC7',
  'refusal-bg': '#121419',
  'refusal-fg': '#E6E8EE',
  'refusal-border': 'rgba(255, 255, 255, 0.2)',
  'warn-text': '#FFC452',
  'error-text': '#FF8A8A',
  'test-tag-bg': 'rgba(255, 255, 255, 0.08)',
  'test-tag-fg': '#A9AEBB',
  'status-pending': '#FFC452',
  'status-failed': '#FF8A8A',
  'status-done': '#43D9A3',
  'status-unknown': '#A9AEBB',
  'status-stale': '#FFC452',
  'font-ui': "'Geist Variable', Geist, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  'font-mono': "'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  'font-figure': "'Geist Variable', Geist, ui-sans-serif, system-ui, sans-serif",
  'radius-panel': '24px',
  'radius-tile': '18px',
  'radius-key': '18px',
  'radius-control': '14px',
  ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  'ease-spring': 'cubic-bezier(0.34, 1.4, 0.64, 1)',
  't-quick': '120ms',
  't-base': '220ms',
  't-slow': '600ms',
  'gap-section': '24px',
  'gap-item': '12px',
  'pad-panel': '20px',
  'row-h': '60px',
  'control-h': '48px',
  'legal-band-min-h': '44px',
  'topbar-h': '56px',
  'dock-h': '88px',
};

/** Light values for the same roles: written and contrast-tested now, not shipped (dark first). */
export const litLight: Partial<RoleMap> = {
  page: '#ECEEF3',
  'page-2': '#E2E5EC',
  'text-1': '#0B0D12',
  'text-2': '#3D4350',
  'text-3': '#555C6A',
  'text-disabled': '#9AA0AC',
  line: 'rgba(10, 13, 20, 0.08)',
  'line-strong': 'rgba(10, 13, 20, 0.16)',
  'accent-text': '#1F56D6',
  'up-text': '#0B6C47',
  'down-text': '#C2262E',
  'solid-bg': '#FFFFFF',
  'solid-bg-raised': '#F4F5F8',
  'solid-bg-sunken': '#E8EBF0',
  'solid-lip': 'inset 0 1px 0 rgba(255, 255, 255, 0.9)',
  'solid-wall': '#D5D9E1',
  'solid-rim': 'rgba(255, 255, 255, 0.95)',
  'solid-rim-dim': 'rgba(10, 13, 20, 0.1)',
  'solid-shadow': '0 3px 0 0 var(--lit-solid-wall), 0 20px 40px -24px rgba(20, 30, 60, 0.35)',
  'glass-rim': 'rgba(255, 255, 255, 0.95)',
  'glass-rim-dim': 'rgba(10, 13, 20, 0.12)',
  'glass-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 2px 0 0 #D5D9E1, 0 18px 36px -20px rgba(20, 30, 60, 0.35)',
  scrim: 'rgba(10, 13, 20, 0.4)',
  veil: 'rgba(236, 238, 243, 0.7)',
  'primary-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.95), inset 0 -1px 0 rgba(0, 0, 0, 0.25), 0 6px 18px -8px rgba(20, 30, 60, 0.35)',
  'key-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 2px 0 0 #D5D9E1, 0 3px 0 0 rgba(20, 30, 60, 0.08)',
  'key-lit-bg':
    'radial-gradient(60% 60% at 50% 50%, color-mix(in srgb, var(--lit-accent) 22%, transparent), transparent 75%), linear-gradient(180deg, #FFFFFF, #F1F3F7)',
  'key-lit-shadow':
    'inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 2px 0 0 #D5D9E1, 0 0 18px color-mix(in srgb, var(--lit-accent) 30%, transparent)',
  'glass-bg': 'linear-gradient(180deg, rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0.5) 70%), rgba(236, 238, 243, 0.7)',
  'secondary-bg': 'linear-gradient(180deg, #FFFFFF, #EEF0F4)',
  'secondary-fg': '#0B0D12',
  'key-bg': 'linear-gradient(180deg, #FFFFFF, #F1F3F7)',
  'control-bg': '#FFFFFF',
  'control-rim': 'rgba(10, 13, 20, 0.48)',
  'control-rim-active': 'rgba(10, 13, 20, 0.68)',
  focus: '#0B0D12',
  'legal-bg': '#FFFFFF',
  'legal-fg': '#0B0D12',
  'legal-border': '#3D4350',
  'refusal-bg': '#F4F5F8',
  'refusal-fg': '#0B0D12',
  'refusal-border': 'rgba(10, 13, 20, 0.2)',
  'warn-text': '#8A5A00',
  'error-text': '#B3261E',
  'test-tag-bg': 'rgba(10, 13, 20, 0.06)',
  'test-tag-fg': '#3D4350',
  'status-pending': '#8A5A00',
  'status-failed': '#B3261E',
  'status-done': '#0B6C47',
  'status-unknown': '#3D4350',
  'status-stale': '#8A5A00',
};

/** The light colours per accent. Blue's values are the ones written in `lit`. */
export const accentSets: Record<Accent, Partial<RoleMap>> = {
  blue: {},
  ember: {
    accent: '#FF6A1A',
    'accent-hot': '#FFC46B',
    'accent-deep': '#5A1606',
    'accent-pair': '#FF2D55',
    'accent-text': '#FF8A4C',
    'accent-fill': '#B3430A',
    'accent-fill-2': '#7A2B05',
  },
  violet: {
    accent: '#A35CFF',
    'accent-hot': '#EAD2FF',
    'accent-deep': '#2C155B',
    'accent-pair': '#4D7CFF',
    'accent-text': '#B98AFF',
    'accent-fill': '#7A3FD6',
    'accent-fill-2': '#55289E',
  },
  emerald: {
    accent: '#2EE0A0',
    'accent-hot': '#D2FFE9',
    'accent-deep': '#08382A',
    'accent-pair': '#2BB5FF',
    'accent-text': '#2EE0A0',
    'accent-fill': '#0F7A55',
    'accent-fill-2': '#0A5A3E',
  },
};

/** Light-scheme accent text per accent (4.5:1 on white). */
export const accentTextLight: Record<Accent, string> = {
  blue: '#1F56D6',
  ember: '#B53D00',
  violet: '#6A2FD1',
  emerald: '#00754B',
};

/** Solid surfaces: no translucency and no blur anywhere; glass layers become opaque panels. */
export const solid: Partial<RoleMap> = {
  field: 'none',
  'glass-bg': 'var(--lit-solid-bg)',
  'glass-blur': 'none',
  sheen: 'linear-gradient(transparent, transparent)',
  veil: 'color-mix(in srgb, var(--lit-page) 86%, transparent)',
  'corner-glow': 'transparent',
};

/** Pro density: more on screen, never smaller than legible. */
export const pro: Partial<RoleMap> = {
  'gap-section': '16px',
  'gap-item': '8px',
  'pad-panel': '14px',
  'row-h': '40px',
  'control-h': '36px',
};

/** Type roles. `flatType` maps to today's text styles. */
export const litType: Record<TypeRole, { size: string; line: string; weight: string; tracking: string }> = {
  hero: { size: '48px', line: '52px', weight: '400', tracking: '-0.035em' },
  figure: { size: '24px', line: '30px', weight: '500', tracking: '-0.02em' },
  title: { size: '28px', line: '34px', weight: '500', tracking: '-0.02em' },
  heading: { size: '17px', line: '24px', weight: '500', tracking: '-0.01em' },
  body: { size: '15px', line: '22px', weight: '400', tracking: '0' },
  label: { size: '13px', line: '18px', weight: '500', tracking: '0' },
  micro: { size: '11px', line: '14px', weight: '500', tracking: '0.08em' },
};
export const flatTypeMap: Record<TypeRole, string> = {
  hero: 'hero',
  figure: 'xl',
  title: '2xl',
  heading: 'md',
  body: 'base',
  label: 'sm',
  micro: 'xs',
};

const decl = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, val]) => `  ${k}: ${cssValue(val)};`)
    .join('\n');
const roleVars = (m: Partial<RoleMap>) => Object.fromEntries(Object.entries(m).map(([k, val]) => [roleVar(k as Role), val]));
const typeVars = (flatMode: boolean) => {
  const out: Record<string, string> = {};
  for (const [k, t] of Object.entries(litType) as [TypeRole, (typeof litType)[TypeRole]][]) {
    const f = flatTypeMap[k];
    out[`--lit-type-${k}-size`] = flatMode ? `var(--if-text-${f})` : t.size;
    out[`--lit-type-${k}-line`] = flatMode ? `var(--if-leading-${f})` : t.line;
    out[`--lit-type-${k}-weight`] = flatMode ? `var(--if-weight-${f})` : t.weight;
    out[`--lit-type-${k}-tracking`] = flatMode ? '0' : t.tracking;
  }
  return out;
};

const L = `:root:where([data-look='${LIT_LOOK}'])`;

/** The exact text of lit.css. */
export function renderLitCss(): string {
  const missing = roleNames.filter((r) => !(r in flat) || !(r in lit));
  if (missing.length > 0) throw new Error(`roles without a value: ${missing.join(', ')}`);
  const accentBlocks = accents
    .filter((a) => Object.keys(accentSets[a]).length > 0)
    .map((a) => `\n${L.replace('])', `][data-accent='${a}'])`)} {\n${decl(roleVars(accentSets[a]))}\n}\n`)
    .join('');
  const lightAccentBlocks = accents
    .map(
      (a) =>
        `${L.replace('])', `][data-theme='light'][data-accent='${a}'])`)} {\n${decl({ '--lit-accent-text': accentTextLight[a] })}\n}\n`,
    )
    .join('\n');
  return `/**
 * Lit glass role tokens (--lit-*). GENERATED from src/lit/tokens.ts by src/lit/generate.ts.
 * Do not edit by hand: lit/lit.test.ts fails if the two drift. Names and meanings: src/lit/contracts.ts.
 * Loaded by the customer app only, after theme/tokens.css. Never imported by apps/admin.
 */

/* The look switched off: every role is today's skin, flat. */
:root {
${decl({ ...roleVars(flat), ...typeVars(true) })}
}

/* Lit glass, dark, blue. */
${L} {
${decl({ ...roleVars(lit), ...typeVars(false) })}
}
${accentBlocks}
/* Light values: written and tested, not shipped. */
${L.replace('])', "][data-theme='light'])")} {
${decl(roleVars(litLight))}
}

${lightAccentBlocks}
/* Solid surfaces: the in-app switch, and automatically for more contrast, forced colours or reduced transparency. */
${L.replace('])', "][data-surfaces='solid'])")} {
${decl(roleVars(solid))}
}

@media (prefers-contrast: more), (forced-colors: active), (prefers-reduced-transparency: reduce) {
  ${L} {
${decl(roleVars(solid)).replace(/^/gm, '  ')}
  }
}

/* Pro density. */
${L.replace('])', "][data-mode='pro'])")} {
${decl(roleVars(pro))}
}

@media (prefers-reduced-motion: reduce) {
  ${L} {
    --lit-t-quick: 0ms;
    --lit-t-base: 0ms;
    --lit-t-slow: 0ms;
  }
}
`;
}
