/**
 * The authentication and permission errors a call to the trading REST API (`/api/v1`) can answer with, published at
 * `/developers/errors/auth` (DV-errors-02). One entry per refusal a key holder can meet: the body `code` a client
 * branches on, the HTTP status, and the `intafacedCode` that names the decision.
 *
 * svc-edge's tests hold its refusals to this list in both directions (`auth-errors-catalogue.test.ts`): every key,
 * signature, scope, environment and authority refusal it sends is here with the same status and codes, and every
 * entry the edge answers is one it sends. The one entry the edge does not answer is the missing key: the edge forwards
 * a call with no key, and the trading service answers it in its CCXT dialect.
 *
 * `anchor` is the fragment of the entry on the page. The edge's key and signature refusals link to
 * `/developers/errors/auth#<code>`, so an entry whose code is its own is anchored by it. The two `PermissionDenied`
 * entries share a code and are anchored by their `intafacedCode`; their replies link elsewhere (the scope refusal to
 * the permission table) or carry the envelope's default link, and the trading service's missing-key reply carries none.
 */

export const AUTH_ERRORS_PATH = '/developers/errors/auth' as const;

export type AuthErrorCause =
  | 'missing'
  | 'denied'
  | 'revoked'
  | 'expired'
  | 'frozen'
  | 'scope'
  | 'environment'
  | 'unsigned'
  | 'stale'
  | 'future'
  | 'tampered'
  | 'replay'
  | 'window_unset'
  | 'authority_unavailable';

export interface AuthErrorEntry {
  readonly cause: AuthErrorCause;
  /** The body `code`, what a client branches on. */
  readonly code: string;
  readonly status: 401 | 403 | 503;
  /** The decision behind the code, sent beside it as `intafacedCode` (absent for the edge's own outage). */
  readonly intafacedCode: string | null;
  /** Who answers: the edge, or the trading service the edge forwarded the call to. */
  readonly answeredBy: 'edge' | 'trade';
  readonly anchor: string;
}

const entry = (
  cause: AuthErrorCause,
  code: string,
  status: AuthErrorEntry['status'],
  intafacedCode: string | null,
  answeredBy: AuthErrorEntry['answeredBy'] = 'edge',
  anchor: string = code,
): AuthErrorEntry => ({ cause, code, status, intafacedCode, answeredBy, anchor });

export const AUTH_ERROR_CATALOGUE: readonly AuthErrorEntry[] = [
  entry('missing', 'AuthenticationError', 401, 'auth.required', 'trade'),
  entry('denied', 'edge.api_key_denied', 401, 'auth.api_key_denied'),
  entry('revoked', 'edge.api_key_revoked', 401, 'auth.api_key_revoked'),
  entry('expired', 'edge.api_key_expired', 401, 'auth.api_key_expired'),
  entry('frozen', 'account_frozen', 403, 'auth.account_frozen'),
  entry('scope', 'PermissionDenied', 403, 'scope.denied', 'edge', 'scope.denied'),
  entry('environment', 'PermissionDenied', 403, 'env.mismatch', 'edge', 'env.mismatch'),
  entry('unsigned', 'edge.request_unsigned', 401, 'auth.request_unsigned'),
  entry('stale', 'edge.request_stale', 401, 'auth.request_stale'),
  entry('future', 'edge.request_future', 401, 'auth.request_future'),
  entry('tampered', 'edge.request_tampered', 401, 'auth.request_tampered'),
  entry('replay', 'edge.request_replay', 401, 'auth.request_replay'),
  entry('window_unset', 'edge.request_window_unset', 503, 'auth.request_window_unset'),
  entry('authority_unavailable', 'edge.authority_unavailable', 503, null),
];
