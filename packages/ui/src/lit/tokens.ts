/**
 * Volt: role token values (the owner's pick, 2026-11-21). Names and meanings are in `./contracts.ts`; this file holds the values.
 *
 * Emitted into `lit.css` by `renderLitCss()` (run `pnpm exec tsx src/lit/generate.ts` in packages/ui and commit both
 * files; `lit.test.ts` fails if they drift):
 *
 * - `flat`: no `data-look` on the root (the kit gallery's flat view). Every role resolves to today's `--if-*` tokens.
 *   Hex values never appear here.
 * - `lit`: Volt, dark: the kit's first values (`litBase`) with Volt's own (`voltDark`) over them. The beta is dark only.
 * - `litLight`: Volt's light values for the same roles, behind the scheme switch; written now so contrast tests run on
 *   both schemes.
 * - `solid` and `pro`: the Solid surfaces mode (no translucency, no blur) and Pro density.
 *
 * Budgets the values keep: money and text sit on opaque content panels (`solid-bg`), glass
 * and blur are only on the nav and sheet layers, and text roles meet 4.5:1 on every solid surface.
 */
import { cssValue } from '../theme/tokens.js';
import { LIT_LOOK, roleNames, roleVar, type Role, type TypeRole } from './contracts.js';

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
  'object-bg': v('panel'),
  'object-fg': v('fg'),
  'object-shadow': 'none',
  'object-spark-bg': v('lime'),
  'object-spark-fg': v('on-lime'),
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
  'cents-size': '1em',
  'cents-shift': '0',
  'cents-tone': 'currentColor',
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

/** The kit's first values, dark: the roles Volt (below) leaves as they were written. */
const litBase: RoleMap = {
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
  'object-bg':
    'radial-gradient(120% 90% at 0% 0%, rgba(255, 255, 255, 0.08), transparent 55%), linear-gradient(160deg, #1A1C24, #07080C 72%)',
  'object-fg': '#F4F5F8',
  'object-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.14), inset 0 0 0 1px rgba(255, 255, 255, 0.06), 0 30px 50px -24px rgba(0, 0, 0, 1)',
  'object-spark-bg': 'linear-gradient(160deg, var(--lit-accent-hot), var(--lit-accent) 60%)',
  'object-spark-fg': '#04050A',
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
  'cents-size': '0.6em',
  'cents-shift': '0',
  'cents-tone': 'var(--lit-text-3)',
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

/** The kit's first light values for the same roles, under Volt's light set below. */
const litBaseLight: Partial<RoleMap> = {
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

/**
 * Volt's material, as the owner picked it from the premium spec (25 Nov, "1A, 2B, 3A"). Each pick is one line:
 * - `FIGURE_FACE` (1): type and figures in Manrope, round, light, tabular; Inter is the other face on offer.
 * - `CENTS` (2): a big figure's cents smaller and dimmed on its line; `raise` lifts them small instead. Tables keep
 *   full cents.
 * - Panels (3): a Simple screen draws no panel paint on the black page; the markets board and Pro mode draw flat
 *   near-black tiles (`TILES`), a board by `data-panels="tiles"` (PageGrid's `panels`). One material: Pro differs
 *   only in density and tiles.
 */
const FIGURE_FACE: 'manrope' | 'inter' = 'manrope';
const CENTS: 'raise' | 'dim' = 'dim';

const FACES = {
  manrope: "'Manrope Variable', Manrope, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  inter: "'Inter Variable', Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
} as const;
const CENTS_LOOK = {
  raise: { 'cents-size': '0.42em', 'cents-shift': '0.95em', 'cents-tone': 'currentColor' },
  dim: { 'cents-size': '0.6em', 'cents-shift': '0', 'cents-tone': 'var(--lit-text-3)' },
} as const;
/** Flat near-black tiles with no lip, shadow or rim (Robinhood Legend's): Pro's panels and the markets board's. */
const TILES: Partial<RoleMap> = {
  'solid-bg': '#0D0E0E',
  'solid-bg-raised': '#151616',
  'radius-panel': '6px',
  'radius-tile': '6px',
  'solid-rim': 'rgba(255, 255, 255, 0)',
  'solid-rim-dim': 'rgba(255, 255, 255, 0)',
};
/** No panel paint: a panel is the black page itself, edged by one even hairline (the solid rim, set in voltDark) as the picked samples draw it (the owner's batch2/15). */
const NO_PANELS: Partial<RoleMap> = {
  'solid-bg': '#000000',
  'solid-bg-raised': '#1A1A1A',
};

/**
 * Volt: matte black and stone, heavy and tactile, with one electric chartreuse spark used once per screen as light on
 * the one thing that matters. The chartreuse (#E0F83A) is the yellow-green the owner's references share (sampled from
 * them, intafaced issue 9302), replacing the earlier lemon (#FAF33E), which sat 17.5 (CIEDE2000) from warning amber
 * (#FFC452); the chartreuse sits 22.9 from it and 26.5 from gain green (#3DDC97), so a warning and a gain never read
 * as the spark. As text it is 16.6:1 on the dark page; on the light page text takes its deep cut (#4A5800, 6.2:1);
 * on a fill its text is ink (14.3:1 at the fill's darkest point). As a ring it passes 3:1 on both pages (the kit page
 * shows the numbers), but the focus ring stays white (ink in light): never the spark, which it must stand out against
 * (contracts.ts). lit.test.ts holds every one of these floors. Today's lime everywhere (pills, ticks, progress) is drawn in ink instead, so the spark is the only
 * colour on a screen. Type and figures are Manrope: round, with light figures in tabular digits.
 */
const voltDark: Partial<RoleMap> = {
  page: '#000000',
  'page-2': '#000000',
  field: 'none',
  'text-1': '#F3F2EC',
  'text-2': '#AAA9A1',
  'text-3': '#8F8E87',
  // A disabled label still reads: 4.5:1 on every solid surface (lit.test.ts), quieter than text-3. It was #4E4D49
  // (2.0:1 to 2.4:1), which the look gate refused (run 45029211940: a disabled "Lock" at 2.17:1).
  'text-disabled': '#86857F',
  line: 'rgba(243, 242, 236, 0.07)',
  'line-strong': 'rgba(243, 242, 236, 0.13)',
  accent: '#E0F83A',
  'accent-hot': '#F2FFB0',
  'accent-deep': '#2F3A05',
  'accent-pair': '#F3F2EC',
  'accent-text': '#E0F83A',
  'accent-fill': '#E0F83A',
  'accent-fill-2': '#CDE82A',
  'on-accent': '#0A0A09',
  up: '#3DDC97',
  down: '#FF5E57',
  'up-text': '#3DDC97',
  'down-text': '#FF7A73',
  'solid-bg-sunken': '#0A0A0A',
  'solid-lip': 'none',
  'solid-rim': 'rgba(243, 242, 236, 0.1)',
  'solid-rim-dim': 'rgba(243, 242, 236, 0.1)',
  'solid-wall': '#050505',
  'solid-shadow': 'none',
  sheen: 'linear-gradient(transparent, transparent)',
  'fill-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.55), 0 0 18px color-mix(in srgb, var(--lit-accent) 30%, transparent)',
  'corner-glow': 'color-mix(in srgb, var(--lit-accent) 22%, transparent)',
  'glass-bg': 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.01) 70%), rgba(18, 18, 17, 0.88)',
  'glass-blur': 'blur(20px) saturate(120%)',
  'glass-rim': 'rgba(255, 255, 255, 0.14)',
  'glass-rim-dim': 'rgba(255, 255, 255, 0.04)',
  'glass-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.07), 0 18px 40px -12px rgba(0, 0, 0, 0.9)',
  scrim: 'rgba(0, 0, 0, 0.72)',
  veil: 'rgba(10, 10, 9, 0.6)',
  'primary-bg': '#E0F83A',
  'primary-fg': '#0A0A09',
  'primary-shadow': 'none',
  'secondary-bg': 'linear-gradient(180deg, #1F1F1D, #161615)',
  'secondary-fg': '#F3F2EC',
  'secondary-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.07), inset 0 0 0 1px rgba(255, 255, 255, 0.05)',
  'key-bg': 'linear-gradient(180deg, #1F1F1D, #161615)',
  'key-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.07), 0 2px 0 0 #050505',
  'key-lit-bg': 'linear-gradient(180deg, #2A2A27, #1E1E1C)',
  'key-lit-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 2px 0 0 #050505',
  'object-bg':
    'radial-gradient(120% 90% at 0% 0%, rgba(255, 255, 255, 0.09), transparent 55%), linear-gradient(160deg, #1D1D1B, #050505 72%)',
  'object-fg': '#F3F2EC',
  'object-shadow':
    'inset 0 1px 0 rgba(255, 255, 255, 0.14), inset 0 0 0 1px rgba(255, 255, 255, 0.06), 0 2px 0 0 #000000, 0 30px 50px -24px rgba(0, 0, 0, 1)',
  'object-spark-bg': 'linear-gradient(180deg, #EAFF6A, #E0F83A 45%, #CDE82A)',
  'object-spark-fg': '#0A0A09',
  'control-bg': '#0E0E0D',
  'control-rim': 'rgba(243, 242, 236, 0.37)',
  'control-rim-active': 'rgba(243, 242, 236, 0.6)',
  focus: '#FFFFFF',
  'legal-bg': '#161615',
  'legal-border': '#B8B7B0',
  'refusal-bg': '#121211',
  'refusal-fg': '#E8E7E1',
  'test-tag-bg': 'rgba(243, 242, 236, 0.08)',
  'test-tag-fg': '#AAA9A1',
  'status-done': '#3DDC97',
  'status-unknown': '#AAA9A1',
  'font-ui': FACES[FIGURE_FACE],
  'font-figure': FACES[FIGURE_FACE],
  ...CENTS_LOOK[CENTS],
  'radius-panel': '28px',
  'radius-tile': '20px',
  'radius-key': '999px',
  'radius-control': '999px',
  ...NO_PANELS,
};

const volt = {
  // Volt's light keeps its dark set wherever the light set says nothing (stone material, faces, the spark).
  light: {
    ...voltDark,
    page: '#E7E5DF',
    'page-2': '#DDDBD4',
    field: 'radial-gradient(120% 60% at 50% -12%, rgba(255, 255, 255, 0.7), transparent 62%)',
    'text-1': '#0D0D0C',
    'text-2': '#44433E',
    'text-3': '#575650',
    'text-disabled': '#605F5A',
    line: 'rgba(13, 13, 12, 0.08)',
    'line-strong': 'rgba(13, 13, 12, 0.15)',
    'accent-text': '#4A5800',
    'on-accent': '#0A0A09',
    'up-text': '#086340',
    'down-text': '#A82226',
    'solid-bg': '#F5F4F0',
    'solid-bg-raised': '#EDECE7',
    'solid-bg-sunken': '#DCDAD3',
    'solid-lip': 'inset 0 1px 0 rgba(255, 255, 255, 0.9), inset 0 -1px 0 rgba(13, 13, 12, 0.06)',
    'solid-wall': '#C9C7BF',
    'solid-rim': 'rgba(255, 255, 255, 0.95)',
    'solid-rim-dim': 'rgba(13, 13, 12, 0.08)',
    'solid-shadow': '0 2px 0 0 var(--lit-solid-wall), 0 24px 40px -26px rgba(30, 28, 20, 0.45)',
    'glass-bg': 'linear-gradient(180deg, rgba(251, 250, 247, 0.94), rgba(237, 236, 231, 0.9))',
    'glass-rim': 'rgba(255, 255, 255, 0.95)',
    'glass-rim-dim': 'rgba(13, 13, 12, 0.1)',
    'glass-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 16px 32px -14px rgba(30, 28, 20, 0.4)',
    scrim: 'rgba(13, 13, 12, 0.4)',
    veil: 'rgba(231, 229, 223, 0.7)',
    'primary-bg': 'linear-gradient(180deg, #2A2A27, #0D0D0C)',
    'primary-fg': '#E0F83A',
    'primary-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.16), 0 8px 22px -10px rgba(13, 13, 12, 0.6)',
    'secondary-bg': 'linear-gradient(180deg, #FBFAF7, #EFEEE9)',
    'secondary-fg': '#0D0D0C',
    'secondary-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.95), inset 0 0 0 1px rgba(13, 13, 12, 0.08)',
    'key-bg': 'linear-gradient(180deg, #FBFAF7, #EFEEE9)',
    'key-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 2px 0 0 #C9C7BF',
    'key-lit-bg': 'linear-gradient(180deg, #FFFFFF, #F3F2EE)',
    'key-lit-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 2px 0 0 #C9C7BF',
    'object-bg':
      'radial-gradient(120% 90% at 0% 0%, rgba(255, 255, 255, 0.09), transparent 55%), linear-gradient(160deg, #262624, #0A0A09 72%)',
    'object-fg': '#F3F2EC',
    'object-shadow':
      'inset 0 1px 0 rgba(255, 255, 255, 0.14), inset 0 0 0 1px rgba(255, 255, 255, 0.06), 0 2px 0 0 #000000, 0 26px 40px -22px rgba(30, 28, 20, 0.6)',
    'control-bg': '#FBFAF7',
    'control-rim': 'rgba(13, 13, 12, 0.5)',
    'control-rim-active': 'rgba(13, 13, 12, 0.7)',
    focus: '#0D0D0C',
    'legal-bg': '#FBFAF7',
    'legal-fg': '#0D0D0C',
    'legal-border': '#44433E',
    'refusal-bg': '#EDECE7',
    'refusal-fg': '#0D0D0C',
    'refusal-border': 'rgba(13, 13, 12, 0.2)',
    'warn-text': '#734000',
    'error-text': '#8F1B17',
    'test-tag-bg': 'rgba(13, 13, 12, 0.06)',
    'test-tag-fg': '#44433E',
    'status-pending': '#734000',
    'status-failed': '#8F1B17',
    'status-done': '#086340',
    'status-unknown': '#44433E',
    'status-stale': '#734000',
  },
  // Today's lime is drawn in ink: the spark is placed by Volt's own sheets, once per screen.
  today: {
    '--if-lime': 'var(--lit-text-1)',
    '--if-lime-hover': 'color-mix(in srgb, var(--lit-text-1) 88%, var(--lit-page))',
    '--if-lime-press': 'color-mix(in srgb, var(--lit-text-1) 76%, var(--lit-page))',
    '--if-on-lime': 'var(--lit-page)',
    '--if-lime-soft': 'color-mix(in srgb, var(--lit-text-1) 10%, transparent)',
    '--if-accent-text': 'var(--lit-text-1)',
    '--if-alloc-1': 'var(--lit-text-1)',
    '--color-accent': 'var(--lit-text-1)',
    '--color-selected': 'color-mix(in srgb, var(--lit-text-1) 10%, var(--lit-solid-bg))',
    '--if-font-mono': 'var(--lit-font-figure)',
  },
  type: {
    hero: { size: '56px', line: '56px', weight: '300', tracking: '-0.035em' },
    figure: { size: '28px', line: '32px', weight: '300', tracking: '-0.02em' },
    title: { size: '30px', line: '36px', weight: '500', tracking: '-0.025em' },
    heading: { size: '17px', line: '24px', weight: '600', tracking: '-0.01em' },
  },
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
  ...TILES,
  'gap-section': '16px',
  'gap-item': '8px',
  'pad-panel': '14px',
  'row-h': '40px',
  'control-h': '36px',
};

/** Type roles. `flatType` maps to today's text styles. */
const litBaseType: Record<TypeRole, { size: string; line: string; weight: string; tracking: string }> = {
  hero: { size: '48px', line: '52px', weight: '400', tracking: '-0.035em' },
  figure: { size: '24px', line: '30px', weight: '500', tracking: '-0.02em' },
  title: { size: '28px', line: '34px', weight: '500', tracking: '-0.02em' },
  heading: { size: '17px', line: '24px', weight: '500', tracking: '-0.01em' },
  body: { size: '15px', line: '22px', weight: '400', tracking: '0' },
  label: { size: '13px', line: '18px', weight: '500', tracking: '0' },
  micro: { size: '11px', line: '14px', weight: '500', tracking: '0.08em' },
};

/** Volt, the look (owner's pick, 2026-11-21): dark, the one the beta ships. */
export const lit: RoleMap = { ...litBase, ...voltDark };
/** Volt's light values: written and contrast-tested, behind the scheme switch; the beta is dark only. */
export const litLight: Partial<RoleMap> = { ...litBaseLight, ...volt.light };
/** Type roles, in Volt's sizes and weights. */
export const litType: Record<TypeRole, { size: string; line: string; weight: string; tracking: string }> = { ...litBaseType, ...volt.type };
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

/**
 * Today's names drawn in the look's roles. A room not yet on a template reads `--if-*` and the older `--color-*` names,
 * so with only the roles above it kept today's skin under the look (intafaced issue 9188: Home, the desk and Money showed
 * almost nothing of it). Each entry points at a role, never a value, so the accent, light and Solid surfaces blocks
 * reach those rooms too. Up and down stay today's, and their tints are mixed from them, so the red-for-up preference keeps working. Emitted on
 * `:root[data-look]`, above the app's own light-theme overrides of the same names.
 */
const todayInLookRoles: Record<string, string> = {
  '--if-bg': 'var(--lit-page)',
  '--if-panel': 'var(--lit-solid-bg)',
  '--if-field': 'var(--lit-solid-bg-raised)',
  '--if-hover': 'var(--lit-solid-bg-raised)',
  '--if-raised': 'var(--lit-solid-bg-raised)',
  '--if-pill-active': 'color-mix(in srgb, var(--lit-text-1) 14%, var(--lit-solid-bg))',
  '--if-popover': 'var(--lit-solid-bg-raised)',
  '--if-menu': 'var(--lit-solid-bg-raised)',
  '--if-tooltip': 'var(--lit-solid-bg-raised)',
  '--if-line': 'var(--lit-line-strong)',
  '--if-line-strong': 'var(--lit-line-strong)',
  '--if-line-stronger': 'color-mix(in srgb, var(--lit-text-1) 24%, transparent)',
  '--if-line-popup': 'var(--lit-line-strong)',
  '--if-grid': 'var(--lit-line)',
  '--if-fg': 'var(--lit-text-1)',
  '--if-fg-2': 'var(--lit-text-2)',
  '--if-fg-3': 'var(--lit-text-3)',
  '--if-fg-disabled': 'var(--lit-text-disabled)',
  '--if-overlay-hover': 'color-mix(in srgb, var(--lit-text-1) 12%, transparent)',
  '--if-overlay-press': 'color-mix(in srgb, var(--lit-text-1) 18%, transparent)',
  '--if-overlay-disabled': 'color-mix(in srgb, var(--lit-text-1) 6%, transparent)',
  '--if-lime': 'var(--lit-accent-fill)',
  '--if-lime-hover': 'color-mix(in srgb, var(--lit-accent-fill) 85%, var(--lit-on-accent))',
  '--if-lime-press': 'var(--lit-accent-fill-2)',
  '--if-on-lime': 'var(--lit-on-accent)',
  '--if-lime-soft': 'color-mix(in srgb, var(--lit-accent) 16%, transparent)',
  '--if-accent-text': 'var(--lit-accent-text)',
  '--if-focus': 'var(--lit-focus)',
  '--if-alloc-1': 'var(--lit-accent)',
  '--if-warn-text': 'var(--lit-warn-text)',
  '--if-error-text': 'var(--lit-error-text)',
  '--if-scrim': 'var(--lit-scrim)',
  // Tints of today's up and down, so the red-for-up swap still reaches them.
  '--if-up-bg': 'color-mix(in srgb, var(--if-up) 22%, transparent)',
  '--if-down-bg': 'color-mix(in srgb, var(--if-down) 22%, transparent)',
  '--if-up-bg-soft': 'color-mix(in srgb, var(--if-up) 12%, transparent)',
  '--if-font-ui': 'var(--lit-font-ui)',
  '--if-r-md': 'var(--lit-radius-tile)',
  '--if-r-lg': 'var(--lit-radius-panel)',
  '--color-background': 'var(--lit-page)',
  '--color-shell': 'var(--lit-page-2)',
  '--color-surface': 'var(--lit-solid-bg)',
  '--color-surface-raised': 'var(--lit-solid-bg-raised)',
  '--color-selected': 'color-mix(in srgb, var(--lit-accent) 14%, var(--lit-solid-bg))',
  '--color-accent': 'var(--lit-accent-fill)',
  '--color-text': 'var(--lit-text-1)',
  '--color-muted': 'var(--lit-text-2)',
  '--color-unavailable-text': 'var(--lit-text-2)',
  '--color-mix-secondary': 'var(--lit-text-3)',
  '--color-divider': 'var(--lit-line-strong)',
  '--color-border': 'var(--lit-line-strong)',
  '--color-search-border': 'var(--lit-line-strong)',
  '--color-destination-border': 'var(--lit-line-strong)',
};

const L = `:root:where([data-look='${LIT_LOOK}'])`;

/** The exact text of lit.css. */
export function renderLitCss(): string {
  const missing = roleNames.filter((r) => !(r in flat) || !(r in lit));
  if (missing.length > 0) throw new Error(`roles without a value: ${missing.join(', ')}`);
  return `/**
 * Volt role tokens (--lit-*). GENERATED from src/lit/tokens.ts by src/lit/generate.ts.
 * Do not edit by hand: lit/lit.test.ts fails if the two drift. Names and meanings: src/lit/contracts.ts.
 * Loaded by the customer app only, after theme/tokens.css. Never imported by apps/admin.
 */

/* Without data-look on the root (the kit gallery's flat view): every role is today's skin, flat. */
:root {
${decl({ ...roleVars(flat), ...typeVars(true) })}
}

/* Volt, dark: the look. */
${L} {
${decl({ ...roleVars(lit), ...typeVars(false) })}
}

/* Volt, light: written and tested, behind the scheme switch; the beta is dark only. */
${L.replace('])', "][data-theme='light'])")} {
${decl(roleVars(litLight))}
}

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

/* Flat tiles on a board that asks for them (the markets board): its panels are tiles, in Simple too. */
:where([data-look='${LIT_LOOK}']) [data-panels='tiles'] {
${decl(roleVars(TILES))}
}

/* Today's names in the look's roles (todayInLookRoles). */
:root[data-look='${LIT_LOOK}'] {
${decl({ ...todayInLookRoles, ...volt.today })}
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
