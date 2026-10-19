import { describe, expect, it } from 'vitest';
import { draftSchema, placeBody, previewBody } from './trade-api';

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

  it('refuses what the service refuses: a buy OCO, a sell bracket, a resting bracket entry, a take-profit at or under the stop-loss', () => {
    expect(draftSchema.safeParse({ ...oco, side: 'buy' }).success).toBe(false);
    expect(draftSchema.safeParse({ ...oco, timeInForce: 'IOC' }).success).toBe(false);
    expect(draftSchema.safeParse({ ...oco, price: '111' }).success).toBe(false);
    expect(draftSchema.safeParse({ ...bracket, side: 'sell' }).success).toBe(false);
    expect(draftSchema.safeParse({ ...bracket, type: 'limit', price: '100' }).success).toBe(false);
    expect(draftSchema.safeParse({ ...oco, exit: { ...oco.exit, stopLoss: '110' } }).success).toBe(false);
    expect(draftSchema.safeParse({ ...bracket, exit: { ...bracket.exit, takeProfit: '80' } }).success).toBe(false);
  });

  it('previews the plain order and places it with the documented body', () => {
    expect(previewBody(oco)).not.toHaveProperty('exit');
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
});
