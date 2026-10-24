import { UPSTREAMS } from './routes.js';

/**
 * The hosted checkout pages svc-pay serves under its edge prefix (`checkout-page.ts`).
 *
 * Every other proxied answer is JSON, so the proxy keeps only its content type and
 * refuses any redirect. These pages are HTML that an anonymous payer opens from a
 * shared link, and two things they rely on were lost at the door:
 *
 * - Their own policy. `no-store` keeps a payer's rail reference out of a shared
 *   browser or proxy cache, and the content security policy that allows no script
 *   and no framing is what makes the page a poor XSS or clickjacking target.
 *   (The edge's own helmet headers already send no-referrer, frame deny and
 *   nosniff on every answer; the page's values are passed too, so it states its
 *   own policy.)
 * - The 303 after "Continue". svc-pay answers the session POST with a redirect to
 *   the session page so a refresh cannot open a second payment. A proxy that
 *   refuses redirects turned every Continue into a 502.
 *
 * Only a 303 to this checkout's own session page is passed on. Anything else
 * still refuses, so an upstream cannot send a payer to another host or path.
 * svc-pay builds that address from `PAY_PUBLIC_BASE_PATH`, which must be this
 * prefix for its link addresses to work at all.
 */

const PAY_PREFIX = UPSTREAMS.find((u) => u.module === 'pay')?.prefix ?? '/api/pay';
const CHECKOUT_PREFIX = `${PAY_PREFIX}/checkout`;
const LINK_PREFIX = `${PAY_PREFIX}/pay/link/`;
const SESSION_PREFIX = `${CHECKOUT_PREFIX}/session/`;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

const CHECKOUT_HEADERS = [
  'cache-control',
  'pragma',
  'referrer-policy',
  'x-content-type-options',
  'x-frame-options',
  'content-security-policy',
] as const;

export function isHostedCheckoutPath(pathname: string): boolean {
  return pathname === CHECKOUT_PREFIX || pathname.startsWith(`${CHECKOUT_PREFIX}/`) || pathname.startsWith(LINK_PREFIX);
}

/** `manual` only where a checkout redirect is expected; everywhere else a redirect stays an upstream failure. */
export function upstreamRedirectMode(pathname: string): 'manual' | 'error' {
  return isHostedCheckoutPath(pathname) ? 'manual' : 'error';
}

/** The checkout page's own policy headers, on checkout paths only. */
export function hostedCheckoutHeaders(pathname: string, upstream: { get(name: string): string | null }): Record<string, string> {
  if (!isHostedCheckoutPath(pathname)) return {};
  const out: Record<string, string> = {};
  for (const name of CHECKOUT_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

/**
 * For a 3xx on a checkout path: the Location to pass on, or null to refuse it.
 * Only a 303 to a session page of this checkout is passed on.
 */
export function hostedCheckoutLocation(status: number, upstream: { get(name: string): string | null }): string | null {
  if (status !== 303) return null;
  const location = upstream.get('location')?.trim() ?? '';
  if (!location.startsWith(SESSION_PREFIX)) return null;
  return SESSION_TOKEN.test(location.slice(SESSION_PREFIX.length)) ? location : null;
}
