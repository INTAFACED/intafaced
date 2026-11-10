/**
 * Developer-area roles in an organisation (DV-console-01; journey J-developer-15 #4).
 *
 * The organisation's admin is its owner: they always manage its keys and give its members developer roles. A member
 * holds at most one: `keys_admin` creates and revokes the organisation's keys, `keys_read` only sees them. Which roles
 * exist is the owner value `IDENTITY_DEVELOPER_ROLES`; blank is `roles not set`, and then no member has key authority
 * and no role can be given (`identity.developer_roles_unset`). A member's key authority never exceeds their role.
 */
import type { Sql } from 'postgres';
import {
  DEVELOPER_ROLES,
  type DeveloperRole,
  type DeveloperSetRoleInput,
  type DeveloperTeam,
  type DeveloperTeamRefusal,
} from '@intafaced/contracts/api-keys';
import { KEY_COLUMNS, toRecord, type KeyRow } from './developer-keys.js';

export type DeveloperTeamErrorCode =
  | DeveloperTeamRefusal
  | 'identity.developer_org_denied'
  | 'identity.developer_role_denied'
  | 'identity.developer_role_unknown'
  | 'identity.developer_member_unknown'
  | 'identity.developer_request_conflict';

export class DeveloperTeamError extends Error {
  constructor(
    message: string,
    readonly code: DeveloperTeamErrorCode,
  ) {
    super(message);
    this.name = 'DeveloperTeamError';
  }
}

/**
 * `IDENTITY_DEVELOPER_ROLES`: the developer roles the owner publishes, joined by commas (`keys_admin,keys_read`).
 * Blank: null, `roles not set`. An unknown or repeated role throws, so the service does not start on a role set it
 * cannot read.
 */
export function parseDeveloperRoles(raw: string | undefined): readonly DeveloperRole[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const roles: DeveloperRole[] = [];
  for (const part of raw.split(',')) {
    const role = part.trim() as DeveloperRole;
    if (!(DEVELOPER_ROLES as readonly string[]).includes(role) || roles.includes(role)) {
      throw new Error(`IDENTITY_DEVELOPER_ROLES must list developer roles (${DEVELOPER_ROLES.join(', ')}), each once`);
    }
    roles.push(role);
  }
  return roles;
}

export type DeveloperSeat = { orgRole: string; developerRole: DeveloperRole | null; orgName: string };

/** The caller's seat in the organisation; not a member refuses as if the organisation did not exist. */
export async function seatOf(sql: Sql, orgId: string, userId: string): Promise<DeveloperSeat> {
  const rows = await sql<Array<{ org_role: string; developer_role: string | null; org_name: string }>>`
    SELECT m.role AS org_role, d.role AS developer_role, o.name AS org_name
    FROM organization_members m
    JOIN organizations o ON o.id = m.org_id
    LEFT JOIN org_developer_roles d ON d.org_id = m.org_id AND d.user_id = m.user_id
    WHERE m.org_id = ${orgId} AND m.user_id = ${userId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new DeveloperTeamError('You are not a member of this organisation', 'identity.developer_org_denied');
  return {
    orgRole: row.org_role,
    developerRole: (DEVELOPER_ROLES as readonly string[]).includes(row.developer_role ?? '') ? (row.developer_role as DeveloperRole) : null,
    orgName: row.org_name,
  };
}

/**
 * Null when the seat may create and revoke the organisation's keys; otherwise why not. The owner always may. A member
 * may only with `keys_admin`, and only while the owner has published that role.
 */
export function manageRefusalOf(seat: DeveloperSeat, published: readonly DeveloperRole[] | null): DeveloperTeamRefusal | null {
  if (seat.orgRole === 'admin') return null;
  if (published === null) return 'identity.developer_roles_unset';
  const role = seat.developerRole !== null && published.includes(seat.developerRole) ? seat.developerRole : null;
  if (role === 'keys_admin') return null;
  if (role === 'keys_read') return 'identity.developer_role_read_only';
  return 'identity.developer_role_none';
}

const MANAGE_MESSAGE: Record<DeveloperTeamRefusal, string> = {
  'identity.developer_roles_unset': 'Developer roles are not set for this organisation',
  'identity.developer_role_read_only': 'Your developer role can see this organisation’s keys but not change them',
  'identity.developer_role_none': 'You hold no developer role in this organisation',
};

/** Throws the caller's refusal when they may not create or revoke the organisation's keys. */
export async function assertMayManageOrgKeys(
  sql: Sql,
  orgId: string,
  userId: string,
  published: readonly DeveloperRole[] | null,
): Promise<void> {
  const refusal = manageRefusalOf(await seatOf(sql, orgId, userId), published);
  if (refusal !== null) throw new DeveloperTeamError(MANAGE_MESSAGE[refusal], refusal);
}

/** The organisation's developer area as the caller sees it: their role, why they may not manage keys, and its keys. */
export async function developerTeam(
  sql: Sql,
  orgId: string,
  userId: string,
  published: readonly DeveloperRole[] | null,
): Promise<DeveloperTeam> {
  const seat = await seatOf(sql, orgId, userId);
  const owner = seat.orgRole === 'admin';
  const myRole = owner ? 'owner' : seat.developerRole !== null && published?.includes(seat.developerRole) ? seat.developerRole : null;
  // A member with no developer role sees no keys; a published role (read or admin) sees them all.
  const keys =
    owner || myRole !== null
      ? await sql<KeyRow[]>`
          SELECT ${sql.unsafe(KEY_COLUMNS)} FROM api_keys WHERE org_id = ${orgId} ORDER BY created_at DESC, id DESC LIMIT 200
        `
      : [];
  const members = owner
    ? await sql<Array<{ user_id: string; email: string; org_role: string; developer_role: string | null; role_version: number }>>`
        SELECT m.user_id, u.email::text AS email, m.role AS org_role, d.role AS developer_role,
          (SELECT count(*)::int FROM org_developer_role_changes c WHERE c.org_id = m.org_id AND c.user_id = m.user_id) AS role_version
        FROM organization_members m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN org_developer_roles d ON d.org_id = m.org_id AND d.user_id = m.user_id
        WHERE m.org_id = ${orgId}
        ORDER BY m.role = 'admin' DESC, u.email
      `
    : [];
  return {
    orgId,
    orgName: seat.orgName,
    rolesPublished: published === null ? null : [...published],
    myRole,
    manageRefusal: manageRefusalOf(seat, published),
    members: members.map((m) => ({
      userId: m.user_id,
      email: m.email,
      orgRole: m.org_role,
      // Only a published role is shown: an unpublished one gives no authority (manageRefusalOf), so it reads as none.
      developerRole: published?.includes(m.developer_role as DeveloperRole) ? (m.developer_role as DeveloperRole) : null,
      roleVersion: Number(m.role_version),
    })),
    keys: keys.map(toRecord),
  };
}

/**
 * The owner gives a member a developer role or takes it away. Only the organisation's admin may (a member never raises
 * their own or anyone's role); the roles must be published and the role among them; the target must be a member. The
 * request id is kept: a repeat answers `changed: false`, and the same id for a different change refuses.
 */
export async function setDeveloperRole(
  sql: Sql,
  actorId: string,
  input: DeveloperSetRoleInput,
  published: readonly DeveloperRole[] | null,
): Promise<{ userId: string; role: DeveloperRole | null; changed: boolean }> {
  const seat = await seatOf(sql, input.orgId, actorId);
  if (seat.orgRole !== 'admin') {
    throw new DeveloperTeamError('Only the organisation’s owner may change developer roles', 'identity.developer_role_denied');
  }
  if (published === null) throw new DeveloperTeamError(MANAGE_MESSAGE['identity.developer_roles_unset'], 'identity.developer_roles_unset');
  if (input.role !== null && !published.includes(input.role)) {
    throw new DeveloperTeamError('That developer role is not published', 'identity.developer_role_unknown');
  }
  return sql.begin(async (tx) => {
    const seen = await tx<Array<{ user_id: string; role: string | null }>>`
      SELECT user_id, role FROM org_developer_role_changes WHERE org_id = ${input.orgId} AND request_id = ${input.requestId}
    `;
    if (seen[0]) {
      if (seen[0].user_id !== input.userId || seen[0].role !== input.role) {
        throw new DeveloperTeamError('This request id was already used for a different change', 'identity.developer_request_conflict');
      }
      return { userId: input.userId, role: input.role, changed: false };
    }
    const member = await tx`SELECT 1 FROM organization_members WHERE org_id = ${input.orgId} AND user_id = ${input.userId}`;
    if (member.length === 0) {
      throw new DeveloperTeamError('That person is not a member of this organisation', 'identity.developer_member_unknown');
    }
    const inserted = await tx`
      INSERT INTO org_developer_role_changes (org_id, request_id, user_id, role, actor_id)
      VALUES (${input.orgId}, ${input.requestId}, ${input.userId}, ${input.role}, ${actorId})
      ON CONFLICT (org_id, request_id) DO NOTHING
      RETURNING 1
    `;
    if (inserted.length === 0) {
      // A concurrent request with this id committed first: the same change is a repeat, another change refuses.
      const raced = await tx<Array<{ user_id: string; role: string | null }>>`
        SELECT user_id, role FROM org_developer_role_changes WHERE org_id = ${input.orgId} AND request_id = ${input.requestId}
      `;
      if (raced[0] && raced[0].user_id === input.userId && raced[0].role === input.role) {
        return { userId: input.userId, role: input.role, changed: false };
      }
      throw new DeveloperTeamError('This request id was already used for a different change', 'identity.developer_request_conflict');
    }
    if (input.role === null) {
      await tx`DELETE FROM org_developer_roles WHERE org_id = ${input.orgId} AND user_id = ${input.userId}`;
    } else {
      await tx`
        INSERT INTO org_developer_roles (org_id, user_id, role, updated_by)
        VALUES (${input.orgId}, ${input.userId}, ${input.role}, ${actorId})
        ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_by = EXCLUDED.updated_by, updated_at = now()
      `;
    }
    return { userId: input.userId, role: input.role, changed: true };
  }) as Promise<{ userId: string; role: DeveloperRole | null; changed: boolean }>;
}

/** An organisation's key, revoked by its owner or a key admin. Returns the key's row after the revoke. */
export async function revokeOrgKey(
  sql: Sql,
  orgId: string,
  userId: string,
  keyId: string,
  reason: string | null,
  published: readonly DeveloperRole[] | null,
): Promise<{ row: KeyRow; changed: boolean } | null> {
  await assertMayManageOrgKeys(sql, orgId, userId, published);
  const current = await sql<KeyRow[]>`SELECT ${sql.unsafe(KEY_COLUMNS)} FROM api_keys WHERE id = ${keyId} AND org_id = ${orgId}`;
  if (!current[0]) return null;
  if (current[0].revoked) return { row: current[0], changed: false };
  const updated = await sql<KeyRow[]>`
    UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'owner', revoke_reason = ${reason}
    WHERE id = ${keyId} AND org_id = ${orgId} AND revoked = false
    RETURNING ${sql.unsafe(KEY_COLUMNS)}
  `;
  if (updated[0]) return { row: updated[0], changed: true };
  const after = await sql<KeyRow[]>`SELECT ${sql.unsafe(KEY_COLUMNS)} FROM api_keys WHERE id = ${keyId} AND org_id = ${orgId}`;
  return after[0] ? { row: after[0], changed: false } : null;
}
