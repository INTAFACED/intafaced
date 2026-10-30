import { describe, expect, it } from 'vitest';
import { BUYBACK_INVALID, HOUSE_BUYBACK_USER_UUID } from '../buyback-order.js';
import { installNativeQtyUpAmend } from '../qty-up-amend.js';
import { principalFor } from '../testing.js';
import type { TradeService, TradeServiceInternal } from '../trade-service.js';
import type { Market, OrderRecord } from '../types.js';
import { amendOrder, applyNativeAmendHold } from './order-change.js';

const order = {
  id: 'buyback-order-1',
  userId: HOUSE_BUYBACK_USER_UUID,
  status: 'open',
  type: 'limit',
  tif: 'GTC',
  holdAsset: 'USDT',
  price: 100n,
} as unknown as OrderRecord;

/** A service that answers only findOrder and amendOutcome; reading anything else (the market, the engine, the ledger) fails the test. */
function onlyFindAndOutcome(): { svc: object; read: string[] } {
  const read: string[] = [];
  const allowed = {
    findOrder: async () => order,
    amendOutcome: (o: OrderRecord, code: string, reasonCode: string | null) => ({ code, reasonCode, orderId: o.id }),
  };
  const svc = new Proxy(allowed, {
    get(target, key) {
      read.push(String(key));
      if (key in target) return target[key as keyof typeof target];
      throw new Error(`svc.${String(key)} was read`);
    },
  });
  return { svc, read };
}

describe('a buyback order is never amended', () => {
  it('the amend door refuses it before the market or the engine is read', async () => {
    const { svc, read } = onlyFindAndOutcome();
    const outcome = await amendOrder(svc as TradeServiceInternal, principalFor(HOUSE_BUYBACK_USER_UUID), order.id, { qty: 1n } as never);
    expect(outcome).toMatchObject({ code: 'NOT_AMENDABLE', reasonCode: BUYBACK_INVALID });
    expect(read.filter((k) => k !== 'findOrder' && k !== 'amendOutcome' && k !== 'then')).toEqual([]);
  });

  it('the installed qty-up amend door refuses it the same way', async () => {
    class Fake {}
    installNativeQtyUpAmend(Fake as unknown as typeof TradeService);
    const amend = (Fake.prototype as unknown as { amendOrder: TradeService['amendOrder'] }).amendOrder;
    const { svc, read } = onlyFindAndOutcome();
    const outcome = await amend.call(svc as TradeService, principalFor(HOUSE_BUYBACK_USER_UUID), order.id, { qty: 1n } as never);
    expect(outcome).toMatchObject({ code: 'NOT_AMENDABLE', reasonCode: BUYBACK_INVALID });
    expect(read.filter((k) => k !== 'findOrder' && k !== 'amendOutcome' && k !== 'then')).toEqual([]);
  });

  it('the amend hold step still refuses it before it reads or posts anything (backstop)', async () => {
    const touched: string[] = [];
    const svc = new Proxy({} as TradeServiceInternal, {
      get(_target, key) {
        touched.push(String(key));
        throw new Error(`svc.${String(key)} was read`);
      },
    });
    await expect(applyNativeAmendHold(svc, order, {} as Market, 1n as never, 1, null)).rejects.toMatchObject({ code: BUYBACK_INVALID });
    expect(touched).toEqual([]);
  });
});
