import { describe, expect, it } from 'vitest';
import { checkLookup, marginRatioText, positionStatusWord } from './positions-model';

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
});
