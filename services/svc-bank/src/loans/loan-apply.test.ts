/**
 * The loan application's arithmetic and its refusals (BK-loan-01, J-bank-09 #2 and #3).
 * The quote's collateral is the smallest pledge `open` accepts: that amount opens, one unit less does not.
 * A published origination fee refuses `open` before any row or lock; blank is not set, never zero.
 */
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { liquidationPrice, minimumCollateral, originationFee, originationFeeOn } from './loan-apply.js';
import { LoanService } from './loan-service.js';
import { fixedPriceSource } from './prices.js';
import { DEFAULT_LIQUIDATION_POLICY, ltvBps } from './risk.js';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const ONE = parseAmount('1');

const productRow = {
  id: PRODUCT_ID,
  name: 'BTC-backed USDT',
  debt_asset_id: 'USDT',
  collateral_asset_id: 'BTC',
  quote_asset_id: 'USDT',
  apr_bps: 1_000,
  max_ltv_bps: 5_000,
  min_principal: '0',
  margin_call_ltv_bps: DEFAULT_LIQUIDATION_POLICY.marginCallLtvBps,
  liquidation_ltv_bps: DEFAULT_LIQUIDATION_POLICY.liquidationLtvBps,
  insolvency_ltv_bps: DEFAULT_LIQUIDATION_POLICY.insolvencyLtvBps,
  target_ltv_bps: DEFAULT_LIQUIDATION_POLICY.targetLtvBps,
  penalty_bps: DEFAULT_LIQUIDATION_POLICY.penaltyBps,
  max_tranche_bps: DEFAULT_LIQUIDATION_POLICY.maxTrancheBps,
  grace_seconds: DEFAULT_LIQUIDATION_POLICY.graceSeconds,
  status: 'open',
};

/** Every statement answers the product row; the statements are kept so a test can say none of them wrote. */
function service(options: { prices?: Record<string, { price: string }>; moduleEnabled?: boolean; originationFeeBps?: string }) {
  const statements: string[] = [];
  const sql = ((strings: TemplateStringsArray) => {
    statements.push(strings.join('?'));
    return Promise.resolve([productRow]);
  }) as unknown as Sql;
  const loans = new LoanService(sql, new MemoryLedger(), {
    priceSource: fixedPriceSource(options.prices ?? { BTC: { price: '60000' } }),
    ...(options.moduleEnabled === undefined ? {} : { moduleEnabled: options.moduleEnabled }),
    ...(options.originationFeeBps === undefined ? {} : { originationFeeBps: options.originationFeeBps }),
  });
  return { loans, statements };
}

const opensAt = (debtValue: bigint, collateral: bigint, price: bigint, cap: number) =>
  ltvBps(debtValue, (collateral * price) / ONE) <= cap;

describe('minimumCollateral is the smallest pledge the opening check accepts', () => {
  it.each([
    ['1000', '60000', 5_000],
    ['1000', '60000', 3_333],
    ['0.000001', '61234.56789', 5_000],
    ['250000', '0.0001', 9_000],
    ['7', '3', 1],
  ])('debt %s at collateral price %s under a %d bps cap', (debt, price, cap) => {
    const debtValue = parseAmount(debt);
    const p = parseAmount(price);
    const c = minimumCollateral(debtValue, p, cap);
    expect(opensAt(debtValue, c, p, cap)).toBe(true);
    expect(opensAt(debtValue, c - 1n, p, cap)).toBe(false);
  });

  it('refuses a zero debt, price or cap rather than answering zero', () => {
    expect(() => minimumCollateral(0n, ONE, 5_000)).toThrow(RangeError);
    expect(() => minimumCollateral(ONE, 0n, 5_000)).toThrow(RangeError);
    expect(() => minimumCollateral(ONE, ONE, 0)).toThrow(RangeError);
  });
});

describe('loans.quote', () => {
  it('quotes 1000 USDT against BTC at 60000: the exact pledge, its LTV and the liquidation price', async () => {
    const { loans, statements } = service({});
    const q = await loans.quote({ productId: PRODUCT_ID, principal: parseAmount('1000') });
    expect(q.requiredCollateral).toBe(33_333_333_333_333_334n);
    expect(q.startingLtvBps).toBe(5_000);
    expect(q.liquidationPrice).toBe(35_294_117_647_058_822_823_530n);
    expect(liquidationPrice(parseAmount('1000'), q.requiredCollateral, 8_500)).toBe(q.liquidationPrice);
    expect(statements.every((s) => /^\s*SELECT/i.test(s))).toBe(true);
  });

  it('an unpriced collateral asset refuses bank.mark_missing, never a zero', async () => {
    const { loans } = service({ prices: {} });
    await expect(loans.quote({ productId: PRODUCT_ID, principal: parseAmount('1000') })).rejects.toMatchObject({
      code: 'bank.mark_missing',
    });
  });

  it('the lending policy off refuses bank.loans_disabled before any read', async () => {
    const { loans, statements } = service({ moduleEnabled: false });
    await expect(loans.quote({ productId: PRODUCT_ID, principal: parseAmount('1000') })).rejects.toMatchObject({
      code: 'bank.loans_disabled',
    });
    expect(statements).toEqual([]);
  });

  it('a zero target refuses bank.below_minimum', async () => {
    const { loans } = service({});
    await expect(loans.quote({ productId: PRODUCT_ID, principal: 0n })).rejects.toMatchObject({ code: 'bank.below_minimum' });
  });
});

describe('the origination fee', () => {
  it.each([undefined, '', '   ', 'abc', '1.5', '-1', '10001'])('%j is not set', (raw) => {
    expect(originationFee(raw)).toEqual({ status: 'not_set' });
  });

  it('reads whole basis points, zero included', () => {
    expect(originationFee('0')).toEqual({ status: 'published', bps: 0 });
    expect(originationFee(' 50 ')).toEqual({ status: 'published', bps: 50 });
    expect(originationFeeOn(parseAmount('1000'), 50)).toBe(parseAmount('5'));
    expect(originationFeeOn(1n, 1)).toBe(1n);
  });

  it('a published non-zero fee refuses open bank.loan_fee_unwired before any row or lock', async () => {
    const { loans, statements } = service({ originationFeeBps: '50' });
    await expect(
      loans.open({
        loanId: '22222222-2222-4222-8222-222222222222',
        productId: PRODUCT_ID,
        userId: '33333333-3333-4333-8333-333333333333',
        collateralAmount: parseAmount('1'),
        principal: parseAmount('1000'),
      }),
    ).rejects.toMatchObject({ code: 'bank.loan_fee_unwired' });
    expect(statements.some((s) => /INSERT|UPDATE/i.test(s))).toBe(false);
  });

  it('a published zero fee does not refuse: the open goes on to its row', async () => {
    const { loans, statements } = service({ originationFeeBps: '0' });
    await loans
      .open({
        loanId: '22222222-2222-4222-8222-222222222222',
        productId: PRODUCT_ID,
        userId: '33333333-3333-4333-8333-333333333333',
        collateralAmount: parseAmount('1'),
        principal: parseAmount('1000'),
      })
      .catch(() => undefined);
    expect(statements.some((s) => /INSERT INTO bank\.loans/i.test(s))).toBe(true);
  });
});
