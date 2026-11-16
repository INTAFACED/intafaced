import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import {
  assertPostingEnabled,
  NO_PARTNER_BANK_CODE,
  partnerPayoutsAccount,
  type NoteRefusal,
  type PartnerBank,
  type PostingFreeze,
} from '../partner/partner-bank.js';
import { businessPartnerAccount, pickRule, type BusinessPermission, type BusinessTeamService, type TeamRule } from './business-team.js';

/**
 * A BUSINESS PAYS ITS SUPPLIERS' BILLS (J-bank-20; BK-bill-01 to BK-bill-03).
 *
 * The business's money is the partner bank's (OWNER 226; docs/adr/2026-11-10-launch-money-model.md), in its own account
 * at the partner, `business:<account id>`. INTAFACED's ledger posts nothing for any of this.
 *
 *   inbox       A bill is uploaded into the business's inbox under its own id, the intake's business key: the same upload
 *               sent again is the same bill. The bill reader (`BANK_BILL_READER`) fills what it read, labelled; with no
 *               reader set every field is typed by hand. Whatever was read, a person reviews it before it goes anywhere.
 *   duplicates  A bill with the same file, the same vendor and reference, or the same amount and due date as one already
 *               received is flagged "may be a duplicate of" that one. It goes nowhere until someone who manages the team
 *               clears the flag (`bank.bill_duplicate_uncleared`).
 *   approval    A bill from a pre-approved vendor at or under its cap is approved at once. Any other bill goes to
 *               approvers: the business's approval rules (J-bank-19) say how many, and never fewer than one; the person who
 *               sent it never approves it, and approvers are distinct.
 *   limits      The business's own Bill Pay limits, per payment, per day and per month. A blank limit is not set, never
 *               unlimited: every payment refuses `bank.bill_limit_unset` until all three are set.
 *   paying      One instruction to the partner per attempt, `bank.business.bill-pay:<bill id>:<attempt>`, stored before it
 *               is sent and sent once; a lost answer is read back by its key, never sent again blind. A category or a split
 *               is our record beside that one payment, adding up to it exactly.
 *   scheduled   A payment for a later date waits, and is cancelled until it is sent: a cancelled one never reaches the
 *               partner, and the bill is approved again.
 *   declined    The partner refused it: nothing moved, and the bill is back in the inbox with the partner's reason.
 *   returned    The partner reports the payee's bank sent it back: the amount is given back to the business's account
 *               once, under `bank.business.bill-return:<payment id>`, and the bill is back in the inbox with the reason.
 */

export const BANK_BILL_READER_ENV = 'BANK_BILL_READER';
/** The only bill reader there is: a TEST stand-in that reads a TEST bill's labelled lines. No engine is chosen. */
export const TEST_BILL_READER = 'test-lines';
export const BILL_READER_LABEL = 'Preview · sample data';

export const BILL_STATUSES = ['inbox', 'awaiting_approval', 'approved', 'scheduled', 'paying', 'paid'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];
export const BILL_PAYMENT_STATUSES = ['scheduled', 'sending', 'sent', 'cancelled', 'declined', 'returned'] as const;
export type BillPaymentStatus = (typeof BILL_PAYMENT_STATUSES)[number];

/** Why a payee's bank sent a payment back, as the partner reports it. */
export const BILL_RETURN_REASONS = ['account_closed', 'account_not_found', 'name_mismatch', 'refused_by_payee_bank'] as const;
export type BillReturnReason = (typeof BILL_RETURN_REASONS)[number];
const RETURN_WORDS: Record<BillReturnReason, string> = {
  account_closed: 'The payee’s bank account is closed.',
  account_not_found: 'The payee’s bank has no account with these details.',
  name_mismatch: 'The payee’s name does not match the account.',
  refused_by_payee_bank: 'The payee’s bank refused the payment.',
};

/** The largest bill file kept: 1 MiB. */
export const MAX_BILL_BYTES = 1_048_576;
export const MAX_SPLIT_LINES = 10;

export const billPayKey = (billId: string, attempt: number): string => `bank.business.bill-pay:${billId}:${attempt}`;
export const billReturnKey = (paymentId: string): string => `bank.business.bill-return:${paymentId}`;

/** `test-lines`, or null while no reader is set. */
export function parseBillReader(raw: string | undefined): typeof TEST_BILL_READER | null {
  return raw?.trim() === TEST_BILL_READER ? TEST_BILL_READER : null;
}

export interface BillExtraction {
  reader: string;
  label: string;
  vendor: string | null;
  reference: string | null;
  amount: string | null;
  dueDate: string | null;
}

/**
 * The TEST reader: a TEST bill is plain text with labelled lines (`Vendor: …`, `Reference: …`, `Amount: 150.00`,
 * `Due: 2026-12-01`). What it cannot read is null. It never guesses.
 */
export function readTestBill(file: Uint8Array): BillExtraction {
  const text = Buffer.from(file).toString('utf8');
  const field = (name: string): string | null => {
    const m = new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, 'im').exec(text);
    return m ? m[1]! : null;
  };
  const vendor = field('Vendor');
  const reference = field('Reference');
  const amount = field('Amount');
  const due = field('Due');
  return {
    reader: TEST_BILL_READER,
    label: BILL_READER_LABEL,
    vendor: vendor && vendor.length <= 128 ? vendor : null,
    reference: reference && reference.length <= 64 ? reference : null,
    amount: amount && /^\d{1,18}(\.\d{1,18})?$/.test(amount) && parseAmount(amount) > 0n ? formatAmount(parseAmount(amount)) : null,
    dueDate: due && isDate(due) ? due : null,
  };
}

function isDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const d = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw;
}

interface BillRow {
  id: string;
  account_id: string;
  created_by: string;
  file_name: string;
  content_type: string;
  file_sha256: string;
  file_size: number;
  extracted: BillExtraction | null;
  vendor: string | null;
  reference: string | null;
  amount: string | null;
  due_date: string | null;
  status: BillStatus;
  round: number;
  approvals_needed: number;
  rule_id: string | null;
  preapproved: boolean;
  submitted_by: string | null;
  submitted_at: Date | null;
  duplicate_of: string | null;
  duplicate_cleared_by: string | null;
  duplicate_cleared_at: Date | null;
  back_reason: string | null;
  back_reason_text: string | null;
  created_at: Date;
}

interface PaymentRow {
  id: string;
  bill_id: string;
  account_id: string;
  attempt: number;
  made_by: string;
  asset_id: string;
  amount: string;
  scheduled_for: string | null;
  status: BillPaymentStatus;
  partner_key: string;
  partner_move_id: string | null;
  partner_reason: string | null;
  partner_reason_text: string | null;
  return_key: string;
  return_move_id: string | null;
  created_at: Date;
  sent_at: Date | null;
  cancelled_at: Date | null;
  answered_at: Date | null;
}

const BILL_COLUMNS = `id, account_id, created_by, file_name, content_type, file_sha256, file_size, extracted, vendor, reference, amount,
  due_date::text AS due_date, status, round, approvals_needed, rule_id, preapproved, submitted_by, submitted_at, duplicate_of,
  duplicate_cleared_by, duplicate_cleared_at, back_reason, back_reason_text, created_at`;
const PAYMENT_COLUMNS = `id, bill_id, account_id, attempt, made_by, asset_id, amount, scheduled_for::text AS scheduled_for, status,
  partner_key, partner_move_id, partner_reason, partner_reason_text, return_key, return_move_id, created_at, sent_at,
  cancelled_at, answered_at`;

export interface BillSplitLine {
  category: string;
  amount: Amount;
}

export interface BillPayment {
  id: string;
  billId: string;
  attempt: number;
  madeByHandle: string;
  assetId: string;
  amount: Amount;
  scheduledFor: string | null;
  status: BillPaymentStatus;
  partnerKey: string;
  partnerMoveId: string | null;
  /** The partner's own code and words for a decline or a return. */
  partnerReason: string | null;
  partnerReasonText: string | null;
  returnKey: string;
  returnMoveId: string | null;
  splits: BillSplitLine[];
  createdAt: Date;
  sentAt: Date | null;
  cancelledAt: Date | null;
  answeredAt: Date | null;
}

export interface BillSummary {
  id: string;
  vendor: string | null;
  reference: string | null;
  amount: Amount | null;
  dueDate: string | null;
  createdAt: Date;
}

export interface Bill extends BillSummary {
  accountId: string;
  assetId: string;
  fileName: string;
  contentType: string;
  fileSize: number;
  fileSha256: string;
  createdByHandle: string;
  extracted: BillExtraction | null;
  status: BillStatus;
  round: number;
  approvalsNeeded: number;
  preapproved: boolean;
  rule: TeamRule | null;
  submittedByHandle: string | null;
  approvals: Array<{ userId: string; handle: string; approvedAt: Date }>;
  duplicateOf: BillSummary | null;
  duplicateCleared: boolean;
  back: { reason: string; text: string } | null;
  payments: BillPayment[];
}

export interface BillVendor {
  name: string;
  cap: Amount;
  createdAt: Date;
}

export interface BillLimits {
  perPayment: Amount | null;
  daily: Amount | null;
  monthly: Amount | null;
}

export interface BillSettings {
  assetId: string;
  reader: { id: string; label: string } | null;
  vendors: BillVendor[];
  limits: BillLimits;
}

export interface BusinessBillsOptions {
  /** `BANK_BILL_READER`, read on each call. */
  readonly reader: () => string | undefined;
  readonly postingFreeze: PostingFreeze;
  readonly noteRefusal?: NoteRefusal;
}

/** Partner refusals that say nothing moved: the payment is declined with the partner's reason and never sent again. */
const DEFINITE_REFUSALS = new Set<string>([
  'bank.partner_insufficient_funds',
  'bank.partner_move_conflict',
  'bank.partner_amount_invalid',
  'bank.asset_mismatch',
  'bank.account_restricted',
]);

const amountOrNull = (raw: string | null): Amount | null => (raw === null ? null : parseAmount(raw));

export class BusinessBillsService {
  constructor(
    private readonly sql: Sql,
    private readonly team: BusinessTeamService,
    private readonly options: BusinessBillsOptions,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  /** The inbox, by approval status and then due date. */
  async bills(accountId: string, userId: string): Promise<Bill[]> {
    await this.team.seat(accountId, userId);
    const rows = await this.sql.unsafe<BillRow[]>(
      `SELECT ${BILL_COLUMNS} FROM bank.business_bills WHERE account_id = $1::uuid
        ORDER BY array_position(ARRAY['inbox','awaiting_approval','approved','scheduled','paying','paid'], status),
                 due_date ASC NULLS LAST, created_at ASC, id ASC
        LIMIT 100`,
      [accountId],
    );
    return this.views(rows);
  }

  async bill(billId: string, userId: string): Promise<Bill> {
    const row = await this.billRow(this.sql, billId);
    await this.team.seat(row.account_id, userId);
    return (await this.views([row]))[0]!;
  }

  async settings(accountId: string, userId: string): Promise<BillSettings> {
    const seat = await this.team.seat(accountId, userId);
    const vendors = await this.sql<Array<{ name: string; cap: string; created_at: Date }>>`
      SELECT name, cap, created_at FROM bank.business_bill_vendors WHERE account_id = ${accountId}::uuid ORDER BY lower(name)
    `;
    const reader = parseBillReader(this.options.reader());
    return {
      assetId: seat.account.assetId,
      reader: reader ? { id: reader, label: BILL_READER_LABEL } : null,
      vendors: vendors.map((v) => ({ name: v.name, cap: parseAmount(v.cap), createdAt: v.created_at })),
      limits: await this.limits(this.sql, accountId),
    };
  }

  // ── The inbox ────────────────────────────────────────────────────────────

  /** BK-bill-01: a bill into the inbox. The same id sent again with the same file is the same bill. */
  async upload(input: {
    accountId: string;
    userId: string;
    billId: string;
    fileName: string;
    contentType: string;
    file: Uint8Array;
  }): Promise<Bill> {
    const fileName = input.fileName.trim();
    if (!fileName || fileName.length > 128)
      throw new BankError('A bill file needs a name of 1 to 128 characters.', 'bank.bill_file_invalid');
    if (input.file.byteLength === 0 || input.file.byteLength > MAX_BILL_BYTES) {
      throw new BankError('A bill file is 1 byte to 1 MiB.', 'bank.bill_file_invalid');
    }
    const sha = createHash('sha256').update(input.file).digest('hex');
    const seat = await this.team.seat(input.accountId, input.userId);
    this.need(seat.permissions, 'propose');
    if (seat.account.status !== 'active') throw new BankError('This business account is closed.', 'bank.business_closed');
    const prior = await this.billRowOrNull(this.sql, input.billId);
    if (prior) {
      if (prior.account_id !== input.accountId || prior.file_sha256 !== sha) {
        throw new BankError('This bill id is already used for another file.', 'bank.business_request_conflict');
      }
      return this.bill(prior.id, input.userId);
    }
    const reader = parseBillReader(this.options.reader());
    const read = reader ? readTestBill(input.file) : null;
    await transaction(this.sql, async (tx) => {
      const inserted = await tx`
        INSERT INTO bank.business_bills
          (id, account_id, created_by, file_name, content_type, file_sha256, file_size, file, extracted, vendor, reference,
           amount, due_date)
        VALUES (${input.billId}::uuid, ${input.accountId}::uuid, ${input.userId}, ${fileName}, ${input.contentType.slice(0, 128)},
                ${sha}, ${input.file.byteLength}, ${Buffer.from(input.file)}, ${read ? tx.json(read as never) : null},
                ${read?.vendor ?? null}, ${read?.reference ?? null}, ${read?.amount ?? null}::numeric, ${read?.dueDate ?? null}::date)
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      if (inserted.length > 0) await this.flagDuplicate(tx, input.billId);
    });
    const row = await this.billRow(this.sql, input.billId);
    if (row.file_sha256 !== sha || row.account_id !== input.accountId) {
      throw new BankError('This bill id is already used for another file.', 'bank.business_request_conflict');
    }
    return this.bill(row.id, input.userId);
  }

  /** The person's review of what the bill says. Only a bill in the inbox is edited; the duplicate check runs again. */
  async review(input: {
    billId: string;
    userId: string;
    vendor: string | null;
    reference: string | null;
    amount: Amount | null;
    dueDate: string | null;
  }): Promise<Bill> {
    const vendor = input.vendor?.trim() || null;
    const reference = input.reference?.trim() || null;
    if (vendor && vendor.length > 128) throw new BankError('A vendor is 128 characters or fewer.', 'bank.bill_field_invalid');
    if (reference && reference.length > 64) throw new BankError('A reference is 64 characters or fewer.', 'bank.bill_field_invalid');
    if (input.amount !== null && input.amount <= 0n) throw new BankError('A bill’s amount is above zero.', 'bank.bill_field_invalid');
    if (input.dueDate !== null && !isDate(input.dueDate)) throw new BankError('A due date is a calendar date.', 'bank.bill_field_invalid');
    await transaction(this.sql, async (tx) => {
      const row = await this.billRow(tx, input.billId, true);
      const seat = await this.team.seat(row.account_id, input.userId);
      this.need(seat.permissions, 'propose');
      if (row.status !== 'inbox') {
        throw new BankError(`This bill is ${row.status.replace('_', ' ')}; only a bill in the inbox is edited.`, 'bank.bill_not_editable');
      }
      await tx`
        UPDATE bank.business_bills
           SET vendor = ${vendor}, reference = ${reference},
               amount = ${input.amount === null ? null : formatAmount(input.amount)}::numeric,
               due_date = ${input.dueDate}::date, updated_at = now()
         WHERE id = ${row.id}::uuid
      `;
      if (!row.duplicate_cleared_at) await this.flagDuplicate(tx, row.id);
    });
    return this.bill(input.billId, input.userId);
  }

  /** Someone who manages the team says the flagged bill is not a duplicate; it may then go to payment. */
  async clearDuplicate(input: { billId: string; userId: string }): Promise<Bill> {
    await transaction(this.sql, async (tx) => {
      const row = await this.billRow(tx, input.billId, true);
      const seat = await this.team.seat(row.account_id, input.userId);
      this.need(seat.permissions, 'manage_team');
      if (!row.duplicate_of || row.duplicate_cleared_at) return;
      await tx`
        UPDATE bank.business_bills SET duplicate_cleared_by = ${input.userId}, duplicate_cleared_at = now(), updated_at = now()
         WHERE id = ${row.id}::uuid
      `;
    });
    return this.bill(input.billId, input.userId);
  }

  // ── Vendors and limits ───────────────────────────────────────────────────

  /** BK-bill-02: a pre-approved vendor and its cap, set again under the same name. */
  async setVendor(input: { accountId: string; userId: string; name: string; cap: Amount }): Promise<BillVendor> {
    const name = input.name.trim();
    if (!name || name.length > 128) throw new BankError('A vendor needs a name of 1 to 128 characters.', 'bank.bill_field_invalid');
    if (input.cap <= 0n) throw new BankError('A vendor’s cap is above zero.', 'bank.bill_field_invalid');
    const seat = await this.team.seat(input.accountId, input.userId);
    this.need(seat.permissions, 'manage_team');
    const rows = await this.sql<Array<{ name: string; cap: string; created_at: Date }>>`
      INSERT INTO bank.business_bill_vendors (account_id, name, cap, created_by)
      VALUES (${input.accountId}::uuid, ${name}, ${formatAmount(input.cap)}::numeric, ${input.userId})
      ON CONFLICT (account_id, lower(name)) DO UPDATE SET cap = EXCLUDED.cap, updated_at = now()
      RETURNING name, cap, created_at
    `;
    return { name: rows[0]!.name, cap: parseAmount(rows[0]!.cap), createdAt: rows[0]!.created_at };
  }

  /** BK-bill-02: the business's Bill Pay limits. A blank limit stays not set, and every payment refuses until all are. */
  async setLimits(input: { accountId: string; userId: string; limits: BillLimits }): Promise<BillLimits> {
    for (const v of [input.limits.perPayment, input.limits.daily, input.limits.monthly]) {
      if (v !== null && v <= 0n) throw new BankError('A Bill Pay limit is above zero, or left blank.', 'bank.bill_field_invalid');
    }
    const seat = await this.team.seat(input.accountId, input.userId);
    this.need(seat.permissions, 'manage_team');
    const f = (v: Amount | null) => (v === null ? null : formatAmount(v));
    await this.sql`
      INSERT INTO bank.business_bill_limits (account_id, per_payment, daily, monthly, updated_by)
      VALUES (${input.accountId}::uuid, ${f(input.limits.perPayment)}::numeric, ${f(input.limits.daily)}::numeric,
              ${f(input.limits.monthly)}::numeric, ${input.userId})
      ON CONFLICT (account_id) DO UPDATE
        SET per_payment = EXCLUDED.per_payment, daily = EXCLUDED.daily, monthly = EXCLUDED.monthly,
            updated_by = EXCLUDED.updated_by, updated_at = now()
    `;
    return this.limits(this.sql, input.accountId);
  }

  // ── Approval ─────────────────────────────────────────────────────────────

  /**
   * The reviewed bill goes on: approved at once from a pre-approved vendor at or under its cap, otherwise to approvers.
   * The rule and the count are fixed now; a vendor or rule changed later never changes what this bill needs.
   */
  async submit(input: { billId: string; userId: string }): Promise<Bill> {
    await transaction(this.sql, async (tx) => {
      const row = await this.billRow(tx, input.billId, true);
      const seat = await this.team.seat(row.account_id, input.userId);
      this.need(seat.permissions, 'propose');
      if (row.status !== 'inbox') {
        throw new BankError(`This bill is ${row.status.replace('_', ' ')}, not in the inbox.`, 'bank.bill_not_editable');
      }
      this.assertNotDuplicate(row);
      if (!row.vendor || row.amount === null || !row.due_date) {
        throw new BankError('Review the bill first: it needs a vendor, an amount and a due date.', 'bank.bill_incomplete');
      }
      const amount = parseAmount(row.amount);
      const vendor = (
        await tx<Array<{ cap: string }>>`
          SELECT cap FROM bank.business_bill_vendors WHERE account_id = ${row.account_id}::uuid AND lower(name) = lower(${row.vendor})
        `
      )[0];
      if (vendor && amount <= parseAmount(vendor.cap)) {
        await tx`
          UPDATE bank.business_bills
             SET status = 'approved', preapproved = true, approvals_needed = 0, rule_id = NULL,
                 submitted_by = ${input.userId}, submitted_at = now(), updated_at = now()
           WHERE id = ${row.id}::uuid
        `;
        return;
      }
      const rules = await this.team.ruleList(row.account_id);
      const rule = pickRule(
        rules.map((r) => ({ ...r, over_amount: formatAmount(r.overAmount), payment_type: r.paymentType })),
        { amount, payee: row.vendor, paymentType: 'domestic' },
      );
      const needed = Math.max(1, rule?.approvals ?? 0);
      const pool = await this.team.approverPool(row.account_id, input.userId);
      if (pool.length < needed) {
        throw new BankError(
          `This bill needs ${needed} approvers other than you, and this business has ${pool.length}. It stays in the inbox.`,
          'bank.business_approvers_short',
        );
      }
      await tx`
        UPDATE bank.business_bills
           SET status = 'awaiting_approval', preapproved = false, approvals_needed = ${needed}, rule_id = ${rule?.id ?? null}::uuid,
               submitted_by = ${input.userId}, submitted_at = now(), updated_at = now()
         WHERE id = ${row.id}::uuid
      `;
    });
    return this.bill(input.billId, input.userId);
  }

  /** One approval by one distinct approver, never the person who sent the bill on. The last one approves the bill. */
  async approve(input: { billId: string; userId: string }): Promise<Bill> {
    await transaction(this.sql, async (tx) => {
      const row = await this.billRow(tx, input.billId, true);
      const seat = await this.team.seat(row.account_id, input.userId);
      if (row.submitted_by === input.userId) {
        throw new BankError(
          'You sent this bill for approval, so you cannot approve it. Another approver must.',
          'bank.business_self_approve',
        );
      }
      this.need(seat.permissions, 'approve');
      if (row.status !== 'awaiting_approval') {
        throw new BankError(`This bill is ${row.status.replace('_', ' ')}; it takes no approvals.`, 'bank.business_approval_inactive');
      }
      const added = await tx`
        INSERT INTO bank.business_bill_approvals (bill_id, round, approver_user_id)
        VALUES (${row.id}::uuid, ${row.round}, ${input.userId})
        ON CONFLICT DO NOTHING
        RETURNING bill_id
      `;
      if (added.length === 0) {
        throw new BankError(
          'You have already approved this bill. A different approver must give the next approval.',
          'bank.business_already_approved',
        );
      }
      const count = Number(
        (
          await tx<Array<{ n: string }>>`
            SELECT count(*)::text AS n FROM bank.business_bill_approvals WHERE bill_id = ${row.id}::uuid AND round = ${row.round}
          `
        )[0]!.n,
      );
      if (count >= row.approvals_needed) {
        await tx`UPDATE bank.business_bills SET status = 'approved', updated_at = now() WHERE id = ${row.id}::uuid AND status = 'awaiting_approval'`;
      }
    });
    return this.bill(input.billId, input.userId);
  }

  // ── Paying ───────────────────────────────────────────────────────────────

  /**
   * BK-bill-02 and BK-bill-03: pays an approved bill now, or schedules it for a later date. One instruction to the partner
   * under `bank.business.bill-pay:<bill id>:<attempt>`, written before it is sent. The split lines, if any, are our record
   * beside it and add up to the bill exactly. The same payment id again is the same payment.
   */
  async pay(input: {
    billId: string;
    userId: string;
    paymentId: string;
    scheduledFor: string | null;
    splits: readonly BillSplitLine[];
  }): Promise<Bill> {
    const prior = await this.paymentRowOrNull(this.sql, input.paymentId);
    if (prior) {
      if (prior.bill_id !== input.billId || prior.scheduled_for !== input.scheduledFor) {
        throw new BankError('This payment id is already used on different terms.', 'bank.business_request_conflict');
      }
      const seat = await this.team.seat(prior.account_id, input.userId);
      this.need(seat.permissions, 'propose');
      if (prior.status === 'sending') {
        await this.moneyMayMove();
        await this.send(prior, seat.partner);
      }
      return this.bill(input.billId, input.userId);
    }
    if (input.splits.length > MAX_SPLIT_LINES) {
      throw new BankError(`A payment is split into at most ${MAX_SPLIT_LINES} lines.`, 'bank.bill_field_invalid');
    }
    for (const line of input.splits) {
      const category = line.category.trim();
      if (!category || category.length > 64)
        throw new BankError('Each line needs a category of 1 to 64 characters.', 'bank.bill_field_invalid');
      if (line.amount <= 0n) throw new BankError('Each line’s amount is above zero.', 'bank.bill_field_invalid');
    }
    if (input.scheduledFor !== null && !isDate(input.scheduledFor)) {
      throw new BankError('A payment date is a calendar date.', 'bank.bill_schedule_invalid');
    }
    // Paid now, money leaves at once: while posting is frozen nothing is recorded or sent.
    if (input.scheduledFor === null) await this.moneyMayMove();
    const created = await transaction(this.sql, async (tx) => {
      const row = await this.billRow(tx, input.billId, true);
      const seat = await this.team.seat(row.account_id, input.userId);
      this.need(seat.permissions, 'propose');
      if (seat.account.status !== 'active') throw new BankError('This business account is closed.', 'bank.business_closed');
      if (!seat.partner) throw noPartner();
      this.assertNotDuplicate(row);
      if (row.status !== 'approved') {
        throw new BankError(
          row.status === 'awaiting_approval'
            ? 'This bill is waiting for its approvals; it cannot be paid yet.'
            : `This bill is ${row.status.replace('_', ' ')}; only an approved bill is paid.`,
          'bank.bill_not_approved',
        );
      }
      const amount = parseAmount(row.amount!);
      if (input.splits.length > 0) {
        const total = input.splits.reduce((sum, l) => sum + l.amount, 0n);
        if (total !== amount) {
          throw new BankError(
            `The lines add up to ${formatAmount(total)}, not the bill’s ${formatAmount(amount)}. Nothing was paid.`,
            'bank.split_total_mismatch',
          );
        }
      }
      if (input.scheduledFor !== null) {
        const later = (await tx<Array<{ ok: boolean }>>`SELECT ${input.scheduledFor}::date > current_date AS ok`)[0]!.ok;
        if (!later) throw new BankError('A scheduled payment is for a later day; to pay today, pay now.', 'bank.bill_schedule_invalid');
      }
      await this.assertWithinLimits(tx, row.account_id, amount);
      const attempt =
        Number(
          (
            await tx<
              Array<{ n: string }>
            >`SELECT coalesce(max(attempt), 0)::text AS n FROM bank.business_bill_payments WHERE bill_id = ${row.id}::uuid`
          )[0]!.n,
        ) + 1;
      const status: BillPaymentStatus = input.scheduledFor === null ? 'sending' : 'scheduled';
      const rows = await tx.unsafe<PaymentRow[]>(
        `INSERT INTO bank.business_bill_payments
           (id, bill_id, account_id, attempt, made_by, asset_id, amount, scheduled_for, status, partner_key, return_key)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::numeric, $8::date, $9, $10, $11)
         RETURNING ${PAYMENT_COLUMNS}`,
        [
          input.paymentId,
          row.id,
          row.account_id,
          attempt,
          input.userId,
          seat.account.assetId,
          formatAmount(amount),
          input.scheduledFor,
          status,
          billPayKey(row.id, attempt),
          billReturnKey(input.paymentId),
        ],
      );
      let line = 0;
      for (const l of input.splits) {
        line += 1;
        await tx`
          INSERT INTO bank.business_bill_splits (payment_id, line, category, amount)
          VALUES (${input.paymentId}::uuid, ${line}, ${l.category.trim()}, ${formatAmount(l.amount)}::numeric)
        `;
      }
      await tx`
        UPDATE bank.business_bills SET status = ${status === 'sending' ? 'paying' : 'scheduled'}, updated_at = now() WHERE id = ${row.id}::uuid
      `;
      return { payment: rows[0]!, partner: seat.partner };
    });
    if (created.payment.status === 'sending') await this.send(created.payment, created.partner);
    return this.bill(input.billId, input.userId);
  }

  /** A sending payment whose partner answer was not definite, sent again under the same key: made at most once. */
  async resend(input: { paymentId: string; userId: string }): Promise<Bill> {
    const row = await this.paymentRow(this.sql, input.paymentId);
    const seat = await this.team.seat(row.account_id, input.userId);
    this.need(seat.permissions, 'propose');
    if (row.status === 'sending') {
      await this.moneyMayMove();
      await this.send(row, seat.partner);
    }
    return this.bill(row.bill_id, input.userId);
  }

  /**
   * BK-bill-03: a scheduled payment stopped before it is sent. It never reaches the partner and the bill is approved again.
   * A second cancel changes nothing; once sent it cannot be cancelled here.
   */
  async cancel(input: { paymentId: string; userId: string }): Promise<Bill> {
    await transaction(this.sql, async (tx) => {
      const row = (
        await tx.unsafe<PaymentRow[]>(`SELECT ${PAYMENT_COLUMNS} FROM bank.business_bill_payments WHERE id = $1::uuid FOR UPDATE`, [
          input.paymentId,
        ])
      )[0];
      if (!row) throw paymentNotFound();
      const seat = await this.team.seat(row.account_id, input.userId);
      this.need(seat.permissions, 'propose');
      if (row.status === 'cancelled') return;
      if (row.status !== 'scheduled') {
        throw new BankError('This payment was already sent to the partner bank, so it cannot be cancelled here.', 'bank.bill_payment_sent');
      }
      await tx`UPDATE bank.business_bill_payments SET status = 'cancelled', cancelled_at = now() WHERE id = ${row.id}::uuid`;
      await tx`UPDATE bank.business_bills SET status = 'approved', updated_at = now() WHERE id = ${row.bill_id}::uuid AND status = 'scheduled'`;
    });
    const row = await this.paymentRow(this.sql, input.paymentId);
    return this.bill(row.bill_id, input.userId);
  }

  /**
   * The scheduled payments whose day has come, sent once each (a job, never a customer's door). A payment cancelled
   * first is never picked up: the cancel and this pick change the same row's status, one at a time.
   */
  async runDue(input: { limit: number }): Promise<{ sent: number; declined: number; unknown: number }> {
    await this.moneyMayMove();
    const picked = await transaction(this.sql, async (tx) =>
      tx.unsafe<PaymentRow[]>(
        `UPDATE bank.business_bill_payments SET status = 'sending'
          WHERE id IN (SELECT id FROM bank.business_bill_payments
                        WHERE status = 'scheduled' AND scheduled_for <= current_date
                        ORDER BY scheduled_for, created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
          RETURNING ${PAYMENT_COLUMNS}`,
        [input.limit],
      ),
    );
    for (const p of picked)
      await this.sql`UPDATE bank.business_bills SET status = 'paying', updated_at = now() WHERE id = ${p.bill_id}::uuid`;
    const out = { sent: 0, declined: 0, unknown: 0 };
    for (const p of picked) {
      try {
        const status = await this.send(p, await this.partnerOfAccount(p.account_id));
        out[status === 'sent' ? 'sent' : 'declined'] += 1;
      } catch {
        out.unknown += 1;
      }
    }
    return out;
  }

  /**
   * The partner reports the payee's bank sent a payment back (a job door, as the partner's report reaches us). The amount
   * is given back to the business's account once, under its return key; the same report again answers the same.
   */
  async returned(input: { paymentId: string; reason: BillReturnReason }): Promise<Bill> {
    const row = await this.paymentRow(this.sql, input.paymentId);
    if (row.status === 'returned') return this.billAsSystem(row.bill_id);
    if (row.status !== 'sent') {
      throw new BankError(`This bill payment is ${row.status}; only a sent payment comes back.`, 'bank.bill_payment_not_sent');
    }
    const partner = await this.partnerOfAccount(row.account_id);
    const back = await partner.move({
      key: row.return_key,
      from: partnerPayoutsAccount(row.asset_id),
      to: businessPartnerAccount(row.account_id, row.asset_id),
      amount: parseAmount(row.amount),
    });
    await transaction(this.sql, async (tx) => {
      const moved = await tx`
        UPDATE bank.business_bill_payments
           SET status = 'returned', return_move_id = ${back.id}, partner_reason = ${input.reason},
               partner_reason_text = ${RETURN_WORDS[input.reason]}, answered_at = now()
         WHERE id = ${row.id}::uuid AND status = 'sent'
         RETURNING id
      `;
      if (moved.length > 0) await this.backToInbox(tx, row.bill_id, `returned:${input.reason}`, RETURN_WORDS[input.reason]);
    });
    return this.billAsSystem(row.bill_id);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Sends one payment's instruction. A definite refusal declines it and puts the bill back; any other failure throws. */
  private async send(row: PaymentRow, partner: PartnerBank | null): Promise<'sent' | 'declined'> {
    if (!partner) throw noPartner();
    let move;
    try {
      // A retry first asks the partner for the move under this key: an answer that was lost is never sent again blind.
      move =
        (await partner.moveByKey(row.partner_key)) ??
        (await partner.move({
          key: row.partner_key,
          from: businessPartnerAccount(row.account_id, row.asset_id),
          to: partnerPayoutsAccount(row.asset_id),
          amount: parseAmount(row.amount),
        }));
    } catch (err) {
      if (err instanceof BankError && DEFINITE_REFUSALS.has(err.code)) {
        await transaction(this.sql, async (tx) => {
          const declined = await tx`
            UPDATE bank.business_bill_payments
               SET status = 'declined', partner_reason = ${err.code}, partner_reason_text = ${err.message.slice(0, 500)}, answered_at = now()
             WHERE id = ${row.id}::uuid AND status = 'sending'
             RETURNING id
          `;
          if (declined.length > 0) await this.backToInbox(tx, row.bill_id, err.code, err.message.slice(0, 500));
        });
        return 'declined';
      }
      throw err;
    }
    await transaction(this.sql, async (tx) => {
      const sent = await tx`
        UPDATE bank.business_bill_payments SET status = 'sent', partner_move_id = ${move.id}, sent_at = ${move.movedAt}, answered_at = now()
         WHERE id = ${row.id}::uuid AND status = 'sending'
         RETURNING id
      `;
      if (sent.length > 0) await tx`UPDATE bank.business_bills SET status = 'paid', updated_at = now() WHERE id = ${row.bill_id}::uuid`;
    });
    return 'sent';
  }

  /** The bill comes back to the inbox with the partner's reason; its approvals start again in a new round. */
  private async backToInbox(tx: Sql, billId: string, reason: string, text: string): Promise<void> {
    await tx`
      UPDATE bank.business_bills
         SET status = 'inbox', round = round + 1, approvals_needed = 0, rule_id = NULL, preapproved = false,
             submitted_by = NULL, submitted_at = NULL, back_reason = ${reason}, back_reason_text = ${text}, updated_at = now()
       WHERE id = ${billId}::uuid
    `;
  }

  /** Flags the earliest other bill of this business that looks the same: same file, vendor and reference, or amount and due date. */
  private async flagDuplicate(tx: Sql, billId: string): Promise<void> {
    await tx`
      UPDATE bank.business_bills b
         SET duplicate_of = (
           SELECT o.id FROM bank.business_bills o
            WHERE o.account_id = b.account_id AND o.id <> b.id AND o.created_at <= b.created_at
              AND (o.file_sha256 = b.file_sha256
                   OR (b.vendor IS NOT NULL AND b.reference IS NOT NULL AND lower(o.vendor) = lower(b.vendor) AND lower(o.reference) = lower(b.reference))
                   OR (b.amount IS NOT NULL AND b.due_date IS NOT NULL AND o.amount = b.amount AND o.due_date = b.due_date))
            ORDER BY o.created_at ASC, o.id ASC
            LIMIT 1)
       WHERE b.id = ${billId}::uuid
    `;
  }

  private assertNotDuplicate(row: BillRow): void {
    if (row.duplicate_of && !row.duplicate_cleared_at) {
      throw new BankError(
        'This bill may be a duplicate of one already received. Someone who manages the team must clear it before it is paid.',
        'bank.bill_duplicate_uncleared',
      );
    }
  }

  /** Per payment, per day and per month, on the database clock; a blank limit refuses. Payments still live count. */
  private async assertWithinLimits(tx: Sql, accountId: string, amount: Amount): Promise<void> {
    const limit = (
      await tx<Array<{ per_payment: string | null; daily: string | null; monthly: string | null }>>`
        SELECT per_payment, daily, monthly FROM bank.business_bill_limits WHERE account_id = ${accountId}::uuid FOR UPDATE
      `
    )[0];
    if (!limit || limit.per_payment === null || limit.daily === null || limit.monthly === null) {
      throw new BankError(
        'This business’s Bill Pay limits are not set, so no bill can be paid yet. Nothing was paid.',
        'bank.bill_limit_unset',
      );
    }
    const used = (
      await tx<Array<{ day: string; month: string }>>`
        SELECT coalesce(sum(amount) FILTER (WHERE created_at >= date_trunc('day', now())), 0)::text AS day,
               coalesce(sum(amount) FILTER (WHERE created_at >= date_trunc('month', now())), 0)::text AS month
          FROM bank.business_bill_payments
         WHERE account_id = ${accountId}::uuid AND status IN ('scheduled', 'sending', 'sent')
      `
    )[0]!;
    const over = (what: string, cap: string, now: Amount) => {
      if (now > parseAmount(cap)) {
        throw new BankError(
          `This payment would pass the business’s ${what} Bill Pay limit of ${formatAmount(parseAmount(cap))}. Nothing was paid.`,
          'bank.bill_limit_exceeded',
        );
      }
    };
    over('per-payment', limit.per_payment, amount);
    over('daily', limit.daily, parseAmount(used.day) + amount);
    over('monthly', limit.monthly, parseAmount(used.month) + amount);
  }

  private async limits(sql: Sql, accountId: string): Promise<BillLimits> {
    const row = (
      await sql<Array<{ per_payment: string | null; daily: string | null; monthly: string | null }>>`
        SELECT per_payment, daily, monthly FROM bank.business_bill_limits WHERE account_id = ${accountId}::uuid
      `
    )[0];
    return {
      perPayment: amountOrNull(row?.per_payment ?? null),
      daily: amountOrNull(row?.daily ?? null),
      monthly: amountOrNull(row?.monthly ?? null),
    };
  }

  private async partnerOfAccount(accountId: string): Promise<PartnerBank> {
    const owner = (
      await this.sql<Array<{ owner_user_id: string | null }>>`
      SELECT owner_user_id FROM bank.business_accounts WHERE id = ${accountId}::uuid
    `
    )[0]?.owner_user_id;
    if (!owner) throw noPartner();
    const seat = await this.team.seat(accountId, owner);
    if (!seat.partner) throw noPartner();
    return seat.partner;
  }

  private async moneyMayMove(): Promise<void> {
    await assertPostingEnabled(this.options.postingFreeze, 'bank_move', this.options.noteRefusal);
  }

  private need(permissions: readonly BusinessPermission[], permission: BusinessPermission): void {
    if (!permissions.includes(permission)) {
      throw new BankError(
        `Your role on this business does not include ${permission.replace('_', ' ')}, so this was refused. Nothing changed.`,
        'bank.business_role_forbidden',
      );
    }
  }

  private async billRowOrNull(sql: Sql, billId: string, lock = false): Promise<BillRow | null> {
    const rows = await sql.unsafe<BillRow[]>(
      `SELECT ${BILL_COLUMNS} FROM bank.business_bills WHERE id = $1::uuid${lock ? ' FOR UPDATE' : ''}`,
      [billId],
    );
    return rows[0] ?? null;
  }

  private async billRow(sql: Sql, billId: string, lock = false): Promise<BillRow> {
    const row = await this.billRowOrNull(sql, billId, lock);
    if (!row) throw new BankError('No bill of this business has that id.', 'bank.bill_not_found');
    return row;
  }

  private async paymentRowOrNull(sql: Sql, paymentId: string): Promise<PaymentRow | null> {
    const rows = await sql.unsafe<PaymentRow[]>(`SELECT ${PAYMENT_COLUMNS} FROM bank.business_bill_payments WHERE id = $1::uuid`, [
      paymentId,
    ]);
    return rows[0] ?? null;
  }

  private async paymentRow(sql: Sql, paymentId: string): Promise<PaymentRow> {
    const row = await this.paymentRowOrNull(sql, paymentId);
    if (!row) throw paymentNotFound();
    return row;
  }

  /** A bill read for a job's answer, with no member's seat: the job is the partner's report, not a person. */
  private async billAsSystem(billId: string): Promise<Bill> {
    return (await this.views([await this.billRow(this.sql, billId)]))[0]!;
  }

  private async views(rows: BillRow[]): Promise<Bill[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const payments = await this.sql.unsafe<PaymentRow[]>(
      `SELECT ${PAYMENT_COLUMNS} FROM bank.business_bill_payments WHERE bill_id = ANY($1::uuid[]) ORDER BY attempt ASC`,
      [ids],
    );
    const paymentIds = payments.map((p) => p.id);
    const splits = paymentIds.length
      ? await this.sql<Array<{ payment_id: string; line: number; category: string; amount: string }>>`
          SELECT payment_id, line, category, amount FROM bank.business_bill_splits WHERE payment_id = ANY(${paymentIds}::uuid[]) ORDER BY line
        `
      : [];
    const approvals = await this.sql<Array<{ bill_id: string; round: number; approver_user_id: string; approved_at: Date }>>`
      SELECT bill_id, round, approver_user_id, approved_at FROM bank.business_bill_approvals
       WHERE bill_id = ANY(${ids}::uuid[]) ORDER BY approved_at ASC, approver_user_id ASC
    `;
    const dupIds = [...new Set(rows.map((r) => r.duplicate_of).filter((d): d is string => d !== null))];
    const dups = dupIds.length
      ? await this.sql.unsafe<BillRow[]>(`SELECT ${BILL_COLUMNS} FROM bank.business_bills WHERE id = ANY($1::uuid[])`, [dupIds])
      : [];
    const assets = await this.sql<Array<{ id: string; asset_id: string }>>`
      SELECT id, asset_id FROM bank.business_accounts WHERE id = ANY(${[...new Set(rows.map((r) => r.account_id))]}::uuid[])
    `;
    const ruleCache = new Map<string, TeamRule[]>();
    for (const accountId of new Set(rows.filter((r) => r.rule_id).map((r) => r.account_id))) {
      ruleCache.set(accountId, await this.team.ruleList(accountId));
    }
    const handles = await this.team.handlesOf([
      ...rows.map((r) => r.created_by),
      ...rows.map((r) => r.submitted_by).filter((s): s is string => s !== null),
      ...approvals.map((a) => a.approver_user_id),
      ...payments.map((p) => p.made_by),
    ]);
    const summary = (r: BillRow): BillSummary => ({
      id: r.id,
      vendor: r.vendor,
      reference: r.reference,
      amount: amountOrNull(r.amount),
      dueDate: r.due_date,
      createdAt: r.created_at,
    });
    return rows.map((r) => {
      const dup = r.duplicate_of ? dups.find((d) => d.id === r.duplicate_of) : undefined;
      return {
        ...summary(r),
        accountId: r.account_id,
        assetId: assets.find((a) => a.id === r.account_id)?.asset_id ?? '',
        fileName: r.file_name,
        contentType: r.content_type,
        fileSize: r.file_size,
        fileSha256: r.file_sha256,
        createdByHandle: handles.get(r.created_by)!,
        extracted: r.extracted,
        status: r.status,
        round: r.round,
        approvalsNeeded: r.approvals_needed,
        preapproved: r.preapproved,
        rule: r.rule_id ? (ruleCache.get(r.account_id)?.find((x) => x.id === r.rule_id) ?? null) : null,
        submittedByHandle: r.submitted_by ? handles.get(r.submitted_by)! : null,
        approvals: approvals
          .filter((a) => a.bill_id === r.id && a.round === r.round)
          .map((a) => ({ userId: a.approver_user_id, handle: handles.get(a.approver_user_id)!, approvedAt: a.approved_at })),
        duplicateOf: dup ? summary(dup) : null,
        duplicateCleared: r.duplicate_cleared_at !== null,
        back: r.back_reason ? { reason: r.back_reason, text: r.back_reason_text ?? '' } : null,
        payments: payments
          .filter((p) => p.bill_id === r.id)
          .map((p) => ({
            id: p.id,
            billId: p.bill_id,
            attempt: p.attempt,
            madeByHandle: handles.get(p.made_by)!,
            assetId: p.asset_id,
            amount: parseAmount(p.amount),
            scheduledFor: p.scheduled_for,
            status: p.status,
            partnerKey: p.partner_key,
            partnerMoveId: p.partner_move_id,
            partnerReason: p.partner_reason,
            partnerReasonText: p.partner_reason_text,
            returnKey: p.return_key,
            returnMoveId: p.return_move_id,
            splits: splits.filter((s) => s.payment_id === p.id).map((s) => ({ category: s.category, amount: parseAmount(s.amount) })),
            createdAt: p.created_at,
            sentAt: p.sent_at,
            cancelledAt: p.cancelled_at,
            answeredAt: p.answered_at,
          })),
      };
    });
  }
}

function paymentNotFound(): BankError {
  return new BankError('No bill payment of this business has that id.', 'bank.bill_payment_not_found');
}

function noPartner(): BankError {
  return new BankError(
    'This business’s money is not held at a partner bank, so no bill can be paid from it.',
    NO_PARTNER_BANK_CODE as 'bank.no_partner_bank',
  );
}
