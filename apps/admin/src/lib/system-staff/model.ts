import {
  staffAccessSchema,
  staffAreaSchema,
  staffEnvSchema,
  staffGetSchema,
  staffListSchema,
  staffRolesListSchema,
  staffVerbSchema,
  type StaffAccess,
  type StaffEntry,
  type StaffGet,
  type StaffList,
  type StaffRoleView,
  type StaffRolesList,
} from '@intafaced/contracts/identity-staff';
import type { FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';
import { explainRefusal, isKnownCode } from '@/lib/desk/refusal-copy';

/**
 * The founder console's staff screens (`/system/users`, `/system/users/:userId`, `/system/roles`; OPS-admin-access-03 step 3).
 * svc-identity owns every row; this file turns its answers into parts the pages render, and says why a control is off. Pure,
 * so the server loaders, the browser re-read and the tests use the same code.
 *
 * Nothing here invents a row, a count or a role mapping. A part that failed carries no data and names svc-identity and the code.
 */

export type { StaffAccess, StaffEntry, StaffGet, StaffList, StaffRoleView, StaffRolesList };

export const SERVICE = 'svc-identity';

/** The edge path of each read: `/api/identity/trpc/<procedure>` (svc-identity's `staff` and `roles` sub-routers). */
export const STAFF_READS = {
  list: 'staff.list',
  get: 'staff.get',
  access: 'staff.access',
  roles: 'roles.list',
} as const;

/** The console's own code for "svc-identity does not serve these procedures here" (an unknown procedure at the edge). */
export const ROSTER_NOT_BUILT = 'admin.staff_roster_not_built';

/** The roster page size asked of identity. The contract allows 1 to 200; the page offers the next page from `nextCursor`. */
export const ROSTER_PAGE = 100;

const FORBIDDEN =
  'svc-identity did not accept your founder session for the staff roster. It needs a live founder signed in with a second factor.';

/** One identity read as a part. An unknown procedure says plainly that svc-identity has no staff roster yet. */
export function identityPart<T>(result: FounderCallResult<T>): Part<T> {
  if (result.kind === 'not_built') {
    const copy = explainRefusal(ROSTER_NOT_BUILT, 404);
    return { kind: 'failed', message: copy.body, code: ROSTER_NOT_BUILT, notBuilt: true, forbidden: false };
  }
  // A non-founder session is refused FORBIDDEN with `operator.denied` or `mfa.required`; the console's own words for each are used.
  if (result.kind === 'forbidden' && isKnownCode(result.refusal.code)) {
    const copy = explainRefusal(result.refusal.code, result.refusal.status);
    return {
      kind: 'failed',
      message: `${copy.title}: ${copy.body} ${copy.next}`,
      code: result.refusal.code,
      notBuilt: false,
      forbidden: true,
    };
  }
  return partFrom(result, (d) => d, {
    service: SERVICE,
    forbiddenMessage: FORBIDDEN,
    refusedMessage: (code) => (isKnownCode(code) ? `svc-identity refused this read: ${explainRefusal(code, 409).title}.` : null),
  });
}

/** Why the controls that need this part are off, or null when it read. Always names svc-identity and the code. */
export function partBlocker(part: Part<unknown>, what: string): string | null {
  if (part.kind === 'ok') return null;
  return `${what} could not be read from svc-identity, so this control stays off: ${part.message}${part.code ? ` (code ${part.code})` : ''}`;
}

/** Built-in roles carry no permissions until the owner sets their mapping; this is the words the pages show for one. */
export const MAPPING_UNSET_WORDS = 'mapping not set by the owner (identity.role_mapping_unset)';

/** A role that can be offered in an assign or an invite: a defined role. A built-in role whose mapping is unset never is. */
export function isAssignable(role: StaffRoleView): boolean {
  return role.state === 'defined';
}

export function assignableRoles(roles: readonly StaffRoleView[], held: readonly string[]): StaffRoleView[] {
  return roles.filter((role) => isAssignable(role) && !held.includes(role.roleId));
}

export function roleName(roles: readonly StaffRoleView[], roleId: string): string {
  return roles.find((role) => role.roleId === roleId)?.name ?? roleId;
}

// ── The permission catalogue, as the role editor lays it out ────────────────

export const STAFF_AREAS = staffAreaSchema.options;
export const STAFF_VERBS = staffVerbSchema.options;
export const STAFF_ENVS = staffEnvSchema.options;

export type Grant = 'unset' | 'allow' | 'deny';

export function permissionOf(area: string, verb: string, env: string): string {
  return `staff:${area}:${verb}:${env}`;
}

/** The editor's grid as the two lists a define sends, in catalogue order. Unset cells are in neither list (denied). */
export function gridToLists(grid: Readonly<Record<string, Grant>>): { allow: string[]; deny: string[] } {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const area of STAFF_AREAS)
    for (const verb of STAFF_VERBS)
      for (const env of STAFF_ENVS) {
        const p = permissionOf(area, verb, env);
        if (grid[p] === 'allow') allow.push(p);
        else if (grid[p] === 'deny') deny.push(p);
      }
  return { allow, deny };
}

/** A defined role's lists as the editor's grid, to start a redefine from what identity stored. */
export function listsToGrid(role: StaffRoleView | null): Record<string, Grant> {
  const grid: Record<string, Grant> = {};
  if (role?.state !== 'defined') return grid;
  for (const p of role.allow) grid[p] = 'allow';
  for (const p of role.deny) grid[p] = 'deny';
  return grid;
}

// ── The views the pages hold, and the browser's strict re-read ─────────────

export interface RosterView {
  readonly asOf: string;
  readonly roster: Part<StaffList>;
  readonly roles: Part<StaffRolesList>;
  /** The founder enrolment door (identity `auth.founderEnrolmentStatus`), kept from the founder screen this page replaces. */
  readonly enrolment: Part<{ open: boolean }>;
}

export interface StaffMemberView {
  readonly asOf: string;
  readonly staffId: string;
  readonly record: Part<StaffGet>;
  readonly access: Part<StaffAccess>;
  readonly roles: Part<StaffRolesList>;
}

export interface RolesView {
  readonly asOf: string;
  readonly roles: Part<StaffRolesList>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** A failed part keeps its words; an ok part is parsed again with the contract schema. Anything else is not a part. */
function readPart<T>(raw: unknown, parse: (data: unknown) => T | null): Part<T> | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === 'ok') {
    const data = parse(raw.data);
    return data === null ? null : { kind: 'ok', data };
  }
  if (raw.kind !== 'failed' || typeof raw.message !== 'string') return null;
  if (!(raw.code === null || typeof raw.code === 'string')) return null;
  if (typeof raw.notBuilt !== 'boolean' || typeof raw.forbidden !== 'boolean') return null;
  return { kind: 'failed', message: raw.message, code: raw.code, notBuilt: raw.notBuilt, forbidden: raw.forbidden };
}

const schemaParse =
  <T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }) =>
  (v: unknown): T | null => {
    const r = schema.safeParse(v);
    return r.success ? r.data : null;
  };

export const parseEnrolment = (raw: unknown): { open: boolean } | null =>
  isRecord(raw) && typeof raw.open === 'boolean' ? { open: raw.open } : null;

export function readRosterView(raw: unknown): RosterView | null {
  if (!isRecord(raw) || typeof raw.asOf !== 'string') return null;
  const roster = readPart(raw.roster, schemaParse(staffListSchema));
  const roles = readPart(raw.roles, schemaParse(staffRolesListSchema));
  const enrolment = readPart(raw.enrolment, parseEnrolment);
  return roster && roles && enrolment ? { asOf: raw.asOf, roster, roles, enrolment } : null;
}

export function readStaffMemberView(raw: unknown): StaffMemberView | null {
  if (!isRecord(raw) || typeof raw.asOf !== 'string' || typeof raw.staffId !== 'string') return null;
  const record = readPart(raw.record, schemaParse(staffGetSchema));
  const access = readPart(raw.access, schemaParse(staffAccessSchema));
  const roles = readPart(raw.roles, schemaParse(staffRolesListSchema));
  return record && access && roles ? { asOf: raw.asOf, staffId: raw.staffId, record, access, roles } : null;
}

export function readRolesView(raw: unknown): RolesView | null {
  if (!isRecord(raw) || typeof raw.asOf !== 'string') return null;
  const roles = readPart(raw.roles, schemaParse(staffRolesListSchema));
  return roles ? { asOf: raw.asOf, roles } : null;
}

/** A staff id as it may appear in a path: what identity hands out (printable, no spaces, at most 128). */
export function isStaffIdParam(value: string): boolean {
  return /^[\x21-\x7e]{1,128}$/.test(value);
}
