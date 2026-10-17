import { describe, expect, it } from 'vitest';
import { merchantProceeds, merchantProceedsPayoutHold, parseAmount, railBoundary, recipes } from '@intafaced/ledger-client';
import { settlementLedgerPlan, type SettlementDestinationKind } from './settlement-ledger.js';

const MERCHANT = '11111111-1111-4111-8111-111111111111';

describe('settlementLedgerPlan', () => {
  it.each([
    { destinationKind: 'bank', railId: 'bank-payout' },
    { destinationKind: 'crypto', railId: 'crypto-native' },
  ] satisfies Array<{ destinationKind: SettlementDestinationKind; railId: string }>)(
    'uses the proceeds payout trio for a $destinationKind payout',
    ({ destinationKind, railId }) => {
      const amount = parseAmount('98.75');
      const withdrawalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:2';
      const payout = {
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount,
        rail: railId,
        withdrawalId,
      };

      const plan = settlementLedgerPlan({
        settlementId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        payoutAttempt: 2,
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount,
        railId,
        destinationKind,
      });

      expect(plan).toEqual({
        withdrawalId,
        destinationKind,
        hold: recipes.merchantProceedsPayoutHold(payout),
        settle: recipes.merchantProceedsPayoutSettle(payout),
        reverse: recipes.merchantProceedsPayoutReverse(payout),
      });
      expect(plan.hold.entries[0]?.account).toEqual(merchantProceeds(MERCHANT, 'USDT'));
      expect(plan.hold.entries[1]?.account).toEqual(merchantProceedsPayoutHold(MERCHANT, 'USDT', withdrawalId));
      expect(plan.settle.entries[1]?.account).toEqual(railBoundary(railId, 'USDT'));
      expect(plan.reverse.entries[1]?.account).toEqual(merchantProceeds(MERCHANT, 'USDT'));
      expect([plan.hold.reason, plan.settle.reason, plan.reverse.reason]).toEqual([
        'pay.proceeds.payout.held',
        'pay.proceeds.payout.settled',
        'pay.proceeds.payout.reversed',
      ]);
      expect(plan.hold.idempotencyKey).toBe(`pay.proceeds.payout.hold:${withdrawalId}`);
      expect(plan.settle.idempotencyKey).toBe(`pay.proceeds.payout.settle:${withdrawalId}`);
      expect(plan.reverse.idempotencyKey).toBe(`pay.proceeds.payout.reverse:${withdrawalId}`);
      const named = [
        plan.hold.idempotencyKey,
        plan.settle.idempotencyKey,
        plan.reverse.idempotencyKey,
        plan.hold.reason,
        plan.settle.reason,
        plan.reverse.reason,
      ].join('\n');
      expect(named).not.toContain('withdraw');
    },
  );

  it('refuses to invent a third settlement destination kind', () => {
    expect(() =>
      settlementLedgerPlan({
        settlementId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        payoutAttempt: 0,
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: parseAmount('1'),
        railId: 'some-future-rail',
        destinationKind: 'cash',
      }),
    ).toThrow(/expected bank or crypto/);
  });
});
