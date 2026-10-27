/**
 * @intafaced/ui — the design system.
 *
 * Black glass, phosphor green. Import `@intafaced/ui/tokens.css` once at the
 * app root; everything else reads the custom properties from there.
 */
export * from './tokens.js';
export * from './primitives.js';

/**
 * Customer-app redesign kit (UI-SPEC section 4.1). Its CSS is imported separately, in the
 * order documented at the top of src/theme/theme.css: src/theme/tokens.css, theme.css, base.css.
 */
export * from './components/index.js';
/** The brand: mark, wordmark, lockups and the iris, drawn from the kit in `packages/ui/brand/` (CSS: `@intafaced/ui/brand.css`). */
export * from './brand/brand.js';
export { colors as themeColors, fonts as themeFonts, textStyles, radii, motion as themeMotion, redUpOverrides } from './theme/tokens.js';
