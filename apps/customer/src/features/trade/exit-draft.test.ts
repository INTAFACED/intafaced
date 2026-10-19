import { describe, expect, it } from 'vitest';
import { draftSchema, placeBody, previewBody, previewSchema } from './trade-api';

const oco = {
  symbol: 'BTC/USDT',
  side: 'sell',
  type: 'limit',
  amount: '0.1',
  price: '110',
  timeInForce: 'GTC',
  postOnly: false,
  clientOrderId: 'desk:1',
  exit: { kind: 'oco', takeProfit: '110', stopLoss: '90' },
} as const;

const bracket = {
  symbol: 'BTC/USDT',
  side: 'buy',
  type: 'market',
  amount: '0.1',
  timeInForce: 'GTC',
  postOnly: false,
  clientOrderId: 'desk:2',
  exit: { kind: 'bracket', takeProfit: '110', stopLoss: '90' },
} as const;

describe('OCO and bracket drafts', () => {
  it('accepts a sell OCO at its take-profit and a buy bracket with a market or IOC/FOK limit entry', () => {
    expect(draftSchema.safeParse(oco).success).toBe(true);
    expect(draftSchema.safeParse(bracket).success).toBe(true);
    for (const timeInForce of ['IOC', 'FOK'] as const)
      expect(draftSchema.safeParse({ ...bracket, type: 'limit', price: '100', timeInForce }).success).toBe(true);
  });

  it('accepts a buy OCO held at its stop-loss limit, and a resting bracket entry', () => {
    const buyOco = {
      ...oco,
      side: 'buy',
      price: '91',
      exit: { kind: 'oco', takeProfit: '80', stopLoss: '90', stopLossLimit: '91' },
    } as const;
    expect(draftSchema.safeParse(buyOco).success).toBe(true);
    expect(draftSchema.safeParse({ ...buyOco, exit: { ...buyOco.exit, stopLossLimit: '90' }, price: '90' }).success).toBe(true);
    expect(draftSchema.safeParse({ ...bracket, type: 'limit', price: '100' }).success).toBe(true);
    expect(placeBody(buyOco)).toMatchObject({
      oco: true,
      side: 'buy',
      type: 'limit',
      price: '91',
      takeProfit: { stopPrice: '80' },
      stopLoss: { stopPrice: '90', price: '91' },
    });
    // The engine's order is take-profit < stop trigger <= stop-loss limit, held at the limit.
    expect(draftSchema.safeParse({ ...buyOco, exit: { ...buyOco.exit, stopLossLimit: undefined } }).success).toBe(false);
    expect(draftSchema.safeParse({ ...buyOco, exit: { ...buyOco.exit, stopLossLimit: '89' }, price: '89' }).success).toBe(false);
    expect(draftSchema.safeParse({ ...buyOco, exit: { ...buyOco.exit, takeProfit: '90' } }).success).toBe(false);
    expect(draftSchema.safeParse({ ...buyOco, price: '80' }).success).toBe(false);
    expect(draftSchema.safeParse({ ...buyOco, timeInForce: 'IOC' }).success).toBe(false);
  });

  it('refuses what the service refuses: a sell bracket, a post-only bracket, a stop-loss limit on a sell OCO, a take-profit at or under the stop-loss', () => {
    expect(draftSchema.safeParse({ ...oco, exit: { ...oco.exit, stopLossLimit: '89' } }).success).toBe(false);
    expect(draftSchema.safeParse({ ...oco, timeInForce: 'IOC' }).success).toBe(false);
    expect(draftSchema.safeParse({ ...oco, price: '111' }).success).toBe(false);
    expect(draftSchema.safeParse({ ...bracket, side: 'sell' }).success).toBe(false);
    expect(draftSchema.safeParse({ ...bracket, type: 'limit', price: '100', timeInForce: 'PO', postOnly: true }).success).toBe(false);
    expect(draftSchema.safeParse({ ...oco, exit: { ...oco.exit, stopLoss: '110' } }).success).toBe(false);
    expect(draftSchema.safeParse({ ...bracket, exit: { ...bracket.exit, takeProfit: '80' } }).success).toBe(false);
  });

  it('previews the plain order and places it with the documented body', () => {
    expect(previewBody(oco)).toMatchObject({ exit: { kind: 'oco', takeProfit: '110', stopLoss: '90' } });
    expect(placeBody(oco)).toEqual({
      symbol: 'BTC/USDT',
      side: 'sell',
      type: 'limit',
      amount: '0.1',
      price: '110',
      timeInForce: 'GTC',
      postOnly: false,
      clientOrderId: 'desk:1',
      oco: true,
      takeProfit: { stopPrice: '110' },
      stopLoss: { stopPrice: '90' },
    });
    expect(placeBody(bracket)).toMatchObject({
      bracket: true,
      type: 'market',
      takeProfit: { stopPrice: '110' },
      stopLoss: { stopPrice: '90' },
    });
    expect(placeBody(bracket)).not.toHaveProperty('exit');
  });

  it('asks the service to price the exit legs: an OCO as oco, a bracket as bracket_exit, a buy OCO with its stop-loss limit', () => {
    expect(previewBody(oco).exit).toEqual({ kind: 'oco', takeProfit: '110', stopLoss: '90' });
    expect(previewBody(bracket).exit).toEqual({ kind: 'bracket_exit', takeProfit: '110', stopLoss: '90' });
    const buyOco = {
      ...oco,
      side: 'buy',
      price: '91',
      exit: { kind: 'oco', takeProfit: '80', stopLoss: '90', stopLossLimit: '91' },
    } as const;
    expect(previewBody(buyOco).exit).toEqual({ kind: 'oco', takeProfit: '80', stopLoss: '90', stopLossLimit: '91' });
    const plain = { ...oco, exit: undefined };
    expect(previewBody(plain)).not.toHaveProperty('exit');
  });

  it('reads the exit-leg fees the service returns, and tolerates a preview without them', () => {
    const base = {
      symbol: 'BTC/USDT',
      side: 'sell',
      type: 'limit',
      amount: '0.1',
      price: '110',
      stopPrice: null,
      timeInForce: 'GTC',
      holdAsset: 'BTC',
      holdAmount: '0.1',
      protectionPrice: null,
      estimatedFee: '0.0022',
      feeAsset: 'USDT',
      feeBps: 2,
      feeRole: 'maker',
      orderable: true,
      refusals: [],
    };
    expect(previewSchema.parse(base).exitFees ?? null).toBeNull();
    const exitFees = {
      side: 'sell',
      takeProfit: { price: '110', feeRole: 'maker', feeBps: 1, estimatedFee: '0.0011', feeAsset: 'USDT' },
      stopLoss: { price: '90', feeRole: 'taker', feeBps: 2, estimatedFee: '0.0018', feeAsset: 'USDT' },
    };
    expect(previewSchema.parse({ ...base, exitFees }).exitFees).toEqual(exitFees);
    expect(previewSchema.safeParse({ ...base, exitFees: { ...exitFees, side: 'up' } }).success).toBe(false);
  });
});
