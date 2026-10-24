import { describe, expect, it } from 'vitest';
import type { Position } from '@intafaced/exchange-contract/schemas';
import type { ConditionalOrder } from './api';
import {
  coverage,
  entryLegProblem,
  estimatedResult,
  failedOutcome,
  isLive,
  legsOf,
  partProblem,
  priceProblem,
  sideOfMark,
} from './protection-logic';

// TEST figures only: nothing here is a real balance or price.
const position: Position = {
  id: 'p1',
  symbol: 'BTC/USDT:USDT',
  timestamp: 1_700_000_000_000,
  datetime: '2023-11-14T22:13:20.000Z',
  side: 'long',
  status: 'open',
  closingReason: null,
  contracts: '0.5',
  contractSize: '1',
  entryPrice: '100',
  markPrice: '110',
  notional: '55',
  leverage: '10',
  collateral: '5',
  initialMargin: '5.5',
  maintenanceMargin: '1',
  unrealizedPnl: '5',
  realizedPnl: '0',
  liquidationPrice: '90',
  marginMode: 'isolated',
  percentage: '100',
};

const leg = (over: Partial<ConditionalOrder>): ConditionalOrder => ({
  id: 'c1',
  market: 'BTC/USDT:USDT',
  kind: 'take_profit',
  side: 'sell',
  quantity: '0.5',
  triggerPrice: '120',
  limitPrice: null,
  positionId: 'p1',
  attachment: 'take_profit',
  status: 'armed',
  cancelReason: null,
  failureReason: null,
  createdAt: '2026-10-23T10:00:00.000Z',
  ...over,
});

describe('legsOf', () => {
  it('shows the live leg over a newer finished one, and the newest finished one when none is live', () => {
    const orders = [
      leg({ id: 'tp-old', status: 'cancelled', cancelReason: 'replaced', createdAt: '2026-10-23T09:00:00.000Z' }),
      leg({ id: 'tp-live', createdAt: '2026-10-23T10:00:00.000Z' }),
      leg({ id: 'tp-other-position', positionId: 'p2', createdAt: '2026-10-23T11:00:00.000Z' }),
      leg({ id: 'sl-1', kind: 'stop_market', attachment: 'stop_loss', status: 'cancelled', createdAt: '2026-10-23T09:00:00.000Z' }),
      leg({ id: 'sl-2', kind: 'stop_market', attachment: 'stop_loss', status: 'filled', createdAt: '2026-10-23T10:30:00.000Z' }),
    ];
    const legs = legsOf(orders, 'p1');
    expect(legs.take_profit?.id).toBe('tp-live');
    expect(legs.stop_loss?.id).toBe('sl-2');
  });
  it('ignores free-standing stops and has nothing for a position without an id', () => {
    expect(legsOf([leg({ attachment: null })], 'p1')).toEqual({ take_profit: null, stop_loss: null });
    expect(legsOf([leg({})], null)).toEqual({ take_profit: null, stop_loss: null });
  });
  it('counts a triggered leg as live: it is still closing the position', () => {
    expect(isLive(leg({ status: 'triggered' }))).toBe(true);
    expect(isLive(leg({ status: 'filled' }))).toBe(false);
    expect(isLive(null)).toBe(false);
  });
});

describe('estimatedResult', () => {
  it('works out the whole position at a price, exact, signed by side', () => {
    expect(estimatedResult(position, '120')).toBe('10');
    expect(estimatedResult(position, '95.5')).toBe('-2.25');
    expect(estimatedResult({ ...position, side: 'short' }, '95.5')).toBe('2.25');
    // Size is in the base asset, as the service's notional and unrealised PnL are: the contract size is not a factor.
    expect(estimatedResult({ ...position, contractSize: '0.001' }, '120')).toBe('10');
    // A part leg: the result on its own size.
    expect(estimatedResult(position, '120', '0.2')).toBe('4');
  });
  it('is unknown, never zero, when a figure is missing or the price is not usable', () => {
    expect(estimatedResult(position, '')).toBeNull();
    expect(estimatedResult(position, '0')).toBeNull();
    expect(estimatedResult({ ...position, entryPrice: null as unknown as string }, '120')).toBeNull();
  });
});

describe('sideOfMark and priceProblem', () => {
  it('a long takes profit above the mark and stops below it; a short the other way round', () => {
    expect(sideOfMark(position, 'take_profit')).toBe('above');
    expect(sideOfMark(position, 'stop_loss')).toBe('below');
    expect(sideOfMark({ ...position, side: 'short' }, 'take_profit')).toBe('below');
    expect(sideOfMark({ ...position, side: 'short' }, 'stop_loss')).toBe('above');
  });
  it('allows an empty field (no leg) and refuses zero or a non-number', () => {
    expect(priceProblem('')).toBeNull();
    expect(priceProblem('64000.5')).toBeNull();
    expect(priceProblem('0')).toBe('invalid');
    expect(priceProblem('abc')).toBe('invalid');
  });
});

describe('part legs', () => {
  it('a size is empty (whole), above zero, and at most the position', () => {
    expect(partProblem('', '0.5')).toBeNull();
    expect(partProblem('0.2', '0.5')).toBeNull();
    expect(partProblem('0.5', '0.5')).toBeNull();
    expect(partProblem('0.6', '0.5')).toBe('overPosition');
    expect(partProblem('0', '0.5')).toBe('invalid');
  });
  it('says what a leg covers and what is left beside it', () => {
    expect(coverage(leg({ wholePosition: true }), '0.5')).toEqual({ whole: true });
    expect(coverage(leg({}), '0.5')).toEqual({ whole: true });
    expect(coverage(leg({ wholePosition: false, quantity: '0.2' }), '0.5')).toEqual({ whole: false, part: '0.2', rest: '0.3' });
  });
});

describe('a take profit and stop loss typed on the ticket', () => {
  it('is none when empty, refused when not a positive number, and judged against the mark by side', () => {
    expect(entryLegProblem('long', 'take_profit', '', '100')).toBeNull();
    expect(entryLegProblem('long', 'take_profit', 'abc', '100')).toBe('invalid');
    expect(entryLegProblem('long', 'stop_loss', '0', '100')).toBe('invalid');
    expect(entryLegProblem('long', 'take_profit', '101', '100')).toBeNull();
    expect(entryLegProblem('long', 'take_profit', '100', '100')).toBe('wrongSide');
    expect(entryLegProblem('long', 'stop_loss', '99', '100')).toBeNull();
    expect(entryLegProblem('long', 'stop_loss', '101', '100')).toBe('wrongSide');
    expect(entryLegProblem('short', 'take_profit', '99', '100')).toBeNull();
    expect(entryLegProblem('short', 'take_profit', '101', '100')).toBe('wrongSide');
    expect(entryLegProblem('short', 'stop_loss', '101', '100')).toBeNull();
    // No mark known: only the number is checked, and the service judges the side.
    expect(entryLegProblem('short', 'stop_loss', '1', null)).toBeNull();
  });
});

describe('failedOutcome', () => {
  const failed = (over: Partial<ConditionalOrder>) =>
    leg({ status: 'failed', failureReason: 'trade.futures_reduce_only_exceeds_position', ...over });

  it('says nothing was closed, no close order reached the book, and the position is open now at its size and side', () => {
    expect(failedOutcome(failed({ closedQuantity: null }), [position])).toEqual({
      closed: null,
      closeOrder: null,
      position: { state: 'open', contracts: position.contracts, side: 'long' },
    });
    expect(failedOutcome(failed({ closedQuantity: '0' }), [position]).closed).toBeNull();
  });

  it('gives what its finished attempts closed, the close order that reached the book, and a position no longer open', () => {
    expect(failedOutcome(failed({ closedQuantity: '0.2', closeOrderId: 'o9' }), [])).toEqual({
      closed: '0.2',
      closeOrder: 'o9',
      position: { state: 'gone' },
    });
    expect(failedOutcome(failed({}), [{ ...position, status: 'closed' }]).position).toEqual({ state: 'gone' });
  });

  it('never calls a position being closed open, and never ties an order with no position to one', () => {
    expect(failedOutcome(failed({}), [{ ...position, status: 'closing' }]).position).toMatchObject({ state: 'closing' });
    expect(failedOutcome(failed({ positionId: null }), [{ ...position, id: null }]).position).toEqual({ state: 'gone' });
  });

  it('does not guess the position while the positions cannot be read', () => {
    expect(failedOutcome(failed({}), null).position).toBe('unknown');
  });
});
