/**
 * Dated futures expiry: one position that cannot be paid must not stop the rest.
 *
 * A winner is paid from `houseFees('trade')`. When that pot cannot cover one winner,
 * the post throws. Before this suite's fix the throw escaped the position loop, so every
 * later position in the market (and every later market in the scan) stayed unsettled,
 * and nothing in the market was marked closed. Each position settles on its own now;
 * the one that cannot be paid comes back as a typed refusal and stays open for the next run.
 */
import {
  MemoryLedger,
  formatAmount,
  houseFees,
  parseAmount as amt,
  positionCollateralAccount,
  recipes,
  userAvailable,
} from '@intafaced/ledger-client';
import { reportDatedSettlement } from './futures-jobs.js';
import { describe, expect, it } from 'vitest';
import {
  runDatedFuturesSettlementJob,
  runDatedFuturesSettlementScan,
  type DatedFuturesSettlementPosition,
} from './dated-futures-settlement.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const CAROL = '33333333-3333-4333-8333-333333333333';
const POS_WIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POS_LOSS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXPIRY = new Date('2026-12-26T08:00:00.000Z');
const AFTER = new Date('2026-12-26T08:00:01.000Z');

function position(positionId: string, userId: string, side: 'long' | 'short'): DatedFuturesSettlementPosition {
  return { positionId, userId, side, size: amt('1'), entryPrice: amt('100'), margin: amt('20'), marginAsset: 'USDT' };
}

/** Alice (long, wins at 110) is listed first; Carol (short, loses) second. The fee pot is empty. */
async function seed(ledger: MemoryLedger) {
  await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'alice' }));
  await ledger.post(recipes.futuresMarginLock({ positionId: POS_WIN, userId: ALICE, assetId: 'USDT', amount: amt('20') }));
  await ledger.post(recipes.deposit({ userId: CAROL, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'carol' }));
  await ledger.post(recipes.futuresMarginLock({ positionId: POS_LOSS, userId: CAROL, assetId: 'USDT', amount: amt('20') }));
}

const positions = [position(POS_WIN, ALICE, 'long'), position(POS_LOSS, CAROL, 'short')];

describe('dated futures settlement isolates an unpayable winner', () => {
  it('settles the later position and reports the unpayable winner, which stays open', async () => {
    const ledger = new MemoryLedger();
    await seed(ledger);
    const closed: string[] = [];
    const result = await runDatedFuturesSettlementJob({
      style: 'dated',
      expiryAt: EXPIRY,
      now: AFTER,
      ownerSettlementPrice: '110',
      positions,
      ledger,
      markClosed: async (id) => {
        closed.push(id);
      },
    });
    expect(result).toMatchObject({ status: 'settled', settledPositionIds: [POS_LOSS] });
    expect(closed).toEqual([POS_LOSS]);
    if (result.status !== 'settled') throw new Error('expected settled');
    expect(result.unsettled).toEqual([{ positionId: POS_WIN, code: 'trade.dated_futures_settlement_unpaid', message: expect.any(String) }]);
    expect(formatAmount((await ledger.balance(positionCollateralAccount(ALICE, 'USDT', POS_WIN))).amount)).toBe('20');
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('980');
    expect(formatAmount((await ledger.balance(positionCollateralAccount(CAROL, 'USDT', POS_LOSS))).amount)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('scan marks each settled position closed even when an earlier one cannot be paid, and moves to the next market', async () => {
    const ledger = new MemoryLedger();
    await seed(ledger);
    const closed: string[] = [];
    const results = await runDatedFuturesSettlementScan({
      now: AFTER,
      settlementFixingConfigured: 'owner',
      ownerSettlementPriceFor: () => '110',
      markets: {
        listExpiredDated: async () => [
          { marketId: MARKET, style: 'dated', expiryAt: EXPIRY },
          { marketId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', style: 'dated', expiryAt: EXPIRY },
        ],
      },
      positions: { listOpenForMarket: async (id) => (id === MARKET ? positions : []) },
      ledger,
      markClosed: async (id) => {
        closed.push(id);
      },
    });
    expect(results).toHaveLength(2);
    expect(closed).toEqual([POS_LOSS]);
  });

  it('a retry settles the winner once the pot covers it, without paying twice', async () => {
    const ledger = new MemoryLedger();
    await seed(ledger);
    const run = () =>
      runDatedFuturesSettlementJob({ style: 'dated', expiryAt: EXPIRY, now: AFTER, ownerSettlementPrice: '110', positions, ledger });
    await run();
    await ledger.post(recipes.deposit({ userId: CAROL, assetId: 'USDT', amount: amt('50'), rail: 'test', railRef: 'pot-seed' }));
    await ledger.post(
      recipes.feeCharge({ chargeId: 'pot', userId: CAROL, module: 'trade', mode: 'asset', assetId: 'USDT', amount: amt('50') }),
    );
    const second = await run();
    expect(second).toMatchObject({ status: 'settled', unsettled: [] });
    expect(formatAmount((await ledger.balance(userAvailable(ALICE, 'USDT'))).amount)).toBe('1010');
    expect(formatAmount((await ledger.balance(houseFees('trade', 'USDT'))).amount)).toBe('40');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('the job reports every unsettled position so a stuck winner is not silent', async () => {
    const ledger = new MemoryLedger();
    await seed(ledger);
    const results = await runDatedFuturesSettlementScan({
      now: AFTER,
      settlementFixingConfigured: 'owner',
      ownerSettlementPriceFor: () => '110',
      markets: { listExpiredDated: async () => [{ marketId: MARKET, style: 'dated', expiryAt: EXPIRY }] },
      positions: { listOpenForMarket: async () => positions },
      ledger,
    });
    const seen: Array<[string, string]> = [];
    reportDatedSettlement(results, (name, err) => seen.push([name, (err as Error).message]));
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe('futures.dated_settlement');
    expect(seen[0]![1]).toContain(`trade.dated_futures_settlement_unpaid positionId=${POS_WIN}`);
  });
});
