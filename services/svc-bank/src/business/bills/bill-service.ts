import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../../errors.js';
import { assertBusinessBillsListLimit } from '../../owner-list-limit.js';
import { parseProofLimits, type ProofLimits } from '../../personal-pay/payee-controls.js';
import type { BusinessService } from '../business-service.js';
import {
  applyReviewEdit,
  billIntakeKey,
  checkBillFile,
  findDuplicates,
  normBillText,
  type BillRecord,
  type BillSource,
  type BillStatus,
} from './bill-intake.js';

/**
 * BK-bill-01: the business bill inbox, hand review and the duplicate flag.
 *
 * A bill is a document and an obligation record. Nothing here posts to the ledger or calls a rail: value moves only from
 * BK-bill-03. Who may do what comes from the one business role table (`business-policy.ts`) through
 * `BusinessService.requireCapability`: `view` reads, `propose` uploads and reviews, `manage_team` (the admins) clears a
 * duplicate flag. The upload limits are the owner's (`BANK_BILL_UPLOAD_LIMITS_JSON`, the proof-upload shape and parser);
 * blank refuses every upload.
 */

export interface BusinessBillView {
  readonly id: string;
  readonly accountId: string;
  readonly source: BillSource;
  readonly status: BillStatus;
  readonly fileName: string;
  readonly fileType: string;
  readonly fileSize: number;
  readonly receivedBy: string;
  readonly receivedAt: Date;
  readonly payee: string | null;
  readonly reference: string | null;
  readonly amount: Amount | null;
  readonly assetId: string | null;
  readonly dueDate: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
  /** Earlier or other bills of the same business this one may duplicate. Advisory; non-empty blocks payment. */
  readonly possibleDuplicateOf: readonly string[];
}

interface BillRow {
  id: string;
  account_id: string;
  source: BillSource;
  status: BillStatus;
  file_name: string;
  file_type: string;
  file_size: number;
  received_by: string;
  created_at: Date;
  payee: string | null;
  reference: string | null;
  amount: string | null;
  asset_id: string | null;
  due_date: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
}

const COLUMNS = `id, account_id, source, status, file_name, file_type, file_size, received_by, created_at,
  payee, reference, amount::text AS amount, asset_id, due_date::text AS due_date, reviewed_by, reviewed_at`;

/** The same columns read from the joined candidate `o`. */
const OTHER_COLUMNS = `o.id, o.account_id, o.source, o.status, o.file_name, o.file_type, o.file_size, o.received_by,
  o.created_at, o.payee, o.reference, o.amount::text AS amount, o.asset_id, o.due_date::text AS due_date, o.reviewed_by,
  o.reviewed_at`;

/** Inbox order (same as `sortInbox`): approval status, due date with none last, received time, id. */
const INBOX_ORDER = `CASE status WHEN 'unreviewed' THEN 0 WHEN 'reviewed' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
  due_date ASC NULLS LAST, created_at ASC, id ASC`;

const toRecord = (row: BillRow, notDuplicateOf: readonly string[] = []): BillRecord => ({
  id: row.id,
  businessId: row.account_id,
  status: row.status,
  payee: row.payee,
  reference: row.reference,
  amount: row.amount === null ? null : parseAmount(row.amount),
  assetId: row.asset_id,
  dueDate: row.due_date,
  notDuplicateOf,
  receivedAt: row.created_at.toISOString(),
});

const toView = (row: BillRow, possibleDuplicateOf: readonly string[]): BusinessBillView => ({
  id: row.id,
  accountId: row.account_id,
  source: row.source,
  status: row.status,
  fileName: row.file_name,
  fileType: row.file_type,
  fileSize: row.file_size,
  receivedBy: row.received_by,
  receivedAt: row.created_at,
  payee: row.payee,
  reference: row.reference,
  amount: row.amount === null ? null : parseAmount(row.amount),
  assetId: row.asset_id,
  dueDate: row.due_date,
  reviewedBy: row.reviewed_by,
  reviewedAt: row.reviewed_at,
  possibleDuplicateOf,
});

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class BusinessBillService {
  private readonly limits: ProofLimits | null;

  constructor(
    private readonly sql: Sql,
    private readonly business: Pick<BusinessService, 'requireCapability'>,
    uploadLimitsJson?: string,
  ) {
    this.limits = parseProofLimits(uploadLimitsJson);
  }

  /** What the upload control may say: the owner's published limits, or `unset`. Never a default. */
  uploadLimitsStatus(): { state: 'unset' | 'published'; allowedTypes: string[]; maxBytes: number | null } {
    if (!this.limits) return { state: 'unset', allowedTypes: [], maxBytes: null };
    return { state: 'published', allowedTypes: [...this.limits.allowedTypes], maxBytes: this.limits.maxBytes };
  }

  /**
   * Drag-and-drop upload. Keyed `bill-in:<accountId>:<sha256>`: the same file sent again to the same business is the
   * same bill (whatever its name), so a retry after a lost reply returns the first answer. A new bill lands unreviewed
   * with every field blank for the customer to type.
   */
  async upload(input: {
    accountId: string;
    actorUserId: string;
    name: string;
    type: string;
    contentBase64: string;
  }): Promise<BusinessBillView> {
    // Blank owner limits refuse before anything is read or stored.
    if (!this.limits) checkBillFile({ mimeType: input.type, sizeBytes: 1 }, null);
    await this.business.requireCapability(input.accountId, input.actorUserId, 'propose');
    await this.assertActive(input.accountId);
    const name = input.name.trim();
    if (name === '' || name.length > 200)
      throw new BankError('The bill file needs a name (up to 200 characters).', 'bank.bill_input_invalid');
    if (!BASE64.test(input.contentBase64) || input.contentBase64.length % 4 !== 0) {
      throw new BankError('The bill file could not be read.', 'bank.bill_input_invalid');
    }
    const bytes = Buffer.from(input.contentBase64, 'base64');
    const type = input.type.trim().toLowerCase();
    checkBillFile({ mimeType: type, sizeBytes: bytes.length }, this.limits);
    const key = billIntakeKey(input.accountId, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');

    await this.sql`
      INSERT INTO bank.business_bills (id, account_id, intake_key, source, status, file_name, file_type, file_size,
                                       file_sha256, file_bytes, received_by)
      VALUES (${randomUUID()}::uuid, ${input.accountId}::uuid, ${key}, 'upload', 'unreviewed', ${name}, ${type},
              ${bytes.length}, ${sha}, ${bytes}, ${input.actorUserId})
      ON CONFLICT (intake_key) DO NOTHING
    `;
    const rows = await this.sql<BillRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM bank.business_bills WHERE intake_key = ${key}
    `;
    const row = rows[0];
    if (!row) throw new BankError('The bill could not be stored.', 'bank.bill_not_found');
    return (await this.withDuplicates([row]))[0]!;
  }

  /** The inbox: sorted by approval status, then due date. Page size is required; blank refuses, never 50. */
  async list(input: { accountId: string; actorUserId: string; limit?: number }): Promise<BusinessBillView[]> {
    const limit = assertBusinessBillsListLimit(input.limit);
    await this.business.requireCapability(input.accountId, input.actorUserId, 'view');
    const rows = await this.sql<BillRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM bank.business_bills
       WHERE account_id = ${input.accountId}::uuid
       ORDER BY ${this.sql.unsafe(INBOX_ORDER)}
       LIMIT ${limit}
    `;
    return this.withDuplicates(rows);
  }

  async get(input: { accountId: string; billId: string; actorUserId: string }): Promise<BusinessBillView> {
    await this.business.requireCapability(input.accountId, input.actorUserId, 'view');
    const row = await this.row(this.sql, input.accountId, input.billId, false);
    return (await this.withDuplicates([row]))[0]!;
  }

  /** The stored file, for the review screen. */
  async document(input: {
    accountId: string;
    billId: string;
    actorUserId: string;
  }): Promise<{ name: string; type: string; contentBase64: string }> {
    await this.business.requireCapability(input.accountId, input.actorUserId, 'view');
    const rows = await this.sql<Array<{ file_name: string; file_type: string; file_bytes: Buffer }>>`
      SELECT file_name, file_type, file_bytes FROM bank.business_bills
       WHERE id = ${input.billId}::uuid AND account_id = ${input.accountId}::uuid
    `;
    if (!rows[0]) throw new BankError('Bill not found', 'bank.bill_not_found');
    return { name: rows[0].file_name, type: rows[0].file_type, contentBase64: rows[0].file_bytes.toString('base64') };
  }

  /**
   * The customer types (or corrects) payee, reference, amount, asset and due date. The bill becomes `reviewed`. An edit
   * after approval resets the approval; sending the same values again changes nothing. A paid bill cannot be edited.
   */
  async review(input: {
    accountId: string;
    billId: string;
    actorUserId: string;
    payee: string;
    reference: string | null;
    amount: Amount;
    assetId: string;
    dueDate: string;
  }): Promise<BusinessBillView> {
    await this.business.requireCapability(input.accountId, input.actorUserId, 'propose');
    const row = await transaction(this.sql, async (tx) => {
      const current = await this.row(tx, input.accountId, input.billId, true);
      const before = toRecord(current);
      const after = applyReviewEdit(before, {
        payee: input.payee,
        reference: input.reference,
        amount: input.amount,
        assetId: input.assetId,
        dueDate: input.dueDate,
      });
      const unchanged =
        before.status !== 'unreviewed' &&
        before.payee === after.payee &&
        before.reference === after.reference &&
        before.amount === after.amount &&
        before.assetId === after.assetId &&
        before.dueDate === after.dueDate;
      if (unchanged) return current;
      const updated = await tx<BillRow[]>`
        UPDATE bank.business_bills
           SET payee = ${after.payee}, payee_norm = ${normBillText(after.payee)},
               reference = ${after.reference}, reference_norm = ${normBillText(after.reference)},
               amount = ${formatAmount(after.amount!)}::numeric, asset_id = ${after.assetId},
               due_date = ${after.dueDate}::date, status = ${after.status},
               reviewed_by = ${input.actorUserId}, reviewed_at = now(), updated_at = now()
         WHERE id = ${current.id}::uuid
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
      return updated[0]!;
    });
    return (await this.withDuplicates([row]))[0]!;
  }

  /** An admin confirms two bills are different. The pair is stored once; repeating it is a no-op. */
  async markNotDuplicate(input: {
    accountId: string;
    billId: string;
    otherBillId: string;
    actorUserId: string;
  }): Promise<BusinessBillView> {
    if (input.billId === input.otherBillId) throw new BankError('A bill cannot be compared with itself.', 'bank.bill_input_invalid');
    await this.business.requireCapability(input.accountId, input.actorUserId, 'manage_team');
    const bill = await this.row(this.sql, input.accountId, input.billId, false);
    await this.row(this.sql, input.accountId, input.otherBillId, false);
    const [low, high] = [input.billId, input.otherBillId].sort() as [string, string];
    await this.sql`
      INSERT INTO bank.business_bill_not_duplicates (account_id, bill_id, other_bill_id, marked_by)
      VALUES (${input.accountId}::uuid, ${low}::uuid, ${high}::uuid, ${input.actorUserId})
      ON CONFLICT (bill_id, other_bill_id) DO NOTHING
    `;
    return (await this.withDuplicates([bill]))[0]!;
  }

  private async assertActive(accountId: string): Promise<void> {
    const rows = await this.sql<Array<{ status: string }>>`SELECT status FROM bank.business_accounts WHERE id = ${accountId}::uuid`;
    if (!rows[0]) throw new BankError(`Business account ${accountId} not found`, 'bank.business_not_found');
    if (rows[0].status !== 'active') throw new BankError('Business account is closed', 'bank.business_closed');
  }

  private async row(sql: Sql, accountId: string, billId: string, lock: boolean): Promise<BillRow> {
    const rows = lock
      ? await sql<BillRow[]>`
          SELECT ${sql.unsafe(COLUMNS)} FROM bank.business_bills
           WHERE id = ${billId}::uuid AND account_id = ${accountId}::uuid FOR UPDATE`
      : await sql<BillRow[]>`
          SELECT ${sql.unsafe(COLUMNS)} FROM bank.business_bills
           WHERE id = ${billId}::uuid AND account_id = ${accountId}::uuid`;
    // Another business's bill is "not found" here, never "forbidden": the caller is a member of `accountId` only.
    if (!rows[0]) throw new BankError('Bill not found', 'bank.bill_not_found');
    return rows[0];
  }

  /**
   * Duplicate flags for a set of bills. SQL only narrows the candidates (same business, same normalised payee and
   * reference, or same amount, asset and due date); `findDuplicates` is the one rule that decides.
   */
  private async withDuplicates(rows: readonly BillRow[]): Promise<BusinessBillView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const candidates = await this.sql<Array<BillRow & { for_bill: string }>>`
      SELECT b.id AS for_bill, ${this.sql.unsafe(OTHER_COLUMNS)}
        FROM bank.business_bills b
        JOIN bank.business_bills o
          ON o.account_id = b.account_id AND o.id <> b.id
         AND ((o.payee_norm = b.payee_norm AND o.reference_norm = b.reference_norm)
              OR (o.amount = b.amount AND o.asset_id = b.asset_id AND o.due_date = b.due_date))
       WHERE b.id = ANY(${ids}::uuid[])
    `;
    const pairs = await this.sql<Array<{ bill_id: string; other_bill_id: string }>>`
      SELECT bill_id, other_bill_id FROM bank.business_bill_not_duplicates
       WHERE bill_id = ANY(${ids}::uuid[]) OR other_bill_id = ANY(${ids}::uuid[])
    `;
    return rows.map((row) => {
      const cleared = pairs.flatMap((p) => (p.bill_id === row.id ? [p.other_bill_id] : p.other_bill_id === row.id ? [p.bill_id] : []));
      const others = candidates.filter((c) => c.for_bill === row.id).map((c) => toRecord(c));
      return toView(row, findDuplicates(toRecord(row, cleared), others));
    });
  }
}
