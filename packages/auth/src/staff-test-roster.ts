/**
 * THE TEST STAFF ROSTER: staff sessions on local and test stacks only (OWNER 44).
 *
 * The real staff roster and the built-in role mappings are blank owner settings (`BUILTIN_STAFF_ROLE_MAPPINGS` is all
 * null; docs/OWNER-SETTINGS.md lists them for the owner and counsel at launch prep). Until they are set, a journey that
 * needs a support, compliance, risk or finance person cannot run. This module lets a local or test stack name a labelled
 * TEST roster instead, from `tooling/profiles/test-owner-values/identity.json`.
 *
 * ── The rules, stated once ──────────────────────────────────────────────────
 *
 *   1. A roster is read only when `APP_ENV` is exactly `dev` or `test` (the raw value, never a schema default). Any other
 *      `APP_ENV` (unset, `staging`, `production`, a typo, a different case) with a non-blank roster refuses
 *      `identity.staff_test_roster_refused`, so a process that holds one cannot boot outside a test stack. Blank is no
 *      roster, everywhere: production keeps the null mappings and the founder-only console.
 *   2. Every label says TEST: the roster's own `label`, and each role's.
 *   3. A TEST role grants only session scopes from `FOUNDER_SESSION_SCOPE_ALLOWLIST` (never `admin:treasury`, a `pay:`
 *      scope or anything that moves money from a session), and only staff permissions for `local` or `staging`, never
 *      `production`.
 *   4. A member is an email on the `local-test.invalid` domain (RFC 2606: it can never be a real person's address), with
 *      exactly one TEST role, listed once.
 *   5. A TEST role's scopes go only on a confirmed-email, second-factor, interactive session: never an API key, never a
 *      sub-account (`scopesForStaffTestSession`), the same gates a founder's session has.
 *
 * `risk` is a TEST custom role: the spec's built-in set (OPS-admin-access-03) is founder, compliance, support, finance
 * and developer, and whether risk becomes a built-in role is the owner's decision.
 */
import { FOUNDER_SESSION_SCOPE_ALLOWLIST, type Scope } from './scopes.js';
import {
  BUILTIN_STAFF_ROLE_MAPPINGS,
  isStaffPermission,
  type BuiltinStaffRoleMapping,
  type BuiltinStaffRoleName,
  type StaffPermission,
} from './staff-permissions.js';

/** The staff roles journeys need. `risk` is custom (see the module note); the other three are built-in names. */
export const STAFF_TEST_ROLE_NAMES = ['support', 'compliance', 'risk', 'finance'] as const;
export type StaffTestRoleName = (typeof STAFF_TEST_ROLE_NAMES)[number];

/** The built-in names among the TEST roles: these fill `BUILTIN_STAFF_ROLE_MAPPINGS` on a test stack. */
const BUILTIN_TEST_ROLES = ['support', 'compliance', 'finance'] as const satisfies readonly BuiltinStaffRoleName[];

/** A roster outside a local or test stack. */
export const STAFF_TEST_ROSTER_REFUSED = 'identity.staff_test_roster_refused' as const;
/** A roster that is not the shape below (bad JSON, a missing TEST label, a scope or permission it may not grant). */
export const STAFF_TEST_ROSTER_INVALID = 'identity.staff_test_roster_invalid' as const;

export class StaffTestRosterError extends Error {
  readonly code: typeof STAFF_TEST_ROSTER_REFUSED | typeof STAFF_TEST_ROSTER_INVALID;
  constructor(code: typeof STAFF_TEST_ROSTER_REFUSED | typeof STAFF_TEST_ROSTER_INVALID, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'StaffTestRosterError';
    this.code = code;
  }
}

export type StaffTestRole = {
  readonly label: string;
  /** Session scopes the role's signed-in session gets, from `FOUNDER_SESSION_SCOPE_ALLOWLIST` only. */
  readonly sessionScopes: readonly Scope[];
  readonly allow: readonly StaffPermission[];
  readonly deny: readonly StaffPermission[];
};

export type StaffTestRoster = {
  readonly label: string;
  readonly roles: Readonly<Record<StaffTestRoleName, StaffTestRole>>;
  readonly members: readonly { readonly email: string; readonly role: StaffTestRoleName }[];
};

/** True only when `APP_ENV` is exactly `dev` or `test`. Same rule as `@intafaced/config` `isExplicitDevOrTest`. */
export function isStaffTestStack(appEnv: string | null | undefined): boolean {
  return appEnv === 'dev' || appEnv === 'test';
}

const MEMBER_EMAIL = /^[a-z0-9][a-z0-9._-]{0,62}@local-test\.invalid$/;
const isTestLabel = (value: unknown): value is string => typeof value === 'string' && /^TEST\b/.test(value.trim());
const invalid = (detail: string): never => {
  throw new StaffTestRosterError(STAFF_TEST_ROSTER_INVALID, detail);
};
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseRole(name: StaffTestRoleName, raw: unknown): StaffTestRole {
  if (!isRecord(raw)) return invalid(`role ${name} is missing`);
  const extra = Object.keys(raw).filter((key) => !['label', 'sessionScopes', 'allow', 'deny'].includes(key));
  if (extra.length > 0) invalid(`role ${name} has unknown fields: ${extra.join(', ')}`);
  if (!isTestLabel(raw.label)) invalid(`role ${name} has no TEST label`);
  const list = (field: 'sessionScopes' | 'allow' | 'deny'): string[] => {
    const value = raw[field];
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return invalid(`role ${name} ${field} is not a list of names`);
    if (new Set(value).size !== value.length) invalid(`role ${name} ${field} names something twice`);
    return value as string[];
  };
  const sessionScopes = list('sessionScopes');
  for (const scope of sessionScopes)
    if (!(FOUNDER_SESSION_SCOPE_ALLOWLIST as readonly string[]).includes(scope))
      invalid(`role ${name} may not grant the session scope ${scope.slice(0, 40)}`);
  const permissions = (field: 'allow' | 'deny'): StaffPermission[] => {
    const value = list(field);
    for (const p of value) {
      if (!isStaffPermission(p)) invalid(`role ${name} ${field} holds ${p.slice(0, 60)}, which is not a staff permission`);
      if (p.endsWith(':production')) invalid(`role ${name} ${field} names ${p}: a TEST role never reaches production`);
    }
    return value as StaffPermission[];
  };
  return {
    label: (raw.label as string).trim(),
    sessionScopes: sessionScopes as Scope[],
    allow: permissions('allow'),
    deny: permissions('deny'),
  };
}

/**
 * Read the TEST roster from its env value. Blank (or unset) is no roster on every stack. A non-blank value refuses
 * `identity.staff_test_roster_refused` unless `appEnv` is exactly `dev` or `test`, before it is even parsed; then a value
 * that breaks a rule in the module note refuses `identity.staff_test_roster_invalid`. Boot calls this, so either
 * refusal stops the process.
 */
export function parseStaffTestRoster(raw: string | null | undefined, appEnv: string | null | undefined): StaffTestRoster | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') return undefined;
  if (!isStaffTestStack(appEnv))
    throw new StaffTestRosterError(
      STAFF_TEST_ROSTER_REFUSED,
      'a TEST staff roster is read only when APP_ENV is exactly dev or test; production keeps the owner roster blank',
    );
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return invalid('the roster is not JSON');
  }
  if (!isRecord(json)) return invalid('the roster is not an object');
  const extra = Object.keys(json).filter((key) => !['label', 'roles', 'members'].includes(key));
  if (extra.length > 0) invalid(`the roster has unknown fields: ${extra.join(', ')}`);
  if (!isTestLabel(json.label)) invalid('the roster has no TEST label');
  if (!isRecord(json.roles)) return invalid('the roster has no roles');
  const unknownRoles = Object.keys(json.roles).filter((key) => !(STAFF_TEST_ROLE_NAMES as readonly string[]).includes(key));
  if (unknownRoles.length > 0) invalid(`the roster names roles outside ${STAFF_TEST_ROLE_NAMES.join(', ')}: ${unknownRoles.join(', ')}`);
  const roles = Object.fromEntries(
    STAFF_TEST_ROLE_NAMES.map((name) => [name, parseRole(name, (json.roles as Record<string, unknown>)[name])]),
  ) as Record<StaffTestRoleName, StaffTestRole>;
  if (!Array.isArray(json.members)) return invalid('the roster has no members list');
  const seen = new Set<string>();
  const members = json.members.map((entry: unknown) => {
    if (!isRecord(entry) || Object.keys(entry).sort().join(',') !== 'email,role') return invalid('a member is not { email, role }');
    const email = typeof entry.email === 'string' ? entry.email : '';
    if (!MEMBER_EMAIL.test(email)) invalid(`member ${email.slice(0, 60)} is not a lower-case address on local-test.invalid`);
    if (seen.has(email)) invalid(`member ${email} is listed twice`);
    seen.add(email);
    if (!(STAFF_TEST_ROLE_NAMES as readonly unknown[]).includes(entry.role)) invalid(`member ${email} has no TEST role`);
    return { email, role: entry.role as StaffTestRoleName };
  });
  return { label: (json.label as string).trim(), roles, members };
}

/**
 * The built-in role mappings this stack uses. No roster (production, or a test stack that set none) is the published
 * table, every one null, so assigning a built-in role still refuses `identity.role_mapping_unset`. With a TEST roster,
 * support, compliance and finance take the roster's TEST mappings; founder and developer stay null.
 */
export function staffRoleMappingsFor(
  roster: StaffTestRoster | undefined,
): Readonly<Record<BuiltinStaffRoleName, BuiltinStaffRoleMapping | null>> {
  if (roster === undefined) return BUILTIN_STAFF_ROLE_MAPPINGS;
  const out: Record<BuiltinStaffRoleName, BuiltinStaffRoleMapping | null> = { ...BUILTIN_STAFF_ROLE_MAPPINGS };
  for (const name of BUILTIN_TEST_ROLES) out[name] = { allow: roster.roles[name].allow, deny: roster.roles[name].deny };
  return out;
}

/** The TEST role of a confirmed email, or null. No roster is always null. Emails compare after trimming and lower-casing. */
export function staffTestRoleFor(roster: StaffTestRoster | undefined, email: string | null | undefined): StaffTestRoleName | null {
  if (roster === undefined || typeof email !== 'string') return null;
  const wanted = email.trim().toLowerCase();
  return roster.members.find((member) => member.email === wanted)?.role ?? null;
}

/**
 * A TEST staff member's session scopes: `base` plus the role's TEST scopes, only on an interactive session with a second
 * factor that is not an API key and not a sub-account. No role, or no roster, is `base` unchanged.
 */
export function scopesForStaffTestSession(
  base: readonly Scope[],
  opts: {
    readonly roster: StaffTestRoster | undefined;
    readonly role: StaffTestRoleName | null;
    readonly mfa: boolean;
    readonly apiKey?: boolean;
    readonly subAccount?: boolean;
  },
): Scope[] {
  const out = [...base];
  if (opts.roster === undefined || opts.role === null || !opts.mfa || opts.apiKey === true || opts.subAccount === true) return out;
  for (const scope of opts.roster.roles[opts.role].sessionScopes) {
    // Re-checked here as well as at parse: a hand-built roster must not differ.
    if (!(FOUNDER_SESSION_SCOPE_ALLOWLIST as readonly string[]).includes(scope)) continue;
    if (!out.includes(scope)) out.push(scope);
  }
  return out;
}
