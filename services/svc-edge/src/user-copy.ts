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
  'edge.authority_unavailable': 'error.generic',
  'edge.upstream_unwired': 'error.network',
  'edge.geo_blocked': 'error.region.blocked',
  'edge.geo_region_unknown': 'error.region.blocked',
  'edge.kill_switch_undecidable': 'error.generic',
  'edge.network_flagged': 'error.forbidden',
  'edge.network_dark': 'error.network',
  'edge.network_unconfigured': 'error.generic',
};

export function userCopy(key: string, params: Readonly<Record<string, string | number | bigint>> = {}): string {
  return translator.tUnsafe(CATALOG_ALIAS[key] ?? key, params);
}
