/**
 * Browser security headers for the operator console.
 *
 * Plain `.mjs` on purpose: `next.config.mjs` loads it straight from Node for the static headers, and `middleware.ts` imports
 * the same file for the per-request Content-Security-Policy. One list, no copy to drift.
 *
 * HSTS: TLS ends at the load balancer in front of this process, so over plain http browsers ignore Strict-Transport-Security.
 * It is still sent for the https responses that are forwarded. No `preload`: that is a one-way registration, not a header.
 *
 * Permissions-Policy leaves `publickey-credentials-get` and `-create` out on purpose: the founder login uses WebAuthn passkeys
 * and their default allowlist (self) is what it needs. Nothing in the console uses camera, microphone, geolocation or payment.
 */

/** Headers that do not vary per request. Sent on every path, API and static files included. */
export const STATIC_SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), display-capture=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

/** A fresh, unguessable value for one response (base64 of a random UUID, the pattern Next documents). */
export function createNonce() {
  return btoa(crypto.randomUUID());
}

/**
 * The page policy. Next stamps this nonce onto its own bootstrap and chunk <script> tags when the same policy arrives on the
 * REQUEST (middleware forwards it), so `script-src` needs no 'unsafe-inline'. `'strict-dynamic'` lets those nonced scripts load
 * the chunks they import; it makes browsers ignore 'self' for scripts, which is intended.
 *
 *  - style-src 'unsafe-inline': React style attributes (e.g. `style={{ display: 'contents' }}`) and Next's own inline <style>.
 *    Styles cannot run code, so this is the one allowance that costs little.
 *  - font-src 'self': `next/font/google` downloads Inter at build time and serves it from /_next/static.
 *  - connect-src 'self': the browser only calls this origin's /api routes; the edge is called server side.
 *  - 'unsafe-eval' only under `next dev`, which React Refresh needs. Never in a production build.
 *
 * @param {string} nonce
 * @param {{ development?: boolean }} [options]
 */
export function contentSecurityPolicy(nonce, options = {}) {
  const development = options.development ?? process.env.NODE_ENV === 'development';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}
