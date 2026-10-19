import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { orderSchema } from '../../src/features/trade/trade-api';
import { BASE, QUOTE, SYMBOL, balance } from './desk';
import { fund, newCustomer } from './stack';

/**
 * A sell OCO (take-profit plus stop-loss) from the pro trader's side. The desk does not offer OCO yet (UNSUPPORTED_TYPES in
 * screens/trade/desk/tif.ts), so the order goes through the app's ApiClient with the body the service documents. One order,
 * one base hold. Buy-side OCO and bracket refuse with a typed reason by design (this file). The fill and cancel journeys wait on
 * two defects handed to the OCO owner (status/trade-oco-journeys.journey.ts.txt).
 */
const ocoBody = (extra: Record<string, unknown> = {}) => ({
  symbol: SYMBOL,
  side: 'sell',
  type: 'limit',
  amount: '0.1',
  price: '110',
  timeInForce: 'GTC',
  oco: true,
  takeProfit: { stopPrice: '110' },
  stopLoss: { stopPrice: '90' },
  clientOrderId: `journey:${randomUUID()}`,
  ...extra,
});

describe('pro trader: sell OCO', () => {
  it('refuses a buy-side OCO and a bracket with a typed reason and holds nothing', async () => {
    const trader = await newCustomer();
    await fund(trader.userId, QUOTE, '1000');
    await fund(trader.userId, BASE, '1');

    const buyOco = await trader.api.rest('/orders', orderSchema, {
      method: 'POST',
      body: ocoBody({ side: 'buy', price: '80', takeProfit: { stopPrice: '90' }, stopLoss: { stopPrice: '70' } }),
    });
    expect(buyOco.ok).toBe(false);
    if (!buyOco.ok) expect(buyOco.code).toBe('trade.order_type_unsupported');

    const bracket = await trader.api.rest('/orders', orderSchema, {
      method: 'POST',
      body: ocoBody({ oco: undefined, bracket: true }),
    });
    expect(bracket.ok).toBe(false);
    if (!bracket.ok) expect(bracket.code).toBe('trade.order_type_unsupported');

    expect((await balance(trader.trade, QUOTE)).used).toBe('0');
    expect((await balance(trader.trade, BASE)).used).toBe('0');
    const open = await trader.trade.orders('open', SYMBOL);
    expect(open.ok && open.data).toEqual([]);
  });
});
