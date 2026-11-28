/**
 * What a settled fill tells affiliates, and in which order, over the production TradeService and a real trade schema:
 * one classic fill (Bob rests a sell, Alice takes it) and one fill against the house market maker. Each step is
 * recorded as it happens: `post:<reason>` when the ledger accepted a post, `accrue:<feeEventId>` and
 * `payout:<feeEventId>` when identity was told. The accrue and payout test files read the same run.
 */
import type { TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt, recipes, type LedgerTx, type PostRequest } from '@intafaced/ledger-client';
import type { AffiliateFeeLeg } from '../affiliate-accrue.js';
import { mmSeedOrderIdFor } from '../ids.js';
import { MM_MATCHING_ACCOUNT_ID } from '../../mm/fill-account.js';
import { principalFor, StubMatching } from '../testing.js';
import { ALICE, BOB, fund, resetAndListMarket, tradeOver } from './saga-trade-fixture.js';

export interface AffiliateRun {
  readonly classic: readonly string[];
  readonly marketMaker: readonly string[];
}

export async function affiliateOrderAfterFills(db: TestDatabase): Promise<AffiliateRun> {
  const steps: string[] = [];
  class RecordingLedger extends MemoryLedger {
    override async post(request: PostRequest): Promise<LedgerTx> {
      const tx = await super.post(request);
      steps.push(`post:${request.reason}`);
      return tx;
    }
  }
  const ledger = new RecordingLedger();
  const matching = new StubMatching();
  const market = await resetAndListMarket(db, ledger, matching);
  await fund(ledger, BOB, 'BTC', '5');
  await fund(ledger, ALICE, 'USDT', '1000');
  await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: 'affiliate-order-mm' }));
  const mmOrderId = mmSeedOrderIdFor('affiliate-order', market.id, 'sell', 1);
  await ledger.post(recipes.marketMakerOrderHold({ orderId: mmOrderId, assetId: 'BTC', amount: amt('1') }));

  const trade = tradeOver(db, ledger, matching, undefined, {
    affiliateAccrue: { accrueTradeFee: async (leg: AffiliateFeeLeg) => void steps.push(`accrue:${leg.feeEventId}`) },
    affiliatePayout: { payoutTradeFee: async (feeEventId: string) => void steps.push(`payout:${feeEventId}`) },
  });
  const order = (userId: string, side: 'buy' | 'sell', clientOrderId: string) =>
    trade.placeOrder(principalFor(userId), { marketId: market.id, side, type: 'limit', qty: amt('1'), price: amt('100'), clientOrderId });

  const maker = await order(BOB, 'sell', 'affiliate-classic-maker');
  const taker = await order(ALICE, 'buy', 'affiliate-classic-taker');
  let from = steps.length;
  await trade.settleFillEvent({
    marketId: market.id,
    makerOrderId: maker.id,
    takerOrderId: taker.id,
    price: '100',
    qty: '1',
    sequence: 1,
    makerAccountId: BOB,
    takerAccountId: ALICE,
  });
  const classic = steps.slice(from);

  const mmTaker = await order(ALICE, 'buy', 'affiliate-mm-taker');
  from = steps.length;
  await trade.settleFillEvent({
    marketId: market.id,
    makerOrderId: mmOrderId,
    takerOrderId: mmTaker.id,
    price: '100',
    qty: '1',
    sequence: 2,
    makerAccountId: MM_MATCHING_ACCOUNT_ID,
    takerAccountId: ALICE,
  });
  return { classic, marketMaker: steps.slice(from) };
}

/** The step's position in the run, or -1. */
export const firstIndex = (steps: readonly string[], prefix: string) => steps.findIndex((step) => step.startsWith(prefix));
export const lastIndex = (steps: readonly string[], prefix: string) => steps.findLastIndex((step) => step.startsWith(prefix));
