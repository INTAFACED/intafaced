import { z } from 'zod';
import {
  BUILTIN_STAFF_ROLE_NAMES,
  STAFF_AREAS,
  STAFF_BUSINESS_USER_NOT_STAFF,
  STAFF_ENVS,
  STAFF_PERMISSION_INVALID,
  STAFF_PERMISSIONS,
  STAFF_ROLE_GRANT_EXCEEDS_HOLDER,
  STAFF_ROLE_MAPPING_UNSET,
  STAFF_SELF_GRANT,
  STAFF_VERBS,
  isStaffPermission,
  type StaffPermission,
} from '@intafaced/auth/staff-permissions';
import { ACTION_APPROVAL_POLICY_UNSET } from './action-approval-policy.js';

/**
 * Wire types for the staff roster, staff roles and the access overview (OPS-admin-access-03:
 * ops-console-admin-access-007, -008, -027, -028). svc-identity owns every row; the console reads through these.
 *
 * The permission catalogue and the merge rules (an explicit deny wins, unset is denied, approve never implies apply)
 * live in `@intafaced/auth/staff-permissions`; this file imports that pure subpath only, so it stays browser-safe
 * (zod and the catalogue, no token code).
 *
 * Every privileged change (invite, disable, remove, define, assign, unassign) carries a four-eyes approval reference:
 * the id of an identity action approval a second person gave, and the payload hash it was approved against. The
 * reference is not authority. identity checks the row is approved by a distinct person, unexpired, unconsumed, of the
 * action type below, bound to this target, `expectedVersion` and payload hash, and consumes it once before the change.
 * The approver count is an owner value; while it is blank identity refuses `action_approval.policy_unset`.
 *
 * Invites name one person. An invite that is an open link (anyone holding it joins) is refused
 * `identity.staff_invite_open_link_refused`. Business users never get staff roles (ORD-013). No password, secret,
 * token or factor ever appears in these shapes; the staff entry is strict so one cannot ride along.
 *
 * Nobody changes their own roles or status (`identity.staff_self_grant`). Founders keep today's founder authority
 * (the `admin:*` scopes and identity's live founder entitlement); staff permissions govern non-founder staff.
 *
 * Ids are opaque strings. Nothing here is money.
 */

export const IDENTITY_STAFF_TARGET_SERVICE = 'svc-identity' as const;

/** The action approval types a privileged staff change spends. One per verb. */
export const IDENTITY_STAFF_ACTION_TYPES = [
  'identity.staff.invite',
  'identity.staff.disable',
  'identity.staff.remove',
  'identity.roles.define',
  'identity.roles.assign',
  'identity.roles.unassign',
] as const;
export type IdentityStaffActionType = (typeof IDENTITY_STAFF_ACTION_TYPES)[number];

// ── Refusals ────────────────────────────────────────────────────────────────

/** An invite that does not name one person (a link anyone can use). */
export const IDENTITY_STAFF_INVITE_OPEN_LINK_REFUSED = 'identity.staff_invite_open_link_refused' as const;
/**
 * The codes `@intafaced/auth/staff-permissions` refuses with, re-exported so the literal has one source. The
 * `IDENTITY_*` names below are the same values under this contract's naming.
 */
export {
  STAFF_BUSINESS_USER_NOT_STAFF,
  STAFF_PERMISSION_INVALID,
  STAFF_ROLE_GRANT_EXCEEDS_HOLDER,
  STAFF_ROLE_MAPPING_UNSET,
  STAFF_SELF_GRANT,
};

/** The actor tried to grant a permission they do not hold themselves (including lifting a deny on a redefine). */
export const IDENTITY_ROLE_GRANT_EXCEEDS_HOLDER = STAFF_ROLE_GRANT_EXCEEDS_HOLDER;
/** The action needs a permission an explicit deny on one of the actor's roles removes. */
export const IDENTITY_PERMISSION_DENIED_EXPLICIT = 'identity.permission_denied_explicit' as const;
/** The change would leave no active founder (disable, remove, or unassign the founder role from the last one). */
export const IDENTITY_STAFF_LAST_FOUNDER = 'identity.staff_last_founder' as const;
/** A sign-in or role change for a person who was never invited and approved. */
export const IDENTITY_STAFF_NOT_INVITED = 'identity.staff_not_invited' as const;
/** A built-in role whose permission mapping the owner has not published. */
export const IDENTITY_ROLE_MAPPING_UNSET = STAFF_ROLE_MAPPING_UNSET;
/** A business account cannot hold a staff role. */
export const IDENTITY_BUSINESS_USER_NOT_STAFF = STAFF_BUSINESS_USER_NOT_STAFF;
/** A role or request names a string outside the staff permission catalogue (or an environment outside the list). */
export const IDENTITY_STAFF_PERMISSION_INVALID = STAFF_PERMISSION_INVALID;
/** A person changing their own roles or their own status. */
export const IDENTITY_STAFF_SELF_GRANT = STAFF_SELF_GRANT;

/**
 * Every typed refusal of the staff and roles procedures, for the console's refusal map. The approval contract's own
 * refusals (`action_approval.same_person`, `action_approval.payload_mismatch` and the rest) come from identity's
 * approval path and are mapped there.
 */
export const IDENTITY_STAFF_REFUSAL_CODES = [
  IDENTITY_STAFF_INVITE_OPEN_LINK_REFUSED,
  IDENTITY_ROLE_GRANT_EXCEEDS_HOLDER,
  IDENTITY_PERMISSION_DENIED_EXPLICIT,
  IDENTITY_STAFF_LAST_FOUNDER,
  IDENTITY_STAFF_NOT_INVITED,
  IDENTITY_ROLE_MAPPING_UNSET,
  IDENTITY_BUSINESS_USER_NOT_STAFF,
  IDENTITY_STAFF_PERMISSION_INVALID,
  IDENTITY_STAFF_SELF_GRANT,
  ACTION_APPROVAL_POLICY_UNSET,
] as const;
export type IdentityStaffRefusalCode = (typeof IDENTITY_STAFF_REFUSAL_CODES)[number];
export const identityStaffRefusalCodeSchema = z.enum(IDENTITY_STAFF_REFUSAL_CODES);

// ── Primitives ──────────────────────────────────────────────────────────────

const iso = z.string().datetime({ offset: true });
const opaqueId = z.string().trim().min(1).max(128);
const payloadHash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Business key the console sends so a lost reply is re-read, never repeated with a new key. */
const requestId = z.string().trim().min(8).max(160);
const version = z
  .string()
  .max(40)
  .regex(/^(?:0|[1-9]\d*)$/);
const reason = z.string().trim().min(3).max(500);
const displayName = z.string().trim().min(1).max(120);
const email = z.string().trim().toLowerCase().email().max(254);

export const staffAreaSchema = z.enum(STAFF_AREAS);
export const staffVerbSchema = z.enum(STAFF_VERBS);
export const staffEnvSchema = z.enum(STAFF_ENVS);

/** One `staff:<area>:<verb>:<env>` from the closed catalogue. Anything else is refused. */
export const staffPermissionSchema = z.custom<StaffPermission>((value) => isStaffPermission(value), {
  message: 'a staff permission staff:<area>:<verb>:<env> from the catalogue',
});

const permissionList = z
  .array(staffPermissionSchema)
  .max(STAFF_PERMISSIONS.length)
  .refine((list) => new Set(list).size === list.length, 'a permission is listed twice');

const isBuiltinName = (name: string): boolean => (BUILTIN_STAFF_ROLE_NAMES as readonly string[]).includes(name.trim().toLowerCase());

/**
 * A four-eyes approval reference. `payloadHash` is the hash the approval was proposed and approved against; identity
 * recomputes it from this request and refuses a mismatch before anything is spent.
 */
export const staffApprovalRefSchema = z.object({ approvalId: opaqueId, payloadHash }).strict();
export type StaffApprovalRef = z.infer<typeof staffApprovalRefSchema>;

// ── Staff roster ────────────────────────────────────────────────────────────

export const STAFF_STATUSES = ['invited', 'active', 'disabled'] as const;
export const staffStatusSchema = z.enum(STAFF_STATUSES);
export type StaffStatus = z.infer<typeof staffStatusSchema>;

/** One staff member as the roster shows them. Strict: no password, secret, token or factor can be carried. */
export const staffEntrySchema = z
  .object({
    staffId: opaqueId,
    /** The identity account this staff record belongs to. */
    userId: opaqueId,
    displayName,
    email,
    status: staffStatusSchema,
    roleIds: z.array(opaqueId),
    /** Null until their first sign-in. */
    lastSignInAt: iso.nullable(),
    invitedAt: iso,
    invitedBy: opaqueId,
    /** Null while invited. */
    activatedAt: iso.nullable(),
    disabledAt: iso.nullable(),
    version,
  })
  .strict();
export type StaffEntry = z.infer<typeof staffEntrySchema>;

export const staffListInputSchema = z
  .object({
    status: staffStatusSchema.optional(),
    cursor: opaqueId.optional(),
    limit: z.number().int().min(1).max(200),
  })
  .strict();
export type StaffListInput = z.infer<typeof staffListInputSchema>;

/** An empty roster is an empty list; nothing is invented. */
export const staffListSchema = z.object({ staff: z.array(staffEntrySchema), nextCursor: opaqueId.nullable(), asOf: iso }).strict();
export type StaffList = z.infer<typeof staffListSchema>;

export const staffIdInputSchema = z.object({ staffId: opaqueId }).strict();
export type StaffIdInput = z.infer<typeof staffIdInputSchema>;

// ── Roles ───────────────────────────────────────────────────────────────────

export const builtinStaffRoleNameSchema = z.enum(BUILTIN_STAFF_ROLE_NAMES);

const roleBase = { roleId: opaqueId, name: displayName, version };

/**
 * A role as the console reads it. A built-in role is `unset` until the owner publishes its mapping; it then carries
 * no permissions and assigning it refuses `identity.role_mapping_unset`. `builtin` goes only with a built-in name and
 * `custom` never with one.
 */
export const staffRoleSchema = z
  .discriminatedUnion('state', [
    z
      .object({
        ...roleBase,
        kind: z.literal('builtin'),
        name: builtinStaffRoleNameSchema,
        state: z.literal('mapping_unset'),
        code: z.literal(IDENTITY_ROLE_MAPPING_UNSET),
      })
      .strict(),
    z
      .object({
        ...roleBase,
        kind: z.enum(['builtin', 'custom']),
        state: z.literal('defined'),
        allow: permissionList,
        deny: permissionList,
      })
      .strict(),
  ])
  .superRefine((role, ctx) => {
    if (role.state !== 'defined') return;
    if (role.kind === 'builtin' && !builtinStaffRoleNameSchema.safeParse(role.name).success) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'a built-in role carries a built-in name' });
    }
    if (role.kind === 'custom' && isBuiltinName(role.name)) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'a custom role never carries a built-in name' });
    }
  });
export type StaffRoleView = z.infer<typeof staffRoleSchema>;

export const staffRolesListInputSchema = z.object({}).strict();
export const staffRolesListSchema = z.object({ roles: z.array(staffRoleSchema), asOf: iso }).strict();
export type StaffRolesList = z.infer<typeof staffRolesListSchema>;

export const staffGetSchema = z.object({ staff: staffEntrySchema, roles: z.array(staffRoleSchema), asOf: iso }).strict();
export type StaffGet = z.infer<typeof staffGetSchema>;

// ── Privileged changes ──────────────────────────────────────────────────────

/**
 * Invite one named person. `roleIds` are granted when they accept; each must be within what the inviter holds
 * (`identity.role_grant_exceeds_holder`) and a built-in role must have a mapping (`identity.role_mapping_unset`).
 * The person sets their own password at first connection; no password or link is in this shape.
 */
const staffInviteFields = z.object({ requestId, email, displayName, roleIds: z.array(opaqueId).max(20) }).strict();
export const staffInviteInputSchema = staffInviteFields.extend({ approval: staffApprovalRefSchema }).strict();
export type StaffInviteInput = z.infer<typeof staffInviteInputSchema>;

/** Field names that mark an invite as a link for anyone rather than for one named person. */
const OPEN_LINK_FIELDS = ['openLink', 'link', 'inviteLink', 'shareLink', 'anyone'] as const;

/**
 * Read an invite request. Refuses `identity.staff_invite_open_link_refused` when it carries an open-link field or
 * names no person (no email or no name); otherwise the strict schema decides. Identity calls this before anything else.
 */
export function readStaffInvite(
  raw: unknown,
):
  | { ok: true; input: StaffInviteInput }
  | { ok: false; code: typeof IDENTITY_STAFF_INVITE_OPEN_LINK_REFUSED }
  | { ok: false; error: z.ZodError } {
  if (raw !== null && typeof raw === 'object') {
    const body = raw as Record<string, unknown>;
    const named =
      typeof body.email === 'string' && body.email.trim() !== '' && typeof body.displayName === 'string' && body.displayName.trim() !== '';
    if (!named || OPEN_LINK_FIELDS.some((field) => field in body)) return { ok: false, code: IDENTITY_STAFF_INVITE_OPEN_LINK_REFUSED };
  }
  const parsed = staffInviteInputSchema.safeParse(raw);
  return parsed.success ? { ok: true, input: parsed.data } : { ok: false, error: parsed.error };
}

/** Disable keeps the record and revokes sign-in; remove deletes the staff record. Neither touches the customer account. */
const staffStatusChangeFields = z.object({ requestId, staffId: opaqueId, reason, expectedVersion: version }).strict();
export const staffDisableInputSchema = staffStatusChangeFields.extend({ approval: staffApprovalRefSchema }).strict();
export type StaffDisableInput = z.infer<typeof staffDisableInputSchema>;

export const staffRemoveInputSchema = staffDisableInputSchema;
export type StaffRemoveInput = StaffDisableInput;

/**
 * Define a custom role, or redefine one (`roleId` and `expectedVersion` together). Built-in roles are never defined
 * here: a built-in name is refused, and there is no `kind` field to set. A permission in both `allow` and `deny` is
 * refused. Every allow, and on a redefine every deny the new definition lifts, must be within what the actor holds
 * (`identity.role_grant_exceeds_holder`, `assertGrantWithinHolder` with the previous role); a new deny narrows and needs
 * no holding.
 *
 * Events: a define changes what every current holder can do, so identity publishes `intafaced.identity.staff.updated`
 * for every current holder of the role, with `changedFields: ['permissions']`, in the same transaction.
 */
const staffRoleDefineFields = z
  .object({
    requestId,
    roleId: opaqueId.optional(),
    expectedVersion: version.optional(),
    name: displayName,
    allow: permissionList,
    deny: permissionList,
  })
  .strict();
type StaffRoleDefineShape = z.infer<typeof staffRoleDefineFields>;
function refineRoleDefine(input: StaffRoleDefineShape, ctx: z.RefinementCtx): void {
  if ((input.roleId === undefined) !== (input.expectedVersion === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['expectedVersion'], message: 'roleId and expectedVersion go together' });
  }
  if (isBuiltinName(input.name)) {
    ctx.addIssue({ code: 'custom', path: ['name'], message: 'a built-in role name cannot be defined as a custom role' });
  }
  if (input.allow.length + input.deny.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['allow'], message: 'a role names at least one permission' });
  }
  const denied = new Set(input.deny);
  const both = input.allow.filter((p) => denied.has(p));
  if (both.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['deny'], message: `in both allow and deny: ${both.join(', ')}` });
  }
}
export const staffRoleDefineInputSchema = staffRoleDefineFields
  .extend({ approval: staffApprovalRefSchema })
  .strict()
  .superRefine(refineRoleDefine);
export type StaffRoleDefineInput = z.infer<typeof staffRoleDefineInputSchema>;

/** Assign or unassign one role on one staff member. `expectedVersion` is the staff record's version. */
const staffRoleAssignFields = z.object({ requestId, staffId: opaqueId, roleId: opaqueId, expectedVersion: version }).strict();
export const staffRoleAssignInputSchema = staffRoleAssignFields.extend({ approval: staffApprovalRefSchema }).strict();
export type StaffRoleAssignInput = z.infer<typeof staffRoleAssignInputSchema>;

export const staffRoleUnassignInputSchema = staffRoleAssignInputSchema;
export type StaffRoleUnassignInput = StaffRoleAssignInput;

/** The approval-less shape each action's subject is computed from: the same normalisation as the input schemas. */
const STAFF_CHANGE_FIELD_SCHEMAS = {
  'identity.staff.invite': staffInviteFields,
  'identity.staff.disable': staffStatusChangeFields,
  'identity.staff.remove': staffStatusChangeFields,
  'identity.roles.define': staffRoleDefineFields.superRefine(refineRoleDefine),
  'identity.roles.assign': staffRoleAssignFields,
  'identity.roles.unassign': staffRoleAssignFields,
} as const;

export type StaffChangeApprovalSubject = {
  actionType: IdentityStaffActionType;
  targetService: typeof IDENTITY_STAFF_TARGET_SERVICE;
  targetId: string;
  fields: Record<string, unknown>;
};

/**
 * What one privileged change binds its approval to: the action type, the target and the fields hashed into the payload
 * hash. Identity computes the hash from these; the console shows the approver the same fields.
 *
 * The input is parsed through the action's schema first (an `approval` field, if present, is set aside), so raw input
 * and already-parsed input give the same subject: names, reasons and emails are trimmed, emails lower-cased, lists
 * sorted, and a new role's target uses its case-folded name. Input the schema refuses throws its `ZodError`.
 */
export function staffChangeApprovalSubject(action: IdentityStaffActionType, input: unknown): StaffChangeApprovalSubject {
  const body =
    input !== null && typeof input === 'object' && 'approval' in input
      ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'approval'))
      : input;
  const base = { actionType: action, targetService: IDENTITY_STAFF_TARGET_SERVICE } as const;
  switch (action) {
    case 'identity.staff.invite': {
      const v = STAFF_CHANGE_FIELD_SCHEMAS[action].parse(body);
      return {
        ...base,
        targetId: `invite:${v.email}`,
        fields: { email: v.email, displayName: v.displayName, roleIds: [...v.roleIds].sort() },
      };
    }
    case 'identity.staff.disable':
    case 'identity.staff.remove': {
      const v = STAFF_CHANGE_FIELD_SCHEMAS[action].parse(body);
      return {
        ...base,
        targetId: `staff:${v.staffId}`,
        fields: { staffId: v.staffId, reason: v.reason, expectedVersion: v.expectedVersion },
      };
    }
    case 'identity.roles.define': {
      const v = STAFF_CHANGE_FIELD_SCHEMAS[action].parse(body);
      return {
        ...base,
        targetId: v.roleId === undefined ? `role:new:${v.name.toLowerCase()}` : `role:${v.roleId}`,
        fields: { name: v.name, allow: [...v.allow].sort(), deny: [...v.deny].sort(), expectedVersion: v.expectedVersion ?? null },
      };
    }
    case 'identity.roles.assign':
    case 'identity.roles.unassign': {
      const v = STAFF_CHANGE_FIELD_SCHEMAS[action].parse(body);
      return {
        ...base,
        targetId: `staff:${v.staffId}`,
        fields: { staffId: v.staffId, roleId: v.roleId, expectedVersion: v.expectedVersion },
      };
    }
  }
}

const changeAudit = {
  auditId: opaqueId,
  requestId,
  action: z.enum(IDENTITY_STAFF_ACTION_TYPES),
  actorId: opaqueId,
  occurredAt: iso,
};

/**
 * The outcome of a privileged change. `changed` names the second person whose approval was spent. `refused` carries
 * one typed code and changes nothing. `replayed` is the same `requestId` after a lost reply: the stored result, not a
 * second change.
 */
export const staffChangeResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      ...changeAudit,
      outcome: z.literal('changed'),
      approverId: opaqueId,
      staff: staffEntrySchema.nullable(),
      role: staffRoleSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...changeAudit,
      outcome: z.literal('replayed'),
      approverId: opaqueId,
      staff: staffEntrySchema.nullable(),
      role: staffRoleSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...changeAudit,
      outcome: z.literal('refused'),
      code: identityStaffRefusalCodeSchema,
      /** The permissions or role the refusal names (for example what a grant lacks). Names only. */
      detail: z.array(z.string().max(128)).max(STAFF_PERMISSIONS.length + 1),
    })
    .strict(),
]);
export type StaffChangeResult = z.infer<typeof staffChangeResultSchema>;

// ── Access overview ─────────────────────────────────────────────────────────

/**
 * One permission of one person and where it comes from: allowed by the listed roles, or removed by an explicit deny
 * (with the roles that would otherwise have allowed it). A permission no role names is unset, which is denied, and is
 * not listed.
 */
export const staffAccessPermissionSchema = z.discriminatedUnion('state', [
  z.object({ permission: staffPermissionSchema, state: z.literal('allowed'), sourceRoleIds: z.array(opaqueId).min(1) }).strict(),
  z
    .object({
      permission: staffPermissionSchema,
      state: z.literal('denied_explicit'),
      sourceRoleIds: z.array(opaqueId),
      deniedByRoleIds: z.array(opaqueId).min(1),
    })
    .strict(),
]);
export type StaffAccessPermission = z.infer<typeof staffAccessPermissionSchema>;

export const staffAccessInputSchema = staffIdInputSchema;

/** `identity.staff.access`: everything one person can do, with its source. Built-in roles without a mapping add nothing. */
export const staffAccessSchema = z
  .object({
    staffId: opaqueId,
    status: staffStatusSchema,
    roles: z.array(staffRoleSchema),
    permissions: z.array(staffAccessPermissionSchema),
    asOf: iso,
  })
  .strict();
export type StaffAccess = z.infer<typeof staffAccessSchema>;
