import { createHash } from 'node:crypto';
import { BankError } from '../../errors.js';
import type { ProofLimits } from '../../personal-pay/payee-controls.js';

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
 * Upload gate. Which file types and how large are owner settings
 * (`BANK_BILL_UPLOAD_LIMITS_JSON`, the same `{ allowedTypes, maxBytes }` shape and parser as the proof upload). The
 * reference product's "PNG, JPEG or PDF under 3MB" is not our value, so blank or unreadable limits refuse rather than
 * default.
 */
export function checkBillFile(file: { mimeType: string; sizeBytes: number }, limits: ProofLimits | null): void {
  if (limits === null) {
    throw new BankError('The owner has not published bill upload limits, so no bill upload is accepted.', 'bank.bill_upload_limit_unset');
  }
  if (!limits.allowedTypes.includes(file.mimeType.trim().toLowerCase())) {
    throw new BankError('That file type is not accepted for bills.', 'bank.bill_file_type');
  }
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) {
    throw new BankError('The bill file is empty.', 'bank.bill_input_invalid');
  }
  if (file.sizeBytes > limits.maxBytes) {
    throw new BankError('The bill file is over the upload size limit.', 'bank.bill_file_too_large');
  }
}

/** The text the duplicate check compares: trimmed, inner spaces collapsed, lower-cased; blank is null. Stored as `*_norm`. */
export function normBillText(s: string | null): string | null {
  if (s === null) return null;
  const t = s.trim().replace(/\s+/g, ' ').toLowerCase();
  return t === '' ? null : t;
}

/**
 * Advisory duplicate flag: another bill of the same business, already received
 * or paid, with the same payee and reference, or the same amount (and asset)
 * and due date. A pair the admin marked "not a duplicate" (either side) is not
 * flagged. Blank fields never match.
 */
export function findDuplicates(bill: BillRecord, others: readonly BillRecord[]): string[] {
  const payee = normBillText(bill.payee);
  const ref = normBillText(bill.reference);
  const out: string[] = [];
  for (const other of others) {
    if (other.id === bill.id || other.businessId !== bill.businessId) continue;
    if (bill.notDuplicateOf.includes(other.id) || other.notDuplicateOf.includes(bill.id)) continue;
    const samePayeeRef = payee !== null && ref !== null && normBillText(other.payee) === payee && normBillText(other.reference) === ref;
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

/** `YYYY-MM-DD` that names a real day (no 30 February rolled into March). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
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
  if (!isCalendarDate(edit.dueDate)) {
    throw new BankError('The due date must be a calendar date.', 'bank.bill_input_invalid');
  }
  return {
    ...bill,
    payee: edit.payee.trim(),
    reference: edit.reference?.trim() || null,
    amount: edit.amount,
    assetId: edit.assetId.trim(),
    dueDate: edit.dueDate,
    status: 'reviewed',
  };
}
