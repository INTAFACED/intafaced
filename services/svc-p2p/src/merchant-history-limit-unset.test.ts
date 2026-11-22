import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { P2P_MERCHANTS_HISTORY } from '@intafaced/contracts/p2p-procedures';
import { P2pError } from './p2p-service.js';
import { MerchantService, assertMerchantHistoryLimit } from './merchant-service.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * merchants.history page size is refuse-closed when unset.
 *
 * history() selected every p2p_merchant_events row for the user, so omit dumped
 * the entire standing log. Blank must refuse. Owner/client may pass 50 explicitly.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

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

  it('history no longer dumps the whole event log without a limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-p2p/src/merchant-service.ts'), 'utf8');
    const start = src.indexOf('async history(');
    const fn = src.slice(start);
    expect(fn).toContain('assertMerchantHistoryLimit');
    expect(fn).toContain('LIMIT ${lim}');
    expect(fn).not.toMatch(/\?\? 50/);
    expect(fn).not.toMatch(/\?\? 100/);
  });

  it('router does not invent 50 when merchants.history omits limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-p2p/src/router.ts'), 'utf8');
    const call = src.indexOf('requireMerchants().history(');
    expect(call).toBeGreaterThan(-1);
    const fn = src.slice(Math.max(0, call - 900), call + 120);
    expect(fn).toContain('history(input.userId, input.limit)');
    // The record keeps the page size optional, so an omitted one reaches the service's named refusal, never a default.
    const omitted = P2P_MERCHANTS_HISTORY.input.safeParse({ userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(omitted.success && omitted.data.limit).toBeUndefined();
    expect(P2P_MERCHANTS_HISTORY.refusals['p2p.merchant_history_limit_unset']).toBe('PRECONDITION_FAILED');
    expect(fn).not.toMatch(/input\.limit \?\? 50/);
    expect(fn).not.toMatch(/\?\? 50/);
    expect(fn).not.toMatch(/\?\? 100/);
  });
});
