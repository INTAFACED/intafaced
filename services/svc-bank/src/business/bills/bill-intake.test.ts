import { describe, expect, it } from 'vitest';
import {
  applyReviewEdit,
  assertPayable,
  billIntakeKey,
  checkBillFile,
  findDuplicates,
  isCalendarDate,
  normBillText,
  sortInbox,
  type BillRecord,
} from './bill-intake.js';

const BIZ = 'biz-1';
const bill = (id: string, over: Partial<BillRecord> = {}): BillRecord => ({
  id,
  businessId: BIZ,
  status: 'unreviewed',
  payee: null,
  reference: null,
  amount: null,
  assetId: null,
  dueDate: null,
  notDuplicateOf: [],
  receivedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const TEST_BYTES = new TextEncoder().encode('TEST bill file');
// TEST values, not owner settings.
const LIMIT = 1_000_000;
const LIMITS = { allowedTypes: ['application/pdf', 'image/png', 'image/jpeg'], maxBytes: LIMIT };

describe('BK-bill-01 intake key', () => {
  it('is bill-in:<accountId>:<sha256>, the same file is the same key', () => {
    const k = billIntakeKey('acct-1', TEST_BYTES);
    expect(k).toMatch(/^bill-in:acct-1:[0-9a-f]{64}$/);
    expect(billIntakeKey('acct-1', new TextEncoder().encode('TEST bill file'))).toBe(k);
  });
  it('differs by file and by account', () => {
    const k = billIntakeKey('acct-1', TEST_BYTES);
    expect(billIntakeKey('acct-2', TEST_BYTES)).not.toBe(k);
    expect(billIntakeKey('acct-1', new TextEncoder().encode('TEST other'))).not.toBe(k);
  });
  it('refuses a blank account id', () => {
    expect(() => billIntakeKey(' ', TEST_BYTES)).toThrow(expect.objectContaining({ code: 'bank.bill_input_invalid' }));
  });
});

describe('BK-bill-01 upload gate', () => {
  it('accepts the owner-published types under the published cap', () => {
    for (const mimeType of LIMITS.allowedTypes) {
      expect(() => checkBillFile({ mimeType, sizeBytes: 10 }, LIMITS)).not.toThrow();
    }
    expect(() => checkBillFile({ mimeType: ' Image/PNG ', sizeBytes: 10 }, LIMITS)).not.toThrow();
  });
  it('refuses every upload when the owner has published no limits, never a default', () => {
    expect(() => checkBillFile({ mimeType: 'application/pdf', sizeBytes: 10 }, null)).toThrow(
      expect.objectContaining({ code: 'bank.bill_upload_limit_unset' }),
    );
  });
  it('refuses a type the owner did not publish, even one the reference product accepts', () => {
    expect(() => checkBillFile({ mimeType: 'image/png', sizeBytes: 10 }, { allowedTypes: ['application/pdf'], maxBytes: LIMIT })).toThrow(
      expect.objectContaining({ code: 'bank.bill_file_type' }),
    );
    expect(() => checkBillFile({ mimeType: 'text/html', sizeBytes: 10 }, LIMITS)).toThrow(
      expect.objectContaining({ code: 'bank.bill_file_type' }),
    );
  });
  it('refuses an empty file and an oversize file; the cap itself is allowed', () => {
    expect(() => checkBillFile({ mimeType: 'image/png', sizeBytes: 0 }, LIMITS)).toThrow(
      expect.objectContaining({ code: 'bank.bill_input_invalid' }),
    );
    expect(() => checkBillFile({ mimeType: 'image/png', sizeBytes: LIMIT + 1 }, LIMITS)).toThrow(
      expect.objectContaining({ code: 'bank.bill_file_too_large' }),
    );
    expect(() => checkBillFile({ mimeType: 'image/png', sizeBytes: LIMIT }, LIMITS)).not.toThrow();
  });
});

describe('BK-bill-01 duplicate detection', () => {
  const first = bill('b1', {
    status: 'paid',
    payee: 'TEST Payee Ltd',
    reference: 'INV-1',
    amount: 100n,
    assetId: 'USD',
    dueDate: '2026-11-01',
  });
  it('flags the same payee and reference (case and spacing ignored)', () => {
    const second = bill('b2', { payee: ' test  payee ltd ', reference: 'inv-1' });
    expect(findDuplicates(second, [first, second])).toEqual(['b1']);
  });
  it('flags the same amount, asset and due date', () => {
    const second = bill('b2', { payee: 'Other', reference: 'X', amount: 100n, assetId: 'USD', dueDate: '2026-11-01' });
    expect(findDuplicates(second, [first])).toEqual(['b1']);
  });
  it('does not flag a different asset, a different date, blank fields or another business', () => {
    expect(findDuplicates(bill('b2', { amount: 100n, assetId: 'EUR', dueDate: '2026-11-01' }), [first])).toEqual([]);
    expect(findDuplicates(bill('b2', { amount: 100n, assetId: 'USD', dueDate: '2026-11-02' }), [first])).toEqual([]);
    expect(findDuplicates(bill('b2'), [bill('b3')])).toEqual([]);
    expect(findDuplicates(bill('b2', { payee: 'TEST Payee Ltd', reference: 'INV-1', businessId: 'biz-2' }), [first])).toEqual([]);
  });
  it('honours "not a duplicate" from either side', () => {
    expect(findDuplicates(bill('b2', { payee: 'TEST Payee Ltd', reference: 'INV-1', notDuplicateOf: ['b1'] }), [first])).toEqual([]);
    expect(findDuplicates(bill('b2', { payee: 'TEST Payee Ltd', reference: 'INV-1' }), [{ ...first, notDuplicateOf: ['b2'] }])).toEqual([]);
  });
});

describe('BK-bill-01 payability and review', () => {
  const edit = { payee: 'TEST Payee', reference: 'INV-9', amount: 250n, assetId: 'USD', dueDate: '2026-12-01' };
  it('an unknown-sender bill lands unreviewed with empty fields and cannot be paid', () => {
    const b = bill('b1');
    expect([b.payee, b.amount, b.dueDate]).toEqual([null, null, null]);
    expect(() => assertPayable(b, [])).toThrow(expect.objectContaining({ code: 'bank.bill_not_approved' }));
  });
  it('a possible duplicate cannot be paid until the admin marks it not a duplicate', () => {
    const earlier = bill('b0', { status: 'paid', ...edit });
    const b = bill('b1', { ...edit, status: 'approved' });
    expect(() => assertPayable(b, [earlier])).toThrow(expect.objectContaining({ code: 'bank.bill_possible_duplicate' }));
    expect(() => assertPayable({ ...b, notDuplicateOf: ['b0'] }, [earlier])).not.toThrow();
  });
  it('a paid bill is refused', () => {
    expect(() => assertPayable(bill('b1', { status: 'paid' }), [])).toThrow(expect.objectContaining({ code: 'bank.bill_already_paid' }));
    expect(() => applyReviewEdit(bill('b1', { status: 'paid' }), edit)).toThrow(
      expect.objectContaining({ code: 'bank.bill_already_paid' }),
    );
  });
  it('a review edit marks it reviewed, and an edit after approval resets the approval', () => {
    expect(applyReviewEdit(bill('b1'), edit).status).toBe('reviewed');
    const approved = bill('b1', { ...edit, status: 'approved' });
    const changed = applyReviewEdit(approved, { ...edit, amount: 251n });
    expect(changed.status).toBe('reviewed');
    expect(changed.amount).toBe(251n);
  });
  it('stores the typed text trimmed and a blank reference as none', () => {
    const b = applyReviewEdit(bill('b1'), { ...edit, payee: '  TEST Payee  ', assetId: ' USD ', reference: '   ' });
    expect([b.payee, b.assetId, b.reference]).toEqual(['TEST Payee', 'USD', null]);
  });
  it('refuses a blank payee, a zero amount and a bad date', () => {
    for (const bad of [
      { payee: ' ' },
      { assetId: '' },
      { amount: 0n },
      { dueDate: '2026-13-45' },
      { dueDate: '2026-02-30' },
      { dueDate: 'tomorrow' },
    ]) {
      expect(() => applyReviewEdit(bill('b1'), { ...edit, ...bad })).toThrow(expect.objectContaining({ code: 'bank.bill_input_invalid' }));
    }
  });
});

describe('BK-bill-01 inbox order', () => {
  it('sorts by approval status, then due date (none last), then received time', () => {
    const rows = [
      bill('p', { status: 'paid', dueDate: '2026-01-01' }),
      bill('a', { status: 'approved', dueDate: '2026-02-01' }),
      bill('u2', { dueDate: '2026-03-01' }),
      bill('u0'),
      bill('u1', { dueDate: '2026-02-15' }),
    ];
    expect(sortInbox(rows).map((r) => r.id)).toEqual(['u1', 'u2', 'u0', 'a', 'p']);
  });
});

describe('BK-bill-01 text and date helpers', () => {
  it('normalises compared text and treats blank as none', () => {
    expect(normBillText('  TEST   Payee\tLtd ')).toBe('test payee ltd');
    expect(normBillText('   ')).toBeNull();
    expect(normBillText(null)).toBeNull();
  });
  it('accepts only real calendar days', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-04-31')).toBe(false);
    expect(isCalendarDate('2026-4-01')).toBe(false);
  });
});
