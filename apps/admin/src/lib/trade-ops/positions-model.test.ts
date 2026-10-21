import { describe, expect, it } from 'vitest';
import { checkLookup, marginRatioText, positionStatusWord, toPositionRows } from './positions-model';

describe('positions model', () => {
  it('needs at least one id', () => {
    expect(checkLookup({}).ok).toBe(false);
    expect(checkLookup({ userId: '  ' })).toMatchObject({ ok: false, code: 'trade_ops.positions_lookup_empty' });
  });
  it('accepts trimmed ids and refuses odd characters', () => {
    expect(checkLookup({ userId: ' u-1 ' })).toEqual({ ok: true, value: { userId: 'u-1' } });
    expect(checkLookup({ positionId: 'a b' })).toMatchObject({ ok: false, code: 'trade_ops.positions_bad_input' });
    expect(checkLookup({ userId: 5 })).toMatchObject({ ok: false });
  });
  it('margin ratio is exact string work', () => {
    expect(marginRatioText('0.0825')).toBe('8.25%');
    expect(marginRatioText('1')).toBe('100%');
    expect(marginRatioText('0.12345')).toBe('12.345%');
    expect(marginRatioText(null)).toBeNull();
    expect(marginRatioText('x')).toBeNull();
  });
  it('status words name liquidation', () => {
    expect(positionStatusWord('liquidation_in_progress').label).toBe('Liquidation in progress');
    expect(positionStatusWord('closing').tone).toBe('warn');
  });
  it('status words cover liquidated and show an unknown word as itself', () => {
    expect(positionStatusWord('liquidated')).toMatchObject({ label: 'Liquidated', tone: 'error' });
    expect(positionStatusWord('mystery').label).toBe('mystery');
  });
  it('rows name the market by symbol and leave unserved figures null, never zero', () => {
    const [row] = toPositionRows(
      [{ id: 'p', userId: 'u', marketId: 'm1', side: 'short', status: 'open', size: '2', entryPrice: '10', openedAt: 't' }],
      new Map([['m1', 'BTC-PERP']]),
    );
    expect(row).toMatchObject({ market: 'BTC-PERP', markPrice: null, liquidationPrice: null, marginRatio: null, unrealisedPnl: null });
    expect(
      toPositionRows(
        [{ id: 'p', userId: 'u', marketId: 'zz', side: 'long', status: 'open', size: '1', entryPrice: '1', openedAt: 't' }],
        new Map(),
      )[0]?.market,
    ).toBe('zz');
  });
});
