/**
 * STAFF PERMISSIONS (OPS-admin-access-03: ops-console-admin-access-007, -008, -027, -028).
 *
 * A staff permission is `staff:<area>:<verb>:<env>`: one verb on one console area in one environment. It is a
 * separate catalogue from the session scopes in `scopes.ts`: a scope says what class of action a token may call at
 * all, a staff permission says what one staff member may do inside the console. Neither is derived from the other.
 *
 * ── The rules, stated once ──────────────────────────────────────────────────
 *
 *   1. The three lists below are closed. A string outside them is not a permission and every function here refuses
 *      it rather than skipping it, so an audit trail never claims a grant no check recognises.
 *   2. Nothing implies anything. `write` does not give `read`, `production` does not give `staging`, and
 *      `approve`, `apply` and `skip` are three separate grants: a person who may approve a change may not apply it
 *      unless `apply` is granted too. An audit of what someone can do is a lookup, never an inference.
 *   3. Several roles merge: an allow from any role counts, and an explicit deny from any role wins over every allow.
 *   4. Anything not explicitly allowed is denied.
 *   5. A person can grant only what they hold (`assertGrantWithinHolder`).
 *   6. The five built-in roles have NO permissions until the owner publishes their mapping (decision note: the mapping
 *      needs counsel and owner review). An unset mapping refuses `identity.role_mapping_unset`; nothing here invents one.
 *   7. Business users never get staff roles (ORD-013).
 *
 * Token claims and session issuance are not decided here (agreed separately). This file holds the catalogue and the
 * pure checks every service applies the same way.
 */

/** Console areas a staff permission names. Closed. */
export const STAFF_AREAS = [
  'accounts',
  'ledger',
  'payments',
  'cards',
  'trading',
  'documents',
  'flags',
  'tokens',
  'settings',
  'authentication',
] as const;
export type StaffArea = (typeof STAFF_AREAS)[number];

/**
 * Verbs. Closed. `approve` (be the second person on a four-eyes change), `apply` (carry out an approved change) and
 * `skip` (pass over a step a policy allows to be passed) are separate grants; none of the eight implies another.
 */
export const STAFF_VERBS = ['read', 'write', 'create', 'update', 'delete', 'approve', 'apply', 'skip'] as const;
export type StaffVerb = (typeof STAFF_VERBS)[number];

/** Environments. Closed. A grant in one never reaches another. */
export const STAFF_ENVS = ['local', 'staging', 'production'] as const;
export type StaffEnv = (typeof STAFF_ENVS)[number];

export type StaffPermission = `staff:${StaffArea}:${StaffVerb}:${StaffEnv}`;

const AREA_SET: ReadonlySet<string> = new Set(STAFF_AREAS);
const VERB_SET: ReadonlySet<string> = new Set(STAFF_VERBS);
const ENV_SET: ReadonlySet<string> = new Set(STAFF_ENVS);

/** The one spelling of a permission. No trimming, no case folding: `Staff:Ledger:Read:Production` is not one. */
export function staffPermission(area: StaffArea, verb: StaffVerb, env: StaffEnv): StaffPermission {
  return `staff:${area}:${verb}:${env}`;
}

/** True only for exactly `staff:<area>:<verb>:<env>` with all three from the closed lists. */
export function isStaffPermission(value: unknown): value is StaffPermission {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length !== 4) return false;
  const [prefix, area, verb, env] = parts as [string, string, string, string];
  return prefix === 'staff' && AREA_SET.has(area) && VERB_SET.has(verb) && ENV_SET.has(env);
}

/** Every permission in the catalogue, area then verb then environment order. The access overview walks this list. */
export const STAFF_PERMISSIONS: readonly StaffPermission[] = STAFF_AREAS.flatMap((area) =>
  STAFF_VERBS.flatMap((verb) => STAFF_ENVS.map((env) => staffPermission(area, verb, env))),
);

// ── Refusals ────────────────────────────────────────────────────────────────

export const STAFF_ROLE_GRANT_EXCEEDS_HOLDER = 'identity.role_grant_exceeds_holder' as const;
export const STAFF_ROLE_MAPPING_UNSET = 'identity.role_mapping_unset' as const;
export const STAFF_BUSINESS_USER_NOT_STAFF = 'identity.business_user_not_staff' as const;
/** A role row holds a string that is not in the catalogue. A stored row like that is a bug or a tamper, never skipped. */
export const STAFF_PERMISSION_INVALID = 'identity.staff_permission_invalid' as const;

export type StaffPermissionRefusalCode =
  | typeof STAFF_ROLE_GRANT_EXCEEDS_HOLDER
  | typeof STAFF_ROLE_MAPPING_UNSET
  | typeof STAFF_BUSINESS_USER_NOT_STAFF
  | typeof STAFF_PERMISSION_INVALID;

export class StaffPermissionError extends Error {
  readonly code: StaffPermissionRefusalCode;
  /** The permissions or role the refusal is about. Names only, never a secret. */
  readonly detail: readonly string[];
  constructor(code: StaffPermissionRefusalCode, detail: readonly string[] = []) {
    super(detail.length > 0 ? `${code}: ${detail.join(', ')}` : code);
    this.name = 'StaffPermissionError';
    this.code = code;
    this.detail = detail;
  }
}

// ── Roles ───────────────────────────────────────────────────────────────────

export const STAFF_ROLE_KINDS = ['builtin', 'custom'] as const;
export type StaffRoleKind = (typeof STAFF_ROLE_KINDS)[number];

export type StaffRole = {
  readonly id: string;
  readonly name: string;
  readonly kind: StaffRoleKind;
  readonly allow: readonly StaffPermission[];
  readonly deny: readonly StaffPermission[];
};

/**
 * What a person can do after their roles merge. `allow` already has every denied permission removed; `deny` is kept
 * so a later check can tell an explicit deny from a permission nobody granted.
 */
export type StaffEffectivePermissions = {
  readonly allow: ReadonlySet<StaffPermission>;
  readonly deny: ReadonlySet<StaffPermission>;
};

function assertCataloguePermissions(role: StaffRole): void {
  const invalid = [...role.allow, ...role.deny].filter((p) => !isStaffPermission(p));
  if (invalid.length > 0) throw new StaffPermissionError(STAFF_PERMISSION_INVALID, [role.id, ...invalid.map(String)]);
}

/**
 * Merge roles into one effective set: the union of every allow, minus the union of every deny. No roles is no
 * permission. A role holding a string outside the catalogue refuses `identity.staff_permission_invalid`.
 */
export function resolveStaffPermissions(roles: readonly StaffRole[]): StaffEffectivePermissions {
  const allow = new Set<StaffPermission>();
  const deny = new Set<StaffPermission>();
  for (const role of roles) {
    assertCataloguePermissions(role);
    for (const p of role.allow) allow.add(p);
    for (const p of role.deny) deny.add(p);
  }
  for (const p of deny) allow.delete(p);
  return { allow, deny };
}

/** False for anything not explicitly allowed, including every explicit deny. */
export function hasStaffPermission(effective: StaffEffectivePermissions, area: StaffArea, verb: StaffVerb, env: StaffEnv): boolean {
  const p = staffPermission(area, verb, env);
  return !effective.deny.has(p) && effective.allow.has(p);
}

/** Why one permission is or is not held. The access overview (`identity.staff.access`) is a list of these. */
export type StaffPermissionExplanation =
  | { readonly permission: StaffPermission; readonly state: 'allowed'; readonly sourceRoleIds: readonly string[] }
  | {
      readonly permission: StaffPermission;
      readonly state: 'denied_explicit';
      /** Roles that allowed it before the deny removed it. May be empty. */
      readonly sourceRoleIds: readonly string[];
      readonly deniedByRoleIds: readonly string[];
    };

/**
 * Every permission that some role names, with the roles it comes from: allowed, or removed by an explicit deny.
 * A permission no role names is unset (denied) and is not listed. Catalogue order.
 */
export function explainStaffPermissions(roles: readonly StaffRole[]): readonly StaffPermissionExplanation[] {
  for (const role of roles) assertCataloguePermissions(role);
  const out: StaffPermissionExplanation[] = [];
  for (const permission of STAFF_PERMISSIONS) {
    const sourceRoleIds = roles.filter((r) => r.allow.includes(permission)).map((r) => r.id);
    const deniedByRoleIds = roles.filter((r) => r.deny.includes(permission)).map((r) => r.id);
    if (deniedByRoleIds.length > 0) out.push({ permission, state: 'denied_explicit', sourceRoleIds, deniedByRoleIds });
    else if (sourceRoleIds.length > 0) out.push({ permission, state: 'allowed', sourceRoleIds });
  }
  return out;
}

/**
 * A person can grant only what they hold. Refuses `identity.role_grant_exceeds_holder`, naming every permission the
 * role allows that the holder's effective set lacks. A role's denies narrow and need no holding.
 */
export function assertGrantWithinHolder(holderEffective: StaffEffectivePermissions, role: StaffRole): void {
  assertCataloguePermissions(role);
  const missing = role.allow.filter((p) => holderEffective.deny.has(p) || !holderEffective.allow.has(p));
  if (missing.length > 0) throw new StaffPermissionError(STAFF_ROLE_GRANT_EXCEEDS_HOLDER, missing);
}

// ── Built-in roles ──────────────────────────────────────────────────────────

/** The INTAFACED role set. Names only: what each may do is the owner's decision and is not published. */
export const BUILTIN_STAFF_ROLE_NAMES = ['founder', 'compliance', 'support', 'finance', 'developer'] as const;
export type BuiltinStaffRoleName = (typeof BUILTIN_STAFF_ROLE_NAMES)[number];

export function isBuiltinStaffRoleName(value: string): value is BuiltinStaffRoleName {
  return (BUILTIN_STAFF_ROLE_NAMES as readonly string[]).includes(value);
}

/** A published mapping for one built-in role. */
export type BuiltinStaffRoleMapping = {
  readonly allow: readonly StaffPermission[];
  readonly deny: readonly StaffPermission[];
};

/**
 * The built-in role mappings. Every one is null: the owner has not decided them and the decision note says the mapping
 * needs counsel and owner review. Do not fill one in here without that decision.
 */
export const BUILTIN_STAFF_ROLE_MAPPINGS: Readonly<Record<BuiltinStaffRoleName, BuiltinStaffRoleMapping | null>> = {
  founder: null,
  compliance: null,
  support: null,
  finance: null,
  developer: null,
};

/**
 * The assignable role for a built-in name, or `identity.role_mapping_unset` while its mapping is null. `mappings`
 * defaults to the published table above.
 */
export function builtinStaffRoleForAssignment(
  name: BuiltinStaffRoleName,
  mappings: Readonly<Record<BuiltinStaffRoleName, BuiltinStaffRoleMapping | null>> = BUILTIN_STAFF_ROLE_MAPPINGS,
): StaffRole {
  const mapping = mappings[name];
  if (mapping === null || mapping === undefined) throw new StaffPermissionError(STAFF_ROLE_MAPPING_UNSET, [name]);
  const role: StaffRole = { id: `builtin:${name}`, name, kind: 'builtin', allow: mapping.allow, deny: mapping.deny };
  assertCataloguePermissions(role);
  return role;
}

// ── Who may hold a staff role ───────────────────────────────────────────────

/** The account type chosen at sign-up, as identity stores it. */
export type StaffCandidate = { readonly accountType: 'individual' | 'business' };

/**
 * Business users never get staff roles (ORD-013); a business account gets merchant admin only. Anything other than
 * an individual account refuses `identity.business_user_not_staff`.
 */
export function assertStaffRoleHolderEligible(candidate: StaffCandidate): void {
  if (candidate.accountType !== 'individual') throw new StaffPermissionError(STAFF_BUSINESS_USER_NOT_STAFF);
}
