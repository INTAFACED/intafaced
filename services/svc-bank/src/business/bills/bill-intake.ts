import { createHash } from 'node:crypto';
import { BankError } from '../../errors.js';

/**
 * BK-bill-01 (domain core): business bill inbox intake, review state and
 * duplicate detection. No ledger write: a bill is a document and an obligation
 * record; value moves only from BK-bill-03.
 *
 * Amounts are bigint (scaled) in memory; this module never parses or formats
 * decimal strings itself.
 */

export type BillStatus = 'unreviewed' | 'reviewed' | 'approved' | 'paid';
export type BillSource = 'upload' | 'email';

export const BILL_MIME_TYPES: ReadonlySet<string> = new Set(['application/pdf', 'image/png', 'image/jpeg']);

export interface BillRecord {
  readonly id: string;
  readonly businessId: string;
  readonly status: BillStatus;
  /** Typed by the customer on review; null until then. */
  readonly payee: string | null;
  readonly reference: string | null;
  readonly amount: bigint | null;
  readonly assetId: string | null;
  /** ISO date (YYYY-MM-DD) or null until reviewed. */
  readonly dueDate: string | null;
  /** Ids the admin marked "not a duplicate" of this bill. */
  readonly notDuplicateOf: readonly string[];
  readonly receivedAt: string;
}

/** `bill-in:<accountId>:<sha256>` — the same file is one bill (spec Failures row). */
export function billIntakeKey(accountId: string, file: Uint8Array): string {
  if (accountId.trim() === '') throw new BankError('Bill intake needs the business account id.', 'bank.bill_input_invalid');
  return `bill-in:${accountId}:${createHash('sha256').update(file).digest('hex')}`;
}

/**
 * Upload gate. The size cap is an owner setting: the reference product's 3MB is
 * "not our value", so a blank cap refuses rather than defaulting.
 */
export function checkBillFile(file: { mimeType: string; sizeBytes: number }, maxBytes: number | undefined): void {
  if (maxBytes === undefined || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new BankError('The bill upload size limit is not set.', 'bank.bill_upload_limit_unset');
  }
  if (!BILL_MIME_TYPES.has(file.mimeType)) {
    throw new BankError('A bill must be a PDF, PNG or JPEG file.', 'bank.bill_file_type');
  }
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) {
    throw new BankError('The bill file is empty.', 'bank.bill_input_invalid');
  }
  if (file.sizeBytes > maxBytes) {
    throw new BankError('The bill file is over the upload size limit.', 'bank.bill_file_too_large');
  }
}

const norm = (s: string | null): string | null => {
  if (s === null) return null;
  const t = s.trim().replace(/\s+/g, ' ').toLowerCase();
  return t === '' ? null : t;
};

/**
 * Advisory duplicate flag: another bill of the same business, already received
 * or paid, with the same payee and reference, or the same amount (and asset)
 * and due date. A pair the admin marked "not a duplicate" (either side) is not
 * flagged. Blank fields never match.
 */
export function findDuplicates(bill: BillRecord, others: readonly BillRecord[]): string[] {
  const payee = norm(bill.payee);
  const ref = norm(bill.reference);
  const out: string[] = [];
  for (const other of others) {
    if (other.id === bill.id || other.businessId !== bill.businessId) continue;
    if (bill.notDuplicateOf.includes(other.id) || other.notDuplicateOf.includes(bill.id)) continue;
    const samePayeeRef = payee !== null && ref !== null && norm(other.payee) === payee && norm(other.reference) === ref;
    const sameAmountDue =
      bill.amount !== null &&
      bill.dueDate !== null &&
      bill.assetId !== null &&
      other.amount === bill.amount &&
      other.assetId === bill.assetId &&
      other.dueDate === bill.dueDate;
    if (samePayeeRef || sameAmountDue) out.push(other.id);
  }
  return out.sort();
}

const STATUS_ORDER: Record<BillStatus, number> = { unreviewed: 0, reviewed: 1, approved: 2, paid: 3 };

/** Inbox order: approval status, then due date (no due date last), then received time, then id. */
export function sortInbox<T extends BillRecord>(bills: readonly T[]): T[] {
  return [...bills].sort((a, b) => {
    const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (s !== 0) return s;
    if (a.dueDate !== b.dueDate) {
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * A bill can go to payment only once the customer has verified it (never
 * unreviewed) and no unresolved duplicate flag remains. Refuses by name.
 */
export function assertPayable(bill: BillRecord, others: readonly BillRecord[]): void {
  if (bill.status === 'paid') throw new BankError('This bill is already paid.', 'bank.bill_already_paid');
  if (bill.status !== 'approved')
    throw new BankError('The bill must be reviewed and approved before it is paid.', 'bank.bill_not_approved');
  if (findDuplicates(bill, others).length > 0) {
    throw new BankError('This bill may be a duplicate; an admin must confirm it first.', 'bank.bill_possible_duplicate');
  }
}

/** Review edits. Editing a bill after approval resets it to reviewed (spec Failures row). */
export function applyReviewEdit(
  bill: BillRecord,
  edit: { payee: string; reference: string | null; amount: bigint; assetId: string; dueDate: string },
): BillRecord {
  if (bill.status === 'paid') throw new BankError('A paid bill cannot be edited.', 'bank.bill_already_paid');
  if (edit.payee.trim() === '' || edit.assetId.trim() === '')
    throw new BankError('Payee and asset are required.', 'bank.bill_input_invalid');
  if (edit.amount <= 0n) throw new BankError('The bill amount must be above zero.', 'bank.bill_input_invalid');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(edit.dueDate) || Number.isNaN(Date.parse(`${edit.dueDate}T00:00:00Z`))) {
    throw new BankError('The due date must be a calendar date.', 'bank.bill_input_invalid');
  }
  return { ...bill, ...edit, reference: edit.reference?.trim() || null, status: 'reviewed' };
}
