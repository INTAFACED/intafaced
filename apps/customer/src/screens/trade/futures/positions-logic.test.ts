import { describe, expect, it } from 'vitest';
import type { Position } from '@intafaced/exchange-contract/schemas';
import {
  amountProblem,
  barWidth,
  closeAllReduce,
  freeFor,
  gateActions,
  hasUnresolved,
  pickNonce,
  remainingIds,
  resultOf,
  rowOf,
  settleOf,
  signedAmount,
  startCloseAll,
  stopsRun,
  tally,
} from './positions-logic';

// TEST figures only: nothing here is a real balance or price.
const base: Position = {
  id: 'p1',
  symbol: 'BTC/USDT:USDT',
  timestamp: 1_700_000_000_000,
  datetime: '2023-11-14T22:13:20.000Z',
  side: 'long',
  status: 'open',
  closingReason: null,
  contracts: '2',
  contractSize: '1',
  entryPrice: '100',
  markPrice: '110',
  notional: '220',
  leverage: '10',
  collateral: '20',
  initialMargin: '22',
  maintenanceMargin: '5',
  unrealizedPnl: '20',
  realizedPnl: '0',
  liquidationPrice: '90',
  marginMode: 'isolated',
  percentage: '10',
};

const gate = (over: Partial<Parameters<typeof gateActions>[0]> = {}, p: Partial<Position> = {}) =>
  gateActions({ position: { ...base, ...p }, planeOff: false, writerLocked: false, liquidating: false, stale: false, ...over });

describe('rowOf', () => {
  it('keeps unknowns null and computes health and distance', () => {
    const row = rowOf(base);
    expect(row.health.marginRatioPct).toBe('12.50');
    expect(row.distancePct).toBe('18.18');
    const unknown = rowOf({ ...base, maintenanceMargin: null, markPrice: null });
    expect(unknown.health.marginRatioPct).toBeNull();
    expect(unknown.health.unknownWhy).toBe('maintenance');
    expect(unknown.distancePct).toBeNull();
    expect(unknown.mark).toBeNull();
  });
});

describe('signedAmount', () => {
  it('signs positives and keeps null', () => {
    expect(signedAmount('1.5', 4)).toBe('+1.5');
    expect(signedAmount('-0.4', 4)).toBe('−0.4');
    expect(signedAmount('0', 4)).toBe('0');
    expect(signedAmount(null, 4)).toBeNull();
  });
});

describe('settle currency', () => {
  it('reads the settle part, else the quote', () => {
    expect(settleOf('BTC/USDT:USDT')).toBe('USDT');
    expect(settleOf('BTC/USDT')).toBe('USDT');
    expect(settleOf('BTC')).toBeNull();
    expect(freeFor('BTC/USDT:USDT', { USDT: { free: '50' } })).toBe('50');
    expect(freeFor('BTC/USDT:USDT', { EUR: { free: '50' } })).toBeNull();
    expect(freeFor('BTC/USDT:USDT', null)).toBeNull();
  });
});

describe('barWidth', () => {
  it('caps at 100 and is null when unknown', () => {
    expect(barWidth(rowOf(base).health)).toBe('12%');
    expect(barWidth(rowOf({ ...base, unrealizedPnl: '-30' }).health)).toBe('100%');
    expect(barWidth(rowOf({ ...base, maintenanceMargin: null }).health)).toBeNull();
  });
});

describe('gateActions', () => {
  it('allows everything on a healthy open position', () => {
    expect(Object.values(gate()).every((x) => x === null)).toBe(true);
  });
  it('plane off and an unresolved request block every action', () => {
    expect(Object.values(gate({ planeOff: true })).every((x) => x === 'planeOff')).toBe(true);
    expect(Object.values(gate({ writerLocked: true })).every((x) => x === 'writerLocked')).toBe(true);
  });
  it('a live liquidation step still allows adding margin', () => {
    const g = gate({ liquidating: true });
    expect(g.add).toBeNull();
    expect(g.reduce).toBe('liquidating');
    expect(g.leverage).toBe('liquidating');
    expect(g.protect).toBe('liquidating');
    expect(g.stop).toBe('liquidating');
    expect(g.close).toBe('liquidating');
  });
  it('a stale read blocks mark-priced actions but not adding margin, and not retrying a close', () => {
    const open = gate({ stale: true });
    expect(open.add).toBeNull();
    expect(open.protect).toBe('stale');
    expect(open.stop).toBe('stale');
    expect(open.close).toBe('stale');
    expect(gate({ stale: true }, { status: 'closing' }).close).toBeNull();
  });
  it('a position without an id or no longer live has no actions', () => {
    expect(gate({}, { id: null }).close).toBe('noId');
    expect(gate({}, { status: 'closed' }).add).toBe('notLive');
  });
});

describe('pickNonce', () => {
  it('re-uses the nonce for the same intent and renews it for a changed one', () => {
    let n = 0;
    const fresh = () => `n${++n}`;
    const a = pickNonce(null, 'add:p1:5', fresh);
    expect(pickNonce(a, 'add:p1:5', fresh)).toBe(a);
    expect(pickNonce(a, 'add:p1:6', fresh).nonce).toBe('n2');
  });
});

describe('amountProblem', () => {
  it('checks empty, sign, free balance and cap with exact decimals', () => {
    expect(amountProblem('', {})).toBe('empty');
    expect(amountProblem('0', {})).toBe('notPositive');
    expect(amountProblem('10.000000000000000001', { free: '10' })).toBe('overFree');
    expect(amountProblem('10', { free: '10' })).toBeNull();
    expect(amountProblem('10', { free: null })).toBeNull();
    expect(amountProblem('51', { cap: '50' })).toBe('overCap');
  });
});

describe('close-all reducer', () => {
  const ids = ['a', 'b', 'c'];
  it('stops on the first unknown answer and holds the rest back', () => {
    let s = startCloseAll(ids);
    s = closeAllReduce(s, { type: 'sending', id: 'a' });
    s = closeAllReduce(s, { type: 'result', id: 'a', result: { kind: 'done' } });
    s = closeAllReduce(s, { type: 'sending', id: 'b' });
    expect(hasUnresolved(s)).toBe(true);
    const unknown = resultOf({ kind: 'uncertain', id: 'close:b' });
    expect(stopsRun(unknown)).toBe(true);
    s = closeAllReduce(s, { type: 'result', id: 'b', result: unknown });
    s = closeAllReduce(s, { type: 'stop' });
    expect(s.results.c).toEqual({ kind: 'skipped' });
    expect(hasUnresolved(s)).toBe(true);
    expect(remainingIds(s)).toEqual(['c']);
    expect(tally(s)).toEqual({ done: 1, refused: 0, unknown: 1, total: 3 });
  });
  it('a refusal does not stop the run and is not unresolved', () => {
    const refused = resultOf({ kind: 'refused', refusal: { title: 'No', body: 'Because', code: 'x', retryable: true } });
    expect(stopsRun(refused)).toBe(false);
    let s = closeAllReduce(startCloseAll(['a']), { type: 'result', id: 'a', result: refused });
    expect(hasUnresolved(s)).toBe(false);
    expect(tally(s).refused).toBe(1);
    s = closeAllReduce(s, { type: 'result', id: 'a', result: { kind: 'done' } });
    expect(remainingIds(s)).toEqual([]);
  });
  it('a blocked send stops the run and can be sent later', () => {
    const blocked = resultOf({ kind: 'blocked', reason: 'pending' });
    expect(stopsRun(blocked)).toBe(true);
    const s = closeAllReduce(startCloseAll(['a']), { type: 'result', id: 'a', result: blocked });
    expect(remainingIds(s)).toEqual(['a']);
  });
});
