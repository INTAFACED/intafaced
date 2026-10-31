import {
  IDENTITY_STAFF_TARGET_SERVICE,
  builtinStaffRoleNameSchema,
  staffChangeApprovalSubject,
  staffPermissionSchema,
  type IdentityStaffActionType,
  type StaffChangeApprovalSubject,
} from '@intafaced/contracts/identity-staff';

/**
 * The six privileged staff changes as two-founder desk requests (OPS-admin-access-03 step 3): invite, disable and remove a
 * staff member, define a custom role, and assign or unassign one role. Each request kind is exactly the identity action type
 * it spends (`IDENTITY_STAFF_ACTION_TYPES`), and what the approval binds to is the contract's `staffChangeApprovalSubject`, so
 * the console and svc-identity hash the same normalised fields.
 *
 * Pure (the contract subpath is zod and the catalogue only), so the browser and the server read packets the same way.
 *
 * The request id the change is sent with is not part of a request: it is not hashed (the subject leaves it out) and is
 * derived from the approval when the change runs (`staffRequestId`), so a run after a lost reply carries the same key.
 */

export type StaffInviteRequest = {
  readonly kind: 'identity.staff.invite';
  readonly email: string;
  readonly displayName: string;
  readonly roleIds: readonly string[];
};
export type StaffDisableRequest = {
  readonly kind: 'identity.staff.disable';
  readonly staffId: string;
  readonly reason: string;
  readonly version: string;
};
export type StaffRemoveRequest = {
  readonly kind: 'identity.staff.remove';
  readonly staffId: string;
  readonly reason: string;
  readonly version: string;
};
/** A new role has `roleId` and `version` null; a redefine names both. */
export type StaffRoleDefineRequest = {
  readonly kind: 'identity.roles.define';
  readonly roleId: string | null;
  readonly version: string | null;
  readonly name: string;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
};
export type StaffRoleAssignRequest = {
  readonly kind: 'identity.roles.assign';
  readonly staffId: string;
  readonly roleId: string;
  readonly version: string;
};
export type StaffRoleUnassignRequest = {
  readonly kind: 'identity.roles.unassign';
  readonly staffId: string;
  readonly roleId: string;
  readonly version: string;
};

export type StaffDeskRequest =
  | StaffInviteRequest
  | StaffDisableRequest
  | StaffRemoveRequest
  | StaffRoleDefineRequest
  | StaffRoleAssignRequest
  | StaffRoleUnassignRequest;

export const STAFF_REQUEST_KINDS = [
  'identity.staff.invite',
  'identity.staff.disable',
  'identity.staff.remove',
  'identity.roles.define',
  'identity.roles.assign',
  'identity.roles.unassign',
] as const satisfies readonly IdentityStaffActionType[];

export function isStaffRequestKind(kind: unknown): kind is StaffDeskRequest['kind'] {
  return typeof kind === 'string' && (STAFF_REQUEST_KINDS as readonly string[]).includes(kind);
}

/** A catalogue permission as the contract types it. A request's lists are checked against the schema before they get here. */
type Permission = ReturnType<typeof staffPermissionSchema.parse>;

/** The subject parse needs a request id of the contract's shape; the subject drops it, so it never reaches the hash. */
const SUBJECT_ONLY_REQUEST_ID = 'console:subject-only';
/** An id identity hands out (staff, role): printable, no spaces, at most 128. */
const OPAQUE_ID = /^[\x21-\x7e]{1,128}$/;
/** The contract's record version: a whole number with no leading zero. */
const VERSION = /^(?:0|[1-9]\d{0,39})$/;
/** The desk's reason rule (`validReason` in approval-packet): trimmed, 12 to 500 characters. */
const REASON_MIN = 12;
const REASON_MAX = 500;
const ROLE_IDS_MAX = 20;

function validStaffReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length >= REASON_MIN && value.length <= REASON_MAX;
}

function idList(value: unknown, max: number, item: (v: string) => boolean): readonly string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  if (!value.every((v): v is string => typeof v === 'string' && item(v))) return null;
  return new Set(value).size === value.length ? [...value] : null;
}

const isPermission = (v: string) => staffPermissionSchema.safeParse(v).success;
const isOpaqueId = (v: string) => OPAQUE_ID.test(v);

/** What a staff request binds its approval to: the contract's subject for the same fields. Throws for fields it refuses. */
export function staffSubjectFor(request: StaffDeskRequest): StaffChangeApprovalSubject {
  const requestId = SUBJECT_ONLY_REQUEST_ID;
  switch (request.kind) {
    case 'identity.staff.invite':
      return staffChangeApprovalSubject(request.kind, {
        requestId,
        email: request.email,
        displayName: request.displayName,
        roleIds: [...request.roleIds],
      });
    case 'identity.staff.disable':
    case 'identity.staff.remove':
      return staffChangeApprovalSubject(request.kind, {
        requestId,
        staffId: request.staffId,
        reason: request.reason,
        expectedVersion: request.version,
      });
    case 'identity.roles.define':
      return staffChangeApprovalSubject(request.kind, {
        requestId,
        ...(request.roleId !== null && request.version !== null ? { roleId: request.roleId, expectedVersion: request.version } : {}),
        name: request.name,
        allow: [...request.allow] as Permission[],
        deny: [...request.deny] as Permission[],
      });
    case 'identity.roles.assign':
    case 'identity.roles.unassign':
      return staffChangeApprovalSubject(request.kind, {
        requestId,
        staffId: request.staffId,
        roleId: request.roleId,
        expectedVersion: request.version,
      });
  }
}

/** True when the contract accepts these fields. A request it would refuse is never made into a packet or an approval. */
function subjectAccepts(request: StaffDeskRequest): boolean {
  try {
    staffSubjectFor(request);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strict reader for one staff request (the `kind` is already one of the six). Exact keys, the contract's own normal form
 * (trimmed, an email in lower case) so what the founders read is what is hashed, and the contract's own checks on top.
 */
export function readStaffRequest(raw: Record<string, unknown>): StaffDeskRequest | null {
  const keys = Object.keys(raw).sort().join(',');
  let request: StaffDeskRequest | null = null;
  switch (raw.kind) {
    case 'identity.staff.invite': {
      if (keys !== 'displayName,email,kind,roleIds') return null;
      const { email, displayName } = raw;
      if (typeof email !== 'string' || email !== email.trim().toLowerCase() || email === '') return null;
      if (typeof displayName !== 'string' || displayName !== displayName.trim() || displayName === '') return null;
      const roleIds = idList(raw.roleIds, ROLE_IDS_MAX, isOpaqueId);
      if (roleIds === null) return null;
      request = { kind: 'identity.staff.invite', email, displayName, roleIds };
      break;
    }
    case 'identity.staff.disable':
    case 'identity.staff.remove': {
      if (keys !== 'kind,reason,staffId,version') return null;
      if (typeof raw.staffId !== 'string' || !isOpaqueId(raw.staffId) || !validStaffReason(raw.reason)) return null;
      if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) return null;
      request = { kind: raw.kind, staffId: raw.staffId, reason: raw.reason, version: raw.version };
      break;
    }
    case 'identity.roles.define': {
      if (keys !== 'allow,deny,kind,name,roleId,version') return null;
      const { roleId, version, name } = raw;
      if (!((roleId === null && version === null) || (typeof roleId === 'string' && typeof version === 'string'))) return null;
      if (typeof roleId === 'string' && (!isOpaqueId(roleId) || !VERSION.test(version as string))) return null;
      if (typeof name !== 'string' || name !== name.trim() || name === '') return null;
      const allow = idList(raw.allow, 264, isPermission);
      const deny = idList(raw.deny, 264, isPermission);
      if (allow === null || deny === null) return null;
      request = { kind: 'identity.roles.define', roleId: roleId as string | null, version: version as string | null, name, allow, deny };
      break;
    }
    case 'identity.roles.assign':
    case 'identity.roles.unassign': {
      if (keys !== 'kind,roleId,staffId,version') return null;
      if (typeof raw.staffId !== 'string' || !isOpaqueId(raw.staffId)) return null;
      if (typeof raw.roleId !== 'string' || !isOpaqueId(raw.roleId)) return null;
      if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) return null;
      request = { kind: raw.kind, staffId: raw.staffId, roleId: raw.roleId, version: raw.version };
      break;
    }
    default:
      return null;
  }
  return request !== null && subjectAccepts(request) ? request : null;
}

/** True for a built-in role name (founder, compliance, support, finance, developer), in any case. */
export function isBuiltinRoleName(name: string): boolean {
  return builtinStaffRoleNameSchema.safeParse(name.trim().toLowerCase()).success;
}

/** The phrase typed before any step. It names the person or role being changed. */
export function staffConfirmPhrase(request: StaffDeskRequest): string {
  switch (request.kind) {
    case 'identity.staff.invite':
      return `INVITE ${request.email}`;
    case 'identity.staff.disable':
      return `DISABLE STAFF ${request.staffId.slice(0, 8)}`;
    case 'identity.staff.remove':
      return `REMOVE STAFF ${request.staffId.slice(0, 8)}`;
    case 'identity.roles.define':
      return request.roleId === null ? `DEFINE ROLE ${request.name.toUpperCase()}` : `REDEFINE ROLE ${request.roleId.slice(0, 8)}`;
    case 'identity.roles.assign':
      return `ASSIGN ROLE ${request.roleId.slice(0, 8)} TO ${request.staffId.slice(0, 8)}`;
    case 'identity.roles.unassign':
      return `UNASSIGN ROLE ${request.roleId.slice(0, 8)} FROM ${request.staffId.slice(0, 8)}`;
  }
}

function listWords(list: readonly string[]): string {
  return list.length === 0 ? 'none' : list.join(', ');
}

/** Plain words for both founders. */
export function describeStaffRequest(request: StaffDeskRequest): string {
  switch (request.kind) {
    case 'identity.staff.invite':
      return `Invite ${request.displayName} <${request.email}> as a staff member, by name: no link anyone could use is made. They set their own password at first connection. Roles granted when they accept: ${listWords(request.roleIds)}. svc-identity refuses a role the inviter does not hold in full, and a built-in role whose mapping the owner has not set.`;
    case 'identity.staff.disable':
      return `Disable staff member ${request.staffId} ("${request.reason}"): their sign-in is revoked and their record is kept. Their customer account, if any, is not touched. svc-identity refuses the last active founder and a person disabling themselves, and applies it only if the record is still at version ${request.version}.`;
    case 'identity.staff.remove':
      return `Remove staff member ${request.staffId} ("${request.reason}"): their staff record is deleted and their sign-in revoked. Their customer account, if any, is not touched. svc-identity refuses the last active founder and a person removing themselves, and applies it only if the record is still at version ${request.version}.`;
    case 'identity.roles.define':
      return `${request.roleId === null ? `Define a new custom role "${request.name}"` : `Redefine custom role ${request.roleId} as "${request.name}" (at version ${request.version})`}. It allows ${request.allow.length} permission${request.allow.length === 1 ? '' : 's'} (${listWords(request.allow)}) and denies ${request.deny.length} (${listWords(request.deny)}). A deny wins over any allow from another role. Every person who holds the role gets the new set at once. svc-identity refuses a permission you do not hold yourself.`;
    case 'identity.roles.assign':
      return `Assign role ${request.roleId} to staff member ${request.staffId}. svc-identity refuses a role you do not hold in full, a built-in role whose mapping the owner has not set, a business account, and a person changing their own roles; it applies it only if the record is still at version ${request.version}.`;
    case 'identity.roles.unassign':
      return `Take role ${request.roleId} away from staff member ${request.staffId}: they lose every permission only that role gave them. svc-identity refuses taking the founder role from the last founder and a person changing their own roles; it applies it only if the record is still at version ${request.version}.`;
  }
}

/** The target service and target id identity binds a staff approval to (the contract's subject). */
export function staffTarget(request: StaffDeskRequest): {
  readonly targetService: typeof IDENTITY_STAFF_TARGET_SERVICE;
  readonly targetId: string;
} {
  const subject = staffSubjectFor(request);
  return { targetService: subject.targetService, targetId: subject.targetId };
}

/** The version a staff approval is bound to: the record or role read, or 0 for something new (an invite, a new role). */
export function staffExpectedVersion(request: StaffDeskRequest): string {
  return request.kind === 'identity.staff.invite'
    ? '0'
    : request.kind === 'identity.roles.define'
      ? (request.version ?? '0')
      : request.version;
}

/**
 * The business key a staff change is sent with: the action and the approval it spends. A run after a lost reply sends the
 * same key, so identity answers with what it stored (`replayed`) instead of making a second change; one approval is one key.
 */
export function staffRequestId(kind: StaffDeskRequest['kind'], approvalId: string): string {
  return `console:${kind}:${approvalId}`;
}
