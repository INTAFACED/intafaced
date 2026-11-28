import { describe, expect, it } from 'vitest';
import { P2pError } from './p2p-service.js';
import { MerchantService, assertMerchantHistoryLimit } from './merchant-service.js';
import { limitsOf, recordingSql } from './testing/sql-recorder-fixture.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * merchants.history page size is refuse-closed when unset.
 *
 * history() selected every p2p_merchant_events row for the user, so omit dumped
 * the entire standing log. Blank must refuse. Owner/client may pass 50 explicitly.
 */

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('merchants.history limit unset refuse', () => {
  it('assertMerchantHistoryLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertMerchantHistoryLimit(undefined)).toThrow(P2pError);
    expect(() => assertMerchantHistoryLimit(Number.NaN)).toThrow(P2pError);
    expect(() => assertMerchantHistoryLimit(0)).toThrow(P2pError);
    try {
      assertMerchantHistoryLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(P2pError);
      expect((e as P2pError).code).toBe('p2p.merchant_history_limit_unset');
      expect((e as P2pError).message).toBe(resolveP2pCopy(P2P_COPY.merchantHistoryLimitUnset));
      expect((e as P2pError).message).not.toMatch(/50-row|default 50/i);
    }
  });

  it('history refuses without limit — never invents 50', async () => {
    const merchants = new MerchantService({} as never, {} as never);
    await expect(merchants.history('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).rejects.toMatchObject({
      code: 'p2p.merchant_history_limit_unset',
    });
    expect(assertMerchantHistoryLimit(50)).toBe(50);
  });

  it('accepts owner-published 50 and caps at 200', () => {
    expect(assertMerchantHistoryLimit(50)).toBe(50);
    expect(assertMerchantHistoryLimit(1)).toBe(1);
    expect(assertMerchantHistoryLimit(200)).toBe(200);
    expect(assertMerchantHistoryLimit(201)).toBe(200);
  });

  it('history reads the event log by the limit it was given, capped at 200', async () => {
    const { sql, calls } = recordingSql();
    const merchants = new MerchantService(sql, {} as never);
    await expect(merchants.history(USER)).rejects.toMatchObject({ code: 'p2p.merchant_history_limit_unset' });
    expect(calls).toHaveLength(0);
    await expect(merchants.history(USER, 50)).resolves.toEqual([]);
    await merchants.history(USER, 201);
    expect(limitsOf(calls)).toEqual([50, 200]);
  });
});
