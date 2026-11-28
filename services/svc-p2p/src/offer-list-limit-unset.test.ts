import { describe, expect, it } from 'vitest';
import { InstrumentService } from './instrument-service.js';
import { P2pError, P2pService, assertOfferListLimit } from './p2p-service.js';
import { limitsOf, recordingSql } from './testing/sql-recorder-fixture.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * offers.list page size is refuse-closed when unset.
 *
 * listOffers used `filter.limit ?? 50`, so omit invented a 50-row public board.
 * Blank must refuse. Owner/client may pass 50 explicitly.
 */

describe('offers.list limit unset refuse', () => {
  it('assertOfferListLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertOfferListLimit(undefined)).toThrow(P2pError);
    expect(() => assertOfferListLimit(Number.NaN)).toThrow(P2pError);
    expect(() => assertOfferListLimit(0)).toThrow(P2pError);
    try {
      assertOfferListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(P2pError);
      expect((e as P2pError).code).toBe('p2p.offer_list_limit_unset');
      expect((e as P2pError).message).toBe(resolveP2pCopy(P2P_COPY.offerListLimitUnset));
      expect((e as P2pError).message).not.toMatch(/50-row|default 50/i);
    }
  });

  it('accepts owner-published 50 and caps at 200', () => {
    expect(assertOfferListLimit(50)).toBe(50);
    expect(assertOfferListLimit(1)).toBe(1);
    expect(assertOfferListLimit(200)).toBe(200);
    expect(assertOfferListLimit(201)).toBe(200);
  });

  it('listOffers refuses an omitted limit before any query, and reads the board by the limit it was given', async () => {
    const { sql, calls } = recordingSql();
    const p2p = new P2pService(sql, {} as never, {} as never, { instruments: new InstrumentService(sql) } as never);
    await expect(p2p.listOffers()).rejects.toMatchObject({ code: 'p2p.offer_list_limit_unset' });
    await expect(p2p.listOffers({ asset: 'USDT' })).rejects.toMatchObject({ code: 'p2p.offer_list_limit_unset' });
    expect(calls).toHaveLength(0);
    await expect(p2p.listOffers({ limit: 50 })).resolves.toEqual([]);
    expect(limitsOf(calls)).toEqual([50]);
    await p2p.listOffers({ limit: 201 });
    expect(limitsOf(calls)).toEqual([50, 200]);
  });
});
