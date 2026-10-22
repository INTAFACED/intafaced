import { describe, expect, it } from 'vitest';
import { applyReviewEdit, assertPayable, billIntakeKey, checkBillFile, findDuplicates, sortInbox, type BillRecord } from './bill-intake.js';

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
const LIMIT = 1_000_000; // TEST value, not an owner setting

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
  it('accepts pdf, png and jpeg under the cap', () => {
    for (const mimeType of ['application/pdf', 'image/png', 'image/jpeg']) {
      expect(() => checkBillFile({ mimeType, sizeBytes: 10 }, LIMIT)).not.toThrow();
    }
  });
  it('refuses when the size cap is blank or invalid, never a default', () => {
    for (const cap of [undefined, 0, -1, 1.5]) {
      expect(() => checkBillFile({ mimeType: 'application/pdf', sizeBytes: 10 }, cap)).toThrow(
        expect.objectContaining({ code: 'bank.bill_upload_limit_unset' }),
      );
    }
  });
  it('refuses another type, an empty file and an oversize file', () => {
    expect(() => checkBillFile({ mimeType: 'text/html', sizeBytes: 10 }, LIMIT)).toThrow(
      expect.objectContaining({ code: 'bank.bill_file_type' }),
    );
    expect(() => checkBillFile({ mimeType: 'image/png', sizeBytes: 0 }, LIMIT)).toThrow(
      expect.objectContaining({ code: 'bank.bill_input_invalid' }),
    );
    expect(() => checkBillFile({ mimeType: 'image/png', sizeBytes: LIMIT + 1 }, LIMIT)).toThrow(
      expect.objectContaining({ code: 'bank.bill_file_too_large' }),
    );
    expect(() => checkBillFile({ mimeType: 'image/png', sizeBytes: LIMIT }, LIMIT)).not.toThrow();
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
  it('refuses a blank payee, a zero amount and a bad date', () => {
    for (const bad of [{ payee: ' ' }, { assetId: '' }, { amount: 0n }, { dueDate: '2026-13-45' }, { dueDate: 'tomorrow' }]) {
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
