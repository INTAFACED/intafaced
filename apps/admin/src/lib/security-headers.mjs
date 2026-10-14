/**
 * Browser security headers for the operator console.
 *
 * Plain `.mjs` on purpose: `next.config.mjs` loads it straight from Node for the static headers, and `middleware.ts` imports
 * the same file for the per-request Content-Security-Policy. One list, no copy to drift.
 *
 * HSTS: TLS ends at the load balancer in front of this process, so over plain http browsers ignore Strict-Transport-Security.
 * It is still sent for the https responses that are forwarded. It is NOT in the static list below and NOT in `next.config.mjs`:
 * `headers()` is baked into the routes manifest at `next build`, so a value there is fixed per image. `src/middleware.ts` sets it
 * from `process.env` on every request instead (`hstsHeaderValue`), so one built image can run at a different ramp stage per
 * deployment. The stage is HSTS_MAX_AGE_SECONDS (default 86400, one day) and HSTS_INCLUDE_SUBDOMAINS (default false);
 * `src/instrumentation.ts` refuses to boot on a bad value (`hstsIssues`), because middleware cannot exit and a throw there is a
 * 500 on every request. Never name these NEXT_PUBLIC_* and never list them under `env` in next.config: either would inline the
 * build-time value. There is no `preload` and no knob for it: it is a one-way registration (see
 * docs/adr/2026-10-14-hsts-staged-ramp-no-preload.md).
 *
 * Roll the CSP out with one staging pass and the browser console open (login, then each console page): a violation is logged
 * there by directive and blocked URL.
 *
 * Permissions-Policy leaves `publickey-credentials-get` and `-create` out on purpose: the founder login uses WebAuthn passkeys
 * and their default allowlist (self) is what it needs. Nothing in the console uses camera, microphone, geolocation or payment.
 */

/** Headers that do not vary per request (and per deployment). Sent on every path, API and static files included. */
export const STATIC_SECURITY_HEADERS = [
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

// ── HSTS (Strict-Transport-Security) ────────────────────────────────────────────────────────────────────────────────

/** Two years, the most any current guidance asks for (Mozilla, OWASP). Also the hard ceiling of HSTS_MAX_AGE_SECONDS. */
export const HSTS_MAX_AGE_LIMIT_SECONDS = 63072000;
/** One day: the gentle value shipped before the variables existed, and the default when they are unset. */
export const HSTS_DEFAULT_MAX_AGE_SECONDS = 86400;
/** Without production posture (APP_ENV dev/test/unset on a laptop), more than this is refused: a copied prod .env must not pin a non-prod host. */
export const HSTS_NON_PRODUCTION_MAX_AGE_SECONDS = 86400;
/** Stable refusal code printed when the HSTS settings are invalid. The per-problem codes are the `code` of each issue. */
export const HSTS_REFUSE_CODE = 'config.hsts_invalid';

/** Public suffixes with two labels that the registrable-domain guard knows. Deliberately short; see `isRegistrableDomain`. */
const TWO_LABEL_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'co.nz',
  'org.nz',
  'net.nz',
  'co.jp',
  'or.jp',
  'ne.jp',
  'ac.jp',
  'co.in',
  'net.in',
  'org.in',
  'co.za',
  'org.za',
  'com.br',
  'net.br',
  'org.br',
  'com.mx',
  'com.ar',
  'com.co',
  'com.sg',
  'com.hk',
  'com.my',
  'com.ph',
  'com.tr',
  'com.cn',
  'com.tw',
  'com.ua',
  'com.pl',
  'co.id',
  'co.il',
  'co.kr',
  'co.th',
]);

/**
 * True when `host` is a name that `includeSubDomains` would turn into a zone-wide policy: the registrable domain itself
 * (`intafaced.com`, `example.co.uk`), a single label (`localhost`), or an IP literal (a leaf by nature, but includeSubDomains is
 * meaningless on it). A conservative guard, not proof of leafness: a host with three or more labels counts as a leaf unless its
 * last two labels are in a short built-in list of two-label public suffixes (co.uk, com.au, ...). It is not the Public Suffix List,
 * so private suffixes (`github.io`, `vercel.app`) and rarer ccTLD suffixes are NOT recognised: `x.vercel.app` passes as a leaf.
 *
 * @param {string} host a hostname (no port, no scheme); case and one trailing dot are ignored
 */
export function isRegistrableDomain(host) {
  const name = String(host).trim().toLowerCase().replace(/\.$/, '');
  if (name === '') return true;
  if (name.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)) return true;
  const labels = name.split('.');
  if (labels.length <= 2) return true;
  return labels.length === 3 && TWO_LABEL_PUBLIC_SUFFIXES.has(labels.slice(-2).join('.'));
}

/** The raw value of a variable, or undefined when it is unset or the empty string (compose passes `KEY=` for unset). */
function setValue(env, key) {
  const raw = env[key];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/**
 * The HSTS stage this environment asks for, parsed strictly and with defaults when a variable is unset. Never throws.
 * `ok` is false when a set value is malformed; the returned numbers are then the defaults, so a caller that skips validation still
 * emits a safe header.
 *
 * @param {Record<string, unknown>} [env]
 * @returns {{ ok: boolean, maxAge: number, includeSubDomains: boolean, issues: { code: string, variable: string }[] }}
 */
export function hstsSettings(env = process.env) {
  /** @type {{ code: string, variable: string }[]} */
  const issues = [];
  let maxAge = HSTS_DEFAULT_MAX_AGE_SECONDS;
  let includeSubDomains = false;

  const rawAge = setValue(env, 'HSTS_MAX_AGE_SECONDS');
  if (rawAge !== undefined) {
    // Canonical digits only: no sign, no exponent, no decimals, no whitespace, no leading zeros. Ten digits cannot overflow.
    if (/^(?:0|[1-9]\d{0,9})$/.test(rawAge) && Number(rawAge) <= HSTS_MAX_AGE_LIMIT_SECONDS) maxAge = Number(rawAge);
    else issues.push({ code: 'hsts.max_age_invalid', variable: 'HSTS_MAX_AGE_SECONDS' });
  }

  const rawInclude = setValue(env, 'HSTS_INCLUDE_SUBDOMAINS');
  if (rawInclude !== undefined) {
    if (rawInclude === 'true') includeSubDomains = true;
    else if (rawInclude !== 'false') issues.push({ code: 'hsts.include_subdomains_invalid', variable: 'HSTS_INCLUDE_SUBDOMAINS' });
  }
  return { ok: issues.length === 0, maxAge, includeSubDomains, issues };
}

/**
 * The Strict-Transport-Security value for this environment, e.g. `max-age=86400` or `max-age=604800; includeSubDomains`. It has no
 * throw path (the middleware runs on every request and cannot refuse the process): a malformed variable falls back to its default
 * here, and `hstsIssues` (run once at boot) is what refuses to start on it. It can never contain `preload`.
 *
 * @param {Record<string, unknown>} [env]
 */
export function hstsHeaderValue(env = process.env) {
  const { maxAge, includeSubDomains } = hstsSettings(env);
  return `max-age=${maxAge}${includeSubDomains ? '; includeSubDomains' : ''}`;
}

/**
 * Everything wrong with the HSTS settings, as stable codes naming the variable (never the value). Empty means the process may start.
 *
 *  - hsts.max_age_invalid / hsts.include_subdomains_invalid: not an integer 0..63072000, or not exactly true|false.
 *  - hsts.max_age_above_non_production_cap: more than one day outside production posture (so a copied prod .env cannot pin a
 *    staging or local host for a year).
 *  - hsts.include_subdomains_host_unknown: includeSubDomains is on but ADMIN_ORIGIN is not a valid URL, so the guard cannot tell
 *    whether the served host is a leaf.
 *  - hsts.include_subdomains_on_registrable_domain: includeSubDomains is on and ADMIN_ORIGIN's host is a registrable domain, which
 *    would make this console's policy cover every subdomain of the company (mail, marketing, third parties). Needs the zone audit
 *    in the ADR first, and a decision in a new ADR, not an env var.
 *
 * @param {Record<string, unknown>} env
 * @param {{ productionPosture: boolean }} options `productionPosture` is `isProductionPosture(env)` from `@intafaced/config`
 * @returns {{ code: string, variable: string }[]}
 */
export function hstsIssues(env, options) {
  const settings = hstsSettings(env);
  const issues = [...settings.issues];
  if (settings.ok && !options.productionPosture && settings.maxAge > HSTS_NON_PRODUCTION_MAX_AGE_SECONDS) {
    issues.push({ code: 'hsts.max_age_above_non_production_cap', variable: 'HSTS_MAX_AGE_SECONDS' });
  }
  if (settings.includeSubDomains) {
    let host = null;
    try {
      host = new URL(typeof env.ADMIN_ORIGIN === 'string' ? env.ADMIN_ORIGIN : '').hostname;
    } catch {
      host = null;
    }
    if (host === null || host === '') issues.push({ code: 'hsts.include_subdomains_host_unknown', variable: 'ADMIN_ORIGIN' });
    else if (isRegistrableDomain(host)) {
      issues.push({ code: 'hsts.include_subdomains_on_registrable_domain', variable: 'HSTS_INCLUDE_SUBDOMAINS' });
    }
  }
  return issues;
}
