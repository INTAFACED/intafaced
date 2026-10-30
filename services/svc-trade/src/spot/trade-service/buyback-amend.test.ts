import { describe, expect, it } from 'vitest';
import { BUYBACK_INVALID, HOUSE_BUYBACK_USER_UUID } from '../buyback-order.js';
import type { TradeServiceInternal } from '../trade-service.js';
import type { Market, OrderRecord } from '../types.js';
import { applyNativeAmendHold } from './order-change.js';

describe('a buyback order is never amended', () => {
  it('refuses before it reads or posts anything', async () => {
    const touched: string[] = [];
    const svc = new Proxy({} as TradeServiceInternal, {
      get(_target, key) {
        touched.push(String(key));
        throw new Error(`svc.${String(key)} was read`);
      },
    });
    const order = { id: 'buyback-order-1', userId: HOUSE_BUYBACK_USER_UUID, holdAsset: 'USDT', price: 100n } as unknown as OrderRecord;
    await expect(applyNativeAmendHold(svc, order, {} as Market, 1n as never, 1, null)).rejects.toMatchObject({ code: BUYBACK_INVALID });
    expect(touched).toEqual([]);
  });
});
