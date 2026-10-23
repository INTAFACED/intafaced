import { describe, expect, it } from 'vitest';
import { spendFiguresOf } from './trpc.js';

const cause = (data: unknown, code = 'bank.insufficient_funds') => ({ code, data });

describe('spendFiguresOf (RC-wallet-09)', () => {
  it('copies the four figures from bank.insufficient_funds', () => {
    expect(spendFiguresOf(cause({ assetId: 'USDT', available: '10', onHold: '5', inEarn: '20', extra: 'x' }))).toEqual({
      assetId: 'USDT',
      available: '10',
      onHold: '5',
      inEarn: '20',
    });
  });
  it('keeps inEarn null', () => {
    expect(spendFiguresOf(cause({ assetId: 'USDT', available: '10.5', onHold: '0', inEarn: null }))?.inEarn).toBeNull();
  });
  it('drops everything on any other code, missing data or a malformed field', () => {
    expect(
      spendFiguresOf(cause({ assetId: 'USDT', available: '10', onHold: '5', inEarn: '20' }, 'ledger.insufficient_funds')),
    ).toBeUndefined();
    expect(spendFiguresOf(cause(undefined))).toBeUndefined();
    expect(spendFiguresOf(cause({ assetId: 'USDT', available: 10, onHold: '5', inEarn: '20' }))).toBeUndefined();
    expect(spendFiguresOf(cause({ assetId: 'USDT', available: '10', onHold: 'lots', inEarn: '20' }))).toBeUndefined();
    expect(spendFiguresOf(cause({ assetId: 'usdt <b>', available: '10', onHold: '5', inEarn: '20' }))).toBeUndefined();
    expect(spendFiguresOf(cause({ assetId: 'USDT', available: '10', onHold: '5', inEarn: 0 }))).toBeUndefined();
    expect(spendFiguresOf(null)).toBeUndefined();
  });
});
