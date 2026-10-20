import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  IDEMPOTENCY_CONFLICT_CODE,
  LedgerError,
  formatAmount,
  parseAmount,
  recipes,
  type Amount,
  type LedgerClient,
  type LedgerTx,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { assertBusinessApprovalsListLimit, assertBusinessListLimit, assertBusinessPendingListLimit } from '../owner-list-limit.js';
import {
  BusinessDirectoryError,
  BusinessLookupLimiter,
  normaliseEmailQuery,
  normaliseHandleQuery,
  unconfiguredBusinessDirectory,
  type BusinessDirectoryPort,
} from './business-directory.js';
import { BUSINESS_ROLES, dutyClash, roleCan, rolesWith, type BusinessCapability, type BusinessMemberRole } from './business-policy.js';
import { accountForSpace, type SpaceRecord, type SpaceService } from '../spaces/space-service.js';
import type { TransferService } from '../transfers/transfer-service.js';
import { withMoneySpan } from '../tracing.js';

/**
 * BUSINESS BANKING — maker/checker with ledger holds (§31:811 / bank.business).
 *
 * Corporate account + multi-user roles + dual control for over-threshold
 * transfers. Under threshold posts immediately via TransferService. At/above
 * threshold: funds move into a purposed hold (`business-approval:<id>`) so the
 * maker cannot spend them while a checker decides; approve settles hold →
 * destination; reject/cancel releases hold → debit pot.
 *
 * Residual / §13 (not invent-risk here): KYB Lane B, expense cards, invoicing
 * (pay.gateway), dedicated org principal. Payroll is atomic via `businessPayroll`.
 */

export type { BusinessMemberRole } from './business-policy.js';
export type BusinessApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface BusinessAccount {
  id: string;
  name: string;
  assetId: string;
  spendThreshold: Amount;
  status: 'active' | 'closed';
  createdAt: Date;
}

export interface BusinessMember {
  accountId: string;
  userId: string;
  role: BusinessMemberRole;
}

export interface BusinessApproval {
  id: string;
  accountId: string;
  makerUserId: string;
  checkerUserId: string | null;
  fromSpaceId: string;
  toSpaceId: string;
  assetId: string;
  amount: Amount;
  status: BusinessApprovalStatus;
  transferId: string | null;
  holdLedgerTxId: string | null;
  ledgerTxId: string | null;
  rejectionCode: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface BusinessPayrollLine {
  toSpaceId: string;
  amount: Amount;
}

export interface BusinessPayrollRun {
  payrollId: string;
  accountId: string;
  actorUserId: string;
  fromSpaceId: string;
  assetId: string;
  ledgerTxId: string;
  recipients: BusinessPayrollLine[];
  createdAt: Date;
}

interface PayrollRunRow {
  id: string;
  account_id: string;
  actor_user_id: string;
  from_space_id: string;
  asset_id: string;
  ledger_tx_id: string;
  created_at: Date;
}

interface PayrollLineRow {
  payroll_id: string;
  to_space_id: string;
  amount: string;
}

interface AccountRow {
  id: string;
  name: string;
  asset_id: string;
  spend_threshold: string;
  status: 'active' | 'closed';
  created_at: Date;
}

interface MemberRow {
  account_id: string;
  user_id: string;
  role: BusinessMemberRole;
}

interface MemberCommandRow {
  id: string;
  account_id: string;
  actor_user_id: string;
  target_user_id: string;
  action: 'remove' | 'set_role';
  role: BusinessMemberRole | null;
}

interface ControlRow {
  id: string;
  account_id: string;
  kind: 'set_threshold' | 'close';
  spend_threshold: string | null;
  proposed_by: string;
  confirmed_by: string | null;
  status: 'pending' | 'applied' | 'cancelled';
  created_at: Date;
  decided_at: Date | null;
}

interface ApprovalRow {
  id: string;
  account_id: string;
  maker_user_id: string;
  checker_user_id: string | null;
  from_space_id: string;
  to_space_id: string;
  asset_id: string;
  amount: string;
  status: BusinessApprovalStatus;
  transfer_id: string | null;
  hold_ledger_tx_id: string | null;
  ledger_tx_id: string | null;
  rejection_code: string | null;
  created_at: Date;
  decided_at: Date | null;
}

function uniqueViolationName(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const row = err as { code?: string; constraint_name?: string };
  if (row.code !== '23505') return null;
  return row.constraint_name ?? '';
}

function encodeOperatorCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id }), 'utf8').toString('base64url');
}

function decodeOperatorCursor(cursor: string): { at: string; id: string } {
  try {
    const json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    if (typeof json.at !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(json.at)) throw new Error('time');
    if (typeof json.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(json.id))
      throw new Error('id');
    return { at: json.at, id: json.id };
  } catch (err) {
    if (err instanceof BankError) throw err;
    throw new BankError('The approvals page cursor is not valid. Ask for the first page again.', 'bank.business_cursor_invalid');
  }
}

function encodeApprovalCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ at: createdAt.toISOString(), id }), 'utf8').toString('base64url');
}

function decodeApprovalCursor(cursor: string): { at: string; id: string } {
  try {
    const json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    if (typeof json.at !== 'string' || typeof json.id !== 'string') throw new Error('shape');
    if (Number.isNaN(Date.parse(json.at))) throw new Error('time');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(json.id)) throw new Error('id');
    return { at: new Date(json.at).toISOString(), id: json.id };
  } catch (err) {
    if (err instanceof BankError) throw err;
    throw new BankError('The approvals page cursor is not valid. Ask for the first page again.', 'bank.business_cursor_invalid');
  }
}

function toAccount(row: AccountRow): BusinessAccount {
  return {
    id: row.id,
    name: row.name,
    assetId: row.asset_id,
    spendThreshold: parseAmount(row.spend_threshold),
    status: row.status,
    createdAt: row.created_at,
  };
}

function toMember(row: MemberRow): BusinessMember {
  return { accountId: row.account_id, userId: row.user_id, role: row.role };
}

function toApproval(row: ApprovalRow): BusinessApproval {
  return {
    id: row.id,
    accountId: row.account_id,
    makerUserId: row.maker_user_id,
    checkerUserId: row.checker_user_id,
    fromSpaceId: row.from_space_id,
    toSpaceId: row.to_space_id,
    assetId: row.asset_id,
    amount: parseAmount(row.amount),
    status: row.status,
    transferId: row.transfer_id,
    holdLedgerTxId: row.hold_ledger_tx_id,
    ledgerTxId: row.ledger_tx_id,
    rejectionCode: row.rejection_code,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

/**
 * A client id keeps the original account, maker, spaces, and amount.
 */
function assertSameProposalTerms(
  existing: BusinessApproval,
  input: {
    clientId: string;
    accountId: string;
    makerUserId: string;
    fromSpaceId: string;
    toSpaceId: string;
    amount: Amount;
  },
): void {
  if (
    existing.accountId !== input.accountId ||
    existing.makerUserId !== input.makerUserId ||
    existing.fromSpaceId !== input.fromSpaceId ||
    existing.toSpaceId !== input.toSpaceId ||
    existing.amount !== input.amount
  ) {
    throw new BankError(
      `Proposal ${input.clientId} already exists on different terms — a retry must carry the same instruction`,
      'bank.business_request_conflict',
    );
  }
}

function decideExistingProposal(
  existing: BusinessApproval,
  input: {
    clientId: string;
    accountId: string;
    makerUserId: string;
    fromSpaceId: string;
    toSpaceId: string;
    amount: Amount;
  },
): { kind: 'posted'; transferId: string; ledgerTxId: string } | { kind: 'pending'; approval: BusinessApproval } {
  assertSameProposalTerms(existing, input);
  if (existing.status === 'pending') return { kind: 'pending', approval: existing };
  if (existing.status === 'approved' && existing.ledgerTxId) {
    return { kind: 'posted', transferId: existing.transferId ?? existing.id, ledgerTxId: existing.ledgerTxId };
  }
  throw new BankError(`Approval ${existing.id} is ${existing.status}`, 'bank.business_approval_inactive');
}

export interface BusinessTeamMember {
  accountId: string;
  userId: string;
  role: BusinessMemberRole;
  handle: string;
}

export interface BusinessPendingControl {
  requestId: string;
  kind: 'set_threshold' | 'close';
  spendThreshold: Amount | null;
  proposedByHandle: string;
  createdAt: Date;
}

export interface BusinessPartyView {
  handle: string | null;
  handleReason: 'handle_unresolved' | null;
  displayName: string | null;
}

export interface BusinessPendingView {
  id: string;
  accountId: string;
  makerHandle: string | null;
  makerHandleReason: 'handle_unresolved' | null;
  receiverOwnerHandle: string | null;
  receiverOwnerHandleReason: 'handle_unresolved' | null;
  receiverOwnerName: string | null;
  fromSpaceId: string;
  toSpaceId: string;
  assetId: string;
  amount: Amount;
  status: BusinessApprovalStatus;
  transferId: string | null;
  holdLedgerTxId: string | null;
  ledgerTxId: string | null;
  createdAt: Date;
}

export interface BusinessApprovalView {
  id: string;
  accountId: string;
  makerHandle: string | null;
  makerHandleReason: 'handle_unresolved' | null;
  checkerHandle: string | null;
  receiverOwnerHandle: string | null;
  receiverOwnerHandleReason: 'handle_unresolved' | null;
  receiverOwnerName: string | null;
  fromSpaceId: string;
  toSpaceId: string;
  assetId: string;
  amount: Amount;
  status: BusinessApprovalStatus;
  transferId: string | null;
  holdLedgerTxId: string | null;
  ledgerTxId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export type BusinessControlResult = {
  status: 'pending' | 'applied' | 'cancelled';
  requestId: string;
  account: BusinessAccount;
};

export class BusinessService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly spaces: SpaceService,
    private readonly transfers: TransferService,
    private readonly directory: BusinessDirectoryPort = unconfiguredBusinessDirectory(),
    private readonly lookups: BusinessLookupLimiter = new BusinessLookupLimiter(),
  ) {}

  async createAccount(input: {
    accountId: string;
    name: string;
    assetId: string;
    spendThreshold: Amount;
    creatorUserId: string;
  }): Promise<BusinessAccount> {
    if (!input.accountId) {
      throw new BankError('Business create needs a caller-stable account id', 'bank.business_request_id_required');
    }
    if (input.spendThreshold <= 0n) {
      throw new BankError('Business spend threshold must be positive', 'bank.business_invalid_threshold');
    }
    const name = input.name.trim();
    if (!name) throw new BankError('Business account needs a name', 'bank.business_invalid_name');
    const threshold = formatAmount(input.spendThreshold);

    const account = await transaction(this.sql, async (tx) => {
      const inserted = await tx<AccountRow[]>`
        INSERT INTO bank.business_accounts (id, name, asset_id, spend_threshold, status)
        VALUES (${input.accountId}::uuid, ${name}, ${input.assetId}, ${threshold}::numeric, 'active')
        ON CONFLICT (id) DO NOTHING
        RETURNING id, name, asset_id, spend_threshold, status, created_at
      `;
      if (inserted[0]) {
        await tx`
          INSERT INTO bank.business_members (account_id, user_id, role)
          VALUES (${inserted[0].id}::uuid, ${input.creatorUserId}, 'admin')
        `;
        return toAccount(inserted[0]);
      }
      const existing = await this.accountIn(tx, input.accountId);
      const members = await tx<MemberRow[]>`
        SELECT account_id, user_id, role FROM bank.business_members
         WHERE account_id = ${input.accountId}::uuid AND user_id = ${input.creatorUserId}
      `;
      const sameOwner = members[0]?.role === 'admin';
      const sameRules = existing.name === name && existing.assetId === input.assetId && formatAmount(existing.spendThreshold) === threshold;
      if (!sameOwner || !sameRules) {
        throw new BankError('This business id is already in use on different terms (bank.business_conflict)', 'bank.business_conflict');
      }
      return existing;
    });
    await this.spaces.ensurePrimary(input.creatorUserId, input.assetId);
    return account;
  }

  async addMember(input: { accountId: string; actorUserId: string; userId: string; role: BusinessMemberRole }): Promise<BusinessMember> {
    return transaction(this.sql, async (tx) => {
      const members = await this.lockMembers(tx, input.accountId);
      this.assertAdminLocked(members, input.actorUserId);
      const current = members.find((row) => row.user_id === input.userId);
      // Adding an existing member re-roles them, so it obeys the same last-administrator rule as setMemberRole.
      if (
        current &&
        roleCan(current.role, 'manage_team') &&
        !roleCan(input.role, 'manage_team') &&
        members.filter((row) => roleCan(row.role, 'manage_team')).length < 2
      ) {
        throw new BankError('The last administrator cannot be demoted (bank.business_last_admin)', 'bank.business_last_admin');
      }
      const rows = await tx<MemberRow[]>`
        INSERT INTO bank.business_members (account_id, user_id, role)
        VALUES (${input.accountId}::uuid, ${input.userId}, ${input.role})
        ON CONFLICT (account_id, user_id) DO UPDATE SET role = EXCLUDED.role
        RETURNING account_id, user_id, role
      `;
      return toMember(rows[0]!);
    });
  }

  async listMembers(accountId: string, actorUserId: string): Promise<BusinessMember[]> {
    await this.assertMember(accountId, actorUserId);
    const rows = await this.sql<MemberRow[]>`
      SELECT account_id, user_id, role FROM bank.business_members
       WHERE account_id = ${accountId}
       ORDER BY created_at ASC
    `;
    return rows.map(toMember);
  }

  async accountsOf(userId: string, limit?: number): Promise<BusinessAccount[]> {
    const page = assertBusinessListLimit(limit);
    const rows = await this.sql<AccountRow[]>`
      SELECT a.id, a.name, a.asset_id, a.spend_threshold, a.status, a.created_at
        FROM bank.business_accounts a
        JOIN bank.business_members m ON m.account_id = a.id
       WHERE m.user_id = ${userId}
       -- Closed accounts stay on the list. A closed company is a fact, not a hidden row.
       ORDER BY a.created_at DESC
       LIMIT ${page}
    `;
    return rows.map(toAccount);
  }

  async proposeTransfer(input: {
    accountId: string;
    makerUserId: string;
    fromSpaceId: string;
    toSpaceId: string;
    amount: Amount;
    clientId: string;
  }): Promise<{ kind: 'posted'; transferId: string; ledgerTxId: string } | { kind: 'pending'; approval: BusinessApproval }> {
    if (!input.clientId) {
      throw new BankError('Business propose needs a caller-stable client id', 'bank.business_request_id_required');
    }
    if (input.amount <= 0n) throw new BankError('Transfer amount must be positive', 'bank.below_minimum');
    const account = await this.account(input.accountId);
    if (account.status !== 'active') throw new BankError('Business account is closed', 'bank.business_closed');
    await this.assertRole(input.accountId, input.makerUserId, 'propose');

    const now = new Date();
    const from = await this.spaces.resolveForDebit(input.fromSpaceId, now);
    const to = await this.spaces.resolveForCredit(input.toSpaceId, {
      actingUserId: from.userId,
      // A retry of a proposal that already booked must resume it, not be refused.
      alreadyBooked: async () =>
        (await this.approvalExists(input.clientId)) ||
        (await this.ledger.getTxByKey(`bank.transfer:${input.clientId}:0`)) !== null ||
        (await this.ledger.getTxByKey(`bank.business.hold:${input.clientId}`)) !== null,
    });
    if (from.assetId !== account.assetId || to.assetId !== account.assetId) {
      throw new BankError(`Business account ${account.assetId} cannot move ${from.assetId}→${to.assetId}`, 'bank.asset_mismatch');
    }
    if (from.userId !== input.makerUserId) {
      throw new BankError('Maker must own the debit space in this partial', 'bank.not_owner');
    }

    const clientId = input.clientId;

    const existingRows = await this.sql<ApprovalRow[]>`
      SELECT id, account_id, maker_user_id, checker_user_id, from_space_id, to_space_id,
             asset_id, amount, status, transfer_id, hold_ledger_tx_id, ledger_tx_id,
             rejection_code, created_at, decided_at
        FROM bank.business_approvals WHERE id = ${clientId}::uuid
    `;
    if (existingRows[0]) return this.resumeProposal(toApproval(existingRows[0]), input);

    // Recover pre-claim legacy receipts before choosing a mode. Neither ledger
    // key may be rebound to different economic terms or a second money path.
    const [previousTransfer, previousHold] = await Promise.all([
      this.ledger.getTxByKey(`bank.transfer:${clientId}:0`).then((tx) => this.withEntries(tx)),
      this.ledger.getTxByKey(`bank.business.hold:${clientId}`).then((tx) => this.withEntries(tx)),
    ]);
    const fromAcct = accountForSpace(from);
    const holdRequest = recipes.businessApprovalHold({ approvalId: clientId, from: fromAcct, amount: input.amount });
    const holdDest = holdRequest.entries.find((entry) => entry.direction === 'debit')!;
    if (
      (previousTransfer &&
        !(await this.postedPayrollMatches(previousTransfer, fromAcct, [{ amount: input.amount, acct: accountForSpace(to) }]))) ||
      (previousHold && !(await this.postedPayrollMatches(previousHold, fromAcct, [{ amount: input.amount, acct: holdDest.account }]))) ||
      (previousTransfer && previousHold)
    ) {
      throw new BankError('The ledger instruction differs from the original proposal', 'bank.business_request_conflict');
    }
    const immediate = !previousHold && input.amount < account.spendThreshold;
    if (previousTransfer && !immediate) {
      throw new BankError('The original transfer cannot become an approval hold', 'bank.business_request_conflict');
    }
    // The immutable instruction wins before either ledger key can post. A
    // pending/null hold or approved/null transfer remains recoverable by its maker.
    const claimed = await this.sql<ApprovalRow[]>`
      INSERT INTO bank.business_approvals
        (id, account_id, maker_user_id, from_space_id, to_space_id, asset_id, amount, status, transfer_id, decided_at)
      VALUES (
        ${clientId}::uuid, ${input.accountId}::uuid, ${input.makerUserId},
        ${input.fromSpaceId}::uuid, ${input.toSpaceId}::uuid,
        ${account.assetId}, ${formatAmount(input.amount)}::numeric,
        ${immediate ? 'approved' : 'pending'}, ${immediate ? clientId : null}, ${immediate ? now : null}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id, account_id, maker_user_id, checker_user_id, from_space_id, to_space_id,
                asset_id, amount, status, transfer_id, hold_ledger_tx_id, ledger_tx_id,
                rejection_code, created_at, decided_at
    `;
    return this.resumeProposal(claimed[0] ? toApproval(claimed[0]) : await this.approval(clientId), input);
  }

  async approve(input: { approvalId: string; checkerUserId: string }): Promise<{ transferId: string; ledgerTxId: string }> {
    return withMoneySpan('bank.business.approve', { operation: 'business-approve', userId: input.checkerUserId }, async () => {
      const approval = await this.approval(input.approvalId);
      if (approval.status === 'approved' && approval.ledgerTxId) {
        // Re-drive: settle key is approval id; row already closed.
        return { transferId: approval.transferId ?? approval.id, ledgerTxId: approval.ledgerTxId };
      }
      if (approval.status === 'approved') {
        // An immediate transfer has no purposed hold. Its original proposer
        // retries the claimed instruction; checker settlement must not invent one.
        if (!approval.holdLedgerTxId) {
          throw new BankError('Retry the original proposal to complete this transfer', 'bank.business_approval_inactive');
        }
        // Unknown settlement outcomes stay recoverable on the same ledger key.
        if (dutyClash({ initiator: approval.makerUserId, approver: input.checkerUserId }) !== null) {
          throw new BankError('Maker cannot approve their own transfer', 'bank.business_self_approve');
        }
        await this.assertRole(approval.accountId, input.checkerUserId, 'approve');
        return this.finishSettle(approval);
      }
      if (approval.status !== 'pending') {
        throw new BankError(`Approval ${approval.id} is ${approval.status}`, 'bank.business_approval_inactive');
      }
      if (!approval.holdLedgerTxId) {
        throw new BankError('Retry the original proposal to complete its hold', 'bank.business_approval_inactive');
      }
      if (dutyClash({ initiator: approval.makerUserId, approver: input.checkerUserId }) !== null) {
        throw new BankError('Maker cannot approve their own transfer', 'bank.business_self_approve');
      }
      await this.assertRole(approval.accountId, input.checkerUserId, 'approve');

      // Ask identity BEFORE the claim. A refusal here leaves the row `pending`,
      // which reject and cancel accept, so the maker's hold can still be
      // released. Checking after the claim would leave an `approved` row that
      // neither can close.
      await this.resolveSettleTarget(approval);

      // Claim pending first so concurrent reject/cancel cannot also release the hold.
      const claimed = await this.sql<ApprovalRow[]>`
          UPDATE bank.business_approvals
             SET status = 'approved',
                 checker_user_id = ${input.checkerUserId},
                 transfer_id = ${approval.id},
                 decided_at = now()
           WHERE id = ${approval.id}::uuid AND status = 'pending' AND hold_ledger_tx_id IS NOT NULL
          RETURNING id, account_id, maker_user_id, checker_user_id, from_space_id, to_space_id,
                    asset_id, amount, status, transfer_id, hold_ledger_tx_id, ledger_tx_id,
                    rejection_code, created_at, decided_at
        `;
      if (!claimed[0]) {
        throw new BankError(`Approval ${approval.id} is no longer pending`, 'bank.business_approval_inactive');
      }

      return this.finishSettle(approval);
    });
  }

  async reject(input: { approvalId: string; checkerUserId: string }): Promise<void> {
    const approval = await this.approval(input.approvalId);
    if (approval.status === 'rejected' || approval.status === 'cancelled') {
      if (dutyClash({ initiator: approval.makerUserId, approver: input.checkerUserId }) !== null) {
        throw new BankError('Maker cannot reject their own transfer as checker', 'bank.business_self_approve');
      }
      await this.assertRole(approval.accountId, input.checkerUserId, 'approve');
      await this.releaseHold(approval);
      return;
    }
    if (approval.status !== 'pending') {
      throw new BankError(`Approval ${approval.id} is ${approval.status}`, 'bank.business_approval_inactive');
    }
    if (dutyClash({ initiator: approval.makerUserId, approver: input.checkerUserId }) !== null) {
      throw new BankError('Maker cannot reject their own transfer as checker', 'bank.business_self_approve');
    }
    await this.assertRole(approval.accountId, input.checkerUserId, 'approve');
    await this.claimAndRelease(approval, {
      actorUserId: input.checkerUserId,
      status: 'rejected',
      rejectionCode: 'bank.business_rejected',
    });
  }

  /**
   * The maker cancels their own pending proposal without a current membership,
   * so removing them cannot strand the hold. An admin cancels anyone else's.
   * A repeat on an already cancelled or rejected row releases the hold again.
   */
  async cancel(input: { approvalId: string; actorUserId: string }): Promise<void> {
    const approval = await this.approval(input.approvalId);
    const own = approval.makerUserId === input.actorUserId;
    if (approval.status === 'cancelled' || approval.status === 'rejected') {
      if (!own) await this.assertRole(approval.accountId, input.actorUserId, 'manage_team');
      await this.releaseHold(approval);
      return;
    }
    if (approval.status !== 'pending') {
      throw new BankError(`Approval ${approval.id} is ${approval.status}`, 'bank.business_approval_inactive');
    }
    if (!own) await this.assertRole(approval.accountId, input.actorUserId, 'manage_team');
    await this.claimAndRelease(approval, {
      actorUserId: input.actorUserId,
      status: 'cancelled',
      rejectionCode: 'bank.business_cancelled',
    });
  }

  async listPending(accountId: string, actorUserId: string, limit?: number): Promise<BusinessPendingView[]> {
    await this.assertMember(accountId, actorUserId);
    const page = assertBusinessPendingListLimit(limit);
    const rows = await this.sql<ApprovalRow[]>`
      SELECT id, account_id, maker_user_id, checker_user_id, from_space_id, to_space_id,
             asset_id, amount, status, transfer_id, hold_ledger_tx_id, ledger_tx_id, rejection_code,
             created_at, decided_at
        FROM bank.business_approvals
       WHERE account_id = ${accountId} AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT ${page}
    `;
    return this.withParties(rows);
  }

  /**
   * Teammates and waiting account controls. Handles come from identity.
   * A missing handle refuses the page: a raw user id is not a name.
   */
  async team(
    accountId: string,
    actorUserId: string,
  ): Promise<{ members: BusinessTeamMember[]; pendingControls: BusinessPendingControl[] }> {
    await this.assertMember(accountId, actorUserId);
    const members = await this.sql<MemberRow[]>`
      SELECT account_id, user_id, role FROM bank.business_members
       WHERE account_id = ${accountId}
       ORDER BY created_at ASC
       LIMIT 201
    `;
    if (members.length > 200) {
      throw new BankError(
        'This team is larger than the published page. It is not truncated (bank.business_directory_incomplete)',
        'bank.business_directory_incomplete',
      );
    }
    const controls = await this.sql<ControlRow[]>`
      SELECT id, account_id, kind, spend_threshold, proposed_by, confirmed_by, status, created_at, decided_at
        FROM bank.business_control_requests
       WHERE account_id = ${accountId} AND status = 'pending'
       ORDER BY created_at ASC
    `;
    const handles = await this.handlesFor([...members.map((row) => row.user_id), ...controls.map((row) => row.proposed_by)]);
    return {
      members: members.map((row) => ({
        accountId: row.account_id,
        userId: row.user_id,
        role: row.role,
        handle: handles.get(row.user_id)!,
      })),
      pendingControls: controls.map((row) => ({
        requestId: row.id,
        kind: row.kind,
        spendThreshold: row.spend_threshold === null ? null : parseAmount(row.spend_threshold),
        proposedByHandle: handles.get(row.proposed_by)!,
        createdAt: row.created_at,
      })),
    };
  }

  async removeMember(input: {
    accountId: string;
    actorUserId: string;
    userId: string;
    requestId: string;
  }): Promise<{ accountId: string; userId: string; removed: true }> {
    this.requireRequestId(input.requestId);
    return transaction(this.sql, async (tx) => {
      const existing = await this.memberCommand(tx, input.requestId, true);
      if (existing) {
        this.assertCommandTerms(existing, { ...input, action: 'remove', role: null });
        return { accountId: input.accountId, userId: input.userId, removed: true as const };
      }
      const members = await this.lockMembers(tx, input.accountId);
      this.assertAdminLocked(members, input.actorUserId);
      const target = members.find((row) => row.user_id === input.userId);
      if (!target) throw new BankError('Not a member of this business account', 'bank.business_not_member');
      if (roleCan(target.role, 'manage_team') && members.filter((row) => roleCan(row.role, 'manage_team')).length < 2) {
        throw new BankError('The last administrator cannot be removed (bank.business_last_admin)', 'bank.business_last_admin');
      }
      const waiting = await tx<Array<{ id: string }>>`
        SELECT id FROM bank.business_approvals
         WHERE account_id = ${input.accountId}::uuid
           AND maker_user_id = ${input.userId}
           AND status = 'pending'
         LIMIT 1
      `;
      if (waiting[0]) {
        throw new BankError(
          'This person still has a payment waiting. Decide or cancel those payments before removing them (bank.business_member_has_pending)',
          'bank.business_member_has_pending',
        );
      }
      const inserted = await tx<Array<{ id: string }>>`
        INSERT INTO bank.business_member_commands (id, account_id, actor_user_id, target_user_id, action, role)
        VALUES (${input.requestId}::uuid, ${input.accountId}::uuid, ${input.actorUserId}, ${input.userId}, 'remove', NULL)
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      if (!inserted[0]) {
        const raced = await this.memberCommand(tx, input.requestId, true);
        if (!raced) throw new BankError('The member change could not be recorded', 'bank.business_request_conflict');
        this.assertCommandTerms(raced, { ...input, action: 'remove', role: null });
        return { accountId: input.accountId, userId: input.userId, removed: true as const };
      }
      await tx`
        DELETE FROM bank.business_members
         WHERE account_id = ${input.accountId}::uuid AND user_id = ${input.userId}
      `;
      return { accountId: input.accountId, userId: input.userId, removed: true as const };
    });
  }

  async setMemberRole(input: {
    accountId: string;
    actorUserId: string;
    userId: string;
    role: BusinessMemberRole;
    requestId: string;
  }): Promise<BusinessMember> {
    this.requireRequestId(input.requestId);
    return transaction(this.sql, async (tx) => {
      const existing = await this.memberCommand(tx, input.requestId, true);
      if (existing) {
        this.assertCommandTerms(existing, { ...input, action: 'set_role', role: input.role });
        return { accountId: input.accountId, userId: input.userId, role: input.role };
      }
      const members = await this.lockMembers(tx, input.accountId);
      this.assertAdminLocked(members, input.actorUserId);
      const target = members.find((row) => row.user_id === input.userId);
      if (!target) throw new BankError('Not a member of this business account', 'bank.business_not_member');
      if (
        roleCan(target.role, 'manage_team') &&
        !roleCan(input.role, 'manage_team') &&
        members.filter((row) => roleCan(row.role, 'manage_team')).length < 2
      ) {
        throw new BankError('The last administrator cannot be demoted (bank.business_last_admin)', 'bank.business_last_admin');
      }
      const inserted = await tx<Array<{ id: string }>>`
        INSERT INTO bank.business_member_commands (id, account_id, actor_user_id, target_user_id, action, role)
        VALUES (
          ${input.requestId}::uuid, ${input.accountId}::uuid, ${input.actorUserId}, ${input.userId},
          'set_role', ${input.role}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      if (!inserted[0]) {
        const raced = await this.memberCommand(tx, input.requestId, true);
        if (!raced) throw new BankError('The member change could not be recorded', 'bank.business_request_conflict');
        this.assertCommandTerms(raced, { ...input, action: 'set_role', role: input.role });
        return { accountId: input.accountId, userId: input.userId, role: input.role };
      }
      await tx`
        UPDATE bank.business_members SET role = ${input.role}
         WHERE account_id = ${input.accountId}::uuid AND user_id = ${input.userId}
      `;
      return { accountId: input.accountId, userId: input.userId, role: input.role };
    });
  }

  /**
   * The primary space of an active person, for a company payment or payroll.
   * Does not create a space. A miss is `{ found: false }` for unknown, frozen,
   * closed and a badly shaped handle or email.
   */
  async resolveRecipientSpace(input: {
    accountId: string;
    actorUserId: string;
    assetId: string;
    handle?: string;
    email?: string;
  }): Promise<{ found: false } | { found: true; handle: string; assetId: string; spaceId: string | null }> {
    await this.assertMember(input.accountId, input.actorUserId);
    if (!this.lookups.tryTake(input.actorUserId)) {
      throw new BankError(
        'Too many recipient lookups. Try again in a minute (bank.business_directory_rate_limited)',
        'bank.business_directory_rate_limited',
      );
    }
    const handleRaw = input.handle?.trim() ?? '';
    const emailRaw = input.email?.trim() ?? '';
    if ((handleRaw === '') === (emailRaw === '')) {
      throw new BankError('Send a handle or an email, not both (bank.business_recipient_query)', 'bank.business_recipient_query');
    }
    const handle = handleRaw === '' ? null : normaliseHandleQuery(handleRaw);
    const email = emailRaw === '' ? null : normaliseEmailQuery(emailRaw);
    if (handleRaw !== '' && handle === null) return { found: false };
    if (emailRaw !== '' && email === null) return { found: false };
    let hit: { userId: string; handle: string } | null;
    try {
      hit = await this.directory.findActive(handle !== null ? { handle } : { email: email! });
    } catch (err) {
      this.directoryError(err);
    }
    if (!hit) return { found: false };
    const space = await this.spaces.findPrimary(hit.userId, input.assetId);
    return { found: true, handle: hit.handle, assetId: input.assetId, spaceId: space?.id ?? null };
  }

  /**
   * Approval history. `business.pending` stays the waiting queue. This page
   * can filter by status and names the maker and checker by handle.
   */
  async listApprovals(
    accountId: string,
    actorUserId: string,
    input: { status?: BusinessApprovalStatus; limit?: number; cursor?: string },
  ): Promise<{ items: BusinessApprovalView[]; nextCursor: string | null }> {
    await this.assertMember(accountId, actorUserId);
    const page = assertBusinessApprovalsListLimit(input.limit);
    const cursor = input.cursor ? decodeApprovalCursor(input.cursor) : null;
    const status = input.status ?? null;
    const rows = await this.sql<ApprovalRow[]>`
      SELECT id, account_id, maker_user_id, checker_user_id, from_space_id, to_space_id,
             asset_id, amount, status, transfer_id, hold_ledger_tx_id, ledger_tx_id, rejection_code,
             created_at, decided_at
        FROM bank.business_approvals
       WHERE account_id = ${accountId}
         AND (${status}::text IS NULL OR status::text = ${status})
         AND (
           ${cursor?.at ?? null}::timestamptz IS NULL
           OR created_at < ${cursor?.at ?? null}::timestamptz
           OR (created_at = ${cursor?.at ?? null}::timestamptz AND id < ${cursor?.id ?? null}::uuid)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT ${page}
    `;
    const checkerIds = rows.flatMap((row) => (row.checker_user_id ? [row.checker_user_id] : []));
    const checkers = checkerIds.length === 0 ? new Map<string, string>() : await this.handlesFor(checkerIds);
    const named = await this.withParties(rows);
    const items = named.map((row, index) => ({
      ...row,
      checkerHandle: rows[index]?.checker_user_id ? (checkers.get(rows[index]!.checker_user_id!) ?? null) : null,
      decidedAt: rows[index]?.decided_at ?? null,
    }));
    const last = rows.at(-1);
    return {
      items,
      nextCursor: last && rows.length === page ? encodeApprovalCursor(last.created_at, last.id) : null,
    };
  }

  /**
   * First administrator records the new threshold. A different administrator
   * confirms the same request id and the same amount. One person cannot apply it.
   */
  async setThreshold(input: {
    accountId: string;
    actorUserId: string;
    spendThreshold: Amount;
    requestId: string;
  }): Promise<BusinessControlResult & { status: 'pending' | 'applied' }> {
    this.requireRequestId(input.requestId);
    if (input.spendThreshold <= 0n) {
      throw new BankError('Business spend threshold must be positive', 'bank.business_invalid_threshold');
    }
    return this.control(input.accountId, input.actorUserId, {
      requestId: input.requestId,
      kind: 'set_threshold',
      spendThreshold: input.spendThreshold,
    });
  }

  /** First administrator records the close. A different administrator confirms it. */
  async closeAccount(input: {
    accountId: string;
    actorUserId: string;
    requestId: string;
  }): Promise<BusinessControlResult & { status: 'pending' | 'applied' }> {
    this.requireRequestId(input.requestId);
    return this.control(input.accountId, input.actorUserId, {
      requestId: input.requestId,
      kind: 'close',
      spendThreshold: null,
    });
  }

  /**
   * Any administrator, including the proposer, withdraws a pending control.
   * A repeat returns the same cancelled result. An applied control stays applied.
   */
  async cancelControl(input: {
    accountId: string;
    actorUserId: string;
    requestId: string;
  }): Promise<{ status: 'cancelled'; requestId: string; account: BusinessAccount }> {
    this.requireRequestId(input.requestId);
    return transaction(this.sql, async (tx) => {
      const existing = await this.controlRow(tx, input.requestId, true);
      if (!existing || existing.account_id !== input.accountId) {
        throw new BankError(`Business control ${input.requestId} not found`, 'bank.business_not_found');
      }
      this.assertAdminLocked(await this.lockMembers(tx, input.accountId), input.actorUserId);
      if (existing.status === 'applied') {
        throw new BankError(`Request ${input.requestId} is already applied`, 'bank.business_approval_inactive');
      }
      if (existing.status === 'pending') {
        const updated = await tx<Array<{ id: string }>>`
          UPDATE bank.business_control_requests
             SET status = 'cancelled', confirmed_by = ${input.actorUserId}, decided_at = now()
           WHERE id = ${input.requestId}::uuid AND status = 'pending'
          RETURNING id
        `;
        if (!updated[0]) throw new BankError(`Request ${input.requestId} is no longer waiting`, 'bank.business_approval_inactive');
      }
      return {
        status: 'cancelled' as const,
        requestId: input.requestId,
        account: await this.accountIn(tx, input.accountId),
      };
    });
  }

  /**
   * Multi-recipient payroll: one ledger post, all paid or none.
   *
   * Same-asset only. A mix would invent an FX/withholding rate — refused as
   * `bank.business_payroll_rate_unset`. Amounts are caller-supplied instruction
   * strings (parsed upstream); this door never computes a salary table.
   *
   * A total at or above the account spend threshold does not post. The approval
   * hold settles one destination for one amount, so it cannot carry these
   * recipients without a new recipe or a new amount. One admin or maker is not
   * a different checker.
   */
  async runPayroll(input: {
    payrollId: string;
    accountId: string;
    actorUserId: string;
    fromSpaceId: string;
    recipients: ReadonlyArray<BusinessPayrollLine>;
  }): Promise<BusinessPayrollRun> {
    if (input.recipients.length === 0) {
      throw new BankError('Payroll needs at least one recipient', 'bank.business_payroll_empty');
    }
    const account = await this.account(input.accountId);
    if (account.status !== 'active') throw new BankError('Business account is closed', 'bank.business_closed');
    await this.assertRole(input.accountId, input.actorUserId, 'propose');

    const existing = await this.payrollRun(input.payrollId);
    if (existing) this.assertPayrollVisibleTerms(existing, input);

    const now = new Date();
    const from = await this.spaces.resolveForDebit(input.fromSpaceId, now);
    if (from.userId !== input.actorUserId) {
      throw new BankError('Payroll debit space must belong to the actor', 'bank.not_owner');
    }
    if (from.assetId !== account.assetId) {
      throw new BankError(`Business account ${account.assetId} cannot payroll ${from.assetId}`, 'bank.asset_mismatch');
    }

    const seen = new Set<string>([input.fromSpaceId]);
    const resolved: Array<{ toSpaceId: string; amount: Amount; acct: ReturnType<typeof accountForSpace> }> = [];
    for (const line of input.recipients) {
      if (line.amount <= 0n) throw new BankError('Payroll line amount must be positive', 'bank.below_minimum');
      if (seen.has(line.toSpaceId)) {
        throw new BankError('Payroll cannot pay the same space twice, or pay the source', 'bank.same_space');
      }
      seen.add(line.toSpaceId);
      const to = await this.spaces.resolveForCredit(line.toSpaceId, {
        actingUserId: from.userId,
        alreadyBooked: async () => Boolean(existing) || (await this.ledger.getTxByKey(`bank.business.payroll:${input.payrollId}`)) !== null,
      });
      if (to.assetId !== from.assetId) {
        throw new BankError(
          `Payroll cannot mix ${from.assetId} and ${to.assetId} — rates are not invented here`,
          'bank.business_payroll_rate_unset',
        );
      }
      resolved.push({ toSpaceId: line.toSpaceId, amount: line.amount, acct: accountForSpace(to) });
    }

    let total: Amount = 0n;
    for (const line of resolved) total += line.amount;
    if (total >= account.spendThreshold) {
      throw new BankError(
        'Dual control is required for a payroll at or above the spend threshold. An admin or maker alone is not a different checker.',
        'bank.business_self_approve',
      );
    }

    const fromAcct = accountForSpace(from);
    return withMoneySpan(
      'bank.business.payroll',
      { operation: 'business-payroll', userId: input.actorUserId, amount: formatAmount(total) },
      async () => {
        const posted = await this.ledger
          .post(
            recipes.businessPayroll({
              payrollId: input.payrollId,
              from: fromAcct,
              recipients: resolved.map((line) => ({ to: line.acct, amount: line.amount })),
            }),
          )
          .catch((error: unknown) => {
            // The ledger now refuses a reused key whose body differs: this payroll id already booked
            // other terms (for example a dropped recipient). Same answer the entries check below gives.
            if (error instanceof LedgerError && error.code === IDEMPOTENCY_CONFLICT_CODE) {
              throw new BankError(`Payroll ${input.payrollId} already exists on different terms`, 'bank.business_request_conflict');
            }
            throw error;
          });
        // Empty entries: this client did not return the book. That is not a
        // different instruction, and it is not a reason to invent a recipient.
        const agreed = await this.payrollEntriesAgree(posted, fromAcct, resolved);
        if (agreed === false) {
          throw new BankError(`Payroll ${input.payrollId} already exists on different terms`, 'bank.business_request_conflict');
        }
        if (existing && existing.ledgerTxId !== posted.id) {
          throw new BankError(`Payroll ${input.payrollId} already exists on different terms`, 'bank.business_request_conflict');
        }
        // Equal stored and requested counts are the same instruction only when
        // the book does not show a recipient this request dropped.
        if (existing && existing.recipients.length === input.recipients.length) {
          this.assertPayrollSameTerms(existing, input);
          return existing;
        }

        return transaction(this.sql, async (tx) => {
          const inserted = await tx<PayrollRunRow[]>`
            INSERT INTO bank.business_payroll_runs
              (id, account_id, actor_user_id, from_space_id, asset_id, ledger_tx_id)
            VALUES (
              ${input.payrollId}::uuid, ${input.accountId}::uuid, ${input.actorUserId},
              ${input.fromSpaceId}::uuid, ${account.assetId}, ${posted.id}
            )
            ON CONFLICT (id) DO NOTHING
            RETURNING id, account_id, actor_user_id, from_space_id, asset_id, ledger_tx_id, created_at
          `;
          if (inserted[0]) {
            for (const line of resolved) {
              await tx`
                INSERT INTO bank.business_payroll_lines (payroll_id, to_space_id, amount)
                VALUES (${input.payrollId}::uuid, ${line.toSpaceId}::uuid, ${formatAmount(line.amount)}::numeric)
              `;
            }
            const recorded = await this.payrollRun(input.payrollId, tx);
            if (!recorded) {
              throw new BankError(`Payroll ${input.payrollId} could not be recorded`, 'bank.business_request_conflict');
            }
            this.assertPayrollSameTerms(recorded, input);
            return recorded;
          }
          const locked = await this.payrollRun(input.payrollId, tx, true);
          if (!locked || locked.ledgerTxId !== posted.id) {
            throw new BankError(`Payroll ${input.payrollId} could not be recorded`, 'bank.business_request_conflict');
          }
          return this.completePayrollLines(tx, locked, input);
        });
      },
    );
  }

  /**
   * Lines already stored must agree with the request. Lines that are not
   * visible yet are not a different instruction — the caller completes them
   * when the ledger payment is that same instruction.
   */
  private assertPayrollVisibleTerms(
    existing: BusinessPayrollRun,
    input: { accountId: string; fromSpaceId: string; recipients: ReadonlyArray<BusinessPayrollLine> },
  ): void {
    if (existing.accountId !== input.accountId || existing.fromSpaceId !== input.fromSpaceId) {
      throw new BankError(`Payroll ${existing.payrollId} already exists on different terms`, 'bank.business_request_conflict');
    }
    const requested = new Map(input.recipients.map((line) => [line.toSpaceId, line.amount]));
    for (const line of existing.recipients) {
      if (requested.get(line.toSpaceId) !== line.amount) {
        throw new BankError(`Payroll ${existing.payrollId} already exists on different terms`, 'bank.business_request_conflict');
      }
    }
  }

  private async completePayrollLines(
    tx: Sql,
    existing: BusinessPayrollRun,
    input: { payrollId: string; accountId: string; fromSpaceId: string; recipients: ReadonlyArray<BusinessPayrollLine> },
  ): Promise<BusinessPayrollRun> {
    this.assertPayrollVisibleTerms(existing, input);
    const have = new Set(existing.recipients.map((line) => line.toSpaceId));
    for (const line of input.recipients) {
      if (have.has(line.toSpaceId)) continue;
      await tx`
        INSERT INTO bank.business_payroll_lines (payroll_id, to_space_id, amount)
        VALUES (${input.payrollId}::uuid, ${line.toSpaceId}::uuid, ${formatAmount(line.amount)}::numeric)
        ON CONFLICT (payroll_id, to_space_id) DO NOTHING
      `;
    }
    const recorded = await this.payrollRun(input.payrollId, tx);
    if (!recorded) {
      throw new BankError(`Payroll ${input.payrollId} could not be recorded`, 'bank.business_request_conflict');
    }
    this.assertPayrollSameTerms(recorded, input);
    return recorded;
  }

  /**
   * `null` — the client returned no entries, so the book was not shown.
   * `true` / `false` — the entries that were returned agree with this request, or they do not.
   */
  private async payrollEntriesAgree(
    posted: LedgerTx,
    fromAcct: ReturnType<typeof accountForSpace>,
    resolved: ReadonlyArray<{ amount: Amount; acct: ReturnType<typeof accountForSpace> }>,
  ): Promise<boolean | null> {
    if (posted.entries.length === 0) return null;
    return this.postedPayrollMatches(posted, fromAcct, resolved);
  }

  /**
   * The HTTP ledger client's `post` receipt and `getTxByKey` answer carry no
   * entries, and `postedPayrollMatches` reads them. Without them every match
   * fails, which showed up as a false `bank.business_request_conflict` on a hold
   * that had already posted. When entries are missing, read the transaction back
   * by id (the ledger's txById door returns them). A transaction the ledger then
   * cannot show is unavailable, never "different".
   */
  private async withEntries(tx: LedgerTx): Promise<LedgerTx>;
  private async withEntries(tx: LedgerTx | null): Promise<LedgerTx | null>;
  private async withEntries(tx: LedgerTx | null): Promise<LedgerTx | null> {
    if (!tx || tx.entries.length > 0) return tx;
    const full = await this.ledger.getTx(tx.id);
    if (!full) throw new LedgerError('Business transfer receipt is unavailable', 'ledger.unavailable');
    return full;
  }

  /** The posted book is the instruction. A same key with other lines is not a second payment. */
  private async postedPayrollMatches(
    posted: LedgerTx,
    fromAcct: ReturnType<typeof accountForSpace>,
    resolved: ReadonlyArray<{ amount: Amount; acct: ReturnType<typeof accountForSpace> }>,
  ): Promise<boolean> {
    const source = await this.ledger.balance(fromAcct);
    if (!source.accountId) return false;
    let total = 0n;
    for (const line of resolved) total += line.amount;
    const credits = posted.entries.filter((entry) => entry.direction === 'credit');
    const debits = posted.entries.filter((entry) => entry.direction === 'debit');
    const credit = credits[0];
    if (credits.length !== 1 || !credit || credit.accountId !== source.accountId || credit.amount !== total) return false;
    if (debits.length !== resolved.length) return false;
    const paid = new Map<string, Amount>();
    for (const entry of debits) {
      if (paid.has(entry.accountId)) return false;
      paid.set(entry.accountId, entry.amount);
    }
    for (const line of resolved) {
      const dest = await this.ledger.balance(line.acct);
      if (!dest.accountId || paid.get(dest.accountId) !== line.amount) return false;
    }
    return true;
  }

  private assertPayrollSameTerms(
    existing: BusinessPayrollRun,
    input: { accountId: string; fromSpaceId: string; recipients: ReadonlyArray<BusinessPayrollLine> },
  ): void {
    if (existing.accountId !== input.accountId || existing.fromSpaceId !== input.fromSpaceId) {
      throw new BankError(`Payroll ${existing.payrollId} already exists on different terms`, 'bank.business_request_conflict');
    }
    if (existing.recipients.length !== input.recipients.length) {
      throw new BankError(`Payroll ${existing.payrollId} already exists on different terms`, 'bank.business_request_conflict');
    }
    const bySpace = new Map(existing.recipients.map((l) => [l.toSpaceId, l.amount]));
    for (const line of input.recipients) {
      if (bySpace.get(line.toSpaceId) !== line.amount) {
        throw new BankError(`Payroll ${existing.payrollId} already exists on different terms`, 'bank.business_request_conflict');
      }
    }
  }

  private async payrollRunRow(id: string, sql: Sql = this.sql, lock = false): Promise<PayrollRunRow | null> {
    const rows = lock
      ? await sql<PayrollRunRow[]>`
          SELECT id, account_id, actor_user_id, from_space_id, asset_id, ledger_tx_id, created_at
            FROM bank.business_payroll_runs WHERE id = ${id}::uuid
           FOR UPDATE
        `
      : await sql<PayrollRunRow[]>`
          SELECT id, account_id, actor_user_id, from_space_id, asset_id, ledger_tx_id, created_at
            FROM bank.business_payroll_runs WHERE id = ${id}
        `;
    return rows[0] ?? null;
  }

  private async payrollRun(id: string, sql: Sql = this.sql, lock = false): Promise<BusinessPayrollRun | null> {
    const row = await this.payrollRunRow(id, sql, lock);
    if (!row) return null;
    const lines = await sql<PayrollLineRow[]>`
      SELECT payroll_id, to_space_id, amount
        FROM bank.business_payroll_lines WHERE payroll_id = ${id}
       ORDER BY to_space_id ASC
    `;
    return {
      payrollId: row.id,
      accountId: row.account_id,
      actorUserId: row.actor_user_id,
      fromSpaceId: row.from_space_id,
      assetId: row.asset_id,
      ledgerTxId: row.ledger_tx_id,
      recipients: lines.map((l) => ({ toSpaceId: l.to_space_id, amount: parseAmount(l.amount) })),
      createdAt: row.created_at,
    };
  }

  /**
   * CAS claim the pending row, then release the purposed hold.
   * Claim-first so approve cannot settle after reject has already won the row.
   */
  private async claimAndRelease(
    approval: BusinessApproval,
    opts: { actorUserId: string; status: 'rejected' | 'cancelled'; rejectionCode: string },
  ): Promise<void> {
    const claimed = await this.sql<Array<{ id: string }>>`
      UPDATE bank.business_approvals
         SET status = ${opts.status},
             checker_user_id = ${opts.actorUserId},
             rejection_code = ${opts.rejectionCode},
             decided_at = now()
       WHERE id = ${approval.id}::uuid AND status = 'pending'
      RETURNING id
    `;
    if (!claimed[0]) {
      throw new BankError(`Approval ${approval.id} is no longer pending`, 'bank.business_approval_inactive');
    }

    await this.releaseHold(approval);
  }

  /** Finish a durable claim without changing its instruction or ledger key. */
  private async resumeProposal(
    approval: BusinessApproval,
    input: Parameters<BusinessService['proposeTransfer']>[0],
  ): Promise<{ kind: 'posted'; transferId: string; ledgerTxId: string } | { kind: 'pending'; approval: BusinessApproval }> {
    assertSameProposalTerms(approval, input);
    if (approval.status === 'pending' && !approval.holdLedgerTxId) return this.resumeHold(approval, input);
    if (approval.status === 'cancelled' || approval.status === 'rejected') await this.releaseHold(approval);
    if (approval.status !== 'approved' || approval.ledgerTxId || approval.holdLedgerTxId) {
      return decideExistingProposal(approval, input);
    }
    const posted = await this.transfers.transfer({
      transferId: approval.id,
      fromSpaceId: approval.fromSpaceId,
      toSpaceId: approval.toSpaceId,
      amount: approval.amount,
    });
    const receipt = await this.ledger.getTx(posted.ledgerTxId);
    if (!receipt) throw new LedgerError('Business transfer receipt is unavailable', 'ledger.unavailable');
    const from = await this.spaces.get(approval.fromSpaceId);
    const to = await this.spaces.get(approval.toSpaceId);
    if (
      receipt.idempotencyKey !== `bank.transfer:${approval.id}:0` ||
      !(await this.postedPayrollMatches(receipt, accountForSpace(from), [{ amount: approval.amount, acct: accountForSpace(to) }]))
    ) {
      throw new BankError('The ledger transfer differs from the original proposal', 'bank.business_request_conflict');
    }
    const recorded = await this.sql<Array<{ id: string }>>`
      UPDATE bank.business_approvals SET ledger_tx_id = ${posted.ledgerTxId}
       WHERE id = ${approval.id}::uuid AND status = 'approved' AND hold_ledger_tx_id IS NULL
         AND (ledger_tx_id IS NULL OR ledger_tx_id = ${posted.ledgerTxId})
      RETURNING id
    `;
    if (!recorded[0]) throw new BankError('The proposal no longer names this transfer', 'bank.business_request_conflict');
    return { kind: 'posted', transferId: approval.id, ledgerTxId: posted.ledgerTxId };
  }

  private async resumeHold(
    approval: BusinessApproval,
    input: Parameters<BusinessService['proposeTransfer']>[0],
  ): Promise<{ kind: 'posted'; transferId: string; ledgerTxId: string } | { kind: 'pending'; approval: BusinessApproval }> {
    return withMoneySpan(
      'bank.business.proposeHold',
      { operation: 'business-propose-hold', userId: approval.makerUserId, amount: formatAmount(approval.amount) },
      async () => {
        const from = await this.spaces.get(approval.fromSpaceId);
        const request = recipes.businessApprovalHold({ approvalId: approval.id, from: accountForSpace(from), amount: approval.amount });
        // Lost acknowledgements leave the claimed instruction intact. The maker
        // retries this key; checker settlement waits for a recorded receipt.
        const held = await this.withEntries(await this.ledger.post(request));
        const destination = request.entries.find((entry) => entry.direction === 'debit')!;
        if (
          held.idempotencyKey !== request.idempotencyKey ||
          !(await this.postedPayrollMatches(held, accountForSpace(from), [{ amount: approval.amount, acct: destination.account }]))
        ) {
          throw new BankError('The ledger hold differs from the original proposal', 'bank.business_request_conflict');
        }
        const recorded = await this.sql<Array<{ id: string }>>`
          UPDATE bank.business_approvals SET hold_ledger_tx_id = ${held.id}
           WHERE id = ${approval.id}::uuid AND status = 'pending'
             AND (hold_ledger_tx_id IS NULL OR hold_ledger_tx_id = ${held.id})
          RETURNING id
        `;
        const current = await this.approval(approval.id);
        if (!recorded[0]) {
          // Cancellation may win while the hold is in flight. Compensate with
          // the original release key, including after a lost hold acknowledgement.
          if (current.status === 'cancelled' || current.status === 'rejected') await this.releaseHold(current);
          if (current.status !== 'pending') {
            throw new BankError(`Approval ${approval.id} is ${current.status}`, 'bank.business_approval_inactive');
          }
        }
        return decideExistingProposal(current, input);
      },
    );
  }

  /** Reconcile the original settle key; an unknown outcome never releases its hold. */
  private async finishSettle(approval: BusinessApproval): Promise<{ transferId: string; ledgerTxId: string }> {
    const from = await this.spaces.get(approval.fromSpaceId);
    let to: SpaceRecord;
    try {
      to = await this.resolveSettleTarget(approval);
    } catch (refusal) {
      // The recipient became unable to receive AFTER the claim (the pre-claim
      // check in approve() passed). An outage (`_unavailable`) stays recoverable
      // on this row. A definite refusal will not clear, so close the row and
      // return the maker's hold rather than keep it forever.
      if (!(refusal instanceof BankError) || refusal.code !== 'bank.recipient_cannot_receive') throw refusal;
      const closed = await this.sql<Array<{ id: string }>>`
        UPDATE bank.business_approvals
           SET status = 'rejected', rejection_code = ${'bank.recipient_cannot_receive'}, decided_at = now()
         WHERE id = ${approval.id}::uuid AND status = 'approved' AND ledger_tx_id IS NULL
        RETURNING id
      `;
      if (closed[0]) await this.releaseHold(approval);
      throw refusal;
    }
    const request = recipes.businessApprovalSettle({
      approvalId: approval.id,
      from: accountForSpace(from),
      to: accountForSpace(to),
      amount: approval.amount,
    });
    let settled: LedgerTx;
    try {
      settled = await this.ledger.post(request);
    } catch (error) {
      // A lost acknowledgement is not proof of a missing post. A failed lookup
      // or transport error leaves approved/null recoverable on this same key.
      const committed = await this.ledger.getTxByKey(request.idempotencyKey);
      if (committed) {
        settled = committed;
      } else {
        if (!(error instanceof LedgerError) || error.code !== 'ledger.insufficient_funds') throw error;
        const rejected = await this.sql<Array<{ id: string }>>`
          UPDATE bank.business_approvals
             SET status = 'rejected', rejection_code = ${'bank.business_settle_unposted'}, decided_at = now()
           WHERE id = ${approval.id}::uuid AND status = 'approved' AND ledger_tx_id IS NULL
          RETURNING id
        `;
        if (!rejected[0]) {
          const current = await this.approval(approval.id);
          if (current.status === 'approved' && current.ledgerTxId) {
            return { transferId: current.transferId ?? current.id, ledgerTxId: current.ledgerTxId };
          }
          throw error;
        }
        await this.releaseHold(approval);
        throw new BankError('The settle did not post and the hold was released', 'bank.business_rejected');
      }
    }
    await this.sql`
        UPDATE bank.business_approvals
           SET ledger_tx_id = ${settled.id}
         WHERE id = ${approval.id}::uuid
      `;
    return { transferId: approval.id, ledgerTxId: settled.id };
  }

  /** The settle destination, refusing a recipient who cannot receive (unless this settle already posted). */
  private async resolveSettleTarget(approval: BusinessApproval): Promise<SpaceRecord> {
    const from = await this.spaces.get(approval.fromSpaceId);
    return this.spaces.resolveForCredit(approval.toSpaceId, {
      actingUserId: from.userId,
      alreadyBooked: async () => (await this.ledger.getTxByKey(`bank.business.settle:${approval.id}`)) !== null,
    });
  }

  /** Release key is the approval id. A second call does not pay the hold twice. */
  private async releaseHold(approval: BusinessApproval): Promise<void> {
    // An intent can be cancelled before any hold posts. If a late post is still
    // in flight, resumeHold compensates after observing the terminal row.
    if (!approval.holdLedgerTxId && !(await this.ledger.getTxByKey(`bank.business.hold:${approval.id}`))) return;
    const from = await this.spaces.get(approval.fromSpaceId);
    await this.ledger.post(
      recipes.businessApprovalRelease({
        approvalId: approval.id,
        from: accountForSpace(from),
        amount: approval.amount,
      }),
    );
  }

  private requireRequestId(requestId: string): void {
    if (!requestId) throw new BankError('This change needs a caller-stable request id', 'bank.business_request_id_required');
  }

  private directoryError(err: unknown): never {
    if (err instanceof BusinessDirectoryError && err.reason === 'unset') {
      throw new BankError(err.message, 'bank.business_directory_unset');
    }
    const message =
      err instanceof BusinessDirectoryError
        ? err.message
        : 'svc-identity did not answer the business directory (bank.business_directory_unavailable)';
    throw new BankError(message, 'bank.business_directory_unavailable');
  }

  async myRole(accountId: string, userId: string): Promise<BusinessMemberRole> {
    const rows = await this.sql<Array<{ role: string }>>`
      SELECT m.role::text AS role
        FROM bank.business_accounts a
        JOIN bank.business_members m ON m.account_id = a.id AND m.user_id = ${userId}
       WHERE a.id = ${accountId}::uuid
    `;
    const role = rows[0]?.role;
    if (!(BUSINESS_ROLES as readonly string[]).includes(role ?? '')) {
      throw new BankError(`Business account ${accountId} not found`, 'bank.business_not_found');
    }
    return role as BusinessMemberRole;
  }

  /**
   * Operator queue across businesses. Read-only. A missing directory refuses
   * the page; a person with no handle is null, not a user id.
   */
  async operatorApprovals(input: { status: BusinessApprovalStatus; limit: number; cursor?: string }): Promise<{
    approvals: Array<{
      businessId: string;
      amount: string;
      assetId: string;
      ageSeconds: number;
      makerHandle: string | null;
      makerHandleReason: 'handle_unresolved' | null;
      rule: string;
    }>;
    nextCursor: string | null;
  }> {
    const cursor = input.cursor ? decodeOperatorCursor(input.cursor) : null;
    const stamp = cursor?.at ?? null;
    const stampId = cursor?.id ?? null;
    const rows = await this.sql<Array<ApprovalRow & { spend_threshold: string; at_key: string }>>`
      SELECT a.id, a.account_id, a.maker_user_id, a.checker_user_id, a.from_space_id, a.to_space_id,
             a.asset_id, a.amount::text AS amount, a.status, a.transfer_id, a.hold_ledger_tx_id, a.ledger_tx_id,
             a.rejection_code, a.created_at, a.decided_at, b.spend_threshold::text AS spend_threshold,
             to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS at_key
        FROM bank.business_approvals a
        JOIN bank.business_accounts b ON b.id = a.account_id
       WHERE a.status::text = ${input.status}
         AND (
           ${stamp}::text IS NULL
           OR to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') > ${stamp}
           OR (
             to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') = ${stamp}
             AND a.id > ${stampId}::uuid
           )
         )
       ORDER BY a.created_at ASC, a.id ASC
       LIMIT ${input.limit}
    `;
    const parties = await this.partiesFor(rows.map((row) => row.maker_user_id));
    const now = Date.now();
    const approvals = rows.map((row) => {
      const party = parties.get(row.maker_user_id);
      return {
        businessId: row.account_id,
        amount: formatAmount(parseAmount(row.amount)),
        assetId: row.asset_id,
        ageSeconds: Math.max(0, Math.floor((now - row.created_at.getTime()) / 1000)),
        makerHandle: party?.handle ?? null,
        makerHandleReason: party?.handleReason ?? 'handle_unresolved',
        rule: formatAmount(parseAmount(row.spend_threshold)),
      };
    });
    const last = rows.at(-1);
    return {
      approvals,
      nextCursor: last && rows.length === input.limit ? encodeOperatorCursor(last.at_key, last.id) : null,
    };
  }

  private async withParties(rows: readonly ApprovalRow[]): Promise<BusinessPendingView[]> {
    const owners = await this.spaceOwners(rows.map((row) => row.to_space_id));
    const parties = await this.partiesFor([...rows.map((row) => row.maker_user_id), ...owners.values()]);
    const missing: BusinessPartyView = { handle: null, handleReason: 'handle_unresolved', displayName: null };
    return rows.map((row) => {
      const approval = toApproval(row);
      const maker = parties.get(approval.makerUserId) ?? missing;
      const ownerId = owners.get(approval.toSpaceId);
      const receiver = ownerId ? (parties.get(ownerId) ?? missing) : missing;
      return {
        id: approval.id,
        accountId: approval.accountId,
        makerHandle: maker.handle,
        makerHandleReason: maker.handleReason,
        receiverOwnerHandle: receiver.handle,
        receiverOwnerHandleReason: receiver.handleReason,
        receiverOwnerName: receiver.displayName,
        fromSpaceId: approval.fromSpaceId,
        toSpaceId: approval.toSpaceId,
        assetId: approval.assetId,
        amount: approval.amount,
        status: approval.status,
        transferId: approval.transferId,
        holdLedgerTxId: approval.holdLedgerTxId,
        ledgerTxId: approval.ledgerTxId,
        createdAt: approval.createdAt,
      };
    });
  }

  private async spaceOwners(spaceIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(spaceIds)];
    if (ids.length === 0) return new Map();
    const rows = await this.sql<Array<{ id: string; user_id: string }>>`
      SELECT id, user_id FROM bank.spaces WHERE id IN ${this.sql(ids)}
    `;
    return new Map(rows.map((row) => [row.id, row.user_id]));
  }

  private async partiesFor(userIds: readonly string[]): Promise<Map<string, BusinessPartyView>> {
    const unique = [...new Set(userIds.filter((id) => id.trim() !== ''))];
    let handles: ReadonlyMap<string, string>;
    let names: ReadonlyMap<string, string>;
    try {
      handles = await this.directory.handlesOf(unique);
      names = await this.directory.publishedNames(unique);
    } catch (err) {
      this.directoryError(err);
    }
    const out = new Map<string, BusinessPartyView>();
    for (const id of unique) {
      const handle = handles.get(id) ?? null;
      out.set(id, {
        handle,
        handleReason: handle ? null : 'handle_unresolved',
        displayName: handle ? (names.get(id) ?? null) : null,
      });
    }
    return out;
  }

  /** Every id must have a public handle. A gap refuses the page rather than showing a raw id. */
  private async handlesFor(userIds: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds.filter((id) => id.trim() !== ''))];
    let found: ReadonlyMap<string, string>;
    try {
      found = await this.directory.handlesOf(unique);
    } catch (err) {
      this.directoryError(err);
    }
    for (const id of unique) {
      if (!found.get(id)) {
        throw new BankError(
          'A person on this account has no public handle in the identity directory, so this list is not shown (bank.business_directory_incomplete)',
          'bank.business_directory_incomplete',
        );
      }
    }
    return new Map(unique.map((id) => [id, found.get(id)!]));
  }

  private async lockMembers(sql: Sql, accountId: string): Promise<MemberRow[]> {
    return sql<MemberRow[]>`
      SELECT account_id, user_id, role FROM bank.business_members
       WHERE account_id = ${accountId}
       FOR UPDATE
    `;
  }

  private assertAdminLocked(members: readonly MemberRow[], actorUserId: string): void {
    const actor = members.find((row) => row.user_id === actorUserId);
    if (!actor) throw new BankError('Not a member of this business account', 'bank.business_not_member');
    if (!roleCan(actor.role, 'manage_team')) {
      throw new BankError(
        `Role ${actor.role} cannot perform this action (need ${rolesWith('manage_team').join('|')})`,
        'bank.business_role_forbidden',
      );
    }
  }

  private async memberCommand(sql: Sql, id: string, lock: boolean): Promise<MemberCommandRow | null> {
    const rows = lock
      ? await sql<MemberCommandRow[]>`
          SELECT id, account_id, actor_user_id, target_user_id, action, role
            FROM bank.business_member_commands WHERE id = ${id}::uuid
           FOR UPDATE
        `
      : await sql<MemberCommandRow[]>`
          SELECT id, account_id, actor_user_id, target_user_id, action, role
            FROM bank.business_member_commands WHERE id = ${id}::uuid
        `;
    return rows[0] ?? null;
  }

  private assertCommandTerms(
    existing: MemberCommandRow,
    input: {
      accountId: string;
      actorUserId: string;
      userId: string;
      requestId: string;
      action: 'remove' | 'set_role';
      role: BusinessMemberRole | null;
    },
  ): void {
    if (
      existing.account_id !== input.accountId ||
      existing.actor_user_id !== input.actorUserId ||
      existing.target_user_id !== input.userId ||
      existing.action !== input.action ||
      existing.role !== input.role
    ) {
      throw new BankError(
        `Request ${input.requestId} already exists on different terms — a retry must carry the same instruction`,
        'bank.business_request_conflict',
      );
    }
  }

  private async control(
    accountId: string,
    actorUserId: string,
    change: { requestId: string; kind: 'set_threshold' | 'close'; spendThreshold: Amount | null },
  ): Promise<BusinessControlResult & { status: 'pending' | 'applied' }> {
    await this.assertRole(accountId, actorUserId, 'manage_team');
    const account = await this.account(accountId);
    return transaction(this.sql, async (tx) => {
      const existing = await this.controlRow(tx, change.requestId, true);
      if (existing) {
        this.assertControlTerms(existing, accountId, change);
        if (existing.status === 'cancelled') {
          throw new BankError(
            `Request ${change.requestId} was withdrawn (bank.business_approval_inactive)`,
            'bank.business_approval_inactive',
          );
        }
        if (existing.status === 'applied')
          return { status: 'applied', requestId: change.requestId, account: await this.accountIn(tx, accountId) };
        if (existing.proposed_by === actorUserId) {
          return { status: 'pending', requestId: change.requestId, account };
        }
        this.assertAdminLocked(await this.lockMembers(tx, accountId), actorUserId);
        await this.assertNoPendingPayment(tx, accountId, change.kind);
        await this.applyControl(tx, accountId, actorUserId, change);
        return { status: 'applied', requestId: change.requestId, account: await this.accountIn(tx, accountId) };
      }
      if (account.status !== 'active') throw new BankError('Business account is closed', 'bank.business_closed');
      await this.assertNoPendingPayment(tx, accountId, change.kind);
      const pending = await tx<Array<{ id: string }>>`
        SELECT id FROM bank.business_control_requests
         WHERE account_id = ${accountId}::uuid AND kind = ${change.kind} AND status = 'pending'
         FOR UPDATE
      `;
      if (pending[0]) {
        throw new BankError(
          'A change of this kind is already waiting for a second administrator (bank.business_change_pending)',
          'bank.business_change_pending',
        );
      }
      const threshold = change.spendThreshold === null ? null : formatAmount(change.spendThreshold);
      try {
        await tx`
          INSERT INTO bank.business_control_requests
            (id, account_id, kind, spend_threshold, proposed_by, status)
          VALUES (
            ${change.requestId}::uuid, ${accountId}::uuid, ${change.kind},
            ${threshold}::numeric, ${actorUserId}, 'pending'
          )
        `;
      } catch (err) {
        const name = uniqueViolationName(err);
        if (name === 'business_control_one_pending') {
          throw new BankError(
            'A change of this kind is already waiting for a second administrator (bank.business_change_pending)',
            'bank.business_change_pending',
          );
        }
        if (name !== null) {
          const raced = await this.controlRow(tx, change.requestId, true);
          if (!raced) throw err;
          this.assertControlTerms(raced, accountId, change);
          if (raced.status === 'cancelled') {
            throw new BankError(
              `Request ${change.requestId} was withdrawn (bank.business_approval_inactive)`,
              'bank.business_approval_inactive',
            );
          }
          return { status: raced.status, requestId: change.requestId, account };
        }
        throw err;
      }
      return { status: 'pending', requestId: change.requestId, account };
    });
  }

  private async assertNoPendingPayment(sql: Sql, accountId: string, kind: 'set_threshold' | 'close'): Promise<void> {
    if (kind !== 'close') return;
    const waiting = await sql<Array<{ id: string }>>`
      SELECT id FROM bank.business_approvals
       WHERE account_id = ${accountId}::uuid AND status = 'pending'
       LIMIT 1
    `;
    if (waiting[0]) {
      throw new BankError(
        'Payments are still waiting for a decision. Decide those before closing the account (bank.business_close_blocked)',
        'bank.business_close_blocked',
      );
    }
  }

  private async applyControl(
    sql: Sql,
    accountId: string,
    actorUserId: string,
    change: { requestId: string; kind: 'set_threshold' | 'close'; spendThreshold: Amount | null },
  ): Promise<void> {
    if (change.kind === 'set_threshold' && change.spendThreshold !== null) {
      const updated = await sql<Array<{ id: string }>>`
        UPDATE bank.business_accounts
           SET spend_threshold = ${formatAmount(change.spendThreshold)}::numeric, updated_at = now()
         WHERE id = ${accountId}::uuid AND status = 'active'
        RETURNING id
      `;
      if (!updated[0]) throw new BankError('Business account is closed', 'bank.business_closed');
    } else {
      const updated = await sql<Array<{ id: string }>>`
        UPDATE bank.business_accounts
           SET status = 'closed', updated_at = now()
         WHERE id = ${accountId}::uuid AND status = 'active'
        RETURNING id
      `;
      if (!updated[0]) throw new BankError('Business account is closed', 'bank.business_closed');
    }
    const recorded = await sql<Array<{ id: string }>>`
      UPDATE bank.business_control_requests
         SET status = 'applied', confirmed_by = ${actorUserId}, decided_at = now()
       WHERE id = ${change.requestId}::uuid AND status = 'pending'
      RETURNING id
    `;
    if (!recorded[0]) throw new BankError('The change is no longer waiting', 'bank.business_approval_inactive');
  }

  private async controlRow(sql: Sql, id: string, lock: boolean): Promise<ControlRow | null> {
    const rows = lock
      ? await sql<ControlRow[]>`
          SELECT id, account_id, kind, spend_threshold, proposed_by, confirmed_by, status, created_at, decided_at
            FROM bank.business_control_requests WHERE id = ${id}::uuid
           FOR UPDATE
        `
      : await sql<ControlRow[]>`
          SELECT id, account_id, kind, spend_threshold, proposed_by, confirmed_by, status, created_at, decided_at
            FROM bank.business_control_requests WHERE id = ${id}::uuid
        `;
    return rows[0] ?? null;
  }

  private assertControlTerms(
    existing: ControlRow,
    accountId: string,
    change: { requestId: string; kind: 'set_threshold' | 'close'; spendThreshold: Amount | null },
  ): void {
    const stored = existing.spend_threshold === null ? null : parseAmount(existing.spend_threshold);
    if (existing.account_id !== accountId || existing.kind !== change.kind || stored !== change.spendThreshold) {
      throw new BankError(
        `Request ${change.requestId} already exists on different terms — a retry must carry the same instruction`,
        'bank.business_request_conflict',
      );
    }
  }

  private async accountIn(sql: Sql, id: string): Promise<BusinessAccount> {
    const rows = await sql<AccountRow[]>`
      SELECT id, name, asset_id, spend_threshold, status, created_at
        FROM bank.business_accounts WHERE id = ${id}
    `;
    if (!rows[0]) throw new BankError(`Business account ${id} not found`, 'bank.business_not_found');
    return toAccount(rows[0]);
  }

  private async account(id: string): Promise<BusinessAccount> {
    const rows = await this.sql<AccountRow[]>`
      SELECT id, name, asset_id, spend_threshold, status, created_at
        FROM bank.business_accounts WHERE id = ${id}
    `;
    if (!rows[0]) throw new BankError(`Business account ${id} not found`, 'bank.business_not_found');
    return toAccount(rows[0]);
  }

  private async approvalExists(id: string): Promise<boolean> {
    const rows = await this.sql<Array<{ id: string }>>`SELECT id FROM bank.business_approvals WHERE id = ${id}::uuid`;
    return rows.length > 0;
  }

  private async approval(id: string): Promise<BusinessApproval> {
    const rows = await this.sql<ApprovalRow[]>`
      SELECT id, account_id, maker_user_id, checker_user_id, from_space_id, to_space_id,
             asset_id, amount, status, transfer_id, hold_ledger_tx_id, ledger_tx_id, rejection_code,
             created_at, decided_at
        FROM bank.business_approvals WHERE id = ${id}
    `;
    if (!rows[0]) throw new BankError(`Approval ${id} not found`, 'bank.business_approval_not_found');
    return toApproval(rows[0]);
  }

  private async assertMember(accountId: string, userId: string): Promise<BusinessMember> {
    const rows = await this.sql<MemberRow[]>`
      SELECT account_id, user_id, role FROM bank.business_members
       WHERE account_id = ${accountId} AND user_id = ${userId}
    `;
    if (!rows[0]) throw new BankError('Not a member of this business account', 'bank.business_not_member');
    return toMember(rows[0]);
  }

  /** The caller must hold `capability` now. A removed member is no longer a member, so holds none. */
  private async assertRole(accountId: string, userId: string, capability: BusinessCapability): Promise<void> {
    const member = await this.assertMember(accountId, userId);
    if (!roleCan(member.role, capability)) {
      throw new BankError(
        `Role ${member.role} cannot perform this action (need ${rolesWith(capability).join('|')})`,
        'bank.business_role_forbidden',
      );
    }
  }
}
