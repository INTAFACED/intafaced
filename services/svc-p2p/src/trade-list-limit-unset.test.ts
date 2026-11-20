import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { P2P_TRADES_LIST } from '@intafaced/contracts/p2p-procedures';
import { describe, expect, it } from 'vitest';
import { P2pError, assertTradeListLimit } from './p2p-service.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * trades.list page size is refuse-closed when unset.
 *
 * listTrades used `limit = 50`, so omit invented a 50-row trade page.
 * Blank must refuse. Owner/client may pass 50 explicitly.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('trades.list limit unset refuse', () => {
  it('assertTradeListLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertTradeListLimit(undefined)).toThrow(P2pError);
    expect(() => assertTradeListLimit(Number.NaN)).toThrow(P2pError);
    expect(() => assertTradeListLimit(0)).toThrow(P2pError);
    try {
      assertTradeListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(P2pError);
      expect((e as P2pError).code).toBe('p2p.trade_list_limit_unset');
      expect((e as P2pError).message).toBe(resolveP2pCopy(P2P_COPY.tradeListLimitUnset));
      expect((e as P2pError).message).not.toMatch(/50-row|default 50/i);
    }
  });

  it('accepts owner-published 50 and caps at 200', () => {
    expect(assertTradeListLimit(50)).toBe(50);
    expect(assertTradeListLimit(1)).toBe(1);
    expect(assertTradeListLimit(200)).toBe(200);
    expect(assertTradeListLimit(201)).toBe(200);
  });

  it('listTrades no longer defaults limit to 50', () => {
    const src = readFileSync(join(ROOT, 'services/svc-p2p/src/p2p-service.ts'), 'utf8');
    const start = src.indexOf('async listTrades(');
    const end = src.indexOf('async getDispute(', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertTradeListLimit');
    expect(fn).not.toMatch(/limit = 50/);
    expect(fn).not.toMatch(/\?\? 50/);
  });

  it('the list record lets an omitted limit reach the named refusal, and the handler does not invent 50', () => {
    expect(P2P_TRADES_LIST.input.safeParse(undefined).success).toBe(true);
    expect(P2P_TRADES_LIST.input.safeParse({}).success).toBe(true);
    expect(P2P_TRADES_LIST.refusals['p2p.trade_list_limit_unset']).toBe('PRECONDITION_FAILED');
    const src = readFileSync(join(ROOT, 'services/svc-p2p/src/router.ts'), 'utf8');
    const handler = src.slice(src.indexOf("'p2p.trades.list':"), src.indexOf("'p2p.trades.page':"));
    expect(handler).toContain('listTrades(userOf(ctx), input?.limit)');
    expect(handler).not.toMatch(/\?\? 50/);
  });
});
