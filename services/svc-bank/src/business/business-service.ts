import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  InsufficientFundsError,
  formatAmount,
  parseAmount,
  recipes,
  type Amount,
  type LedgerClient,
  type LedgerTx,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { assertBusinessListLimit, assertBusinessPendingListLimit } from '../owner-list-limit.js';
import { accountForSpace, type SpaceService } from '../spaces/space-service.js';
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

export type BusinessMemberRole = 'admin' | 'maker' | 'checker';
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
 * One decision for a client id that already has a row: the opening lookup and
 * the insert that loses ON CONFLICT DO NOTHING. Different terms conflict.
 * Pending retries. An approved row with a ledger tx is the original post.
 * Anything else is inactive.
 */
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
  if (existing.status === 'pending') return { kind: 'pending', approval: existing };
  if (existing.status === 'approved' && existing.ledgerTxId) {
    return { kind: 'posted', transferId: existing.transferId ?? existing.id, ledgerTxId: existing.ledgerTxId };
  }
  throw new BankError(`Approval ${existing.id} is ${existing.status}`, 'bank.business_approval_inactive');
}

export class BusinessService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly spaces: SpaceService,
    private readonly transfers: TransferService,
  ) {}

  async createAccount(input: { name: string; assetId: string; spendThreshold: Amount; creatorUserId: string }): Promise<BusinessAccount> {
    if (input.spendThreshold <= 0n) {
      throw new BankError('Business spend threshold must be positive', 'bank.business_invalid_threshold');
    }
    const name = input.name.trim();
    if (!name) throw new BankError('Business account needs a name', 'bank.business_invalid_name');

    const rows = await this.sql<AccountRow[]>`
      INSERT INTO bank.business_accounts (name, asset_id, spend_threshold, status)
      VALUES (${name}, ${input.assetId}, ${formatAmount(input.spendThreshold)}::numeric, 'active')
      RETURNING id, name, asset_id, spend_threshold, status, created_at
    `;
    const account = toAccount(rows[0]!);
    await this.sql`
      INSERT INTO bank.business_members (account_id, user_id, role)
      VALUES (${account.id}::uuid, ${input.creatorUserId}, 'admin')
    `;
    await this.spaces.ensurePrimary(input.creatorUserId, input.assetId);
    return account;
  }

  async addMember(input: { accountId: string; actorUserId: string; userId: string; role: BusinessMemberRole }): Promise<BusinessMember> {
    await this.assertRole(input.accountId, input.actorUserId, ['admin']);
    const rows = await this.sql<MemberRow[]>`
      INSERT INTO bank.business_members (account_id, user_id, role)
      VALUES (${input.accountId}::uuid, ${input.userId}, ${input.role})
      ON CONFLICT (account_id, user_id) DO UPDATE SET role = EXCLUDED.role
      RETURNING account_id, user_id, role
    `;
    return toMember(rows[0]!);
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
       WHERE m.user_id = ${userId} AND a.status = 'active'
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
    await this.assertRole(input.accountId, input.makerUserId, ['admin', 'maker']);

    const now = new Date();
    const from = await this.spaces.resolveForDebit(input.fromSpaceId, now);
    const to = await this.spaces.resolveForCredit(input.toSpaceId);
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
    if (existingRows[0]) return decideExistingProposal(toApproval(existingRows[0]), input);

    if (input.amount < account.spendThreshold) {
      const posted = await this.transfers.transfer({
        transferId: clientId,
        fromSpaceId: input.fromSpaceId,
        toSpaceId: input.toSpaceId,
        amount: input.amount,
      });
      // Record the client id on the same row the lookup above already reads.
      // Status is approved and ledger_tx_id is the transfer that just posted, so
      // a later call sees the instruction: different terms conflict, the same
      // terms return this post, and a checker cannot settle a second time.
      await this.sql`
        INSERT INTO bank.business_approvals
          (id, account_id, maker_user_id, from_space_id, to_space_id, asset_id, amount, status, transfer_id, ledger_tx_id, decided_at)
        VALUES (
          ${clientId}::uuid, ${input.accountId}::uuid, ${input.makerUserId},
          ${input.fromSpaceId}::uuid, ${input.toSpaceId}::uuid,
          ${account.assetId}, ${formatAmount(input.amount)}::numeric, 'approved',
          ${posted.transferId}, ${posted.ledgerTxId}, now()
        )
      `;
      return { kind: 'posted', transferId: posted.transferId, ledgerTxId: posted.ledgerTxId };
    }

    // Over threshold: hold funds first so concurrent spend cannot empty the pot,
    // then record the pending approval. Hold key is approval id (idempotent).
    const approvalId = clientId;
    const fromAcct = accountForSpace(from);

    return withMoneySpan(
      'bank.business.proposeHold',
      { operation: 'business-propose-hold', userId: input.makerUserId, amount: formatAmount(input.amount) },
      async () => {
        let holdTxId: string;
        try {
          const held = await this.ledger.post(
            recipes.businessApprovalHold({
              approvalId,
              from: fromAcct,
              amount: input.amount,
            }),
          );
          holdTxId = held.id;
        } catch (err) {
          // Router maps InsufficientFundsError to ledger.insufficient_funds.
          if (err instanceof InsufficientFundsError) throw err;
          throw err;
        }

        const rows = await this.sql<ApprovalRow[]>`
          INSERT INTO bank.business_approvals
            (id, account_id, maker_user_id, from_space_id, to_space_id, asset_id, amount, status, hold_ledger_tx_id)
          VALUES (
            ${approvalId}::uuid, ${input.accountId}::uuid, ${input.makerUserId},
            ${input.fromSpaceId}::uuid, ${input.toSpaceId}::uuid,
            ${account.assetId}, ${formatAmount(input.amount)}::numeric, 'pending', ${holdTxId}
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING id, account_id, maker_user_id, checker_user_id, from_space_id, to_space_id,
                    asset_id, amount, status, transfer_id, hold_ledger_tx_id, ledger_tx_id,
                    rejection_code, created_at, decided_at
        `;
        if (rows[0]) return { kind: 'pending' as const, approval: toApproval(rows[0]) };
        const raced = await this.sql<ApprovalRow[]>`
          SELECT id, account_id, maker_user_id, checker_user_id, from_space_id, to_space_id,
                 asset_id, amount, status, transfer_id, hold_ledger_tx_id, ledger_tx_id,
                 rejection_code, created_at, decided_at
            FROM bank.business_approvals WHERE id = ${approvalId}::uuid
        `;
        return decideExistingProposal(toApproval(raced[0]!), input);
      },
    );
  }

  async approve(input: { approvalId: string; checkerUserId: string }): Promise<{ transferId: string; ledgerTxId: string }> {
    return withMoneySpan('bank.business.approve', { operation: 'business-approve', userId: input.checkerUserId }, async () => {
      const approval = await this.approval(input.approvalId);
      if (approval.status === 'approved' && approval.ledgerTxId) {
        // Re-drive: settle key is approval id; row already closed.
        return { transferId: approval.transferId ?? approval.id, ledgerTxId: approval.ledgerTxId };
      }
      if (approval.status === 'approved') {
        // The row was claimed and the settle post did not land. The settle
        // key is the approval id, so this retry posts once.
        if (approval.makerUserId === input.checkerUserId) {
          throw new BankError('Maker cannot approve their own transfer', 'bank.business_self_approve');
        }
        await this.assertRole(approval.accountId, input.checkerUserId, ['admin', 'checker']);
        return this.finishSettle(approval);
      }
      if (approval.status !== 'pending') {
        throw new BankError(`Approval ${approval.id} is ${approval.status}`, 'bank.business_approval_inactive');
      }
      if (approval.makerUserId === input.checkerUserId) {
        throw new BankError('Maker cannot approve their own transfer', 'bank.business_self_approve');
      }
      await this.assertRole(approval.accountId, input.checkerUserId, ['admin', 'checker']);

      // Claim pending first so concurrent reject/cancel cannot also release the hold.
      const claimed = await this.sql<ApprovalRow[]>`
          UPDATE bank.business_approvals
             SET status = 'approved',
                 checker_user_id = ${input.checkerUserId},
                 transfer_id = ${approval.id},
                 decided_at = now()
           WHERE id = ${approval.id}::uuid AND status = 'pending'
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
      if (approval.makerUserId === input.checkerUserId) {
        throw new BankError('Maker cannot reject their own transfer as checker', 'bank.business_self_approve');
      }
      await this.assertRole(approval.accountId, input.checkerUserId, ['admin', 'checker']);
      await this.releaseHold(approval);
      return;
    }
    if (approval.status !== 'pending') {
      throw new BankError(`Approval ${approval.id} is ${approval.status}`, 'bank.business_approval_inactive');
    }
    if (approval.makerUserId === input.checkerUserId) {
      throw new BankError('Maker cannot reject their own transfer as checker', 'bank.business_self_approve');
    }
    await this.assertRole(approval.accountId, input.checkerUserId, ['admin', 'checker']);
    await this.claimAndRelease(approval, {
      actorUserId: input.checkerUserId,
      status: 'rejected',
      rejectionCode: 'bank.business_rejected',
    });
  }

  /**
   * Maker cancels their pending proposal, or an admin cancels any pending one.
   * Hold returns to the debit pot.
   */
  async cancel(input: { approvalId: string; actorUserId: string }): Promise<void> {
    const approval = await this.approval(input.approvalId);
    if (approval.status === 'cancelled' || approval.status === 'rejected') {
      if (approval.makerUserId === input.actorUserId) {
        await this.assertMember(approval.accountId, input.actorUserId);
      } else {
        await this.assertRole(approval.accountId, input.actorUserId, ['admin']);
      }
      await this.releaseHold(approval);
      return;
    }
    if (approval.status !== 'pending') {
      throw new BankError(`Approval ${approval.id} is ${approval.status}`, 'bank.business_approval_inactive');
    }
    if (approval.makerUserId === input.actorUserId) {
      await this.assertMember(approval.accountId, input.actorUserId);
    } else {
      await this.assertRole(approval.accountId, input.actorUserId, ['admin']);
    }
    await this.claimAndRelease(approval, {
      actorUserId: input.actorUserId,
      status: 'cancelled',
      rejectionCode: 'bank.business_cancelled',
    });
  }

  async listPending(accountId: string, actorUserId: string, limit?: number): Promise<BusinessApproval[]> {
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
    return rows.map(toApproval);
  }

  /**
   * Multi-recipient payroll: one ledger post, all paid or none.
   *
   * Same-asset only. A mix would invent an FX/withholding rate — refused as
   * `bank.business_payroll_rate_unset`. Amounts are caller-supplied instruction
   * strings (parsed upstream); this door never computes a salary table.
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
    await this.assertRole(input.accountId, input.actorUserId, ['admin', 'maker']);

    const existing = await this.payrollRun(input.payrollId);
    if (existing) {
      this.assertPayrollVisibleTerms(existing, input);
      if (existing.recipients.length === input.recipients.length) {
        this.assertPayrollSameTerms(existing, input);
        return existing;
      }
    }

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
      const to = await this.spaces.resolveForCredit(line.toSpaceId);
      if (to.assetId !== from.assetId) {
        throw new BankError(
          `Payroll cannot mix ${from.assetId} and ${to.assetId} — rates are not invented here`,
          'bank.business_payroll_rate_unset',
        );
      }
      resolved.push({ toSpaceId: line.toSpaceId, amount: line.amount, acct: accountForSpace(to) });
    }

    if (existing) {
      const recordedTx = await this.ledger.getTx(existing.ledgerTxId);
      if (!recordedTx || !(await this.postedPayrollMatches(recordedTx, accountForSpace(from), resolved))) {
        throw new BankError(
          `Payroll ${input.payrollId} already exists on different terms`,
          'bank.business_request_conflict',
        );
      }
      return transaction(this.sql, async (tx) => {
        const locked = await this.payrollRun(input.payrollId, tx, true);
        if (!locked) {
          throw new BankError(`Payroll ${input.payrollId} could not be recorded`, 'bank.business_request_conflict');
        }
        return this.completePayrollLines(tx, locked, input);
      });
    }

    return withMoneySpan(
      'bank.business.payroll',
      { operation: 'business-payroll', userId: input.actorUserId, amount: formatAmount(resolved.reduce((acc, l) => acc + l.amount, 0n)) },
      async () => {
        let posted;
        try {
          posted = await this.ledger.post(
            recipes.businessPayroll({
              payrollId: input.payrollId,
              from: accountForSpace(from),
              recipients: resolved.map((line) => ({ to: line.acct, amount: line.amount })),
            }),
          );
        } catch (err) {
          if (err instanceof InsufficientFundsError) throw err;
          throw err;
        }

        if (!(await this.postedPayrollMatches(posted, accountForSpace(from), resolved))) {
          throw new BankError(
            `Payroll ${input.payrollId} already exists on different terms`,
            'bank.business_request_conflict',
          );
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
          if (!locked) {
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

  /** Settle key is the approval id. A second call returns the posted tx. */
  private async finishSettle(approval: BusinessApproval): Promise<{ transferId: string; ledgerTxId: string }> {
    const from = await this.spaces.get(approval.fromSpaceId);
    const to = await this.spaces.resolveForCredit(approval.toSpaceId);
    const settled = await this.ledger.post(
      recipes.businessApprovalSettle({
        approvalId: approval.id,
        from: accountForSpace(from),
        to: accountForSpace(to),
        amount: approval.amount,
      }),
    );
    await this.sql`
        UPDATE bank.business_approvals
           SET ledger_tx_id = ${settled.id}
         WHERE id = ${approval.id}::uuid
      `;
    return { transferId: approval.id, ledgerTxId: settled.id };
  }

  /** Release key is the approval id. A second call does not pay the hold twice. */
  private async releaseHold(approval: BusinessApproval): Promise<void> {
    const from = await this.spaces.get(approval.fromSpaceId);
    await this.ledger.post(
      recipes.businessApprovalRelease({
        approvalId: approval.id,
        from: accountForSpace(from),
        amount: approval.amount,
      }),
    );
  }

  private async account(id: string): Promise<BusinessAccount> {
    const rows = await this.sql<AccountRow[]>`
      SELECT id, name, asset_id, spend_threshold, status, created_at
        FROM bank.business_accounts WHERE id = ${id}
    `;
    if (!rows[0]) throw new BankError(`Business account ${id} not found`, 'bank.business_not_found');
    return toAccount(rows[0]);
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

  private async assertRole(accountId: string, userId: string, allowed: BusinessMemberRole[]): Promise<void> {
    const member = await this.assertMember(accountId, userId);
    if (!allowed.includes(member.role)) {
      throw new BankError(`Role ${member.role} cannot perform this action (need ${allowed.join('|')})`, 'bank.business_role_forbidden');
    }
  }
}
