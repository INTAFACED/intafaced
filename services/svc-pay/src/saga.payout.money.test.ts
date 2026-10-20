/**
 * SAGATEST for svc-pay's merchant proceeds payout: `payoutSettlement` posts the hold, asks the rail, then posts the
 * settle. `describeMoneyDoor` replays it as a duplicate request, a lost acknowledgement on each post, and a crash after
 * each post, and requires the book of one clean run every time. Postgres and the rail (the chain) survive a crash, as
 * they would for real.
 */
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { formatAmount, MemoryLedger, parseAmount as amt, type LedgerClient } from '@intafaced/ledger-client';
import { describeMoneyDoor, type MoneyDoorScenario } from '@intafaced/ledger-client/testing/saga';
import { PayError } from './payment-service.js';
import { railFailure } from './rails/rail-adapter.js';
import { createLedgerClient } from './ledger-client.js';
import { installPayoutDestinationShim } from './payout-destination-test-shim.js';
import { overHarness, payServiceOver, pinPayIds, resetPay, SAGA_SECRET, sagaPayDatabase, sagaRails } from './saga-fixture-test.js';

// Each replay boots a database and runs the door several times; the 5s default is too tight on a loaded CI runner.
vi.setConfig({ testTimeout: 30_000 });

const PAYMENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MERCHANT_USER = '11111111-1111-4111-8111-111111111111';
const DEST = { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' };

const pg = sagaPayDatabase();
beforeAll(() => pg.open(), 120_000);
afterAll(() => pg.close(), 30_000);

let restoreShim: (() => void) | undefined;
afterEach(() => {
  restoreShim?.();
  restoreShim = undefined;
});

let rails = sagaRails();
let settlementId = '';
let merchantId = '';

/** The hold is released, or paid out: never left behind, and the rail is never asked to send twice. */
async function noHoldLeft(ledger: MemoryLedger): Promise<void> {
  const held = (await ledger.balances('module', `pay:proceeds:${merchantId}`))
    .filter((b) => b.account.kind === 'hold')
    .reduce((acc, b) => acc + b.amount, 0n);
  if (held !== 0n) throw new Error(`a payout hold of ${formatAmount(held)} is stranded`);
}

function payoutScenario(name: string, refused: boolean): MoneyDoorScenario {
  return {
    name,
    secret: SAGA_SECRET,
    verify: verifyServiceHeaders,
    async setup(ledger) {
      restoreShim?.();
      restoreShim = installPayoutDestinationShim(pg.database().sql);
      await resetPay(pg.database());
      await pinPayIds(pg.database());
      rails = sagaRails();
      if (refused) {
        rails.crypto.payout = async (s) =>
          railFailure({
            railRef: '',
            amount: s.amount,
            assetId: s.assetId,
            failureCode: 'chain.not_configured',
            failureReason: 'NO CHAIN IS CONFIGURED',
          });
      }
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
      const settlement = await pay.settleWindow({
        merchantId: merchant.id,
        window: 'saga-payout',
        assetId: 'USDT',
        from: new Date(Date.now() - 24 * 3600_000),
        to: new Date(Date.now() + 24 * 3600_000),
      });
      settlementId = settlement.id;
      merchantId = merchant.id;
    },
    run: (fetchImpl) =>
      overHarness(fetchImpl, async () => {
        const pay = payServiceOver(pg.database(), createLedgerClient('http://ledger.test', SAGA_SECRET), rails.registry);
        // A refused attempt is finished (`failed`, one reverse booked). Calling again opens the NEXT attempt on purpose,
        // so only an unfinished payout is resumed, the way a retry after a lost reply or a crash would.
        if (refused && (await pay.getSettlement(settlementId)).status === 'failed') return undefined;
        try {
          return await pay.payoutSettlement({ settlementId, railId: 'crypto-native', destination: DEST });
        } catch (error) {
          // A refusal is this door's typed answer, and it is what a retry of a refused payout gets too.
          if (refused && error instanceof PayError && error.code === 'pay.rail_failed') return undefined;
          throw error;
        }
      }),
    async invariant(ledger) {
      await noHoldLeft(ledger);
      const sent = rails.chain.outboundTransfers().length;
      if (sent !== (refused ? 0 : 1)) throw new Error(`the rail sent ${sent} transfers`);
    },
  };
}

const paid = payoutScenario('svc-pay merchant proceeds payout (hold, rail, settle)', false);
const refusedByRail = payoutScenario('svc-pay merchant proceeds payout refused by the rail (hold, reverse)', true);

describeMoneyDoor(paid, () => new MemoryLedger());
describeMoneyDoor(refusedByRail, () => new MemoryLedger());
