import { describe, expect, it } from 'vitest';
import { fakeSql, partial } from '@intafaced/service-kit/testing';
import {
  formatAmount,
  MemoryLedger,
  merchantClearing,
  merchantProceeds,
  parseAmount,
  recipes,
  type PostRequest,
} from '@intafaced/ledger-client';
import type { PayServiceInternal, PaymentCustody, PaymentRow } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';
import { bookDisputeResolution, chargebackLedgerRefusal, openChargeback, postChargebackOpenOrRefuse } from './chargebacks.js';
import { toPayment } from './internal.js';
import { getPayment } from './payment-reads.js';

/**
 * At launch our book holds only our own money: a payment paid to the business's own wallet or held by the partner never entered our
 * book. A dispute on it debits nothing: clearing is pooled per business, so a debit would take other payments' money.
 * TEST ids and TEST amounts.
 */
const merchantId = '00000000-0000-4000-8000-000000000010';
const userId = '00000000-0000-4000-8000-000000000011';
const paymentId = '00000000-0000-4000-8000-000000000020';
const amount = parseAmount('100');

async function harness(custody: PaymentCustody) {
  const ledger = new MemoryLedger();
  // Another payment, in our custody, captured into the same pooled clearing: the money a wrong debit would take.
  await ledger.post(
    recipes.paymentCapture({
      paymentId: '00000000-0000-4000-8000-000000000099',
      merchantId,
      assetId: 'USDT',
      amount,
      rail: 'crypto-native',
      railRef: '0xother-platform-payment',
    }),
  );
  const posts: PostRequest[] = [];
  const realPost = ledger.post.bind(ledger);
  ledger.post = async (request: PostRequest) => {
    posts.push(request);
    return realPost(request);
  };
  const paymentRow: PaymentRow = {
    id: paymentId,
    merchant_id: merchantId,
    profile_id: null,
    amount: '100',
    currency: 'USDT',
    method: custody === 'partner' ? 'bank_transfer' : 'crypto',
    rail_adapter: custody === 'partner' ? 'bank-transfer-sandbox' : 'crypto-native',
    rail_ref: '0xpayment',
    status: 'captured',
    created_at: new Date('2026-11-23T00:00:00.000Z'),
    custody,
  };
  const svc: PayServiceInternal = partial<PayServiceInternal>({
    sql: fakeSql([paymentRow]),
    ledger,
    rails: new RailRegistry([]),
    getPayment: (id: string) => getPayment(svc, id),
    view: async (_q: unknown, row: PaymentRow) => ({ ...toPayment(row), capturedAmount: amount, refundedAmount: 0n }),
    getMerchant: async () => ({
      id: merchantId,
      userId,
      mode: 'gateway' as const,
      tier: 1,
      kybStatus: 'approved' as const,
      kybRef: null,
      status: 'active' as const,
      pricing: { feeBps: 100 },
      settlementPrefs: {},
    }),
    paymentIsSandbox: async () => false,
    chargebackSettledPot: async () => 'proceeds' as const,
    clearingBalance: async (mId: string, assetId: string) => (await ledger.balance(merchantClearing(mId, assetId))).amount,
    merchantBalance: async (mId: string, assetId: string) => (await ledger.balance(merchantProceeds(mId, assetId))).amount,
    chargebackSplit: async (
      _pId: string,
      _dId: string,
      amt: bigint,
      settledPot: 'proceeds' | 'user',
      compute: () => Promise<{ fromClearing: bigint; fromMerchantBalance: bigint; shortfall: bigint }>,
    ) => ({ ...(await compute()), settledPot, planSeq: '1', amount: formatAmount(amt), replayed: false }),
    ensureChargebackPlanLive: async () => undefined,
    recordChargebackLedgerEffect: async () => undefined,
    chargebackLedgerRefusal: (e: unknown) => chargebackLedgerRefusal(svc, e),
    openChargeback: (input: Parameters<typeof openChargeback>[1]) => openChargeback(svc, input),
  });
  const clearing = async () => (await ledger.balance(merchantClearing(merchantId, 'USDT'))).amount;
  return { svc, posts, clearing };
}

const dispute = { disputeId: 'dp-test-1', paymentId, merchantId, amount: '100', assetId: 'USDT' };

describe('a chargeback on a payment not in our custody debits nothing', () => {
  for (const custody of ['merchant_wallet', 'partner'] as const) {
    it(`${custody}: openChargeback refuses before any post, and pooled clearing keeps the other payment's money`, async () => {
      const { svc, posts, clearing } = await harness(custody);
      await expect(openChargeback(svc, dispute)).rejects.toMatchObject({ code: 'pay.payment_not_in_our_custody' });
      expect(posts).toHaveLength(0);
      expect(await clearing()).toBe(amount);
    });

    it(`${custody}: the rail's dispute.opened records the case with a named refusal, so the rail does not retry forever`, async () => {
      const { svc, posts, clearing } = await harness(custody);
      const wire = await postChargebackOpenOrRefuse(svc, dispute);
      expect(wire.ledgerPost).toBeUndefined();
      expect(wire.ledgerRefuse).toMatchObject({ code: 'pay.payment_not_in_our_custody', disputeId: 'dp-test-1', paymentId });
      expect(posts).toHaveLength(0);
      expect(await clearing()).toBe(amount);
    });

    it(`${custody}: a lost or closed outcome books nothing and still resolves`, async () => {
      const { svc, posts, clearing } = await harness(custody);
      for (const outcome of ['lost', 'closed'] as const) {
        await expect(bookDisputeResolution(svc, { ...dispute, outcome })).resolves.toMatchObject({
          openingTxId: null,
          shortfallTxId: null,
          wonTxId: null,
          recoveredTxId: null,
        });
      }
      expect(posts).toHaveLength(0);
      expect(await clearing()).toBe(amount);
    });
  }

  it('platform: the same dispute still debits clearing, unchanged', async () => {
    const { svc, posts, clearing } = await harness('platform');
    const opened = await openChargeback(svc, dispute);
    expect(opened.openingTxId).not.toBeNull();
    expect(posts).toHaveLength(1);
    expect(await clearing()).toBe(0n);
  });
});
