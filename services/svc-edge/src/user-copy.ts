/**
 * User-visible copy for svc-edge public / proxy refuse paths.
 *
 * Every string a client reads from a refuse on the public door or proxy goes
 * through @intafaced/i18n. Mode is prod on purpose: a missing key must not throw
 * on a live geo-block or origin refuse, and must not invent English — tUnsafe
 * renders the dotted key name, which is greppable and not blank.
 *
 * Catalog keys that already exist on tip are aliased from edge error codes.
 * Codes with no catalog row stay the code itself until a catalog PR adds copy.
 * Operator / admin diagnostic sentences stay on structured fields and ops doors.
 */
import { createTranslator } from '@intafaced/i18n';

const translator = createTranslator('en', undefined, { mode: 'prod', onMissing: () => undefined });

/**
 * Edge refuse codes that already have a catalog sentence. Unlisted codes
 * are passed through as keys — missing → dotted name, never invented copy.
 */
const CATALOG_ALIAS: Readonly<Record<string, string>> = {
  'edge.no_route': 'error.notFound',
  'edge.s2s_not_proxied': 'error.notFound',
  'edge.unresolvable_path': 'error.notFound',
  'edge.origin_not_allowed': 'error.forbidden',
  'auth.csrf_origin_required': 'error.forbidden',
  'edge.rate_limited': 'error.rateLimited',
  'edge.upstream_unavailable': 'error.network',
  'edge.upstream_unwired': 'error.network',
  'edge.authority_unavailable': 'error.generic',
  'edge.geo_blocked': 'error.region.blocked',
  'edge.geo_region_unknown': 'error.region.blocked',
  'edge.kill_switch_undecidable': 'error.generic',
  'edge.network_flagged': 'error.forbidden',
  'edge.network_dark': 'error.network',
  'edge.network_unconfigured': 'error.generic',
  // Key refusals and the account freeze (api-key-refusal.ts). Generic sentences until the catalogue gains
  // dedicated ones; the code and the docs link carry the detail.
  'edge.api_key_denied': 'error.forbidden',
  'edge.api_key_revoked': 'error.forbidden',
  'edge.api_key_expired': 'error.forbidden',
  account_frozen: 'error.forbidden',
  // The caller's request signature (api-key-refusal.ts, DV-auth-01). The code and the docs link carry the detail;
  // a blank owner window is the platform's to set, so it takes the generic sentence.
  'edge.request_unsigned': 'error.forbidden',
  'edge.request_stale': 'error.forbidden',
  'edge.request_future': 'error.forbidden',
  'edge.request_tampered': 'error.forbidden',
  'edge.request_replay': 'error.forbidden',
  'edge.request_window_unset': 'error.generic',
  // A key used against the other environment's host (gateway-plane.ts). The code carries the detail.
  'env.mismatch': 'error.forbidden',
  // Framework refusals renamed by the envelope (reply-envelope.ts). `edge.request_invalid` and
  // `edge.internal_error` have no row on purpose: they take the sentence for their status (`refusalCopy`).
  'edge.body_too_large': 'error.generic',
  'edge.unsupported_media_type': 'error.generic',
};

/** Whether this code has a catalogue sentence of its own (through the alias table or directly). */
export function hasCopy(key: string): boolean {
  return translator.tUnsafe(CATALOG_ALIAS[key] ?? key, {}) !== (CATALOG_ALIAS[key] ?? key);
}

/**
 * A human sentence for a refusal, never a bare code: the code's own sentence when the catalogue has one, else
 * the generic sentence for its HTTP status. For the `message` of a completed edge body (reply-envelope.ts).
 */
export function refusalCopy(code: string | undefined, status: number): string {
  if (code && hasCopy(code)) return userCopy(code);
  if (status === 401 || status === 403) return userCopy('error.forbidden');
  if (status === 404) return userCopy('error.notFound');
  if (status === 429) return userCopy('error.rateLimited');
  return userCopy('error.generic');
}

export function userCopy(key: string, params: Readonly<Record<string, string | number | bigint>> = {}): string {
  return translator.tUnsafe(CATALOG_ALIAS[key] ?? key, params);
}
