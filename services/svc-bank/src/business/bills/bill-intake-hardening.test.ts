import { describe, expect, it } from 'vitest';
import { applyReviewEdit, base64DecodedLength, normBillAsset, sniffBillType, type BillRecord } from './bill-intake.js';

const bill = (id: string): BillRecord => ({
  id,
  businessId: 'biz-1',
  status: 'unreviewed',
  payee: null,
  reference: null,
  amount: null,
  assetId: null,
  dueDate: null,
  notDuplicateOf: [],
  receivedAt: '2026-10-01T00:00:00.000Z',
});

describe('BK-bill-01 hardening (unit)', () => {
  it('normBillAsset upper-cases catalogue assets and refuses unknown ones', () => {
    expect(normBillAsset(' usdt ')).toBe('USDT');
    expect(normBillAsset('Eur')).toBe('EUR');
    expect(() => normBillAsset('NOPE')).toThrow(expect.objectContaining({ code: 'bank.bill_input_invalid' }));
  });

  it('applyReviewEdit stores the normalised asset', () => {
    const edit = { payee: 'TEST Payee', reference: null, amount: 1n, assetId: 'usdc', dueDate: '2026-12-01' };
    expect(applyReviewEdit(bill('b1'), edit).assetId).toBe('USDC');
    expect(() => applyReviewEdit(bill('b1'), { ...edit, assetId: 'usdx' })).toThrow(
      expect.objectContaining({ code: 'bank.bill_input_invalid' }),
    );
  });

  it('base64DecodedLength matches the decoded size without decoding', () => {
    for (const n of [1, 2, 3, 4, 5, 64, 65]) {
      const s = Buffer.alloc(n, 7).toString('base64');
      expect(base64DecodedLength(s)).toBe(n);
    }
  });

  it('sniffBillType trusts bytes over the declared type', () => {
    expect(sniffBillType('application/pdf', Buffer.from('%PDF-1.7 TEST'))).toBe('application/pdf');
    expect(sniffBillType('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(() => sniffBillType('application/pdf', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toThrow(
      expect.objectContaining({ code: 'bank.bill_file_type' }),
    );
    expect(() => sniffBillType('image/png', Buffer.from('  <?xml version="1.0"?><svg/>'))).toThrow(
      expect.objectContaining({ code: 'bank.bill_file_type' }),
    );
    expect(sniffBillType(' Application/PDF ', Buffer.from('TEST no signature'))).toBe('application/pdf');
  });
});
