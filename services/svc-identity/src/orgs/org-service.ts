/**
 * Organizations + membership (M01).
 *
 * Roles: admin, trader, auditor, risk-manager. Missing / unknown role refuses.
 * Auditor and risk-manager cannot place. Trader and risk-manager cannot add members.
 * Risk-manager (and admin) can see risk.
 * Adding or granting admin refuses unless a second distinct admin approver is present.
 * Create an org; add a member; a member of A cannot act as B.
 * Missing org/member id refuses — never invent a home org.
 * No balance. No ledger. Does not place an order. No approval-workflow UI.
 */
import { randomUUID } from 'node:crypto';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';

export const ORG_ROLES = ['admin', 'trader', 'auditor', 'risk-manager'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export type OrgView = {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
};

export type OrgMemberView = {
  readonly orgId: string;
  readonly userId: string;
  readonly role: OrgRole;
};

export type OrgActorView = {
  readonly orgId: string;
  readonly userId: string;
  readonly role: OrgRole;
};

export type OrgPlaceView = {
  readonly orgId: string;
  readonly userId: string;
  readonly role: 'admin' | 'trader';
};

export type OrgRiskView = {
  readonly orgId: string;
  readonly userId: string;
  readonly role: 'admin' | 'risk-manager';
};

export class OrgError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'org.id_required'
      | 'org.member_id_required'
      | 'org.actor_id_required'
      | 'org.role_required'
      | 'org.role_invalid'
      | 'org.not_found'
      | 'org.member_not_found'
      | 'org.actor_not_found'
      | 'org.membership_denied'
      | 'org.not_admin'
      | 'org.place_denied'
      | 'org.risk_denied'
      | 'org.already_member'
      | 'org.second_approver_required'
      | 'org.self_approval'
      | 'org.second_approver_not_admin'
      | 'org.invalid'
      /** The change would leave the organization with no admin. */
      | 'org.last_admin',
  ) {
    super(message);
    this.name = 'OrgError';
  }
}

export function requireOrgId(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    throw new OrgError('orgId is required', 'org.id_required');
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OrgError('orgId is required', 'org.id_required');
  }
  return value.trim();
}

export function requireMemberId(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    throw new OrgError('memberId is required', 'org.member_id_required');
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OrgError('memberId is required', 'org.member_id_required');
  }
  return value.trim();
}

export function requireActorId(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    throw new OrgError('actor userId is required', 'org.actor_id_required');
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OrgError('actor userId is required', 'org.actor_id_required');
  }
  return value.trim();
}

export function requireOrgRole(value: string | null | undefined): OrgRole {
  if (value === null || value === undefined) {
    throw new OrgError('org role is required', 'org.role_required');
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OrgError('org role is required', 'org.role_required');
  }
  const role = value.trim();
  if (role === 'admin' || role === 'trader' || role === 'auditor' || role === 'risk-manager') {
    return role;
  }
  throw new OrgError('org role is invalid', 'org.role_invalid');
}

function requireName(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    throw new OrgError('org name is required', 'org.invalid');
  }
  const name = value.trim();
  if (name.length < 1 || name.length > 128) {
    throw new OrgError('org name is required', 'org.invalid');
  }
  return name;
}

/**
 * Dual-control for minting admin. Proposer cannot be the second pair of eyes.
 * Missing / self / non-admin second approver refuses — never single-admin-promote.
 */
async function requireDistinctAdminApprover(
  sql: Sql,
  org: string,
  actor: string,
  secondApproverId: string | null | undefined,
): Promise<void> {
  if (secondApproverId === null || secondApproverId === undefined) {
    throw new OrgError('Second distinct admin approver is required to grant admin', 'org.second_approver_required');
  }
  if (typeof secondApproverId !== 'string' || secondApproverId.trim() === '') {
    throw new OrgError('Second distinct admin approver is required to grant admin', 'org.second_approver_required');
  }
  const approver = secondApproverId.trim();
  if (approver === actor) {
    throw new OrgError('Proposer cannot satisfy independent-approver requirement', 'org.self_approval');
  }
  const seat = await sql<Array<{ role: string }>>`
    SELECT role FROM organization_members WHERE org_id = ${org} AND user_id = ${approver} LIMIT 1
  `;
  if (!seat[0]) {
    throw new OrgError('Second approver must be an admin of this organization', 'org.second_approver_not_admin');
  }
  if (requireOrgRole(seat[0].role) !== 'admin') {
    throw new OrgError('Second approver must be an admin of this organization', 'org.second_approver_not_admin');
  }
}

type OrgRow = { id: string; name: string; created_by: string };

export async function createOrg(sql: Sql, actorUserId: string | null | undefined, name: string | null | undefined): Promise<OrgView> {
  const actor = requireActorId(actorUserId);
  const orgName = requireName(name);
  const users = await sql<Array<{ id: string }>>`
    SELECT id FROM users WHERE id = ${actor} LIMIT 1
  `;
  if (!users[0]) {
    throw new OrgError('User not found', 'org.actor_not_found');
  }
  const id = randomUUID();
  const rows = await sql<OrgRow[]>`
    INSERT INTO organizations (id, name, created_by)
    VALUES (${id}, ${orgName}, ${actor})
    RETURNING id, name, created_by
  `;
  const row = rows[0];
  if (!row) {
    throw new OrgError('User not found', 'org.actor_not_found');
  }
  await sql`
    INSERT INTO organization_members (org_id, user_id, role)
    VALUES (${row.id}, ${actor}, ${'admin'})
  `;
  return { id: row.id, name: row.name, createdBy: row.created_by };
}

export async function addOrgMember(
  sql: Sql,
  actorUserId: string | null | undefined,
  orgId: string | null | undefined,
  memberId: string | null | undefined,
  role: string | null | undefined,
  secondApproverId?: string | null,
): Promise<OrgMemberView> {
  const actor = requireActorId(actorUserId);
  const org = requireOrgId(orgId);
  const member = requireMemberId(memberId);
  const grant = requireOrgRole(role);

  const actorSeat = await assertOrgActor(sql, actor, org);
  if (actorSeat.role !== 'admin') {
    throw new OrgError('Only an admin can add a member', 'org.not_admin');
  }

  if (grant === 'admin') {
    await requireDistinctAdminApprover(sql, org, actor, secondApproverId);
  }

  const users = await sql<Array<{ id: string }>>`
    SELECT id FROM users WHERE id = ${member} LIMIT 1
  `;
  if (!users[0]) {
    throw new OrgError('Member not found', 'org.member_not_found');
  }

  const existing = await sql<Array<{ user_id: string }>>`
    SELECT user_id FROM organization_members WHERE org_id = ${org} AND user_id = ${member} LIMIT 1
  `;
  if (existing[0]) {
    throw new OrgError('Already a member', 'org.already_member');
  }

  await sql`
    INSERT INTO organization_members (org_id, user_id, role)
    VALUES (${org}, ${member}, ${grant})
  `;
  return { orgId: org, userId: member, role: grant };
}

/**
 * Lock every admin seat of an organization (`FOR UPDATE`, stable order) and return their user ids.
 * Call inside a transaction before any change that can remove an admin seat.
 */
export async function lockOrgAdmins(tx: Sql, orgId: string): Promise<string[]> {
  const rows = await tx<Array<{ user_id: string }>>`
    SELECT user_id FROM organization_members WHERE org_id = ${orgId} AND role = 'admin' ORDER BY user_id FOR UPDATE`;
  return rows.map((r) => r.user_id);
}

/**
 * THE last-admin rule, in one place: refuse `org.last_admin` when `leavingUserId` is the only
 * admin in `lockedAdminIds` (from `lockOrgAdmins`). Demotion and member removal both use it.
 */
export function requireAnotherAdmin(lockedAdminIds: readonly string[], leavingUserId: string): void {
  if (lockedAdminIds.includes(leavingUserId) && lockedAdminIds.length <= 1) {
    throw new OrgError('An organization must keep at least one admin', 'org.last_admin');
  }
}

/**
 * Change an existing member's role. Granting admin needs a second distinct admin.
 * Demoting the organization's last admin refuses with `org.last_admin`.
 */
export async function grantOrgRole(
  sql: Sql,
  actorUserId: string | null | undefined,
  orgId: string | null | undefined,
  memberId: string | null | undefined,
  role: string | null | undefined,
  secondApproverId?: string | null,
): Promise<OrgMemberView> {
  const actor = requireActorId(actorUserId);
  const org = requireOrgId(orgId);
  const member = requireMemberId(memberId);
  const grant = requireOrgRole(role);

  const actorSeat = await assertOrgActor(sql, actor, org);
  if (actorSeat.role !== 'admin') {
    throw new OrgError('Only an admin can grant a role', 'org.not_admin');
  }

  const existing = await sql<Array<{ user_id: string; role: string }>>`
    SELECT user_id, role FROM organization_members WHERE org_id = ${org} AND user_id = ${member} LIMIT 1
  `;
  if (!existing[0]) {
    throw new OrgError('Member not found', 'org.member_not_found');
  }

  if (grant === 'admin') {
    await requireDistinctAdminApprover(sql, org, actor, secondApproverId);
  }

  if (existing[0].role === 'admin' && grant !== 'admin') {
    // Demoting an admin must never leave the organization without one. Every admin
    // seat is locked first, then the actor and the target are re-read under the lock.
    return transaction(sql, async (tx) => {
      const admins = await lockOrgAdmins(tx, org);
      // A stale actor (demoted after the check above) cannot demote anyone.
      if (!admins.includes(actor)) throw new OrgError('Only an admin can grant a role', 'org.not_admin');
      const [target] = await tx<Array<{ role: string }>>`
        SELECT role FROM organization_members WHERE org_id = ${org} AND user_id = ${member} FOR UPDATE`;
      if (!target) throw new OrgError('Member not found', 'org.member_not_found');
      // If the target was demoted meanwhile it is no longer an admin seat: plain role change.
      if (target.role === 'admin') requireAnotherAdmin(admins, member);
      await tx`
        UPDATE organization_members SET role = ${grant} WHERE org_id = ${org} AND user_id = ${member}
      `;
      return { orgId: org, userId: member, role: grant };
    });
  }

  await sql`
    UPDATE organization_members SET role = ${grant} WHERE org_id = ${org} AND user_id = ${member}
  `;
  return { orgId: org, userId: member, role: grant };
}

/**
 * Named org action. Membership in another org is not a shortcut.
 * Unknown / missing seat role refuses.
 */
export async function assertOrgActor(
  sql: Sql,
  actorUserId: string | null | undefined,
  orgId: string | null | undefined,
): Promise<OrgActorView> {
  const actor = requireActorId(actorUserId);
  const org = requireOrgId(orgId);

  const orgs = await sql<Array<{ id: string }>>`
    SELECT id FROM organizations WHERE id = ${org} LIMIT 1
  `;
  if (!orgs[0]) {
    throw new OrgError('Organization not found', 'org.not_found');
  }

  const seat = await sql<Array<{ role: string }>>`
    SELECT role FROM organization_members WHERE org_id = ${org} AND user_id = ${actor} LIMIT 1
  `;
  if (!seat[0]) {
    throw new OrgError('Not a member of this organization', 'org.membership_denied');
  }
  return { orgId: org, userId: actor, role: requireOrgRole(seat[0].role) };
}

/**
 * Identity-side place door. Does not submit an order.
 * Admin and trader may place. Auditor and risk-manager cannot. Missing role refuses.
 */
export async function assertOrgPlace(
  sql: Sql,
  actorUserId: string | null | undefined,
  orgId: string | null | undefined,
): Promise<OrgPlaceView> {
  const actor = await assertOrgActor(sql, actorUserId, orgId);
  if (actor.role !== 'admin' && actor.role !== 'trader') {
    throw new OrgError(actor.role === 'risk-manager' ? 'Risk manager cannot place' : 'Auditor cannot place', 'org.place_denied');
  }
  return { orgId: actor.orgId, userId: actor.userId, role: actor.role };
}

/**
 * Identity-side risk door. Does not compute risk.
 * Admin and risk-manager may see risk. Trader and auditor cannot. Missing role refuses.
 */
export async function assertOrgRisk(
  sql: Sql,
  actorUserId: string | null | undefined,
  orgId: string | null | undefined,
): Promise<OrgRiskView> {
  const actor = await assertOrgActor(sql, actorUserId, orgId);
  if (actor.role !== 'admin' && actor.role !== 'risk-manager') {
    throw new OrgError('This role cannot see org risk', 'org.risk_denied');
  }
  return { orgId: actor.orgId, userId: actor.userId, role: actor.role };
}
