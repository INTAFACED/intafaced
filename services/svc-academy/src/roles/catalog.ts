/**
 * AC-roles-01 — the published permission list and the built-in course roles.
 *
 * `refund` only authorises REQUESTING a refund. The refund itself is the
 * ledger-client recipe path of AC-commerce-01 and never runs in role code;
 * nothing in roles/** imports the ledger client.
 */
import { academyBuiltinRoleSchema, academyPermissionSchema } from '@intafaced/contracts';
import { AcademyError } from '../errors.js';

/** Published list lives in @intafaced/contracts (academy-roles.ts); no local copy. */
export const ACADEMY_PERMISSIONS = academyPermissionSchema.options;
export type AcademyPermission = (typeof ACADEMY_PERMISSIONS)[number];

export const BUILTIN_ROLES = academyBuiltinRoleSchema.options;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];

const ALL: readonly AcademyPermission[] = ACADEMY_PERMISSIONS;

export const BUILTIN_ROLE_PERMISSIONS: Readonly<Record<BuiltinRole, readonly AcademyPermission[]>> = {
  admin: ALL,
  instructor: ALL.filter((p) => p !== 'refund' && p !== 'financial_view'),
  staff: ALL.filter((p) => p !== 'delete' && p !== 'refund' && p !== 'financial_view'),
  /** Cannot edit content, publish or delete; can read progress. */
  limited_staff: ['view_progress', 'grade', 'enrol', 'moderate', 'comments', 'coaching'],
  /** Answer data with anonymised ids only (AC-analytics reads honour this). */
  data_researcher: ['reports'],
  author: ['edit_content', 'comments'],
};

export function isBuiltinRole(role: string): role is BuiltinRole {
  return (BUILTIN_ROLES as readonly string[]).includes(role);
}

export function isPermission(p: string): p is AcademyPermission {
  return (ACADEMY_PERMISSIONS as readonly string[]).includes(p);
}

/** `custom:<slug>` — lowercase words joined by hyphens. */
export function customRoleId(slug: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64) {
    throw new AcademyError('role slug must be lowercase words joined by hyphens', 'academy.role_invalid');
  }
  return `custom:${slug}`;
}

export function assertPermissions(perms: readonly string[]): AcademyPermission[] {
  if (perms.length === 0) throw new AcademyError('a role needs at least one permission', 'academy.role_invalid');
  const out = new Set<AcademyPermission>();
  for (const p of perms) {
    if (!isPermission(p)) throw new AcademyError(`unknown permission ${p}`, 'academy.role_invalid');
    out.add(p);
  }
  return [...out].sort();
}

/**
 * A role cannot grant more than its assigner holds. `assignerHeld` is null
 * for a founder session that holds no academy role rows (the founder scope is
 * the outer gate); a staff assigner must hold every permission of the role.
 */
export function assertNoEscalation(target: readonly AcademyPermission[], assignerHeld: ReadonlySet<AcademyPermission> | null): void {
  if (assignerHeld === null) return;
  const missing = target.filter((p) => !assignerHeld.has(p));
  if (missing.length > 0) {
    throw new AcademyError(`assigner does not hold: ${missing.join(', ')}`, 'academy.role_escalation');
  }
}
