import { describe, expect, it } from 'vitest';
import { checkedParts, feeSummary } from './payment-model';

// TEST DATA only. J-merchant-05 #5: a stored fee shows its parts only when they add up to it.
const snap = {
  fee: '1.5',
  assetCode: 'USDT',
  appliedLayer: 'merchant' as const,
  ruleId: '7b0e8f5e-6d64-4a4c-9a55-4c6f1d3a7e11',
  feeBps: 100,
  flatFee: '0.5',
  spreadBps: null,
  roundingBeneficiary: 'platform' as const,
  roundingMode: 'ceil' as const,
  bookedFee: null,
  reserveAmount: null,
  recordedAt: '2026-11-05T00:00:00.000Z',
};
const payment = { assetId: 'USDT', capturedAmount: '100', pricingSnapshot: snap };

describe('the fee in its parts', () => {
  it('keeps a TEST 1.50 fee’s 1.00 and 0.50 parts, which add up', () => {
    const fee = feeSummary({
      ...payment,
      pricingSnapshot: {
        ...snap,
        parts: [
          { kind: 'percent', amount: '1' },
          { kind: 'flat', amount: '0.5' },
        ],
      },
    });
    expect(fee).toMatchObject({
      kind: 'rule',
      fee: '1.5',
      percent: '1',
      parts: [
        { kind: 'percent', amount: '1' },
        { kind: 'flat', amount: '0.5' },
      ],
    });
  });
  it('drops parts that do not add up, and an older service that sent none, so the page says the split is not recorded', () => {
    expect(checkedParts('1.5', [{ kind: 'percent', amount: '1' }])).toBeNull();
    expect(
      checkedParts('10', [
        { kind: 'percent', amount: '12' },
        { kind: 'maximum', amount: '2' },
      ]),
    ).toEqual([
      { kind: 'percent', amount: '12' },
      { kind: 'maximum', amount: '2' },
    ]);
    expect(feeSummary(payment)).toMatchObject({ kind: 'rule', parts: null });
  });
});
