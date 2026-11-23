import { describe, expect, it, vi } from 'vitest';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, type Amount } from '@intafaced/ledger-client';
import { TokenError } from './token-service.js';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { runBuybackWindow, type BuybackJobDeps } from './buyback-job.js';

const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WINDOW = { from: new Date('2026-07-01T00:00:00.000Z'), to: new Date('2026-07-08T00:00:00.000Z') };

async function seedFee(ledger: MemoryLedger, module: string, assetId: string, amount: string): Promise<void> {
  const payer = '99999999-9999-4999-8999-999999999999';
  await ledger.post(
    recipes.deposit({
      userId: payer,
      assetId,
      amount: amt(amount),
      rail: 'test',
      railRef: `${module}:${assetId}:${amount}:${Math.random()}`,
    }),
  );
  await ledger.post(
    recipes.feeCharge({
      chargeId: `${module}:${Math.random()}`,
      userId: payer,
      module,
      mode: 'asset',
      assetId,
      amount: amt(amount),
    }),
  );
}

function deps(overrides: Partial<BuybackJobDeps> & { ledger: MemoryLedger }): BuybackJobDeps {
  return {
    buybackJobEnabled: true,
    assetId: 'IFC',
    quoteAssetId: 'USDT',
    buybackParams: vi.fn(async () => DEFAULT_BUYBACK_PARAMS),
    placeIocMarketBuy: vi.fn(async () => ({ filledQty: amt('10') })),
    settleBuyback: vi.fn(async (input) => ({
      runId: input.runId,
      burned: input.tokensBought,
      toRewards: 0n,
    })),
    ...overrides,
  };
}

describe('runBuybackWindow', () => {
  it('refuses when the job is unset — never reads pots, never places, never burns', async () => {
    const ledger = new MemoryLedger();
    const d = deps({ ledger, buybackJobEnabled: false });
    const balance = vi.spyOn(ledger, 'balance');

    await expect(runBuybackWindow(d, { runId: RUN, revenueWindow: WINDOW })).rejects.toMatchObject({
      name: 'TokenError',
      code: 'token.buyback_job_unset',
    });
    expect(d.placeIocMarketBuy).not.toHaveBeenCalled();
    expect(d.settleBuyback).not.toHaveBeenCalled();
    expect(balance).not.toHaveBeenCalled();
  });

  it('refuses caller-typed tokensBought — fill is not an input', async () => {
    const ledger = new MemoryLedger();
    const d = deps({ ledger });
    await expect(runBuybackWindow(d, { runId: RUN, revenueWindow: WINDOW, tokensBought: amt('999') } as never)).rejects.toMatchObject({
      name: 'TokenError',
      code: 'token.buyback_job_unset',
    });
    expect(d.placeIocMarketBuy).not.toHaveBeenCalled();
    expect(d.settleBuyback).not.toHaveBeenCalled();
  });

  it('refuses caller-typed revenueTotal — pots are not an input', async () => {
    const ledger = new MemoryLedger();
    const d = deps({ ledger });
    await expect(runBuybackWindow(d, { runId: RUN, revenueWindow: WINDOW, revenueTotal: { USDT: '999' } } as never)).rejects.toMatchObject({
      name: 'TokenError',
      code: 'token.buyback_job_unset',
    });
    expect(d.placeIocMarketBuy).not.toHaveBeenCalled();
    expect(d.settleBuyback).not.toHaveBeenCalled();
  });

  it('sizes quoteBudget from houseFees × buybackBudget and settles the FILL not the budget', async () => {
    const ledger = new MemoryLedger();
    await seedFee(ledger, 'trade', 'USDT', '40');
    await seedFee(ledger, 'pay', 'USDT', '60');
    const d = deps({ ledger });

    const result = await runBuybackWindow(d, { runId: RUN, revenueWindow: WINDOW });
    expect(formatAmount(result.tokensBought)).toBe('10');
    expect(d.placeIocMarketBuy).toHaveBeenCalledOnce();
    expect(d.placeIocMarketBuy).toHaveBeenCalledWith({ quoteBudget: amt('50'), clientOrderId: RUN });
    expect(d.settleBuyback).toHaveBeenCalledOnce();
    expect(d.settleBuyback).toHaveBeenCalledWith({
      runId: RUN,
      revenueWindow: WINDOW,
      revenueTotal: { USDT: '100' },
      tokensBought: amt('10'),
    });
  });

  it('empty book / zero fill is token.buyback_book_empty — no invented mid, no settle', async () => {
    const ledger = new MemoryLedger();
    await seedFee(ledger, 'trade', 'USDT', '100');
    const d = deps({
      ledger,
      placeIocMarketBuy: vi.fn(async () => ({ filledQty: 0n })),
    });
    await expect(runBuybackWindow(d, { runId: RUN, revenueWindow: WINDOW })).rejects.toBeInstanceOf(TokenError);
    await expect(runBuybackWindow(d, { runId: RUN, revenueWindow: WINDOW })).rejects.toMatchObject({
      code: 'token.buyback_book_empty',
    });
    expect(d.placeIocMarketBuy).toHaveBeenCalled();
    expect(d.settleBuyback).not.toHaveBeenCalled();
  });

  it('zero revenue refuses before placeOrder — no invented spend', async () => {
    const ledger = new MemoryLedger();
    const d = deps({ ledger });
    await expect(runBuybackWindow(d, { runId: RUN, revenueWindow: WINDOW })).rejects.toMatchObject({
      code: 'token.buyback_revenue_invalid',
    });
    expect(d.placeIocMarketBuy).not.toHaveBeenCalled();
    expect(d.settleBuyback).not.toHaveBeenCalled();
  });

  it('blank quote asset is unset — never invents USDT', async () => {
    const ledger = new MemoryLedger();
    const d = deps({ ledger, quoteAssetId: '' });
    await expect(runBuybackWindow(d, { runId: RUN, revenueWindow: WINDOW })).rejects.toMatchObject({
      code: 'token.buyback_job_unset',
    });
    expect(d.placeIocMarketBuy).not.toHaveBeenCalled();
  });

  it('fails if placeIocMarketBuy is skipped — fill cannot come from the budget', async () => {
    const ledger = new MemoryLedger();
    await seedFee(ledger, 'trade', 'USDT', '100');
    const settleBuyback = vi.fn(async (input: { tokensBought: Amount; runId: string }) => ({
      runId: input.runId,
      burned: input.tokensBought,
      toRewards: 0n,
    }));
    const d = deps({
      ledger,
      placeIocMarketBuy: vi.fn(async () => ({ filledQty: amt('7') })),
      settleBuyback,
    });
    await runBuybackWindow(d, { runId: RUN, revenueWindow: WINDOW });
    expect(d.placeIocMarketBuy).toHaveBeenCalledOnce();
    expect(settleBuyback.mock.calls[0]?.[0]?.tokensBought).toBe(amt('7'));
    expect(settleBuyback.mock.calls[0]?.[0]?.tokensBought).not.toBe(amt('50'));
  });
});
