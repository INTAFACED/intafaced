import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction, type Queryable } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import {
  assertPostingEnabled,
  NO_PARTNER_BANK_CODE,
  partnerPayoutsAccount,
  type NoteRefusal,
  type PartnerBank,
  type PartnerPayee,
  type PostingFreeze,
} from '../partner/partner-bank.js';
import { recoverPersonalSignAddress } from '../ramps/wallet-ownership.js';
import { isEvmAddressRef, isIbanRef } from '../withdraw-destination.js';
import { businessPartnerAccount, pickRule, type BusinessPermission, type BusinessTeamService } from './business-team.js';

/**
 * A BUSINESS PAYS ITS TEAM AND CONTRACTORS IN BULK (J-bank-21; BK-bpay-01, BK-bpay-02, RC-bank-05).
 *
 * The business's money is the partner bank's (OWNER 226; docs/adr/2026-11-10-launch-money-model.md), in its own account
 * at the partner, `business:<account id>`. INTAFACED's ledger posts nothing for any of this.
 *
 *   bulk run     A CSV (`name,iban,amount,currency,reference`) is imported under the run's own id. Every line is checked;
 *                a line that fails is in the validation report with its code and sends nothing, and nothing is held at
 *                import. Confirming the run is the funding step: the business's partner balance must cover the total
 *                (`bank.bulk_run_unfunded`, nothing changes). At or above the business's own threshold the run waits for
 *                an approver who is not the person who confirmed it. Then one instruction to the partner carrying every line,
 *                `bank.business.bulk-pay:<run id>`, stored before it is sent and sent once; a lost answer is read back by
 *                its key, never sent again blind. A second run cannot reuse the key: the same id on another file is
 *                `bank.business_request_conflict`, and the key is the id's, so it is never blank.
 *   contractors  A contractor (payout IBAN, and a wallet for crypto payroll) and their invoices. A contractor may add
 *                themselves through a one-use onboarding link. Paying a batch of open invoices writes the intent row first;
 *                the business's approval rules (J-bank-19) say how many approvers it needs. Then one instruction to the
 *                partner's payout rail, `bank.business.contractor-batch:<batch id>`; with no partner payout rail the
 *                intent is kept, refused with `rail.bank`, and nothing moves.
 *   crypto       The business's own wallet is connected by signing an offered message. A recurring payroll pays its members
 *                monthly; each month's run is one message under `bank.business.crypto-payroll:<payroll>:<YYYY-MM>`, with a
 *                payslip per member, signed by the business's own wallet. INTAFACED holds no key and no vault, and sends
 *                nothing on chain: the signed run is the wallet's to broadcast (`rail.crypto`, no chain rail here).
 */

export const MAX_BULK_FILE_BYTES = 262_144;
export const MAX_BULK_LINES = 500;
export const MAX_BATCH_INVOICES = 50;
export const MAX_PAYROLL_MEMBERS = 50;

export const BULK_RUN_STATUSES = ['draft', 'awaiting_approval', 'sending', 'sent', 'declined'] as const;
export type BulkRunStatus = (typeof BULK_RUN_STATUSES)[number];
export const BULK_LINE_CODES = [
  'columns_invalid',
  'name_missing',
  'iban_invalid',
  'amount_invalid',
  'asset_mismatch',
  'duplicate_line',
] as const;
export type BulkLineCode = (typeof BULK_LINE_CODES)[number];
export const CONTRACTOR_BATCH_STATUSES = ['awaiting_approval', 'sending', 'sent', 'declined', 'refused'] as const;
export type ContractorBatchStatus = (typeof CONTRACTOR_BATCH_STATUSES)[number];
export const INVOICE_STATUSES = ['open', 'in_batch', 'paid'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const PAYROLL_RUN_STATUSES = ['awaiting_signature', 'signed'] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

export const bulkPayKey = (runId: string): string => `bank.business.bulk-pay:${runId}`;
export const contractorBatchKey = (batchId: string): string => `bank.business.contractor-batch:${batchId}`;
export const cryptoPayrollKey = (payrollId: string, period: string): string => `bank.business.crypto-payroll:${payrollId}:${period}`;

/** Partner refusals that say nothing moved: the run or batch is declined with the partner's reason and never sent again. */
const DEFINITE_REFUSALS = new Set<string>([
  'bank.partner_insufficient_funds',
  'bank.partner_move_conflict',
  'bank.partner_amount_invalid',
  'bank.asset_mismatch',
  'bank.account_restricted',
]);

// ── The CSV ─────────────────────────────────────────────────────────────────

export interface BulkLine {
  line: number;
  name: string;
  iban: string;
  amount: Amount;
  reference: string | null;
}

export interface BulkIssue {
  line: number;
  code: BulkLineCode;
  detail: string;
  raw: string;
}

const NAME_RE = /^[^\p{Cc}]{1,140}$/u;
const AMOUNT_RE = /^\d{1,18}(\.\d{1,18})?$/;
const COLUMNS = ['name', 'iban', 'amount', 'currency', 'reference'] as const;

/** One CSV row's cells: commas split, a double-quoted cell may hold commas and "" for a quote. */
function cells(row: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (quoted) {
      if (ch === '"' && row[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (quoted) return null;
  out.push(cur.trim());
  return out;
}

/**
 * The file's lines, each valid one or its issue. The header names the columns (any order; `reference` may be left out).
 * A file with no such header, or with no line at all, is refused whole: `bank.bulk_file_invalid`.
 */
export function parseBulkCsv(text: string, assetId: string): { lines: BulkLine[]; issues: BulkIssue[] } {
  const rows = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = cells(rows[0] ?? '')?.map((c) => c.toLowerCase()) ?? [];
  const at = Object.fromEntries(COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<(typeof COLUMNS)[number], number>;
  if (at.name < 0 || at.iban < 0 || at.amount < 0 || at.currency < 0) {
    throw new BankError('The file’s first row names its columns: name, iban, amount, currency and reference.', 'bank.bulk_file_invalid');
  }
  const lines: BulkLine[] = [];
  const issues: BulkIssue[] = [];
  const seen = new Map<string, number>();
  let n = 0;
  for (const raw of rows.slice(1)) {
    if (raw.trim() === '') continue;
    n += 1;
    if (n > MAX_BULK_LINES) throw new BankError(`A file has at most ${MAX_BULK_LINES} lines.`, 'bank.bulk_file_invalid');
    const issue = (code: BulkLineCode, detail: string) => issues.push({ line: n, code, detail, raw: raw.slice(0, 500) });
    const row = cells(raw);
    if (!row || row.length !== header.length) {
      issue('columns_invalid', `This line has ${row?.length ?? 0} columns; the header has ${header.length}.`);
      continue;
    }
    const name = row[at.name]!;
    const iban = row[at.iban]!.replace(/\s+/g, '').toUpperCase();
    const amount = row[at.amount]!;
    const currency = row[at.currency]!.toUpperCase();
    const reference = at.reference >= 0 ? row[at.reference]! || null : null;
    if (!NAME_RE.test(name)) issue('name_missing', 'A recipient’s name is 1 to 140 characters.');
    else if (!isIbanRef(iban)) issue('iban_invalid', 'The IBAN does not check out.');
    else if (!AMOUNT_RE.test(amount) || parseAmount(amount) <= 0n)
      issue('amount_invalid', `“${amount.slice(0, 40)}” is not an amount above zero.`);
    else if (currency !== assetId)
      issue('asset_mismatch', `This line is in ${currency.slice(0, 12) || 'no currency'}; the account pays in ${assetId}.`);
    else if (reference !== null && reference.length > 64) issue('columns_invalid', 'A reference is 64 characters or fewer.');
    else if (seen.has(iban)) issue('duplicate_line', `This account is already paid on line ${seen.get(iban)}.`);
    else {
      seen.set(iban, n);
      lines.push({ line: n, name, iban, amount: parseAmount(amount), reference });
    }
  }
  if (n === 0) throw new BankError('The file has no lines to pay.', 'bank.bulk_file_invalid');
  return { lines, issues };
}

// ── Views ───────────────────────────────────────────────────────────────────

export interface BulkRun {
  id: string;
  accountId: string;
  assetId: string;
  fileSha256: string;
  status: BulkRunStatus;
  total: Amount;
  lines: BulkLine[];
  issues: BulkIssue[];
  /** The business's threshold as it stood when the run was confirmed; null before. */
  threshold: Amount | null;
  approvalsNeeded: number;
  confirmedBy: string | null;
  approvals: Array<{ userId: string; approvedAt: Date }>;
  partnerKey: string;
  partnerMoveId: string | null;
  /** How many recipients the partner's one instruction carried, as the partner took it; null before it is sent. */
  partnerPayees: number | null;
  partnerReason: string | null;
  partnerReasonText: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

export interface ContractorInvoice {
  id: string;
  contractorId: string;
  number: string;
  assetId: string;
  amount: Amount;
  dueDate: string | null;
  status: InvoiceStatus;
  createdAt: Date;
}

export interface Contractor {
  id: string;
  accountId: string;
  name: string;
  email: string | null;
  /** The payout IBAN, masked to its last four characters. */
  ibanLast4: string | null;
  walletAddress: string | null;
  onboarded: 'business' | 'self';
  invoices: ContractorInvoice[];
  createdAt: Date;
}

export interface ContractorBatch {
  id: string;
  accountId: string;
  assetId: string;
  total: Amount;
  status: ContractorBatchStatus;
  approvalsNeeded: number;
  ruleId: string | null;
  createdBy: string;
  approvals: Array<{ userId: string; approvedAt: Date }>;
  lines: Array<{ invoiceId: string; contractorName: string; number: string; amount: Amount }>;
  partnerKey: string;
  partnerMoveId: string | null;
  /** How many recipients the partner's one instruction carried, as the partner took it; null before it is sent. */
  partnerPayees: number | null;
  refusalCode: string | null;
  partnerReasonText: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

export interface PayrollWallet {
  address: string;
  connectedAt: Date;
}

export interface Payslip {
  contractorId: string;
  name: string;
  walletAddress: string;
  assetId: string;
  amount: Amount;
}

export interface PayrollRun {
  id: string;
  payrollId: string;
  period: string;
  runKey: string;
  walletAddress: string;
  message: string;
  total: Amount;
  status: PayrollRunStatus;
  signature: string | null;
  signedAt: Date | null;
  payslips: Payslip[];
  createdAt: Date;
}

export interface CryptoPayroll {
  id: string;
  accountId: string;
  name: string;
  assetId: string;
  dayOfMonth: number;
  members: Array<{ contractorId: string; name: string; walletAddress: string | null; amount: Amount }>;
  runs: PayrollRun[];
  createdAt: Date;
}

export interface BusinessPayoutsOptions {
  readonly postingFreeze: PostingFreeze;
  readonly noteRefusal?: NoteRefusal;
}

interface AccountRow {
  id: string;
  name: string;
  asset_id: string;
  status: 'active' | 'closed';
  spend_threshold: string;
  owner_user_id: string | null;
}

interface RunRow {
  id: string;
  account_id: string;
  created_by: string;
  file_sha256: string;
  asset_id: string;
  amount: string;
  status: BulkRunStatus;
  approvals_needed: number;
  threshold: string | null;
  confirmed_by: string | null;
  partner_key: string;
  partner_move_id: string | null;
  partner_payees: number | null;
  partner_reason: string | null;
  partner_reason_text: string | null;
  created_at: Date;
  sent_at: Date | null;
}

interface BatchRow {
  id: string;
  account_id: string;
  created_by: string;
  asset_id: string;
  amount: string;
  status: ContractorBatchStatus;
  approvals_needed: number;
  rule_id: string | null;
  partner_key: string;
  partner_move_id: string | null;
  partner_payees: number | null;
  refusal_code: string | null;
  partner_reason_text: string | null;
  created_at: Date;
  sent_at: Date | null;
}

interface PayrollRunRow {
  id: string;
  payroll_id: string;
  period: string;
  run_key: string;
  wallet_address: string;
  message: string;
  amount: string;
  status: PayrollRunStatus;
  signature: string | null;
  signed_at: Date | null;
  created_at: Date;
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const isDate = (raw: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const d = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw;
};
const conflict = (what: string) => new BankError(`This ${what} id is already used on different terms.`, 'bank.business_request_conflict');

/** The exact text the business's wallet signs to connect it. It names the business and the address, and moves nothing. */
export function walletConnectMessage(accountId: string, address: string, offerId: string): string {
  return [
    'INTAFACED business payroll wallet',
    `Business: ${accountId}`,
    `Address: ${address}`,
    `Offer: ${offerId}`,
    'Signing this connects your own wallet to this business’s crypto payroll. It moves no funds.',
  ].join('\n');
}

/** The exact text the business's wallet signs for one month's run: its key, every payee and amount, and the total. */
export function payrollRunMessage(input: {
  runKey: string;
  business: string;
  wallet: string;
  assetId: string;
  period: string;
  payslips: ReadonlyArray<{ walletAddress: string; amount: Amount }>;
  total: Amount;
}): string {
  return [
    'INTAFACED crypto payroll run',
    `Run: ${input.runKey}`,
    `Business: ${input.business}`,
    `From your wallet: ${input.wallet}`,
    `Period: ${input.period}`,
    ...input.payslips.map((p) => `Pay ${formatAmount(p.amount)} ${input.assetId} to ${p.walletAddress}`),
    `Total: ${formatAmount(input.total)} ${input.assetId}`,
    'Signed by your own wallet. INTAFACED holds no key and no vault for this payroll.',
  ].join('\n');
}

export class BusinessPayoutsService {
  constructor(
    private readonly sql: Sql,
    private readonly team: BusinessTeamService,
    private readonly options: BusinessPayoutsOptions,
  ) {}

  // ── Bulk runs (BK-bpay-01) ─────────────────────────────────────────────────

  /** Imports a CSV as a draft run under its own id. Nothing is held or sent. The same id on the same file is the same run. */
  async importRun(input: { accountId: string; userId: string; runId: string; csv: string }): Promise<BulkRun> {
    if (Buffer.byteLength(input.csv, 'utf8') > MAX_BULK_FILE_BYTES) {
      throw new BankError('A bulk payment file is at most 256 KiB.', 'bank.bulk_file_invalid');
    }
    const seat = await this.team.seat(input.accountId, input.userId);
    this.need(seat.permissions, 'propose');
    if (seat.account.status !== 'active') throw closed();
    const sha = sha256(input.csv);
    const prior = await this.runRowOrNull(this.sql, input.runId);
    if (prior) {
      if (prior.account_id !== input.accountId || prior.file_sha256 !== sha) throw conflict('run');
      return this.run(prior.id, input.userId);
    }
    const { lines, issues } = parseBulkCsv(input.csv, seat.account.assetId);
    const total = lines.reduce((sum, l) => sum + l.amount, 0n);
    await transaction(this.sql, async (tx) => {
      const made = await tx`
        INSERT INTO bank.business_bulk_runs (id, account_id, created_by, file_sha256, asset_id, amount, partner_key)
        VALUES (${input.runId}::uuid, ${input.accountId}::uuid, ${input.userId}, ${sha}, ${seat.account.assetId},
                ${formatAmount(total)}::numeric, ${bulkPayKey(input.runId)})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      if (made.length === 0) return;
      for (const l of lines) {
        await tx`
          INSERT INTO bank.business_bulk_lines (run_id, line, name, iban, amount, reference)
          VALUES (${input.runId}::uuid, ${l.line}, ${l.name}, ${l.iban}, ${formatAmount(l.amount)}::numeric, ${l.reference})
        `;
      }
      for (const i of issues) {
        await tx`
          INSERT INTO bank.business_bulk_issues (run_id, line, code, detail, raw)
          VALUES (${input.runId}::uuid, ${i.line}, ${i.code}, ${i.detail}, ${i.raw})
        `;
      }
    });
    const row = await this.runRow(this.sql, input.runId);
    if (row.account_id !== input.accountId || row.file_sha256 !== sha) throw conflict('run');
    return this.run(row.id, input.userId);
  }

  async runs(accountId: string, userId: string): Promise<BulkRun[]> {
    await this.team.seat(accountId, userId);
    const rows = await this.sql<RunRow[]>`
      SELECT * FROM bank.business_bulk_runs WHERE account_id = ${accountId}::uuid ORDER BY created_at DESC, id LIMIT 50
    `;
    return Promise.all(rows.map((r) => this.runView(r)));
  }

  async run(runId: string, userId: string): Promise<BulkRun> {
    const row = await this.runRow(this.sql, runId);
    await this.team.seat(row.account_id, userId);
    return this.runView(row);
  }

  /**
   * The funding step and the confirmation. The partner's figure for the business's account must cover the valid lines'
   * total, or nothing changes (`bank.bulk_run_unfunded`). At or above the business's threshold the run waits for an
   * approver; under it, the one instruction goes to the partner now. Confirming a run already sending sends it again
   * under the same key, which the partner makes at most once.
   */
  async confirmRun(input: { runId: string; userId: string }): Promise<BulkRun> {
    const prior = await this.runRow(this.sql, input.runId);
    const seat = await this.team.seat(prior.account_id, input.userId);
    this.need(seat.permissions, 'propose');
    if (prior.status === 'sending') {
      await this.moneyMayMove();
      await this.sendRun(prior, seat.partner);
      return this.run(prior.id, input.userId);
    }
    if (prior.status !== 'draft') return this.run(prior.id, input.userId);
    if (seat.account.status !== 'active') throw closed();
    if (!seat.partner) throw noPartner();
    const total = parseAmount(prior.amount);
    if (total === 0n) throw new BankError('No line of this file is valid, so there is nothing to send.', 'bank.bulk_run_empty');
    await this.moneyMayMove();
    const held = await seat.partner.balance(businessPartnerAccount(prior.account_id, prior.asset_id));
    if (held.amount === null || held.unavailable) {
      throw new BankError(
        `${seat.partner.label} has not reported this account’s balance, so the run is not sent.`,
        'bank.partner_unavailable',
      );
    }
    if (held.amount < total) {
      throw new BankError(
        `This run needs ${formatAmount(total)} ${prior.asset_id}; the account holds ${formatAmount(held.amount)} at ${seat.partner.label}. Add money, then confirm again. Nothing was sent.`,
        'bank.bulk_run_unfunded',
      );
    }
    const next = await transaction(this.sql, async (tx) => {
      const row = await this.runRow(tx, input.runId, true);
      if (row.status !== 'draft') return row;
      const account = await this.accountRow(tx, row.account_id);
      const threshold = parseAmount(account.spend_threshold);
      const needed = total >= threshold ? 1 : 0;
      if (needed > 0) {
        const pool = await this.team.approverPool(row.account_id, input.userId);
        if (pool.length < needed) {
          throw new BankError(
            `This run is at or above the business’s threshold of ${formatAmount(threshold)} ${row.asset_id}, so another approver must approve it, and this business has none besides you.`,
            'bank.business_approvers_short',
          );
        }
      }
      const status: BulkRunStatus = needed > 0 ? 'awaiting_approval' : 'sending';
      const rows = await tx<RunRow[]>`
        UPDATE bank.business_bulk_runs
           SET status = ${status}, approvals_needed = ${needed}, threshold = ${formatAmount(threshold)}::numeric,
               confirmed_by = ${input.userId}, confirmed_at = now()
         WHERE id = ${row.id}::uuid
         RETURNING *
      `;
      return rows[0]!;
    });
    if (next.status === 'sending') await this.sendRun(next, seat.partner);
    return this.run(input.runId, input.userId);
  }

  /** An approver's yes, never the person who confirmed it. The last one needed sends the run's one instruction. */
  async approveRun(input: { runId: string; userId: string }): Promise<BulkRun> {
    const prior = await this.runRow(this.sql, input.runId);
    const seat = await this.team.seat(prior.account_id, input.userId);
    if (prior.confirmed_by === input.userId) {
      throw new BankError('You confirmed this run, so you cannot approve it. Another approver must.', 'bank.business_self_approve');
    }
    this.need(seat.permissions, 'approve');
    if (prior.status !== 'awaiting_approval') {
      throw new BankError(`This run is ${prior.status.replace('_', ' ')}; it takes no approvals.`, 'bank.business_approval_inactive');
    }
    await this.moneyMayMove();
    const next = await transaction(this.sql, async (tx) => {
      const row = await this.runRow(tx, input.runId, true);
      if (row.status !== 'awaiting_approval') return row;
      await tx`
        INSERT INTO bank.business_bulk_approvals (run_id, approver_user_id) VALUES (${row.id}::uuid, ${input.userId})
        ON CONFLICT DO NOTHING
      `;
      const n = Number(
        (await tx<Array<{ n: string }>>`SELECT count(*)::text AS n FROM bank.business_bulk_approvals WHERE run_id = ${row.id}::uuid`)[0]!.n,
      );
      if (n < row.approvals_needed) return row;
      return (await tx<RunRow[]>`UPDATE bank.business_bulk_runs SET status = 'sending' WHERE id = ${row.id}::uuid RETURNING *`)[0]!;
    });
    if (next.status === 'sending') await this.sendRun(next, seat.partner);
    return this.run(input.runId, input.userId);
  }

  // ── Contractors and invoices (BK-bpay-02) ──────────────────────────────────

  async contractors(accountId: string, userId: string): Promise<Contractor[]> {
    await this.team.seat(accountId, userId);
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT * FROM bank.business_contractors WHERE account_id = ${accountId}::uuid ORDER BY created_at, id LIMIT 200
    `;
    const invoices = await this.sql<Array<Record<string, unknown>>>`
      SELECT id, contractor_id, number, asset_id, amount, due_date::text AS due_date, status, created_at
        FROM bank.business_contractor_invoices WHERE account_id = ${accountId}::uuid ORDER BY created_at, id
    `;
    return rows.map((r) => contractorView(r, invoices));
  }

  /** A contractor the business adds. The same id on the same details is the same contractor. */
  async addContractor(input: {
    accountId: string;
    userId: string;
    contractorId: string;
    name: string;
    email: string | null;
    iban: string | null;
    walletAddress: string | null;
  }): Promise<Contractor> {
    const seat = await this.team.seat(input.accountId, input.userId);
    this.need(seat.permissions, 'propose');
    if (seat.account.status !== 'active') throw closed();
    await this.insertContractor(this.sql, { ...input, onboarded: 'business' });
    return this.contractor(input.contractorId, input.userId);
  }

  async contractor(contractorId: string, userId: string): Promise<Contractor> {
    const row = (
      await this.sql<Array<Record<string, unknown>>>`SELECT * FROM bank.business_contractors WHERE id = ${contractorId}::uuid`
    )[0];
    if (!row) throw new BankError('No contractor of this business has that id.', 'bank.contractor_not_found');
    await this.team.seat(String(row.account_id), userId);
    const invoices = await this.sql<Array<Record<string, unknown>>>`
      SELECT id, contractor_id, number, asset_id, amount, due_date::text AS due_date, status, created_at
        FROM bank.business_contractor_invoices WHERE contractor_id = ${contractorId}::uuid ORDER BY created_at, id
    `;
    return contractorView(row, invoices);
  }

  /** An invoice stored against a contractor, in the business account's asset. The same id on the same terms is the same. */
  async addInvoice(input: {
    contractorId: string;
    userId: string;
    invoiceId: string;
    number: string;
    amount: Amount;
    dueDate: string | null;
  }): Promise<Contractor> {
    const number = input.number.trim();
    if (!number || number.length > 64) throw new BankError('An invoice number is 1 to 64 characters.', 'bank.contractor_field_invalid');
    if (input.amount <= 0n) throw new BankError('An invoice’s amount is above zero.', 'bank.contractor_field_invalid');
    if (input.dueDate !== null && !isDate(input.dueDate))
      throw new BankError('A due date is a calendar date.', 'bank.contractor_field_invalid');
    const c = (
      await this.sql<Array<{ account_id: string }>>`SELECT account_id FROM bank.business_contractors WHERE id = ${input.contractorId}::uuid`
    )[0];
    if (!c) throw new BankError('No contractor of this business has that id.', 'bank.contractor_not_found');
    const seat = await this.team.seat(c.account_id, input.userId);
    this.need(seat.permissions, 'propose');
    const prior = (
      await this.sql<Array<{ contractor_id: string; number: string; amount: string }>>`
      SELECT contractor_id, number, amount FROM bank.business_contractor_invoices WHERE id = ${input.invoiceId}::uuid
    `
    )[0];
    if (prior) {
      if (prior.contractor_id !== input.contractorId || prior.number !== number || parseAmount(prior.amount) !== input.amount)
        throw conflict('invoice');
      return this.contractor(input.contractorId, input.userId);
    }
    try {
      await this.sql`
        INSERT INTO bank.business_contractor_invoices (id, contractor_id, account_id, number, asset_id, amount, due_date, created_by)
        VALUES (${input.invoiceId}::uuid, ${input.contractorId}::uuid, ${c.account_id}::uuid, ${number}, ${seat.account.assetId},
                ${formatAmount(input.amount)}::numeric, ${input.dueDate}::date, ${input.userId})
      `;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new BankError(`This contractor already has an invoice numbered ${number}.`, 'bank.contractor_invoice_duplicate');
      }
      throw err;
    }
    return this.contractor(input.contractorId, input.userId);
  }

  /** A one-use onboarding link for a contractor to add themselves. Only its hash is kept; the token is shown once. */
  async createInvite(input: { accountId: string; userId: string }): Promise<{ inviteId: string; token: string }> {
    const seat = await this.team.seat(input.accountId, input.userId);
    this.need(seat.permissions, 'manage_team');
    if (seat.account.status !== 'active') throw closed();
    const token = randomBytes(24).toString('base64url');
    const inviteId = randomUUID();
    await this.sql`
      INSERT INTO bank.business_contractor_invites (id, account_id, token_sha256, created_by)
      VALUES (${inviteId}::uuid, ${input.accountId}::uuid, ${sha256(token)}, ${input.userId})
    `;
    return { inviteId, token };
  }

  /** What an onboarding link says, before the contractor fills it in: the business's name, and whether it is still open. */
  async inviteInfo(token: string): Promise<{ businessName: string; open: boolean }> {
    const row = (
      await this.sql<Array<{ name: string; used_at: Date | null; status: string }>>`
      SELECT a.name, i.used_at, a.status FROM bank.business_contractor_invites i JOIN bank.business_accounts a ON a.id = i.account_id
       WHERE i.token_sha256 = ${sha256(token)}
    `
    )[0];
    if (!row) throw new BankError('This onboarding link is not one we know.', 'bank.contractor_invite_invalid');
    return { businessName: row.name, open: row.used_at === null && row.status === 'active' };
  }

  /** The contractor adds themselves through the link, once. They give their own payout IBAN and wallet. */
  async joinAsContractor(input: {
    token: string;
    userId: string;
    name: string;
    email: string | null;
    iban: string | null;
    walletAddress: string | null;
  }): Promise<{ contractorId: string; businessName: string }> {
    return transaction(this.sql, async (tx) => {
      const invite = (
        await tx<Array<{ id: string; account_id: string; used_at: Date | null; contractor_id: string | null; joined_by: string | null }>>`
        SELECT id, account_id, used_at, contractor_id, joined_by FROM bank.business_contractor_invites
         WHERE token_sha256 = ${sha256(input.token)} FOR UPDATE
      `
      )[0];
      if (!invite) throw new BankError('This onboarding link is not one we know.', 'bank.contractor_invite_invalid');
      const account = await this.accountRow(tx, invite.account_id);
      if (invite.used_at) {
        if (invite.joined_by === input.userId && invite.contractor_id)
          return { contractorId: invite.contractor_id, businessName: account.name };
        throw new BankError('This onboarding link was already used.', 'bank.contractor_invite_used');
      }
      if (account.status !== 'active') throw closed();
      const contractorId = randomUUID();
      await this.insertContractor(tx, { ...input, accountId: invite.account_id, contractorId, onboarded: 'self' });
      await tx`
        UPDATE bank.business_contractor_invites SET joined_by = ${input.userId}, contractor_id = ${contractorId}::uuid, used_at = now()
         WHERE id = ${invite.id}::uuid
      `;
      return { contractorId, businessName: account.name };
    });
  }

  async batches(accountId: string, userId: string): Promise<ContractorBatch[]> {
    await this.team.seat(accountId, userId);
    const rows = await this.sql<BatchRow[]>`
      SELECT * FROM bank.business_contractor_batches WHERE account_id = ${accountId}::uuid ORDER BY created_at DESC, id LIMIT 50
    `;
    return Promise.all(rows.map((r) => this.batchView(r)));
  }

  async batch(batchId: string, userId: string): Promise<ContractorBatch> {
    const row = await this.batchRow(this.sql, batchId);
    await this.team.seat(row.account_id, userId);
    return this.batchView(row);
  }

  /**
   * Pays a batch of open invoices. The intent row is written first, with its key and the business's approval rule fixed
   * then. With approvals needed it waits for them; otherwise it goes to the partner's payout rail now, as one instruction.
   */
  async payBatch(input: { accountId: string; userId: string; batchId: string; invoiceIds: readonly string[] }): Promise<ContractorBatch> {
    const ids = [...new Set(input.invoiceIds.map((i) => i.toLowerCase()))].sort();
    if (ids.length === 0 || ids.length > MAX_BATCH_INVOICES) {
      throw new BankError(`A batch pays 1 to ${MAX_BATCH_INVOICES} invoices.`, 'bank.contractor_field_invalid');
    }
    const seat = await this.team.seat(input.accountId, input.userId);
    this.need(seat.permissions, 'propose');
    const prior = await this.batchRowOrNull(this.sql, input.batchId);
    if (prior) {
      const lines = await this.sql<
        Array<{ invoice_id: string }>
      >`SELECT invoice_id FROM bank.business_contractor_batch_lines WHERE batch_id = ${prior.id}::uuid ORDER BY invoice_id`;
      if (prior.account_id !== input.accountId || lines.map((l) => l.invoice_id).join() !== ids.join()) throw conflict('batch');
      if (prior.status === 'sending') {
        await this.moneyMayMove();
        await this.sendBatch(prior, seat.partner);
      }
      return this.batch(prior.id, input.userId);
    }
    if (seat.account.status !== 'active') throw closed();
    if (seat.partner) await this.moneyMayMove();
    const rules = await this.team.ruleList(input.accountId);
    const created = await transaction(this.sql, async (tx) => {
      const invoices = await tx<
        Array<{ id: string; account_id: string; status: InvoiceStatus; amount: string; asset_id: string; iban: string | null }>
      >`
        SELECT i.id, i.account_id, i.status, i.amount, i.asset_id, c.iban FROM bank.business_contractor_invoices i
          JOIN bank.business_contractors c ON c.id = i.contractor_id
         WHERE i.id = ANY(${ids}::uuid[]) ORDER BY i.id FOR UPDATE OF i
      `;
      if (invoices.length !== ids.length || invoices.some((i) => i.account_id !== input.accountId)) {
        throw new BankError('Every invoice in a batch is this business’s.', 'bank.contractor_not_found');
      }
      const taken = invoices.find((i) => i.status !== 'open');
      if (taken) throw new BankError('An invoice in this batch is already being paid or paid.', 'bank.contractor_invoice_not_open');
      if (invoices.some((i) => !i.iban)) {
        throw new BankError(
          'A contractor in this batch has no payout IBAN, so the payout rail cannot pay them.',
          'bank.contractor_field_invalid',
        );
      }
      if (invoices.some((i) => i.asset_id !== seat.account.assetId)) {
        throw new BankError(`Every invoice is in ${seat.account.assetId}, the account’s asset.`, 'bank.asset_mismatch');
      }
      const total = invoices.reduce((sum, i) => sum + parseAmount(i.amount), 0n);
      const rule = pickRule(
        rules.map((r) => ({ ...r, over_amount: formatAmount(r.overAmount), payment_type: r.paymentType })),
        { amount: total, payee: '', paymentType: 'payroll' },
      );
      const needed = rule?.approvals ?? 0;
      if (needed > 0) {
        const pool = await this.team.approverPool(input.accountId, input.userId);
        if (pool.length < needed) {
          throw new BankError(
            `This batch needs ${needed} approver(s) other than you under the business’s rules, and this business has ${pool.length}.`,
            'bank.business_approvers_short',
          );
        }
      }
      const status: ContractorBatchStatus = needed > 0 ? 'awaiting_approval' : seat.partner ? 'sending' : 'refused';
      // The intent row, before anything reaches the partner.
      const rows = await tx<BatchRow[]>`
        INSERT INTO bank.business_contractor_batches
          (id, account_id, created_by, asset_id, amount, status, approvals_needed, rule_id, partner_key, refusal_code, answered_at)
        VALUES (${input.batchId}::uuid, ${input.accountId}::uuid, ${input.userId}, ${seat.account.assetId}, ${formatAmount(total)}::numeric,
                ${status}, ${needed}, ${rule?.id ?? null}::uuid, ${contractorBatchKey(input.batchId)},
                ${status === 'refused' ? 'rail.bank' : null}, ${status === 'refused' ? new Date() : null})
        RETURNING *
      `;
      for (const i of invoices) {
        await tx`INSERT INTO bank.business_contractor_batch_lines (batch_id, invoice_id, amount) VALUES (${input.batchId}::uuid, ${i.id}::uuid, ${i.amount}::numeric)`;
      }
      if (status !== 'refused') {
        await tx`UPDATE bank.business_contractor_invoices SET status = 'in_batch' WHERE id = ANY(${ids}::uuid[])`;
      }
      return rows[0]!;
    });
    if (created.status === 'sending') await this.sendBatch(created, seat.partner);
    return this.batch(input.batchId, input.userId);
  }

  /** One distinct approver's yes, never the person who made the batch. The last one needed sends it to the payout rail. */
  async approveBatch(input: { batchId: string; userId: string }): Promise<ContractorBatch> {
    const prior = await this.batchRow(this.sql, input.batchId);
    const seat = await this.team.seat(prior.account_id, input.userId);
    if (prior.created_by === input.userId) {
      throw new BankError('You made this batch, so you cannot approve it. Another approver must.', 'bank.business_self_approve');
    }
    this.need(seat.permissions, 'approve');
    if (prior.status !== 'awaiting_approval') {
      throw new BankError(`This batch is ${prior.status.replace('_', ' ')}; it takes no approvals.`, 'bank.business_approval_inactive');
    }
    if (seat.partner) await this.moneyMayMove();
    const next = await transaction(this.sql, async (tx) => {
      const row = await this.batchRow(tx, input.batchId, true);
      if (row.status !== 'awaiting_approval') return row;
      const added = await tx`
        INSERT INTO bank.business_contractor_batch_approvals (batch_id, approver_user_id) VALUES (${row.id}::uuid, ${input.userId})
        ON CONFLICT DO NOTHING RETURNING batch_id
      `;
      if (added.length === 0) {
        throw new BankError(
          'You have already approved this batch. A different approver must give the next approval.',
          'bank.business_already_approved',
        );
      }
      const n = Number(
        (
          await tx<
            Array<{ n: string }>
          >`SELECT count(*)::text AS n FROM bank.business_contractor_batch_approvals WHERE batch_id = ${row.id}::uuid`
        )[0]!.n,
      );
      if (n < row.approvals_needed) return row;
      if (!seat.partner) {
        await tx`UPDATE bank.business_contractor_invoices SET status = 'open' WHERE id IN (SELECT invoice_id FROM bank.business_contractor_batch_lines WHERE batch_id = ${row.id}::uuid)`;
        return (
          await tx<BatchRow[]>`
          UPDATE bank.business_contractor_batches SET status = 'refused', refusal_code = 'rail.bank', answered_at = now() WHERE id = ${row.id}::uuid RETURNING *
        `
        )[0]!;
      }
      return (
        await tx<BatchRow[]>`UPDATE bank.business_contractor_batches SET status = 'sending' WHERE id = ${row.id}::uuid RETURNING *`
      )[0]!;
    });
    if (next.status === 'sending') await this.sendBatch(next, seat.partner);
    return this.batch(input.batchId, input.userId);
  }

  // ── Crypto payroll (RC-bank-05) ────────────────────────────────────────────

  async wallet(accountId: string, userId: string): Promise<PayrollWallet | null> {
    await this.team.seat(accountId, userId);
    return this.walletOf(this.sql, accountId);
  }

  /** The message the business's own wallet signs to connect it. Each offer is new; nothing is connected until it is signed. */
  async walletOffer(input: { accountId: string; userId: string; address: string }): Promise<{ offerId: string; message: string }> {
    const address = input.address.trim().toLowerCase();
    if (!isEvmAddressRef(address)) throw new BankError('A wallet address is 0x and 40 hex digits.', 'bank.payroll_wallet_invalid');
    const seat = await this.team.seat(input.accountId, input.userId);
    this.need(seat.permissions, 'manage_team');
    const offerId = randomUUID();
    const message = walletConnectMessage(input.accountId, address, offerId);
    await this.sql`
      INSERT INTO bank.business_payroll_wallet_offers (id, account_id, address, message, created_by)
      VALUES (${offerId}::uuid, ${input.accountId}::uuid, ${address}, ${message}, ${input.userId})
    `;
    return { offerId, message };
  }

  /** Connects the wallet that signed the offer. Another signer is refused and nothing changes. */
  async connectWallet(input: { offerId: string; userId: string; signature: string }): Promise<PayrollWallet> {
    const offer = (
      await this.sql<Array<{ account_id: string; address: string; message: string }>>`
      SELECT account_id, address, message FROM bank.business_payroll_wallet_offers WHERE id = ${input.offerId}::uuid
    `
    )[0];
    if (!offer) throw new BankError('No wallet offer of this business has that id.', 'bank.payroll_wallet_invalid');
    const seat = await this.team.seat(offer.account_id, input.userId);
    this.need(seat.permissions, 'manage_team');
    if (recoverPersonalSignAddress(offer.message, input.signature) !== offer.address) {
      throw new BankError('That signature is not from the wallet named. Nothing was connected.', 'bank.payroll_signature_invalid');
    }
    await transaction(this.sql, async (tx) => {
      await tx`UPDATE bank.business_payroll_wallet_offers SET used_at = now() WHERE id = ${input.offerId}::uuid AND used_at IS NULL`;
      await tx`
        INSERT INTO bank.business_payroll_wallets (account_id, address, offer_id, signature, connected_by)
        VALUES (${offer.account_id}::uuid, ${offer.address}, ${input.offerId}::uuid, ${input.signature.trim()}, ${input.userId})
        ON CONFLICT (account_id) DO UPDATE
          SET address = EXCLUDED.address, offer_id = EXCLUDED.offer_id, signature = EXCLUDED.signature,
              connected_by = EXCLUDED.connected_by, connected_at = now()
      `;
    });
    return (await this.walletOf(this.sql, offer.account_id))!;
  }

  async payrolls(accountId: string, userId: string): Promise<CryptoPayroll[]> {
    await this.team.seat(accountId, userId);
    const rows = await this.sql<Array<{ id: string }>>`
      SELECT id FROM bank.business_crypto_payrolls WHERE account_id = ${accountId}::uuid ORDER BY created_at, id LIMIT 50
    `;
    return Promise.all(rows.map((r) => this.payrollView(r.id)));
  }

  /** A recurring payroll: its members are contractors with a wallet, paid monthly on a day from the business's own wallet. */
  async createPayroll(input: {
    accountId: string;
    userId: string;
    payrollId: string;
    name: string;
    dayOfMonth: number;
    members: ReadonlyArray<{ contractorId: string; amount: Amount }>;
  }): Promise<CryptoPayroll> {
    const name = input.name.trim();
    if (!name || name.length > 128) throw new BankError('A payroll’s name is 1 to 128 characters.', 'bank.contractor_field_invalid');
    if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 28) {
      throw new BankError('A payroll runs on day 1 to 28 of the month.', 'bank.contractor_field_invalid');
    }
    if (input.members.length === 0 || input.members.length > MAX_PAYROLL_MEMBERS) {
      throw new BankError(`A payroll pays 1 to ${MAX_PAYROLL_MEMBERS} people.`, 'bank.contractor_field_invalid');
    }
    const seat = await this.team.seat(input.accountId, input.userId);
    this.need(seat.permissions, 'manage_team');
    if (seat.account.status !== 'active') throw closed();
    if (!(await this.walletOf(this.sql, input.accountId))) {
      throw new BankError('Connect the business’s own wallet first: it signs every run.', 'bank.payroll_wallet_missing');
    }
    const prior = (
      await this.sql<
        Array<{ account_id: string; name: string }>
      >`SELECT account_id, name FROM bank.business_crypto_payrolls WHERE id = ${input.payrollId}::uuid`
    )[0];
    if (prior) {
      if (prior.account_id !== input.accountId || prior.name !== name) throw conflict('payroll');
      return this.payrollView(input.payrollId);
    }
    await transaction(this.sql, async (tx) => {
      const ids = input.members.map((m) => m.contractorId.toLowerCase());
      if (new Set(ids).size !== ids.length) throw new BankError('A person is in a payroll once.', 'bank.contractor_field_invalid');
      const people = await tx<Array<{ id: string; account_id: string; wallet_address: string | null }>>`
        SELECT id, account_id, wallet_address FROM bank.business_contractors WHERE id = ANY(${ids}::uuid[])
      `;
      if (people.length !== ids.length || people.some((p) => p.account_id !== input.accountId)) {
        throw new BankError('Every member is a contractor of this business.', 'bank.contractor_not_found');
      }
      if (people.some((p) => !p.wallet_address)) {
        throw new BankError('Every member needs a wallet address to be paid in crypto.', 'bank.contractor_wallet_missing');
      }
      for (const m of input.members)
        if (m.amount <= 0n) throw new BankError('Each member’s amount is above zero.', 'bank.contractor_field_invalid');
      await tx`
        INSERT INTO bank.business_crypto_payrolls (id, account_id, name, asset_id, day_of_month, created_by)
        VALUES (${input.payrollId}::uuid, ${input.accountId}::uuid, ${name}, ${seat.account.assetId}, ${input.dayOfMonth}, ${input.userId})
      `;
      for (const m of input.members) {
        await tx`
          INSERT INTO bank.business_crypto_payroll_members (payroll_id, contractor_id, amount)
          VALUES (${input.payrollId}::uuid, ${m.contractorId}::uuid, ${formatAmount(m.amount)}::numeric)
        `;
      }
    });
    return this.payrollView(input.payrollId);
  }

  /**
   * One month's run: its payslips and the message the business's own wallet signs, under the run key. The same month
   * again is the same run; nothing is sent, held or posted.
   */
  async prepareRun(input: { payrollId: string; userId: string; period: string }): Promise<CryptoPayroll> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period))
      throw new BankError('A period is a month, YYYY-MM.', 'bank.contractor_field_invalid');
    const payroll = (
      await this.sql<Array<{ account_id: string; asset_id: string }>>`
      SELECT account_id, asset_id FROM bank.business_crypto_payrolls WHERE id = ${input.payrollId}::uuid
    `
    )[0];
    if (!payroll) throw new BankError('No payroll of this business has that id.', 'bank.contractor_not_found');
    const seat = await this.team.seat(payroll.account_id, input.userId);
    this.need(seat.permissions, 'propose');
    const wallet = await this.walletOf(this.sql, payroll.account_id);
    if (!wallet) throw new BankError('Connect the business’s own wallet first: it signs every run.', 'bank.payroll_wallet_missing');
    const runKey = cryptoPayrollKey(input.payrollId, input.period);
    await transaction(this.sql, async (tx) => {
      const exists = await tx`SELECT 1 FROM bank.business_crypto_payroll_runs WHERE run_key = ${runKey}`;
      if (exists.length > 0) return;
      const members = await tx<Array<{ contractor_id: string; name: string; wallet_address: string; amount: string }>>`
        SELECT m.contractor_id, c.name, c.wallet_address, m.amount FROM bank.business_crypto_payroll_members m
          JOIN bank.business_contractors c ON c.id = m.contractor_id
         WHERE m.payroll_id = ${input.payrollId}::uuid ORDER BY c.created_at, c.id
      `;
      const payslips = members.map((m) => ({ ...m, amount: parseAmount(m.amount) }));
      const total = payslips.reduce((sum, p) => sum + p.amount, 0n);
      const message = payrollRunMessage({
        runKey,
        business: seat.account.name,
        wallet: wallet.address,
        assetId: payroll.asset_id,
        period: input.period,
        payslips: payslips.map((p) => ({ walletAddress: p.wallet_address, amount: p.amount })),
        total,
      });
      const runId = randomUUID();
      const made = await tx`
        INSERT INTO bank.business_crypto_payroll_runs (id, payroll_id, period, run_key, wallet_address, message, amount, created_by)
        VALUES (${runId}::uuid, ${input.payrollId}::uuid, ${input.period}, ${runKey}, ${wallet.address}, ${message},
                ${formatAmount(total)}::numeric, ${input.userId})
        ON CONFLICT (run_key) DO NOTHING RETURNING id
      `;
      if (made.length === 0) return;
      for (const p of payslips) {
        await tx`
          INSERT INTO bank.business_crypto_payslips (run_id, contractor_id, name, wallet_address, asset_id, amount)
          VALUES (${runId}::uuid, ${p.contractor_id}::uuid, ${p.name}, ${p.wallet_address}, ${payroll.asset_id}, ${formatAmount(p.amount)}::numeric)
        `;
      }
    });
    return this.payrollView(input.payrollId);
  }

  /** The business's own wallet signs the run. Any other signer is refused and the run stays unsigned. */
  async signRun(input: { runId: string; userId: string; signature: string }): Promise<CryptoPayroll> {
    const run = (
      await this.sql<Array<PayrollRunRow & { account_id: string }>>`
      SELECT r.*, p.account_id FROM bank.business_crypto_payroll_runs r JOIN bank.business_crypto_payrolls p ON p.id = r.payroll_id
       WHERE r.id = ${input.runId}::uuid
    `
    )[0];
    if (!run) throw new BankError('No payroll run of this business has that id.', 'bank.contractor_not_found');
    const seat = await this.team.seat(run.account_id, input.userId);
    this.need(seat.permissions, 'propose');
    if (run.status === 'signed') return this.payrollView(run.payroll_id);
    // Signed by the business's own wallet as it is now: a run prepared for a wallet since replaced is not signed by it.
    const current = await this.walletOf(this.sql, run.account_id);
    if (!current || current.address !== run.wallet_address) {
      throw new BankError(
        'The business’s wallet changed since this run was prepared. Prepare a new run for the wallet connected now.',
        'bank.payroll_wallet_missing',
      );
    }
    if (recoverPersonalSignAddress(run.message, input.signature) !== run.wallet_address) {
      throw new BankError(
        'That signature is not from the business’s own wallet. The run stays unsigned.',
        'bank.payroll_signature_invalid',
      );
    }
    await this.sql`
      UPDATE bank.business_crypto_payroll_runs SET status = 'signed', signature = ${input.signature.trim()}, signed_at = now()
       WHERE id = ${run.id}::uuid AND status = 'awaiting_signature'
    `;
    return this.payrollView(run.payroll_id);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async sendRun(row: RunRow, partner: PartnerBank | null): Promise<void> {
    if (!partner) throw noPartner();
    const lines = await this.sql<Array<{ name: string; iban: string; amount: string; reference: string | null }>>`
      SELECT name, iban, amount, reference FROM bank.business_bulk_lines WHERE run_id = ${row.id}::uuid ORDER BY line
    `;
    const payees = lines.map((l) => ({ name: l.name, iban: l.iban, amount: parseAmount(l.amount), reference: l.reference }));
    const answer = await this.sendOnce(partner, row.partner_key, row.account_id, row.asset_id, parseAmount(row.amount), payees);
    if (answer.declined) {
      await this.sql`
        UPDATE bank.business_bulk_runs SET status = 'declined', partner_reason = ${answer.declined.code},
               partner_reason_text = ${answer.declined.text}, answered_at = now()
         WHERE id = ${row.id}::uuid AND status = 'sending'
      `;
      return;
    }
    await this.sql`
      UPDATE bank.business_bulk_runs SET status = 'sent', partner_move_id = ${answer.move.id}, partner_payees = ${answer.move.payees?.length ?? null},
             sent_at = ${answer.move.movedAt}, answered_at = now()
       WHERE id = ${row.id}::uuid AND status = 'sending'
    `;
  }

  private async sendBatch(row: BatchRow, partner: PartnerBank | null): Promise<void> {
    if (!partner) throw noPartner();
    const lines = await this.sql<Array<{ name: string; iban: string; amount: string; number: string }>>`
      SELECT c.name, c.iban, l.amount, i.number FROM bank.business_contractor_batch_lines l
        JOIN bank.business_contractor_invoices i ON i.id = l.invoice_id
        JOIN bank.business_contractors c ON c.id = i.contractor_id
       WHERE l.batch_id = ${row.id}::uuid ORDER BY i.id
    `;
    const payees = lines.map((l) => ({ name: l.name, iban: l.iban, amount: parseAmount(l.amount), reference: l.number }));
    const answer = await this.sendOnce(partner, row.partner_key, row.account_id, row.asset_id, parseAmount(row.amount), payees);
    await transaction(this.sql, async (tx) => {
      if (answer.declined) {
        const done = await tx`
          UPDATE bank.business_contractor_batches SET status = 'declined', refusal_code = ${answer.declined.code},
                 partner_reason_text = ${answer.declined.text}, answered_at = now()
           WHERE id = ${row.id}::uuid AND status = 'sending' RETURNING id
        `;
        if (done.length > 0) {
          await tx`UPDATE bank.business_contractor_invoices SET status = 'open' WHERE id IN (SELECT invoice_id FROM bank.business_contractor_batch_lines WHERE batch_id = ${row.id}::uuid)`;
        }
        return;
      }
      const done = await tx`
        UPDATE bank.business_contractor_batches SET status = 'sent', partner_move_id = ${answer.move.id}, partner_payees = ${answer.move.payees?.length ?? null},
               sent_at = ${answer.move.movedAt}, answered_at = now()
         WHERE id = ${row.id}::uuid AND status = 'sending' RETURNING id
      `;
      if (done.length > 0) {
        await tx`UPDATE bank.business_contractor_invoices SET status = 'paid' WHERE id IN (SELECT invoice_id FROM bank.business_contractor_batch_lines WHERE batch_id = ${row.id}::uuid)`;
      }
    });
  }

  /**
   * One instruction to the partner under its key, from the business's account to the partner's outbound payments. A retry
   * first asks the partner for the move under this key: an answer that was lost is never sent again blind. A definite
   * refusal comes back as `declined`; anything else that fails throws, and the row stays `sending` to be read back.
   */
  private async sendOnce(
    partner: PartnerBank,
    key: string,
    accountId: string,
    assetId: string,
    amount: Amount,
    payees: readonly PartnerPayee[],
  ): Promise<
    | { declined: null; move: { id: string; movedAt: Date; payees?: readonly PartnerPayee[] | undefined } }
    | { declined: { code: string; text: string }; move: null }
  > {
    try {
      const move =
        (await partner.moveByKey(key)) ??
        (await partner.move({ key, from: businessPartnerAccount(accountId, assetId), to: partnerPayoutsAccount(assetId), amount, payees }));
      return { declined: null, move };
    } catch (err) {
      if (err instanceof BankError && DEFINITE_REFUSALS.has(err.code)) {
        return { declined: { code: err.code, text: err.message.slice(0, 500) }, move: null };
      }
      throw err;
    }
  }

  private async insertContractor(
    sql: Queryable,
    input: {
      accountId: string;
      userId: string;
      contractorId: string;
      name: string;
      email: string | null;
      iban: string | null;
      walletAddress: string | null;
      onboarded: 'business' | 'self';
    },
  ): Promise<void> {
    const name = input.name.trim();
    const email = input.email?.trim() || null;
    const iban = input.iban ? input.iban.replace(/\s+/g, '').toUpperCase() : null;
    const wallet = input.walletAddress?.trim().toLowerCase() || null;
    if (!NAME_RE.test(name)) throw new BankError('A contractor’s name is 1 to 140 characters.', 'bank.contractor_field_invalid');
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      throw new BankError('That email address does not look right.', 'bank.contractor_field_invalid');
    }
    if (iban && !isIbanRef(iban)) throw new BankError('The IBAN does not check out.', 'bank.contractor_field_invalid');
    if (wallet && !isEvmAddressRef(wallet))
      throw new BankError('A wallet address is 0x and 40 hex digits.', 'bank.contractor_field_invalid');
    if (!iban && !wallet) throw new BankError('A contractor needs a payout IBAN or a wallet address.', 'bank.contractor_field_invalid');
    const rows = await sql<Array<{ account_id: string; name: string; iban: string | null; wallet_address: string | null }>>`
      INSERT INTO bank.business_contractors (id, account_id, name, email, iban, wallet_address, onboarded, created_by)
      VALUES (${input.contractorId}::uuid, ${input.accountId}::uuid, ${name}, ${email}, ${iban}, ${wallet}, ${input.onboarded}, ${input.userId})
      ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
      RETURNING account_id, name, iban, wallet_address
    `;
    const r = rows[0]!;
    if (r.account_id !== input.accountId || r.name !== name || r.iban !== iban || r.wallet_address !== wallet) throw conflict('contractor');
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

  private async accountRow(sql: Queryable, accountId: string): Promise<AccountRow> {
    const row = (
      await sql<AccountRow[]>`
      SELECT id, name, asset_id, status, spend_threshold, owner_user_id FROM bank.business_accounts WHERE id = ${accountId}::uuid
    `
    )[0];
    if (!row) throw new BankError('No business account has that id.', 'bank.business_not_found');
    return row;
  }

  private async runRowOrNull(sql: Queryable, runId: string, lock = false): Promise<RunRow | null> {
    const rows = lock
      ? await sql<RunRow[]>`SELECT * FROM bank.business_bulk_runs WHERE id = ${runId}::uuid FOR UPDATE`
      : await sql<RunRow[]>`SELECT * FROM bank.business_bulk_runs WHERE id = ${runId}::uuid`;
    return rows[0] ?? null;
  }

  private async runRow(sql: Queryable, runId: string, lock = false): Promise<RunRow> {
    const row = await this.runRowOrNull(sql, runId, lock);
    if (!row) throw new BankError('No bulk payment run of this business has that id.', 'bank.bulk_run_not_found');
    return row;
  }

  private async batchRowOrNull(sql: Queryable, batchId: string, lock = false): Promise<BatchRow | null> {
    const rows = lock
      ? await sql<BatchRow[]>`SELECT * FROM bank.business_contractor_batches WHERE id = ${batchId}::uuid FOR UPDATE`
      : await sql<BatchRow[]>`SELECT * FROM bank.business_contractor_batches WHERE id = ${batchId}::uuid`;
    return rows[0] ?? null;
  }

  private async batchRow(sql: Queryable, batchId: string, lock = false): Promise<BatchRow> {
    const row = await this.batchRowOrNull(sql, batchId, lock);
    if (!row) throw new BankError('No contractor batch of this business has that id.', 'bank.contractor_not_found');
    return row;
  }

  private async walletOf(sql: Sql, accountId: string): Promise<PayrollWallet | null> {
    const row = (
      await sql<Array<{ address: string; connected_at: Date }>>`
      SELECT address, connected_at FROM bank.business_payroll_wallets WHERE account_id = ${accountId}::uuid
    `
    )[0];
    return row ? { address: row.address, connectedAt: row.connected_at } : null;
  }

  private async runView(row: RunRow): Promise<BulkRun> {
    const lines = await this.sql<Array<{ line: number; name: string; iban: string; amount: string; reference: string | null }>>`
      SELECT line, name, iban, amount, reference FROM bank.business_bulk_lines WHERE run_id = ${row.id}::uuid ORDER BY line
    `;
    const issues = await this.sql<Array<{ line: number; code: BulkLineCode; detail: string; raw: string }>>`
      SELECT line, code, detail, raw FROM bank.business_bulk_issues WHERE run_id = ${row.id}::uuid ORDER BY line
    `;
    const approvals = await this.sql<Array<{ approver_user_id: string; approved_at: Date }>>`
      SELECT approver_user_id, approved_at FROM bank.business_bulk_approvals WHERE run_id = ${row.id}::uuid ORDER BY approved_at
    `;
    return {
      id: row.id,
      accountId: row.account_id,
      assetId: row.asset_id,
      fileSha256: row.file_sha256,
      status: row.status,
      total: parseAmount(row.amount),
      lines: lines.map((l) => ({ ...l, amount: parseAmount(l.amount) })),
      issues: issues.map((i) => ({ ...i })),
      threshold: row.threshold === null ? null : parseAmount(row.threshold),
      approvalsNeeded: row.approvals_needed,
      confirmedBy: row.confirmed_by,
      approvals: approvals.map((a) => ({ userId: a.approver_user_id, approvedAt: a.approved_at })),
      partnerKey: row.partner_key,
      partnerMoveId: row.partner_move_id,
      partnerPayees: row.partner_payees,
      partnerReason: row.partner_reason,
      partnerReasonText: row.partner_reason_text,
      createdAt: row.created_at,
      sentAt: row.sent_at,
    };
  }

  private async batchView(row: BatchRow): Promise<ContractorBatch> {
    const lines = await this.sql<Array<{ invoice_id: string; name: string; number: string; amount: string }>>`
      SELECT l.invoice_id, c.name, i.number, l.amount FROM bank.business_contractor_batch_lines l
        JOIN bank.business_contractor_invoices i ON i.id = l.invoice_id
        JOIN bank.business_contractors c ON c.id = i.contractor_id
       WHERE l.batch_id = ${row.id}::uuid ORDER BY c.name, i.number
    `;
    const approvals = await this.sql<Array<{ approver_user_id: string; approved_at: Date }>>`
      SELECT approver_user_id, approved_at FROM bank.business_contractor_batch_approvals WHERE batch_id = ${row.id}::uuid ORDER BY approved_at
    `;
    return {
      id: row.id,
      accountId: row.account_id,
      assetId: row.asset_id,
      total: parseAmount(row.amount),
      status: row.status,
      approvalsNeeded: row.approvals_needed,
      ruleId: row.rule_id,
      createdBy: row.created_by,
      approvals: approvals.map((a) => ({ userId: a.approver_user_id, approvedAt: a.approved_at })),
      lines: lines.map((l) => ({ invoiceId: l.invoice_id, contractorName: l.name, number: l.number, amount: parseAmount(l.amount) })),
      partnerKey: row.partner_key,
      partnerMoveId: row.partner_move_id,
      partnerPayees: row.partner_payees,
      refusalCode: row.refusal_code,
      partnerReasonText: row.partner_reason_text,
      createdAt: row.created_at,
      sentAt: row.sent_at,
    };
  }

  private async payrollView(payrollId: string): Promise<CryptoPayroll> {
    const p = (
      await this.sql<Array<{ id: string; account_id: string; name: string; asset_id: string; day_of_month: number; created_at: Date }>>`
      SELECT id, account_id, name, asset_id, day_of_month, created_at FROM bank.business_crypto_payrolls WHERE id = ${payrollId}::uuid
    `
    )[0];
    if (!p) throw new BankError('No payroll of this business has that id.', 'bank.contractor_not_found');
    const members = await this.sql<Array<{ contractor_id: string; name: string; wallet_address: string | null; amount: string }>>`
      SELECT m.contractor_id, c.name, c.wallet_address, m.amount FROM bank.business_crypto_payroll_members m
        JOIN bank.business_contractors c ON c.id = m.contractor_id
       WHERE m.payroll_id = ${payrollId}::uuid ORDER BY c.created_at, c.id
    `;
    const runs = await this.sql<PayrollRunRow[]>`
      SELECT * FROM bank.business_crypto_payroll_runs WHERE payroll_id = ${payrollId}::uuid ORDER BY period DESC LIMIT 24
    `;
    const slips = runs.length
      ? await this.sql<
          Array<{ run_id: string; contractor_id: string; name: string; wallet_address: string; asset_id: string; amount: string }>
        >`
          SELECT run_id, contractor_id, name, wallet_address, asset_id, amount FROM bank.business_crypto_payslips
           WHERE run_id = ANY(${runs.map((r) => r.id)}::uuid[]) ORDER BY name, contractor_id
        `
      : [];
    return {
      id: p.id,
      accountId: p.account_id,
      name: p.name,
      assetId: p.asset_id,
      dayOfMonth: p.day_of_month,
      members: members.map((m) => ({
        contractorId: m.contractor_id,
        name: m.name,
        walletAddress: m.wallet_address,
        amount: parseAmount(m.amount),
      })),
      runs: runs.map((r) => ({
        id: r.id,
        payrollId: r.payroll_id,
        period: r.period,
        runKey: r.run_key,
        walletAddress: r.wallet_address,
        message: r.message,
        total: parseAmount(r.amount),
        status: r.status,
        signature: r.signature,
        signedAt: r.signed_at,
        createdAt: r.created_at,
        payslips: slips
          .filter((s) => s.run_id === r.id)
          .map((s) => ({
            contractorId: s.contractor_id,
            name: s.name,
            walletAddress: s.wallet_address,
            assetId: s.asset_id,
            amount: parseAmount(s.amount),
          })),
      })),
      createdAt: p.created_at,
    };
  }
}

function contractorView(r: Record<string, unknown>, invoices: ReadonlyArray<Record<string, unknown>>): Contractor {
  const iban = (r.iban as string | null) ?? null;
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    name: String(r.name),
    email: (r.email as string | null) ?? null,
    ibanLast4: iban ? iban.slice(-4) : null,
    walletAddress: (r.wallet_address as string | null) ?? null,
    onboarded: r.onboarded as 'business' | 'self',
    createdAt: r.created_at as Date,
    invoices: invoices
      .filter((i) => i.contractor_id === r.id)
      .map((i) => ({
        id: String(i.id),
        contractorId: String(i.contractor_id),
        number: String(i.number),
        assetId: String(i.asset_id),
        amount: parseAmount(String(i.amount)),
        dueDate: (i.due_date as string | null) ?? null,
        status: i.status as InvoiceStatus,
        createdAt: i.created_at as Date,
      })),
  };
}

function closed(): BankError {
  return new BankError('This business account is closed.', 'bank.business_closed');
}

function noPartner(): BankError {
  return new BankError(
    'This business’s money is not held at a partner bank, so nothing can be paid from it.',
    NO_PARTNER_BANK_CODE as 'bank.no_partner_bank',
  );
}
