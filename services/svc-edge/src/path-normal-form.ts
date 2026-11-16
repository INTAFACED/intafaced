/**
 * The edge decides on a path only when the path is in normal form, so every decision it makes reads the path the
 * service behind it will serve.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * The edge compares paths as strings: `/internal/` is not a public door, `/api/bank/` is held for agent keys, a kill
 * refuses `/api/trade/...` but lets a cancel out. The service behind it does not route on that string. Its router
 * decodes percent-escapes first, so `/%69nternal/x` is served by the `/internal/x` handler while the edge's string
 * comparison saw something else and forwarded it, signed with the edge's own key (project-state #2703).
 *
 * Decoding cleverly on the edge's side would mean predicting every router behind it. Refusing is simpler: a client
 * that builds its URLs with any standard encoder never sends the forms below, so a request that does is refused 400
 * before any decision is made on it.
 *
 * Refused (RFC 3986 §2.3 and §6.2.2):
 *   · an escape of an unreserved character (`A-Z a-z 0-9 - . _ ~`): `%69` is `i`, and a normaliser decodes it;
 *   · an escape of a control character (`%00`-`%1F`, `%7F`) or of a backslash (`%5C`), which no route names;
 *   · an escaped percent sign followed by two hex digits (`%2569`), which a second decode turns into an escape;
 *   · an empty segment (`//`), which a router set to ignore duplicate slashes collapses.
 *
 * Kept, on purpose: an escaped reserved character such as `%2F` inside a segment. `BTC%2FUSDT` is an ordinary
 * market symbol on the CCXT routes, the service's router does not split on it, and the `/internal` check in
 * `routes.ts` decodes it before deciding. Escapes of non-ASCII bytes are kept too: the URL parser writes them itself.
 * Lower-case hex in an escape is kept: once the escapes above are refused it changes no decision.
 *
 * Already handled before this runs (`resolvedPathname`): a raw backslash becomes `/`, `.` and `..` segments
 * (escaped or not) are resolved by the URL parser, a malformed escape or invalid UTF-8 is refused, and a dot
 * segment that appears only after decoding is refused.
 */

export type NotNormal = 'escaped-unreserved' | 'escaped-control' | 'escaped-backslash' | 'double-encoded' | 'empty-segment';

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const ESCAPE = /%([0-9A-Fa-f]{2})/g;
const HEX_PAIR = /^[0-9A-Fa-f]{2}/;

/** Why `pathname` is not in normal form, or null when it is. `pathname` is the URL parser's output, query removed. */
export function notNormalReason(pathname: string): NotNormal | null {
  if (pathname.includes('//')) return 'empty-segment';
  for (const match of pathname.matchAll(ESCAPE)) {
    const byte = Number.parseInt(match[1]!, 16);
    if (UNRESERVED.test(String.fromCharCode(byte))) return 'escaped-unreserved';
    if (byte < 0x20 || byte === 0x7f) return 'escaped-control';
    if (byte === 0x5c) return 'escaped-backslash';
    if (byte === 0x25 && HEX_PAIR.test(pathname.slice(match.index + 3))) return 'double-encoded';
  }
  return null;
}
