/**
 * SAGATEST for svc-pay's payment refund on the crypto-native rail: `refund` debits the merchant (phase 1), the rail
 * sends the money back out, then the refund is recorded. `describeMoneyDoor` replays it as a duplicate request, a lost
 * acknowledgement on each ledger post, and a crash after each post, and requires the book of one clean run every time.
 * The same `refundId` is the business key on every call. Postgres and the chain survive a crash, as they would for real.
 *
 * Two doors: a refund drawn on clearing (before the window posts) and one drawn on the merchant's proceeds (after).
 */
import { afterAll, beforeAll } from 'vitest';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, type LedgerClient } from '@intafaced/ledger-client';
import { describeMoneyDoor, type MoneyDoorScenario } from '@intafaced/ledger-client/testing/saga';
import { createLedgerClient } from './ledger-client.js';
import { overHarness, payServiceOver, pinPayIds, resetPay, SAGA_SECRET, sagaPayDatabase, sagaRails } from './saga-fixture-test.js';

const MERCHANT_USER = '11111111-1111-4111-8111-111111111111';
const PAYMENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REFUND_ID = 'saga-refund-1';

const pg = sagaPayDatabase();
beforeAll(() => pg.open(), 120_000);
afterAll(() => pg.close(), 30_000);

let rails = sagaRails();

function refundScenario(name: string, afterSettlement: boolean): MoneyDoorScenario {
  return {
    name,
    secret: SAGA_SECRET,
    verify: verifyServiceHeaders,
    async setup(ledger) {
      await resetPay(pg.database());
      await pinPayIds(pg.database());
      rails = sagaRails();
      const pay = payServiceOver(pg.database(), ledger as LedgerClient, rails.registry);
      const merchant = await pay.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 0 } });
      const payment = await pay.createPayment({
        requestId: PAYMENT_ID,
        merchantId: merchant.id,
        amount: amt('10'),
        assetId: 'USDT',
        method: 'crypto',
        railAdapter: 'crypto-native',
      });
      const address = await rails.chain.acceptanceAddress(payment.id, 'USDT');
      rails.chain.credit({ address, assetId: 'USDT', amount: amt('10'), from: '0xbuyer', confirmations: 12 });
      await pay.authorize(payment.id);
      await pay.capture(payment.id);
      if (afterSettlement) {
        await pay.settleWindow({
          merchantId: merchant.id,
          window: 'saga-refund',
          assetId: 'USDT',
          from: new Date(Date.now() - 24 * 3600_000),
          to: new Date(Date.now() + 24 * 3600_000),
        });
      }
    },
    run: (fetchImpl) =>
      overHarness(fetchImpl, async () => {
        const pay = payServiceOver(pg.database(), createLedgerClient('http://ledger.test', SAGA_SECRET), rails.registry);
        return pay.refund(PAYMENT_ID, amt('4'), { refundId: REFUND_ID });
      }),
    async invariant() {
      // One refund, one send: the rail is never asked to pay the same refund twice.
      const sent = rails.chain.outboundTransfers().length;
      if (sent !== 1) throw new Error(`the rail sent ${sent} refund transfers`);
      const events = await pg.database()
        .sql`SELECT 1 FROM pay.payment_events WHERE event = 'refunded' AND payload->>'refundId' = ${REFUND_ID}`;
      if (events.length > 1) throw new Error(`the refund was recorded ${events.length} times`);
    },
  };
}

describeMoneyDoor(refundScenario('svc-pay payment refund from clearing (crypto-native)', false), () => new MemoryLedger());
describeMoneyDoor(refundScenario('svc-pay payment refund from settled proceeds (crypto-native)', true), () => new MemoryLedger());
