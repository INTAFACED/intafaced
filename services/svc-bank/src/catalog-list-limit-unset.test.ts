import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BankError } from './errors.js';
import { assertEarnPoolsListLimit, assertLoanProductsListLimit } from './catalog-list-limit.js';
import { bankRouterSource } from './router/router-source.js';

/**
 * Catalog page size is refuse-closed when unset.
 *
 * earn.pools / loans.products used to SELECT without LIMIT. Blank must refuse.
 * Owner/client may pass 50 explicitly. Never invent 50.
 *
 * Not milled: job batches (already refuse-closed), treasury dual-control,
 * earn.accrueAll work set (still every open pool — not a catalog dump).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function refuseBank(fn: (n: number | undefined) => number, code: string) {
  expect(() => fn(undefined)).toThrow(BankError);
  expect(() => fn(Number.NaN)).toThrow(BankError);
  expect(() => fn(0)).toThrow(BankError);
  try {
    fn(undefined);
    throw new Error('expected refuse');
  } catch (e) {
    expect(e).toBeInstanceOf(BankError);
    expect((e as BankError).code).toBe(code);
    expect((e as BankError).message).not.toMatch(/default 50|50-row/i);
  }
}

describe('svc-bank catalog list limit unset refuse', () => {
  it('earn.pools / loans.products asserts refuse blank / NaN / 0 — never invent 50', () => {
    refuseBank(assertEarnPoolsListLimit, 'bank.earn_pools_list_limit_unset');
    refuseBank(assertLoanProductsListLimit, 'bank.loan_products_list_limit_unset');
  });

  it('accepts owner-published 50 and caps at 200', () => {
    expect(assertEarnPoolsListLimit(50)).toBe(50);
    expect(assertLoanProductsListLimit(50)).toBe(50);
    expect(assertEarnPoolsListLimit(1)).toBe(1);
    expect(assertEarnPoolsListLimit(200)).toBe(200);
    expect(assertEarnPoolsListLimit(201)).toBe(200);
    expect(assertLoanProductsListLimit(201)).toBe(200);
  });

  it('listPools / listProducts require the assert and SQL LIMIT — no invented 50', () => {
    const earn = readFileSync(join(ROOT, 'services/svc-bank/src/earn/earn-service.ts'), 'utf8');
    const listPools = earn.slice(earn.indexOf('async listPools('), earn.indexOf('async fundPool('));
    expect(listPools).toContain('assertEarnPoolsListLimit');
    expect(listPools).toContain('LIMIT ${page}');
    expect(listPools).not.toMatch(/\?\? 50/);
    expect(listPools).not.toMatch(/limit = 50/);

    const loans = readFileSync(join(ROOT, 'services/svc-bank/src/loans/loan-service.ts'), 'utf8');
    const listProducts = loans.slice(loans.indexOf('async listProducts('), loans.indexOf('async product('));
    expect(listProducts).toContain('assertLoanProductsListLimit');
    expect(listProducts).toContain('LIMIT ${page}');
    expect(listProducts).not.toMatch(/\?\? 50/);
    expect(listProducts).not.toMatch(/limit = 50/);
  });

  it('tRPC earn.pools / loans.products pass optional input.limit — omit is not 50', () => {
    const router = bankRouterSource();
    const pools = router.slice(router.indexOf('pools: scopedProcedure'), router.indexOf('deposit: scopedProcedure'));
    expect(pools).toContain('limit: z.number().int().min(1).max(200).optional()');
    expect(pools).toContain('listPools(input.assetId, input.limit)');
    expect(pools).not.toMatch(/\?\? 50/);
    expect(pools).not.toMatch(/listPools\(input\.assetId\)/);

    const products = router.slice(router.indexOf('products: scopedProcedure'), router.indexOf('open: scopedProcedure'));
    expect(products).toContain('limit: z.number().int().min(1).max(200).optional()');
    expect(products).toContain('listProducts(input.assetId, input.limit)');
    expect(products).not.toMatch(/\?\? 50/);
    expect(products).not.toMatch(/listProducts\(input\.assetId\)/);
  });

  it('accrueAll still loads the full accrual work set (open pools, and closed pools still holding savings) — not a catalog page of 50', () => {
    const earn = readFileSync(join(ROOT, 'services/svc-bank/src/earn/earn-service.ts'), 'utf8');
    const accrueAll = earn.slice(earn.indexOf('async accrueAll('), earn.indexOf('async interestPaid('));
    expect(accrueAll).toContain('this.poolsForAccrual()');
    expect(accrueAll).not.toMatch(/this\.listPools\(\)/);
    expect(accrueAll).not.toMatch(/\?\? 50/);
  });
});
