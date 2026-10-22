/**
 * Organisation reads and membership upkeep (I-account-lifecycle-05, first half).
 *
 * `listOrgs` returns the caller's own organisations. `getOrg` returns one organisation and its members to a member
 * only; anyone else gets the same not-found as a missing organisation. `removeOrgMember` lets an admin remove a
 * member, or any member remove themselves, and never leaves an organisation without an admin. `renameOrg` is admin
 * only. Every change is one transaction with its history row. No balance, no ledger, no KYC shortcut.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { OrgError, requireActorId, requireMemberId, requireOrgId, requireOrgRole, type OrgRole } from './org-service.js';

export type OrgSummary = { readonly id: string; readonly name: string; readonly role: OrgRole; readonly createdAt: string };
export type OrgDetail = {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly members: Array<{ readonly userId: string; readonly handle: string; readonly role: OrgRole; readonly since: string }>;
};

export class OrgAdminError extends Error {
  constructor(
    message: string,
    readonly code: 'org.last_admin',
  ) {
    super(message);
    this.name = 'OrgAdminError';
  }
}

function requireName(value: string | null | undefined): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 1 || name.length > 128) throw new OrgError('org name is required', 'org.invalid');
  return name;
}

export async function listOrgs(sql: Sql, actorUserId: string | null | undefined): Promise<{ orgs: OrgSummary[] }> {
  const actor = requireActorId(actorUserId);
  const rows = await sql<Array<{ id: string; name: string; role: string; created_at: Date }>>`
    SELECT o.id, o.name, m.role, o.created_at
    FROM organization_members m JOIN organizations o ON o.id = m.org_id
    WHERE m.user_id = ${actor}
    ORDER BY o.created_at, o.id
  `;
  return { orgs: rows.map((r) => ({ id: r.id, name: r.name, role: requireOrgRole(r.role), createdAt: r.created_at.toISOString() })) };
}

export async function getOrg(sql: Sql, actorUserId: string | null | undefined, orgId: string | null | undefined): Promise<OrgDetail> {
  const actor = requireActorId(actorUserId);
  const org = requireOrgId(orgId);
  const [row] = await sql<Array<{ id: string; name: string; created_by: string; created_at: Date; is_member: boolean }>>`
    SELECT o.id, o.name, o.created_by, o.created_at,
      EXISTS (SELECT 1 FROM organization_members m WHERE m.org_id = o.id AND m.user_id = ${actor}) AS is_member
    FROM organizations o WHERE o.id = ${org}
  `;
  // A non-member cannot tell an organisation that exists from one that does not.
  if (!row || !row.is_member) throw new OrgError('Organization not found', 'org.not_found');
  const members = await sql<Array<{ user_id: string; handle: string; role: string; created_at: Date }>>`
    SELECT m.user_id, u.handle, m.role, m.created_at
    FROM organization_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ${org}
    ORDER BY m.created_at, m.user_id
  `;
  return {
    id: row.id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    members: members.map((m) => ({ userId: m.user_id, handle: m.handle, role: requireOrgRole(m.role), since: m.created_at.toISOString() })),
  };
}

/** Locks the organisation row and returns the actor's seat, or the not-found / not-a-member refusals. */
async function lockedSeat(tx: Sql, actor: string, org: string): Promise<{ name: string; role: OrgRole }> {
  const [row] = await tx<Array<{ name: string }>>`SELECT name FROM organizations WHERE id = ${org} FOR UPDATE`;
  if (!row) throw new OrgError('Organization not found', 'org.not_found');
  const [seat] = await tx<Array<{ role: string }>>`SELECT role FROM organization_members WHERE org_id = ${org} AND user_id = ${actor}`;
  if (!seat) throw new OrgError('Not a member of this organization', 'org.membership_denied');
  return { name: row.name, role: requireOrgRole(seat.role) };
}

export async function removeOrgMember(
  sql: Sql,
  actorUserId: string | null | undefined,
  orgId: string | null | undefined,
  memberId: string | null | undefined,
): Promise<{ orgId: string; userId: string; removed: true }> {
  const actor = requireActorId(actorUserId);
  const org = requireOrgId(orgId);
  const member = requireMemberId(memberId);
  return transaction(sql, async (tx) => {
    const seat = await lockedSeat(tx, actor, org);
    if (member !== actor && seat.role !== 'admin') throw new OrgError('Only an admin can remove a member', 'org.not_admin');
    const [target] = await tx<Array<{ role: string }>>`SELECT role FROM organization_members WHERE org_id = ${org} AND user_id = ${member}`;
    if (!target) throw new OrgError('Member not found', 'org.member_not_found');
    if (requireOrgRole(target.role) === 'admin') {
      // Lock every admin seat so a concurrent removal or role change cannot leave the organisation with none.
      const admins = await tx<Array<{ user_id: string }>>`
        SELECT user_id FROM organization_members WHERE org_id = ${org} AND role = 'admin' ORDER BY user_id FOR UPDATE`;
      if (admins.length <= 1) throw new OrgAdminError('An organization must keep at least one admin', 'org.last_admin');
    }
    await tx`DELETE FROM organization_members WHERE org_id = ${org} AND user_id = ${member}`;
    await tx`
      INSERT INTO organization_history (org_id, actor_id, kind, subject_id, before)
      VALUES (${org}, ${actor}, 'member_removed', ${member}, ${target.role})
    `;
    return { orgId: org, userId: member, removed: true as const };
  });
}

export async function renameOrg(
  sql: Sql,
  actorUserId: string | null | undefined,
  orgId: string | null | undefined,
  name: string | null | undefined,
): Promise<{ id: string; name: string; changed: boolean }> {
  const actor = requireActorId(actorUserId);
  const org = requireOrgId(orgId);
  const next = requireName(name);
  return transaction(sql, async (tx) => {
    const seat = await lockedSeat(tx, actor, org);
    if (seat.role !== 'admin') throw new OrgError('Only an admin can rename the organization', 'org.not_admin');
    if (seat.name === next) return { id: org, name: next, changed: false };
    await tx`UPDATE organizations SET name = ${next} WHERE id = ${org}`;
    await tx`
      INSERT INTO organization_history (org_id, actor_id, kind, before, after)
      VALUES (${org}, ${actor}, 'renamed', ${seat.name}, ${next})
    `;
    return { id: org, name: next, changed: true };
  });
}
