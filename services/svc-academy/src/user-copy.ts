/**
 * User-visible copy for `svc-academy` curriculum / cert / lobby doors.
 *
 * Every string a client reads from a refuse or status path goes through
 * `@intafaced/i18n`. Mode is `prod` on purpose: a missing key must not throw
 * on a live lobby refuse, and must not invent English — `tUnsafe` renders
 * the dotted key name, which is greppable and not blank.
 *
 * Catalog keys that already exist on tip are aliased from academy error codes.
 * Codes with no catalog row stay the code itself until a catalog PR adds copy.
 * Perk / IFC rates are never invented here.
 */
import { createTranslator } from '@intafaced/i18n';

const translator = createTranslator('en', undefined, { mode: 'prod', onMissing: () => undefined });

/**
 * Academy refuse codes that already have a catalog sentence. Unlisted codes
 * are passed through as keys — missing → dotted name, never invented copy.
 */
const CATALOG_ALIAS: Readonly<Record<string, string>> = {
  'academy.room_not_found': 'error.notFound',
  'academy.session_not_found': 'error.notFound',
  'academy.curriculum_not_found': 'error.notFound',
  'academy.path_not_found': 'error.notFound',
  'academy.cert_not_found': 'error.notFound',
  'academy.not_host': 'error.forbidden',
  'academy.host_rights_required': 'error.forbidden',
  'academy.invite_required': 'error.forbidden',
};

export function userCopy(key: string, params: Readonly<Record<string, string | number | bigint>> = {}): string {
  return translator.tUnsafe(CATALOG_ALIAS[key] ?? key, params);
}
