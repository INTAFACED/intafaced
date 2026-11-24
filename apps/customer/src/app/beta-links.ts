import { betaHides } from './beta-volt';

/**
 * The beta's links: with the beta switch on, no link anywhere in the app opens a room the beta hides. Every link
 * the app draws, in a room or in the kit (@intafaced/ui), is a JSX `<a>`, so the beta's build swaps React's JSX runtime
 * for this wrap of it (vite.config.ts betaVolt) and an `<a>` whose app path betaHides() draws nothing, whoever wrote it.
 * Other builds use React's runtime untouched. An anchor made outside JSX is refused by beta-links.test.ts.
 */
type Make = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => unknown;
/** React's production runtime (`jsx`, `jsxs`) or its development one (`jsxDEV`, which `vite dev` and the tests compile to). */
export interface JsxRuntime {
  jsx?(type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]): unknown;
  jsxs?(type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]): unknown;
  jsxDEV?(type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]): unknown;
  Fragment: unknown;
}

/** The app path an `href` opens, or undefined for another site, a mail link or an in-page anchor. */
export function appPath(href: unknown): string | undefined {
  if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) return undefined;
  return href.split(/[?#]/)[0] || undefined;
}

/** Whether the beta's build leaves out a link to `href` (always no with the switch off). */
export function betaDropsLink(href: unknown): boolean {
  const path = appPath(href);
  return path !== undefined && betaHides(path);
}

/**
 * Stands in for a dropped `<a>`. It is still an element, so a component that clones or merges props into the link it was
 * given (a Button's `render={<a href=… />}`) gets nothing back instead of an error, and the hidden room's link is gone
 * with whatever was put inside it.
 */
export function BetaDroppedLink(): null {
  return null;
}

/** React's runtime with every `<a>` to a room the beta hides drawn as nothing. The list is read per link, so tests can set it. */
export function betaRuntime<R extends JsxRuntime>(real: R): R {
  const guard = (make: Make | undefined): Make | undefined =>
    make &&
    ((type, props, ...rest) =>
      type === 'a' && betaDropsLink(props?.href) ? make(BetaDroppedLink, props, ...rest) : make(type, props, ...rest));
  return { ...real, jsx: guard(real.jsx), jsxs: guard(real.jsxs), jsxDEV: guard(real.jsxDEV) };
}
