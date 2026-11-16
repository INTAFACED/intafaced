import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import {
  assertPostingEnabled,
  NO_PARTNER_BANK_CODE,
  partnerPayoutsAccount,
  type PartnerAccountRef,
  type PartnerBank,
  type NoteRefusal,
  type PartnerCustody,
  type PostingFreeze,
} from '../partner/partner-bank.js';
import { BusinessDirectoryError, normaliseEmailQuery, normaliseHandleQuery, type BusinessDirectoryPort } from './business-directory.js';
import { BUSINESS_ROLE_CAPABILITIES, BUSINESS_ROLES, roleCan, type BusinessMemberRole } from './business-policy.js';

/**
 * A BUSINESS BANK TEAM AND ITS APPROVAL RULES (J-bank-19; BK-biz-01 to BK-biz-04).
 *
 * The business's money is the partner bank's (OWNER 226; docs/adr/2026-11-10-launch-money-model.md). It sits in the
 * business's own account at the partner, `business:<account id>`, and the partner reports its figure. A payment the team
 * proposes is one instruction to the partner, under the business key `bank.business.payment:<payment id>`, stored on the
 * payment's row before it is sent and sent once; an answer that is not definite is read back by that key, never sent
 * again blind. INTAFACED's ledger posts nothing for any of it.
 *
 *   roles         The business names its own roles (a Bookkeeper with `view` and `export`). A member holding one has
 *                 exactly its permissions; a member without one has their built-in role's. Nobody grants a permission
 *                 they do not hold themselves (`bank.business_role_grant_exceeds`).
 *   advisors      An advisor reads the business and nothing more, and only once the business's owner approved them:
 *                 added by anyone else, they wait, and only the owner may approve (`bank.business_owner_only`).
 *   invites       By email or by link, for the owner-set `BANK_BUSINESS_INVITE_MINUTES` (blank refuses every invite,
 *                 `bank.business_invite_lifetime_unset`). Only a hash of the link's secret is kept. An expired one is
 *                 refused `bank.business_invite_expired` and can be sent again; a revoked one `bank.business_invite_revoked`.
 *   rules         A payment over an amount, to a payee or any, of a type or any, needs a number of distinct approvers. Of
 *                 every rule a payment matches, the one asking the most approvals applies; with none it is sent at once.
 *   approvals     Distinct people holding `approve`. The maker never approves their own payment, even when they hold
 *                 `approve` (`bank.business_self_approve`). The approval that completes the count sends the instruction.
 *   team spend    By member, the partner's own lines for the business, each matched to its payment's maker, beside the
 *                 business's own record of what it sent. Only `team_spend` sees everyone; anyone else sees themselves.
 */

export const BANK_BUSINESS_INVITE_MINUTES_ENV = 'BANK_BUSINESS_INVITE_MINUTES';

export const BUSINESS_PERMISSIONS = ['view', 'export', 'propose', 'approve', 'manage_team', 'team_spend'] as const;
export type BusinessPermission = (typeof BUSINESS_PERMISSIONS)[number];

export const BUSINESS_PAYMENT_TYPES = ['domestic', 'international', 'payroll'] as const;
export type BusinessPaymentType = (typeof BUSINESS_PAYMENT_TYPES)[number];

export type BusinessPaymentStatus = 'pending' | 'sending' | 'sent' | 'refused' | 'rejected';

/** The most approvals a rule may ask for. */
export const MAX_RULE_APPROVALS = 5;

/** The business key of a payment's one partner instruction. */
export const businessPaymentKey = (paymentId: string): string => `bank.business.payment:${paymentId}`;

/** The business's own account at the partner bank. */
export const businessPartnerAccount = (accountId: string, assetId: string): PartnerAccountRef => ({
  userId: `business:${accountId}`,
  assetId,
  spaceId: null,
});

/** What a built-in role may do as a team permission. Administrators hold all of them; everyone else what their role says. */
export function builtInPermissions(role: BusinessMemberRole): BusinessPermission[] {
  const caps = BUSINESS_ROLE_CAPABILITIES[role];
  if (caps.includes('manage_team')) return [...BUSINESS_PERMISSIONS];
  return BUSINESS_PERMISSIONS.filter((p) => (caps as readonly string[]).includes(p));
}

/**
 * The built-in role a member with a named role holds in `business_members.role`: the widest built-in role whose every
 * capability the named role grants (ties go to the first in the table). Every older business door (proposing and
 * approving transfers, the withdrawal approver check svc-pay asks, member management) reads that column, so a named
 * role narrows them too and never leaves the member wider there than the role says. `sign` is never in a named role, so
 * a named role never fits `admin`; a named role always includes `view`, so `viewer` always fits.
 */
export function fittedRole(permissions: readonly string[]): BusinessMemberRole {
  let best: BusinessMemberRole = 'viewer';
  for (const role of BUSINESS_ROLES) {
    const caps = BUSINESS_ROLE_CAPABILITIES[role];
    if (!caps.every((c) => permissions.includes(c))) continue;
    if (caps.length > BUSINESS_ROLE_CAPABILITIES[best].length) best = role;
  }
  return best;
}

/** A whole number of minutes from 1 to 43200 (30 days), or null while the owner has not set it. */
export function parseInviteMinutes(raw: string | undefined): number | null {
  const trimmed = raw?.trim() ?? '';
  if (!/^[1-9]\d{0,4}$/.test(trimmed)) return null;
  const minutes = Number.parseInt(trimmed, 10);
  return minutes <= 43_200 ? minutes : null;
}

const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

interface MemberRow {
  user_id: string;
  role: BusinessMemberRole;
  custom_role_id: string | null;
  department_id: string | null;
  advisor: boolean;
  permissions: string[] | null;
  role_name: string | null;
}

interface AccountRow {
  id: string;
  name: string;
  asset_id: string;
  status: 'active' | 'closed';
  owner_user_id: string | null;
}

interface PaymentRow {
  id: string;
  account_id: string;
  maker_user_id: string;
  payee: string;
  payment_type: BusinessPaymentType;
  asset_id: string;
  amount: string;
  rule_id: string | null;
  approvals_needed: number;
  status: BusinessPaymentStatus;
  partner_key: string;
  partner_move_id: string | null;
  refusal_code: string | null;
  created_at: Date;
  sent_at: Date | null;
}

interface RuleRow {
  id: string;
  over_amount: string;
  payee: string | null;
  payment_type: BusinessPaymentType | null;
  approvals: number;
  created_at: Date;
}

interface InviteRow {
  id: string;
  account_id: string;
  kind: 'email' | 'link';
  email: string | null;
  role: BusinessMemberRole | null;
  custom_role_id: string | null;
  invited_by: string;
  status: 'open' | 'accepted' | 'revoked' | 'replaced';
  expires_at: Date;
  accepted_by: string | null;
  replaced_by: string | null;
  created_at: Date;
  expired: boolean;
}

export interface TeamMember {
  userId: string;
  handle: string;
  role: BusinessMemberRole;
  customRole: { id: string; name: string } | null;
  advisor: boolean;
  departmentId: string | null;
  permissions: BusinessPermission[];
}

export interface TeamRole {
  id: string;
  name: string;
  permissions: BusinessPermission[];
  createdAt: Date;
}

export interface TeamAdvisor {
  userId: string;
  handle: string;
  addedByHandle: string;
  status: 'pending' | 'approved';
  createdAt: Date;
}

export interface TeamInvite {
  id: string;
  kind: 'email' | 'link';
  email: string | null;
  role: BusinessMemberRole | null;
  customRole: { id: string; name: string } | null;
  status: 'open' | 'expired' | 'accepted' | 'revoked' | 'replaced';
  expiresAt: Date;
  createdAt: Date;
}

export interface TeamRule {
  id: string;
  overAmount: Amount;
  payee: string | null;
  paymentType: BusinessPaymentType | null;
  approvals: number;
  createdAt: Date;
}

export interface TeamPaymentApproval {
  userId: string;
  handle: string;
  approvedAt: Date;
}

export interface TeamPayment {
  id: string;
  accountId: string;
  makerUserId: string;
  makerHandle: string;
  payee: string;
  paymentType: BusinessPaymentType;
  assetId: string;
  amount: Amount;
  rule: TeamRule | null;
  approvalsNeeded: number;
  approvals: TeamPaymentApproval[];
  status: BusinessPaymentStatus;
  partnerKey: string;
  partnerMoveId: string | null;
  refusalCode: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

export interface TeamOverview {
  account: { id: string; name: string; assetId: string; status: 'active' | 'closed' };
  owner: boolean;
  me: TeamMember;
  inviteMinutes: number | null;
  partner: { label: string; amount: Amount | null; asOf: Date | null } | null;
}

export interface TeamSpendMember {
  userId: string;
  handle: string;
  departmentId: string | null;
  /** The sum of the partner's own lines for this member's payments. */
  partnerTotal: Amount;
  partnerLines: number;
  /** The sum of the payments the business's own record says were sent for this member. */
  recordTotal: Amount;
}

export interface TeamSpendDepartment {
  id: string;
  name: string;
  /** The business's own budget, or null: not set, never zero. */
  budget: Amount | null;
  spent: Amount;
  members: string[];
}

export interface TeamSpend {
  scope: 'team' | 'self';
  assetId: string;
  partnerLabel: string;
  members: TeamSpendMember[];
  departments: TeamSpendDepartment[];
}

export interface BusinessTeamOptions {
  /** `BANK_BUSINESS_INVITE_MINUTES`, read on each call. */
  readonly inviteMinutes: () => string | undefined;
  /**
   * svc-ledger's platform-wide posting freeze, the money kill switch. Every door that can send a payment asks it before it
   * writes anything, and the partner wrapper asks it again before each move; a freeze that cannot be read refuses.
   */
  readonly postingFreeze: PostingFreeze;
  readonly noteRefusal?: NoteRefusal;
}

function forbidden(permission: BusinessPermission): BankError {
  return new BankError(
    `Your role on this business does not include ${permission.replace('_', ' ')}, so this was refused. Nothing changed.`,
    'bank.business_role_forbidden',
  );
}

function notMember(): BankError {
  return new BankError('You are not a member of this business account.', 'bank.business_not_member');
}

function amountOf(raw: string): Amount {
  return parseAmount(raw);
}

export class BusinessTeamService {
  constructor(
    private readonly sql: Sql,
    private readonly custody: PartnerCustody,
    private readonly directory: BusinessDirectoryPort,
    private readonly options: BusinessTeamOptions,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  async overview(accountId: string, userId: string): Promise<TeamOverview> {
    const account = await this.account(this.sql, accountId);
    const me = await this.member(this.sql, accountId, userId);
    const handles = await this.handles([userId]);
    const partner = this.partnerFor(account);
    let figure: TeamOverview['partner'] = null;
    if (partner) {
      const balance = await partner.balance(businessPartnerAccount(account.id, account.asset_id));
      figure = { label: balance.label, amount: balance.amount, asOf: balance.asOf };
    }
    return {
      account: { id: account.id, name: account.name, assetId: account.asset_id, status: account.status },
      owner: account.owner_user_id === userId,
      me: this.toMember(me, handles),
      inviteMinutes: parseInviteMinutes(this.options.inviteMinutes()),
      partner: figure,
    };
  }

  async members(accountId: string, userId: string): Promise<TeamMember[]> {
    await this.member(this.sql, accountId, userId);
    const rows = await this.memberRows(this.sql, accountId);
    const handles = await this.handles(rows.map((r) => r.user_id));
    return rows.map((row) => this.toMember(row, handles));
  }

  async roles(accountId: string, userId: string): Promise<TeamRole[]> {
    await this.member(this.sql, accountId, userId);
    const rows = await this.sql<Array<{ id: string; name: string; permissions: string[]; created_at: Date }>>`
      SELECT id, name, permissions, created_at FROM bank.business_custom_roles
       WHERE account_id = ${accountId}::uuid ORDER BY created_at ASC, id ASC
    `;
    return rows.map((r) => ({ id: r.id, name: r.name, permissions: r.permissions as BusinessPermission[], createdAt: r.created_at }));
  }

  async advisors(accountId: string, userId: string): Promise<TeamAdvisor[]> {
    await this.member(this.sql, accountId, userId);
    const rows = await this.sql<Array<{ user_id: string; added_by: string; status: 'pending' | 'approved'; created_at: Date }>>`
      SELECT user_id, added_by, status, created_at FROM bank.business_advisors
       WHERE account_id = ${accountId}::uuid ORDER BY created_at ASC
    `;
    const handles = await this.handles(rows.flatMap((r) => [r.user_id, r.added_by]));
    return rows.map((r) => ({
      userId: r.user_id,
      handle: handles.get(r.user_id)!,
      addedByHandle: handles.get(r.added_by)!,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  async invites(accountId: string, userId: string): Promise<TeamInvite[]> {
    const me = await this.member(this.sql, accountId, userId);
    this.need(me, 'manage_team');
    const rows = await this.sql<Array<InviteRow & { role_name: string | null }>>`
      SELECT i.id, i.account_id, i.kind, i.email, i.role, i.custom_role_id, i.invited_by, i.status, i.expires_at,
             i.accepted_by, i.replaced_by, i.created_at, (i.expires_at <= now()) AS expired, r.name AS role_name
        FROM bank.business_invites i
        LEFT JOIN bank.business_custom_roles r ON r.id = i.custom_role_id
       WHERE i.account_id = ${accountId}::uuid
       ORDER BY i.created_at DESC
       LIMIT 50
    `;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      email: r.email,
      role: r.role,
      customRole: r.custom_role_id ? { id: r.custom_role_id, name: r.role_name ?? '' } : null,
      status: r.status === 'open' && r.expired ? 'expired' : r.status,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    }));
  }

  async rules(accountId: string, userId: string): Promise<TeamRule[]> {
    await this.member(this.sql, accountId, userId);
    const rows = await this.ruleRows(this.sql, accountId);
    return rows.map(toRule);
  }

  async payments(accountId: string, userId: string): Promise<TeamPayment[]> {
    await this.member(this.sql, accountId, userId);
    const rows = await this.sql<PaymentRow[]>`
      SELECT * FROM bank.business_payments WHERE account_id = ${accountId}::uuid ORDER BY created_at DESC, id DESC LIMIT 50
    `;
    return this.withApprovals(rows);
  }

  async payment(paymentId: string, userId: string): Promise<TeamPayment> {
    const row = await this.paymentRow(this.sql, paymentId);
    await this.member(this.sql, row.account_id, userId);
    return (await this.withApprovals([row]))[0]!;
  }

  // ── Roles ───────────────────────────────────────────────────────────────

  /** BK-biz-01: a role the business names, granting no permission the creator does not hold. */
  async createRole(input: {
    accountId: string;
    actorUserId: string;
    roleId: string;
    name: string;
    permissions: readonly BusinessPermission[];
  }): Promise<TeamRole> {
    const name = input.name.trim();
    if (!name || name.length > 64) throw new BankError('A role needs a name of 1 to 64 characters.', 'bank.business_invalid_name');
    const permissions = [...new Set(input.permissions)];
    if (permissions.length === 0 || permissions.some((p) => !(BUSINESS_PERMISSIONS as readonly string[]).includes(p))) {
      throw new BankError('A role needs at least one permission from the list.', 'bank.business_role_invalid');
    }
    // Every member reads the business; a role without view would hold more on the older doors than it says.
    if (!permissions.includes('view')) {
      throw new BankError('A role always includes view.', 'bank.business_role_invalid');
    }
    return transaction(this.sql, async (tx) => {
      await this.activeAccount(tx, input.accountId);
      const me = await this.member(tx, input.accountId, input.actorUserId);
      this.need(me, 'manage_team');
      const mine = permissionsOf(me);
      const beyond = permissions.filter((p) => !mine.includes(p));
      if (beyond.length > 0) {
        throw new BankError(
          `You cannot create a role that grants ${beyond.join(', ')}: you do not hold ${beyond.length === 1 ? 'it' : 'them'} yourself. Nothing was created.`,
          'bank.business_role_grant_exceeds',
        );
      }
      const ordered = BUSINESS_PERMISSIONS.filter((p) => permissions.includes(p));
      const existing = await tx<Array<{ id: string; account_id: string; name: string; permissions: string[]; created_at: Date }>>`
        SELECT id, account_id, name, permissions, created_at FROM bank.business_custom_roles WHERE id = ${input.roleId}::uuid
      `;
      if (existing[0]) {
        const same =
          existing[0].account_id === input.accountId &&
          existing[0].name === name &&
          existing[0].permissions.join(',') === ordered.join(',');
        if (!same) throw new BankError('This role id is already used on different terms.', 'bank.business_request_conflict');
        return { id: existing[0].id, name, permissions: ordered, createdAt: existing[0].created_at };
      }
      try {
        const rows = await tx<Array<{ id: string; created_at: Date }>>`
          INSERT INTO bank.business_custom_roles (id, account_id, name, permissions, created_by)
          VALUES (${input.roleId}::uuid, ${input.accountId}::uuid, ${name}, ${ordered}::text[], ${input.actorUserId})
          RETURNING id, created_at
        `;
        return { id: rows[0]!.id, name, permissions: ordered, createdAt: rows[0]!.created_at };
      } catch (err) {
        if (uniqueViolation(err)) throw new BankError(`This business already has a role named ${name}.`, 'bank.business_role_name_taken');
        throw err;
      }
    });
  }

  /**
   * Gives a member a named role, within the actor's own permissions, and sets their built-in role to the one it fits
   * (`fittedRole`), so every older door holds them to it too. With null the named role is taken away and the member keeps
   * the built-in role they hold now; an administrator widens it through the member doors.
   */
  async assignRole(input: { accountId: string; actorUserId: string; userId: string; roleId: string | null }): Promise<TeamMember> {
    return transaction(this.sql, async (tx) => {
      await this.activeAccount(tx, input.accountId);
      const me = await this.member(tx, input.accountId, input.actorUserId);
      this.need(me, 'manage_team');
      const target = await this.memberOrNull(tx, input.accountId, input.userId);
      if (!target || target.advisor) throw new BankError('That person is not a member of this business.', 'bank.business_not_member');
      const account = await this.account(tx, input.accountId);
      if (account.owner_user_id === input.userId) {
        throw new BankError('The owner keeps every permission; their role is not changed.', 'bank.business_last_admin');
      }
      if (input.roleId) {
        const role = await this.roleIn(tx, input.accountId, input.roleId);
        const beyond = role.permissions.filter((p) => !permissionsOf(me).includes(p as BusinessPermission));
        if (beyond.length > 0) {
          throw new BankError(
            `You cannot give a role that grants ${beyond.join(', ')}, which you do not hold.`,
            'bank.business_role_grant_exceeds',
          );
        }
        const fitted = fittedRole(role.permissions);
        if (roleCan(target.role, 'manage_team') && !roleCan(fitted, 'manage_team')) {
          const managers = await tx<Array<{ role: BusinessMemberRole }>>`
            SELECT role FROM bank.business_members WHERE account_id = ${input.accountId}::uuid FOR UPDATE
          `;
          if (managers.filter((m) => roleCan(m.role, 'manage_team')).length < 2) {
            throw new BankError('The last administrator cannot be narrowed.', 'bank.business_last_admin');
          }
        }
        await tx`
          UPDATE bank.business_members SET custom_role_id = ${input.roleId}::uuid, role = ${fitted}
           WHERE account_id = ${input.accountId}::uuid AND user_id = ${input.userId}
        `;
      } else {
        await tx`
          UPDATE bank.business_members SET custom_role_id = NULL
           WHERE account_id = ${input.accountId}::uuid AND user_id = ${input.userId}
        `;
      }
      const row = await this.member(tx, input.accountId, input.userId);
      return this.toMember(row, await this.handles([input.userId]));
    });
  }

  // ── Advisors ────────────────────────────────────────────────────────────

  /** BK-biz-01: an advisor by handle. Added by the owner it is approved; by anyone else it waits for the owner. */
  async addAdvisor(input: { accountId: string; actorUserId: string; handle: string }): Promise<TeamAdvisor> {
    const handle = normaliseHandleQuery(input.handle);
    if (!handle) throw new BankError('Enter the advisor’s handle.', 'bank.business_invalid_handle');
    let found: { userId: string; handle: string } | null;
    try {
      found = await this.directory.findActive({ handle });
    } catch (err) {
      throw directoryRefusal(err);
    }
    if (!found) throw new BankError('No active account has that handle.', 'bank.business_person_not_found');
    const person = found;
    return transaction(this.sql, async (tx) => {
      const account = await this.activeAccount(tx, input.accountId);
      const me = await this.member(tx, input.accountId, input.actorUserId);
      this.need(me, 'manage_team');
      if (await this.memberOrNull(tx, input.accountId, person.userId)) {
        throw new BankError('That person is already on this business.', 'bank.business_already_member');
      }
      const byOwner = account.owner_user_id === input.actorUserId;
      const rows = await tx<Array<{ status: 'pending' | 'approved'; added_by: string; created_at: Date }>>`
        INSERT INTO bank.business_advisors (account_id, user_id, added_by, status, decided_by, decided_at)
        VALUES (${input.accountId}::uuid, ${person.userId}, ${input.actorUserId}, ${byOwner ? 'approved' : 'pending'},
                ${byOwner ? input.actorUserId : null}, ${byOwner ? new Date() : null})
        ON CONFLICT (account_id, user_id) DO NOTHING
        RETURNING status, added_by, created_at
      `;
      const row =
        rows[0] ??
        (
          await tx<Array<{ status: 'pending' | 'approved'; added_by: string; created_at: Date }>>`
            SELECT status, added_by, created_at FROM bank.business_advisors
             WHERE account_id = ${input.accountId}::uuid AND user_id = ${person.userId}
          `
        )[0]!;
      if (row.status === 'approved') await this.seatAdvisor(tx, input.accountId, person.userId);
      const handles = await this.handles([row.added_by]);
      return {
        userId: person.userId,
        handle: person.handle,
        addedByHandle: handles.get(row.added_by)!,
        status: row.status,
        createdAt: row.created_at,
      };
    });
  }

  /** Only the business's owner approves an advisor; then the advisor reads the business, and nothing more. */
  async approveAdvisor(input: { accountId: string; actorUserId: string; userId: string }): Promise<TeamAdvisor> {
    return transaction(this.sql, async (tx) => {
      const account = await this.activeAccount(tx, input.accountId);
      await this.member(tx, input.accountId, input.actorUserId);
      if (account.owner_user_id !== input.actorUserId) {
        throw new BankError('Only the owner of this business can approve an advisor. Nothing changed.', 'bank.business_owner_only');
      }
      const rows = await tx<Array<{ status: 'pending' | 'approved'; added_by: string; created_at: Date }>>`
        UPDATE bank.business_advisors
           SET status = 'approved', decided_by = COALESCE(decided_by, ${input.actorUserId}), decided_at = COALESCE(decided_at, now())
         WHERE account_id = ${input.accountId}::uuid AND user_id = ${input.userId}
        RETURNING status, added_by, created_at
      `;
      if (!rows[0]) throw new BankError('No advisor of this business is waiting with that id.', 'bank.business_advisor_not_found');
      await this.seatAdvisor(tx, input.accountId, input.userId);
      const handles = await this.handles([input.userId, rows[0].added_by]);
      return {
        userId: input.userId,
        handle: handles.get(input.userId)!,
        addedByHandle: handles.get(rows[0].added_by)!,
        status: 'approved',
        createdAt: rows[0].created_at,
      };
    });
  }

  // ── Invites ─────────────────────────────────────────────────────────────

  /**
   * BK-biz-02: an invite by email or by link, as a built-in role or a named one. Returns the link's secret once; only its
   * hash is kept. The same invite id returns the same invite, with no secret (it is not kept).
   */
  async invite(input: {
    accountId: string;
    actorUserId: string;
    inviteId: string;
    email: string | null;
    role: BusinessMemberRole | null;
    roleId: string | null;
  }): Promise<{ invite: TeamInvite; token: string | null }> {
    const minutes = this.inviteMinutes();
    const email = input.email === null ? null : normaliseEmailQuery(input.email)?.toLowerCase();
    if (email === undefined) throw new BankError('Enter a valid email address.', 'bank.business_invalid_email');
    if ((input.role === null) === (input.roleId === null)) {
      throw new BankError('Choose one role for the invite.', 'bank.business_role_invalid');
    }
    return transaction(this.sql, async (tx) => {
      await this.activeAccount(tx, input.accountId);
      const me = await this.member(tx, input.accountId, input.actorUserId);
      this.need(me, 'manage_team');
      if (input.roleId) {
        const granted = (await this.roleIn(tx, input.accountId, input.roleId)).permissions;
        const beyond = granted.filter((p) => !permissionsOf(me).includes(p as BusinessPermission));
        if (beyond.length > 0) {
          throw new BankError(
            `You cannot invite someone to a role that grants ${beyond.join(', ')}, which you do not hold.`,
            'bank.business_role_grant_exceeds',
          );
        }
      } else {
        this.assertMayGrantBuiltIn(me, input.role!);
      }
      const prior = await this.inviteRow(tx, input.inviteId);
      if (prior) {
        const same =
          prior.account_id === input.accountId &&
          prior.email === email &&
          prior.role === input.role &&
          prior.custom_role_id === input.roleId &&
          prior.invited_by === input.actorUserId;
        if (!same) throw new BankError('This invite id is already used on different terms.', 'bank.business_request_conflict');
        return { invite: await this.inviteView(tx, prior.id), token: null };
      }
      const token = randomBytes(24).toString('base64url');
      await tx`
        INSERT INTO bank.business_invites (id, account_id, kind, email, token_hash, role, custom_role_id, invited_by, expires_at)
        VALUES (${input.inviteId}::uuid, ${input.accountId}::uuid, ${email ? 'email' : 'link'}, ${email}, ${hashToken(token)},
                ${input.role}, ${input.roleId}::uuid, ${input.actorUserId}, now() + make_interval(mins => ${minutes}::int))
      `;
      return { invite: await this.inviteView(tx, input.inviteId), token };
    });
  }

  /** Sends an open or expired invite again: the old link stops working and a new one lasts the full lifetime. */
  async resendInvite(input: { accountId: string; actorUserId: string; inviteId: string; newInviteId: string }): Promise<{
    invite: TeamInvite;
    token: string | null;
  }> {
    const minutes = this.inviteMinutes();
    return transaction(this.sql, async (tx) => {
      await this.activeAccount(tx, input.accountId);
      const me = await this.member(tx, input.accountId, input.actorUserId);
      this.need(me, 'manage_team');
      const old = await this.inviteRow(tx, input.inviteId, true);
      if (!old || old.account_id !== input.accountId) throw inviteNotFound();
      if (old.status === 'replaced' && old.replaced_by === input.newInviteId) {
        return { invite: await this.inviteView(tx, input.newInviteId), token: null };
      }
      if (old.status !== 'open') {
        throw new BankError(`This invite is ${old.status} and cannot be sent again.`, 'bank.business_invite_inactive');
      }
      // Sending it again is granting it again: the one who sends must hold the role it carries.
      if (old.role) this.assertMayGrantBuiltIn(me, old.role);
      else if (old.custom_role_id) {
        const beyond = (await this.roleIn(tx, old.account_id, old.custom_role_id)).permissions.filter(
          (p) => !permissionsOf(me).includes(p as BusinessPermission),
        );
        if (beyond.length > 0) {
          throw new BankError(`You cannot send an invite to a role that grants ${beyond.join(', ')}.`, 'bank.business_role_grant_exceeds');
        }
      }
      const token = randomBytes(24).toString('base64url');
      await tx`
        INSERT INTO bank.business_invites (id, account_id, kind, email, token_hash, role, custom_role_id, invited_by, expires_at)
        VALUES (${input.newInviteId}::uuid, ${old.account_id}::uuid, ${old.kind}, ${old.email}, ${hashToken(token)},
                ${old.role}, ${old.custom_role_id}::uuid, ${input.actorUserId}, now() + make_interval(mins => ${minutes}::int))
      `;
      await tx`
        UPDATE bank.business_invites SET status = 'replaced', replaced_by = ${input.newInviteId}::uuid, decided_at = now()
         WHERE id = ${old.id}::uuid
      `;
      return { invite: await this.inviteView(tx, input.newInviteId), token };
    });
  }

  async revokeInvite(input: { accountId: string; actorUserId: string; inviteId: string }): Promise<TeamInvite> {
    return transaction(this.sql, async (tx) => {
      const me = await this.member(tx, input.accountId, input.actorUserId);
      this.need(me, 'manage_team');
      const old = await this.inviteRow(tx, input.inviteId, true);
      if (!old || old.account_id !== input.accountId) throw inviteNotFound();
      if (old.status === 'open') {
        await tx`UPDATE bank.business_invites SET status = 'revoked', decided_at = now() WHERE id = ${old.id}::uuid`;
      } else if (old.status !== 'revoked') {
        throw new BankError(`This invite is ${old.status} and cannot be revoked.`, 'bank.business_invite_inactive');
      }
      return this.inviteView(tx, old.id);
    });
  }

  /** The invitee opens the link. An email invite is for the account with that email only. */
  async acceptInvite(input: { token: string; userId: string }): Promise<{ accountId: string; name: string; member: TeamMember }> {
    const row = await this.inviteByToken(this.sql, input.token);
    if (row.status === 'accepted' && row.accepted_by === input.userId) {
      const account = await this.account(this.sql, row.account_id);
      const member = await this.member(this.sql, row.account_id, input.userId);
      return { accountId: account.id, name: account.name, member: this.toMember(member, await this.handles([input.userId])) };
    }
    assertInviteOpen(row);
    if (row.email) {
      let found: { userId: string } | null;
      try {
        found = await this.directory.findActive({ email: row.email });
      } catch (err) {
        throw directoryRefusal(err);
      }
      if (!found || found.userId !== input.userId) {
        throw new BankError(
          'This invite was sent to another email address. Sign in with that account to accept it.',
          'bank.business_invite_wrong_person',
        );
      }
    }
    return transaction(this.sql, async (tx) => {
      const locked = await this.inviteRow(tx, row.id, true);
      if (!locked) throw inviteNotFound();
      assertInviteOpen(locked);
      const account = await this.activeAccount(tx, locked.account_id);
      if (await this.memberOrNull(tx, locked.account_id, input.userId)) {
        throw new BankError('You are already on this business.', 'bank.business_already_member');
      }
      // A named role seats the member on the built-in role it fits, so the older doors hold them to it too.
      const seat = locked.custom_role_id
        ? fittedRole((await this.roleIn(tx, locked.account_id, locked.custom_role_id)).permissions)
        : (locked.role ?? 'viewer');
      await tx`
        INSERT INTO bank.business_members (account_id, user_id, role, custom_role_id)
        VALUES (${locked.account_id}::uuid, ${input.userId}, ${seat}, ${locked.custom_role_id}::uuid)
      `;
      await tx`
        UPDATE bank.business_invites SET status = 'accepted', accepted_by = ${input.userId}, decided_at = now()
         WHERE id = ${locked.id}::uuid
      `;
      const member = await this.member(tx, locked.account_id, input.userId);
      return { accountId: account.id, name: account.name, member: this.toMember(member, await this.handles([input.userId])) };
    });
  }

  // ── Rules ───────────────────────────────────────────────────────────────

  /** BK-biz-03: an approval rule by amount, payee and payment type. */
  async addRule(input: {
    accountId: string;
    actorUserId: string;
    ruleId: string;
    overAmount: Amount;
    payee: string | null;
    paymentType: BusinessPaymentType | null;
    approvals: number;
  }): Promise<TeamRule> {
    if (input.overAmount < 0n) throw new BankError('A rule’s amount cannot be below zero.', 'bank.business_rule_invalid');
    if (!Number.isInteger(input.approvals) || input.approvals < 1 || input.approvals > MAX_RULE_APPROVALS) {
      throw new BankError(`A rule asks for 1 to ${MAX_RULE_APPROVALS} approvers.`, 'bank.business_rule_invalid');
    }
    const payee = input.payee?.trim() || null;
    if (payee && payee.length > 128) throw new BankError('A payee name is 128 characters or fewer.', 'bank.business_rule_invalid');
    return transaction(this.sql, async (tx) => {
      await this.activeAccount(tx, input.accountId);
      const me = await this.member(tx, input.accountId, input.actorUserId);
      this.need(me, 'manage_team');
      const over = formatAmount(input.overAmount);
      const rows = await tx<Array<RuleRow & { account_id: string }>>`
        INSERT INTO bank.business_payment_rules (id, account_id, over_amount, payee, payment_type, approvals, created_by)
        VALUES (${input.ruleId}::uuid, ${input.accountId}::uuid, ${over}::numeric, ${payee}, ${input.paymentType}, ${input.approvals},
                ${input.actorUserId})
        ON CONFLICT (id) DO NOTHING
        RETURNING id, account_id, over_amount, payee, payment_type, approvals, created_at
      `;
      const row =
        rows[0] ??
        (
          await tx<Array<RuleRow & { account_id: string }>>`
            SELECT id, account_id, over_amount, payee, payment_type, approvals, created_at
              FROM bank.business_payment_rules WHERE id = ${input.ruleId}::uuid
          `
        )[0]!;
      const same =
        row.account_id === input.accountId &&
        amountOf(row.over_amount) === input.overAmount &&
        row.payee === payee &&
        row.payment_type === input.paymentType &&
        row.approvals === input.approvals;
      if (!same) throw new BankError('This rule id is already used on different terms.', 'bank.business_request_conflict');
      return toRule(row);
    });
  }

  // ── Payments ────────────────────────────────────────────────────────────

  /**
   * A payment from the business's account at the partner to a payee. The rule it falls under is fixed now: a rule added
   * later never changes what this payment needs. With no rule it is sent at once.
   */
  async propose(input: {
    accountId: string;
    makerUserId: string;
    paymentId: string;
    payee: string;
    paymentType: BusinessPaymentType;
    amount: Amount;
  }): Promise<TeamPayment> {
    const payee = input.payee.trim();
    if (!payee || payee.length > 128) throw new BankError('A payment needs a payee of 1 to 128 characters.', 'bank.business_payee_invalid');
    if (input.amount <= 0n) throw new BankError('A payment needs an amount above zero.', 'bank.below_minimum');
    const prior = await this.paymentRowOrNull(this.sql, input.paymentId);
    if (prior) {
      const same =
        prior.account_id === input.accountId &&
        prior.maker_user_id === input.makerUserId &&
        prior.payee === payee &&
        prior.payment_type === input.paymentType &&
        amountOf(prior.amount) === input.amount;
      if (!same) throw new BankError('This payment id is already used on different terms.', 'bank.business_request_conflict');
      if (prior.status === 'sending') {
        await this.moneyMayMove();
        await this.send(prior);
      }
      return this.payment(prior.id, input.makerUserId);
    }
    // A payment no rule holds is sent at once: while posting is frozen nothing is recorded or sent.
    await this.moneyMayMove();
    const created = await transaction(this.sql, async (tx) => {
      const account = await this.activeAccount(tx, input.accountId);
      const me = await this.member(tx, input.accountId, input.makerUserId);
      this.need(me, 'propose');
      if (!this.partnerFor(account)) throw noPartner();
      const rule = pickRule(await this.ruleRows(tx, input.accountId), { amount: input.amount, payee, paymentType: input.paymentType });
      const needed = rule?.approvals ?? 0;
      if (needed > 0) {
        const pool = (await this.memberRows(tx, input.accountId)).filter(
          (m) => m.user_id !== input.makerUserId && permissionsOf(m).includes('approve'),
        );
        if (pool.length < needed) {
          throw new BankError(
            `This payment needs ${needed} approvers other than you, and this business has ${pool.length}. Nothing was proposed.`,
            'bank.business_approvers_short',
          );
        }
      }
      const rows = await tx<PaymentRow[]>`
        INSERT INTO bank.business_payments
          (id, account_id, maker_user_id, payee, payment_type, asset_id, amount, rule_id, approvals_needed, status, partner_key)
        VALUES (${input.paymentId}::uuid, ${input.accountId}::uuid, ${input.makerUserId}, ${payee}, ${input.paymentType},
                ${account.asset_id}, ${formatAmount(input.amount)}::numeric, ${rule?.id ?? null}::uuid, ${needed},
                ${needed === 0 ? 'sending' : 'pending'}, ${businessPaymentKey(input.paymentId)})
        ON CONFLICT (id) DO NOTHING
        RETURNING *
      `;
      return rows[0] ?? null;
    });
    if (!created) return this.propose(input);
    if (created.status === 'sending') await this.send(created);
    return this.payment(created.id, input.makerUserId);
  }

  /**
   * One approval by one distinct approver. The maker is refused even when they hold `approve`. The approval that
   * completes the rule's count sends the instruction to the partner, once. Called again by an approver while it is being
   * sent, it reads the instruction back by its key and makes it at most once.
   */
  async approve(input: { paymentId: string; approverUserId: string }): Promise<TeamPayment> {
    // The approval that completes the count sends: while posting is frozen no approval is recorded.
    await this.moneyMayMove();
    const decided = await transaction(this.sql, async (tx) => {
      const row = await this.paymentRow(tx, input.paymentId, true);
      const me = await this.member(tx, row.account_id, input.approverUserId);
      if (row.maker_user_id === input.approverUserId) {
        throw new BankError('You proposed this payment, so you cannot approve it. Another approver must.', 'bank.business_self_approve');
      }
      this.need(me, 'approve');
      const already = await tx<Array<{ n: number }>>`
        SELECT 1 AS n FROM bank.business_payment_approvals
         WHERE payment_id = ${row.id}::uuid AND approver_user_id = ${input.approverUserId}
      `;
      if (row.status === 'sending' && already[0]) return row;
      if (row.status !== 'pending') {
        throw new BankError(`This payment is ${row.status}; it takes no more approvals.`, 'bank.business_approval_inactive');
      }
      if (already[0]) {
        throw new BankError(
          'You have already approved this payment. A different approver must give the next approval.',
          'bank.business_already_approved',
        );
      }
      await tx`
        INSERT INTO bank.business_payment_approvals (payment_id, approver_user_id) VALUES (${row.id}::uuid, ${input.approverUserId})
      `;
      const count = (
        await tx<Array<{ n: string }>>`SELECT count(*)::text AS n FROM bank.business_payment_approvals WHERE payment_id = ${row.id}::uuid`
      )[0]!.n;
      if (Number(count) < row.approvals_needed) return null;
      // The key is on the row already; marking it sending before the partner is asked is what makes it sent once.
      const sending = await tx<PaymentRow[]>`
        UPDATE bank.business_payments SET status = 'sending' WHERE id = ${row.id}::uuid AND status = 'pending' RETURNING *
      `;
      return sending[0]!;
    });
    if (decided) await this.send(decided);
    return this.payment(input.paymentId, input.approverUserId);
  }

  /** An approver or the maker declines a waiting payment. Nothing is sent. */
  async reject(input: { paymentId: string; userId: string }): Promise<TeamPayment> {
    await transaction(this.sql, async (tx) => {
      const row = await this.paymentRow(tx, input.paymentId, true);
      const me = await this.member(tx, row.account_id, input.userId);
      if (row.maker_user_id !== input.userId) this.need(me, 'approve');
      if (row.status === 'rejected') return;
      if (row.status !== 'pending') {
        throw new BankError(`This payment is ${row.status} and cannot be declined.`, 'bank.business_approval_inactive');
      }
      await tx`UPDATE bank.business_payments SET status = 'rejected' WHERE id = ${row.id}::uuid`;
    });
    return this.payment(input.paymentId, input.userId);
  }

  /** Sends a payment whose answer from the partner was not definite, under the same key: made at most once. */
  async resend(input: { paymentId: string; userId: string }): Promise<TeamPayment> {
    await this.moneyMayMove();
    const row = await this.paymentRow(this.sql, input.paymentId);
    const me = await this.member(this.sql, row.account_id, input.userId);
    if (row.maker_user_id !== input.userId) this.need(me, 'approve');
    if (row.status === 'sending') await this.send(row);
    return this.payment(input.paymentId, input.userId);
  }

  // ── Team spend and departments ──────────────────────────────────────────

  async addDepartment(input: {
    accountId: string;
    actorUserId: string;
    departmentId: string;
    name: string;
    budget: Amount | null;
  }): Promise<{
    id: string;
    name: string;
    budget: Amount | null;
  }> {
    const name = input.name.trim();
    if (!name || name.length > 64) throw new BankError('A department needs a name of 1 to 64 characters.', 'bank.business_invalid_name');
    if (input.budget !== null && input.budget <= 0n) {
      throw new BankError('A budget is above zero, or left blank for none.', 'bank.business_budget_invalid');
    }
    return transaction(this.sql, async (tx) => {
      await this.activeAccount(tx, input.accountId);
      const me = await this.member(tx, input.accountId, input.actorUserId);
      this.need(me, 'manage_team');
      const budget = input.budget === null ? null : formatAmount(input.budget);
      try {
        await tx`
          INSERT INTO bank.business_departments (id, account_id, name, budget)
          VALUES (${input.departmentId}::uuid, ${input.accountId}::uuid, ${name}, ${budget}::numeric)
          ON CONFLICT (id) DO NOTHING
        `;
      } catch (err) {
        if (uniqueViolation(err))
          throw new BankError(`This business already has a department named ${name}.`, 'bank.business_role_name_taken');
        throw err;
      }
      const row = (
        await tx<Array<{ id: string; account_id: string; name: string; budget: string | null }>>`
          SELECT id, account_id, name, budget FROM bank.business_departments WHERE id = ${input.departmentId}::uuid
        `
      )[0]!;
      const same =
        row.account_id === input.accountId && row.name === name && (row.budget === null ? null : amountOf(row.budget)) === input.budget;
      if (!same) throw new BankError('This department id is already used on different terms.', 'bank.business_request_conflict');
      return { id: row.id, name: row.name, budget: row.budget === null ? null : amountOf(row.budget) };
    });
  }

  async setDepartment(input: { accountId: string; actorUserId: string; userId: string; departmentId: string | null }): Promise<TeamMember> {
    return transaction(this.sql, async (tx) => {
      const me = await this.member(tx, input.accountId, input.actorUserId);
      this.need(me, 'manage_team');
      const target = await this.memberOrNull(tx, input.accountId, input.userId);
      if (!target) throw notMember();
      if (input.departmentId) {
        const found = await tx`
          SELECT 1 FROM bank.business_departments WHERE id = ${input.departmentId}::uuid AND account_id = ${input.accountId}::uuid
        `;
        if (!found[0]) throw new BankError('This business has no such department.', 'bank.business_department_not_found');
      }
      await tx`
        UPDATE bank.business_members SET department_id = ${input.departmentId}::uuid
         WHERE account_id = ${input.accountId}::uuid AND user_id = ${input.userId}
      `;
      return this.toMember(await this.member(tx, input.accountId, input.userId), await this.handles([input.userId]));
    });
  }

  /**
   * BK-biz-04: what each member's payments took out, from the partner's own lines for the business, beside the business's
   * record. With `team_spend` the whole team and its departments; without it, the caller's own line only.
   */
  async spend(accountId: string, userId: string): Promise<TeamSpend> {
    const account = await this.account(this.sql, accountId);
    const me = await this.member(this.sql, accountId, userId);
    const team = permissionsOf(me).includes('team_spend');
    const partner = this.partnerFor(account);
    if (!partner) throw noPartner();
    const lines = await partner.moves(`business:${accountId}`, { limit: 200, assetId: account.asset_id });
    const payments = await this.sql<
      Array<{ id: string; maker_user_id: string; amount: string; status: BusinessPaymentStatus; partner_key: string }>
    >`
      SELECT id, maker_user_id, amount, status, partner_key FROM bank.business_payments WHERE account_id = ${accountId}::uuid
    `;
    const byKey = new Map(payments.map((p) => [p.partner_key, p]));
    const rows = await this.memberRows(this.sql, accountId);
    const shown = team ? rows : rows.filter((r) => r.user_id === userId);
    const handles = await this.handles(shown.map((r) => r.user_id));
    const members: TeamSpendMember[] = shown.map((row) => {
      let partnerTotal = 0n;
      let partnerLines = 0;
      for (const line of lines) {
        const paid = byKey.get(line.key);
        if (!paid || paid.maker_user_id !== row.user_id || line.from.userId !== `business:${accountId}`) continue;
        partnerTotal += line.amount;
        partnerLines += 1;
      }
      const recordTotal = payments
        .filter((p) => p.maker_user_id === row.user_id && p.status === 'sent')
        .reduce((sum, p) => sum + amountOf(p.amount), 0n);
      return {
        userId: row.user_id,
        handle: handles.get(row.user_id)!,
        departmentId: row.department_id,
        partnerTotal,
        partnerLines,
        recordTotal,
      };
    });
    let departments: TeamSpendDepartment[] = [];
    if (team) {
      const deps = await this.sql<Array<{ id: string; name: string; budget: string | null }>>`
        SELECT id, name, budget FROM bank.business_departments WHERE account_id = ${accountId}::uuid ORDER BY created_at ASC, id ASC
      `;
      departments = deps.map((d) => {
        const inIt = members.filter((m) => m.departmentId === d.id);
        return {
          id: d.id,
          name: d.name,
          budget: d.budget === null ? null : amountOf(d.budget),
          spent: inIt.reduce((sum, m) => sum + m.partnerTotal, 0n),
          members: inIt.map((m) => m.userId),
        };
      });
    }
    return { scope: team ? 'team' : 'self', assetId: account.asset_id, partnerLabel: partner.label, members, departments };
  }

  /** The owner's TEST money into the business's account at the TEST partner (the journey's start), once per fund id. */
  async assertOwner(accountId: string, userId: string): Promise<{ assetId: string }> {
    const account = await this.account(this.sql, accountId);
    if (account.owner_user_id !== userId) {
      throw new BankError('Only the owner of this business can do this.', 'bank.business_owner_only');
    }
    return { assetId: account.asset_id };
  }

  // ── For the business's bills (J-bank-20) ───────────────────────────────

  /** The business, its partner bank (null when its money is not held at one) and the caller's permissions on it. */
  async seat(
    accountId: string,
    userId: string,
  ): Promise<{
    account: { id: string; name: string; assetId: string; status: 'active' | 'closed' };
    partner: PartnerBank | null;
    permissions: BusinessPermission[];
  }> {
    const account = await this.account(this.sql, accountId);
    const me = await this.member(this.sql, accountId, userId);
    return {
      account: { id: account.id, name: account.name, assetId: account.asset_id, status: account.status },
      partner: this.partnerFor(account),
      permissions: permissionsOf(me),
    };
  }

  /** The members other than `exclude` who hold `approve`. */
  async approverPool(accountId: string, exclude: string): Promise<string[]> {
    return (await this.memberRows(this.sql, accountId))
      .filter((m) => m.user_id !== exclude && permissionsOf(m).includes('approve'))
      .map((m) => m.user_id);
  }

  /** The business's approval rules, as `pickRule` reads them. */
  async ruleList(accountId: string): Promise<TeamRule[]> {
    return (await this.ruleRows(this.sql, accountId)).map(toRule);
  }

  /** Public handles from svc-identity; a person with none is refused by name. */
  async handlesOf(userIds: readonly string[]): Promise<Map<string, string>> {
    return this.handles(userIds);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async send(row: PaymentRow): Promise<void> {
    const account = await this.account(this.sql, row.account_id);
    const partner = this.partnerFor(account);
    if (!partner) throw noPartner();
    const from = businessPartnerAccount(row.account_id, row.asset_id);
    const amount = amountOf(row.amount);
    let move;
    try {
      // A retry first asks the partner for the move under this key: an answer that was lost is never sent again blind.
      move =
        (await partner.moveByKey(row.partner_key)) ??
        (await partner.move({ key: row.partner_key, from, to: partnerPayoutsAccount(row.asset_id), amount }));
    } catch (err) {
      if (err instanceof BankError && DEFINITE_REFUSALS.has(err.code)) {
        await this.sql`
          UPDATE bank.business_payments SET status = 'refused', refusal_code = ${err.code}
           WHERE id = ${row.id}::uuid AND status = 'sending'
        `;
      }
      throw err;
    }
    await this.sql`
      UPDATE bank.business_payments SET status = 'sent', partner_move_id = ${move.id}, sent_at = ${move.movedAt}
       WHERE id = ${row.id}::uuid AND status = 'sending'
    `;
  }

  private partnerFor(account: AccountRow): PartnerBank | null {
    return account.owner_user_id ? this.custody.bankFor(account.owner_user_id) : null;
  }

  private inviteMinutes(): number {
    const minutes = parseInviteMinutes(this.options.inviteMinutes());
    if (minutes === null) {
      throw new BankError(
        'How long a team invite lasts is not set, so no invite can be sent yet. Nothing was sent.',
        'bank.business_invite_lifetime_unset',
      );
    }
    return minutes;
  }

  /** Refuses `bank.posting_frozen` while posting is frozen, or while the freeze cannot be read. */
  private async moneyMayMove(): Promise<void> {
    await assertPostingEnabled(this.options.postingFreeze, 'bank_move', this.options.noteRefusal);
  }

  /**
   * A built-in role may be granted only by someone who holds all of it: every team permission it carries, and every
   * capability the older business doors give it (`sign` among them, which no team permission names).
   */
  private assertMayGrantBuiltIn(me: MemberRow, role: BusinessMemberRole): void {
    const beyond = [
      ...builtInPermissions(role).filter((p) => !permissionsOf(me).includes(p)),
      ...BUSINESS_ROLE_CAPABILITIES[role].filter((c) => !roleCan(me.role, c) && !(BUSINESS_PERMISSIONS as readonly string[]).includes(c)),
    ];
    if (beyond.length > 0) {
      throw new BankError(
        `You cannot invite someone to a role that grants ${[...new Set(beyond)].join(', ')}, which you do not hold.`,
        'bank.business_role_grant_exceeds',
      );
    }
  }

  private need(me: MemberRow, permission: BusinessPermission): void {
    if (!permissionsOf(me).includes(permission)) throw forbidden(permission);
  }

  private async seatAdvisor(sql: Sql, accountId: string, userId: string): Promise<void> {
    await sql`
      INSERT INTO bank.business_members (account_id, user_id, role, advisor)
      VALUES (${accountId}::uuid, ${userId}, 'viewer', true)
      ON CONFLICT (account_id, user_id) DO NOTHING
    `;
  }

  private async account(sql: Sql, accountId: string): Promise<AccountRow> {
    const rows = await sql<AccountRow[]>`
      SELECT id, name, asset_id, status, owner_user_id FROM bank.business_accounts WHERE id = ${accountId}::uuid
    `;
    if (!rows[0]) throw new BankError('No business account has this id.', 'bank.business_not_found');
    return rows[0];
  }

  private async activeAccount(sql: Sql, accountId: string): Promise<AccountRow> {
    const account = await this.account(sql, accountId);
    if (account.status !== 'active') throw new BankError('This business account is closed.', 'bank.business_closed');
    return account;
  }

  private async memberRows(sql: Sql, accountId: string): Promise<MemberRow[]> {
    return sql<MemberRow[]>`
      SELECT m.user_id, m.role, m.custom_role_id, m.department_id, m.advisor, r.permissions, r.name AS role_name
        FROM bank.business_members m
        LEFT JOIN bank.business_custom_roles r ON r.id = m.custom_role_id
       WHERE m.account_id = ${accountId}::uuid
       ORDER BY m.created_at ASC, m.user_id ASC
    `;
  }

  private async memberOrNull(sql: Sql, accountId: string, userId: string): Promise<MemberRow | null> {
    const rows = await sql<MemberRow[]>`
      SELECT m.user_id, m.role, m.custom_role_id, m.department_id, m.advisor, r.permissions, r.name AS role_name
        FROM bank.business_members m
        LEFT JOIN bank.business_custom_roles r ON r.id = m.custom_role_id
       WHERE m.account_id = ${accountId}::uuid AND m.user_id = ${userId}
    `;
    return rows[0] ?? null;
  }

  private async member(sql: Sql, accountId: string, userId: string): Promise<MemberRow> {
    await this.account(sql, accountId);
    const row = await this.memberOrNull(sql, accountId, userId);
    if (!row) throw notMember();
    return row;
  }

  private async roleIn(sql: Sql, accountId: string, roleId: string): Promise<{ id: string; name: string; permissions: string[] }> {
    const rows = await sql<Array<{ id: string; name: string; permissions: string[] }>>`
      SELECT id, name, permissions FROM bank.business_custom_roles WHERE id = ${roleId}::uuid AND account_id = ${accountId}::uuid
    `;
    if (!rows[0]) throw new BankError('This business has no such role.', 'bank.business_role_not_found');
    return rows[0];
  }

  private async ruleRows(sql: Sql, accountId: string): Promise<RuleRow[]> {
    return sql<RuleRow[]>`
      SELECT id, over_amount, payee, payment_type, approvals, created_at FROM bank.business_payment_rules
       WHERE account_id = ${accountId}::uuid ORDER BY created_at ASC, id ASC
    `;
  }

  private async paymentRowOrNull(sql: Sql, paymentId: string, lock = false): Promise<PaymentRow | null> {
    const rows = lock
      ? await sql<PaymentRow[]>`SELECT * FROM bank.business_payments WHERE id = ${paymentId}::uuid FOR UPDATE`
      : await sql<PaymentRow[]>`SELECT * FROM bank.business_payments WHERE id = ${paymentId}::uuid`;
    return rows[0] ?? null;
  }

  private async paymentRow(sql: Sql, paymentId: string, lock = false): Promise<PaymentRow> {
    const row = await this.paymentRowOrNull(sql, paymentId, lock);
    if (!row) throw new BankError('No payment of this business has that id.', 'bank.business_approval_not_found');
    return row;
  }

  private async inviteRow(sql: Sql, inviteId: string, lock = false): Promise<InviteRow | null> {
    const rows = lock
      ? await sql<InviteRow[]>`
          SELECT *, (expires_at <= now()) AS expired FROM bank.business_invites WHERE id = ${inviteId}::uuid FOR UPDATE`
      : await sql<InviteRow[]>`SELECT *, (expires_at <= now()) AS expired FROM bank.business_invites WHERE id = ${inviteId}::uuid`;
    return rows[0] ?? null;
  }

  private async inviteByToken(sql: Sql, token: string): Promise<InviteRow> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw inviteNotFound();
    const rows = await sql<InviteRow[]>`
      SELECT *, (expires_at <= now()) AS expired FROM bank.business_invites WHERE token_hash = ${hashToken(token)}
    `;
    if (!rows[0]) throw inviteNotFound();
    return rows[0];
  }

  private async inviteView(sql: Sql, inviteId: string): Promise<TeamInvite> {
    const rows = await sql<Array<InviteRow & { role_name: string | null }>>`
      SELECT i.*, (i.expires_at <= now()) AS expired, r.name AS role_name
        FROM bank.business_invites i LEFT JOIN bank.business_custom_roles r ON r.id = i.custom_role_id
       WHERE i.id = ${inviteId}::uuid
    `;
    const r = rows[0]!;
    return {
      id: r.id,
      kind: r.kind,
      email: r.email,
      role: r.role,
      customRole: r.custom_role_id ? { id: r.custom_role_id, name: r.role_name ?? '' } : null,
      status: r.status === 'open' && r.expired ? 'expired' : r.status,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    };
  }

  private async withApprovals(rows: PaymentRow[]): Promise<TeamPayment[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const approvals = await this.sql<Array<{ payment_id: string; approver_user_id: string; approved_at: Date }>>`
      SELECT payment_id, approver_user_id, approved_at FROM bank.business_payment_approvals
       WHERE payment_id = ANY(${ids}::uuid[]) ORDER BY approved_at ASC, approver_user_id ASC
    `;
    const ruleIds = [...new Set(rows.map((r) => r.rule_id).filter((id): id is string => id !== null))];
    const rules = ruleIds.length
      ? await this.sql<RuleRow[]>`
          SELECT id, over_amount, payee, payment_type, approvals, created_at FROM bank.business_payment_rules WHERE id = ANY(${ruleIds}::uuid[])`
      : [];
    const handles = await this.handles([...rows.map((r) => r.maker_user_id), ...approvals.map((a) => a.approver_user_id)]);
    return rows.map((row) => {
      const rule = rules.find((r) => r.id === row.rule_id);
      return {
        id: row.id,
        accountId: row.account_id,
        makerUserId: row.maker_user_id,
        makerHandle: handles.get(row.maker_user_id)!,
        payee: row.payee,
        paymentType: row.payment_type,
        assetId: row.asset_id,
        amount: amountOf(row.amount),
        rule: rule ? toRule(rule) : null,
        approvalsNeeded: row.approvals_needed,
        approvals: approvals
          .filter((a) => a.payment_id === row.id)
          .map((a) => ({ userId: a.approver_user_id, handle: handles.get(a.approver_user_id)!, approvedAt: a.approved_at })),
        status: row.status,
        partnerKey: row.partner_key,
        partnerMoveId: row.partner_move_id,
        refusalCode: row.refusal_code,
        createdAt: row.created_at,
        sentAt: row.sent_at,
      };
    });
  }

  private toMember(row: MemberRow, handles: ReadonlyMap<string, string>): TeamMember {
    return {
      userId: row.user_id,
      handle: handles.get(row.user_id)!,
      role: row.role,
      customRole: row.custom_role_id ? { id: row.custom_role_id, name: row.role_name ?? '' } : null,
      advisor: row.advisor,
      departmentId: row.department_id,
      permissions: permissionsOf(row),
    };
  }

  /** Public handles from svc-identity. A person with none is refused by name, never shown as someone else. */
  private async handles(userIds: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    let found: ReadonlyMap<string, string>;
    try {
      found = await this.directory.handlesOf(unique);
    } catch (err) {
      throw directoryRefusal(err);
    }
    for (const id of unique) {
      if (!found.get(id)) {
        throw new BankError(
          'A person on this business has no public handle in the identity directory, so this is not shown.',
          'bank.business_directory_incomplete',
        );
      }
    }
    return new Map(unique.map((id) => [id, found.get(id)!]));
  }
}

/** What a member may do: their named role's permissions, or their built-in role's. An advisor only reads. */
export function permissionsOf(row: Pick<MemberRow, 'role' | 'permissions' | 'advisor'>): BusinessPermission[] {
  if (row.advisor) return ['view'];
  if (row.permissions) return BUSINESS_PERMISSIONS.filter((p) => row.permissions!.includes(p));
  return builtInPermissions(row.role);
}

/** Of every rule the payment matches, the one asking the most approvals; then the highest amount; then the oldest. */
export function pickRule<R extends Pick<RuleRow, 'over_amount' | 'payee' | 'payment_type' | 'approvals'>>(
  rules: readonly R[],
  payment: { amount: Amount; payee: string; paymentType: BusinessPaymentType },
): R | null {
  let best: R | null = null;
  for (const rule of rules) {
    if (!(payment.amount > amountOf(rule.over_amount))) continue;
    if (rule.payee !== null && rule.payee.toLowerCase() !== payment.payee.toLowerCase()) continue;
    if (rule.payment_type !== null && rule.payment_type !== payment.paymentType) continue;
    if (
      !best ||
      rule.approvals > best.approvals ||
      (rule.approvals === best.approvals && amountOf(rule.over_amount) > amountOf(best.over_amount))
    ) {
      best = rule;
    }
  }
  return best;
}

/** Partner refusals that say nothing moved: the payment is closed as refused and never sent again. */
const DEFINITE_REFUSALS = new Set<string>([
  'bank.partner_insufficient_funds',
  'bank.partner_move_conflict',
  'bank.partner_amount_invalid',
  'bank.asset_mismatch',
  'bank.account_restricted',
]);

function toRule(row: RuleRow): TeamRule {
  return {
    id: row.id,
    overAmount: amountOf(row.over_amount),
    payee: row.payee,
    paymentType: row.payment_type,
    approvals: row.approvals,
    createdAt: row.created_at,
  };
}

function assertInviteOpen(row: Pick<InviteRow, 'status' | 'expired'>): void {
  if (row.status === 'revoked')
    throw new BankError('This invite was revoked. Ask the business for a new one.', 'bank.business_invite_revoked');
  if (row.status === 'replaced') {
    throw new BankError('This invite was sent again, so this link no longer works. Use the newest one.', 'bank.business_invite_replaced');
  }
  if (row.status === 'accepted') throw new BankError('This invite has already been used.', 'bank.business_invite_used');
  if (row.expired) {
    throw new BankError('This invite has expired. Ask the business to send it again.', 'bank.business_invite_expired');
  }
}

function inviteNotFound(): BankError {
  return new BankError('This invite link is not known.', 'bank.business_invite_not_found');
}

function noPartner(): BankError {
  return new BankError(
    'This business’s money is not held at a partner bank, so no payment can be made from it.',
    NO_PARTNER_BANK_CODE as 'bank.no_partner_bank',
  );
}

function directoryRefusal(err: unknown): BankError {
  if (err instanceof BusinessDirectoryError && err.reason === 'unset') return new BankError(err.message, 'bank.business_directory_unset');
  return new BankError('svc-identity did not answer the business directory.', 'bank.business_directory_unavailable');
}

function uniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
