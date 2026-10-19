import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Draft } from '../../src/features/trade/trade-api';
import { stack, type Customer } from './stack';

/** What every spot journey shares: a draft the way the desk builds it, review-then-place, and the balances read. */
export const SYMBOL = stack.symbol();
export const [BASE, QUOTE] = SYMBOL.split('/') as [string, string];

export function draft(extra: Partial<Draft> = {}): Draft {
  return {
    symbol: SYMBOL,
    side: 'buy',
    type: 'limit',
    amount: '0.1',
    price: '80',
    timeInForce: 'GTC',
    postOnly: false,
    clientOrderId: `journey:${randomUUID()}`,
    ...extra,
  };
}

/** The order a placement returned, or a failure that says what the service said. */
export function orderOf(placed: Awaited<ReturnType<Customer['trade']['place']>>) {
  if (!placed.ok) throw new Error(`placement refused: ${placed.reason} ${'code' in placed ? placed.code : ''} ${placed.message}`);
  if (!('data' in placed)) throw new Error('placement came back as a changed review');
  return placed.data;
}

/** Review, then place, the way the desk's confirm step does. */
export async function reviewAndPlace(trade: Customer['trade'], d: Draft) {
  const review = await trade.preview(d);
  if (!review.ok) throw new Error(`preview refused: ${review.message}`);
  expect(review.data.refusals, 'the service refused the preview').toEqual([]);
  expect(review.data.orderable).toBe(true);
  return { review: review.data, placed: await trade.place(d, review.data) };
}

export const balance = async (trade: Customer['trade'], asset: string) => {
  const result = await trade.balances();
  if (!result.ok) throw new Error(`balances refused: ${result.message}`);
  return result.data.balances[asset] ?? { free: '0', used: '0', total: '0' };
};
