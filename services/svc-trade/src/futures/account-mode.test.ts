import { describe, expect, it } from 'vitest';
import { decideModeWrite, presentAccountMode } from './account-mode.js';

describe('account position mode', () => {
  it('when the book cannot key a second side, the read is fixed one-way and hedge refuses', () => {
    expect(presentAccountMode(null, false)).toEqual({ mode: 'one_way', source: 'fixed' });
    expect(decideModeWrite({ current: null, next: 'hedge', openPositionCount: 0, sameClientKey: false }, false)).toMatchObject({
      ok: false,
      code: 'trade.position_mode_hedge_unsupported',
    });
  });

  it('the live book stores hedge while flat, and a change with an open position refuses', () => {
    expect(presentAccountMode(null)).toMatchObject({ mode: null, source: 'unset', code: 'trade.position_mode_unset' });
    expect(decideModeWrite({ current: null, next: 'hedge', openPositionCount: 0, sameClientKey: false })).toEqual({
      ok: true,
      mode: 'hedge',
      changed: true,
    });
    expect(decideModeWrite({ current: 'one_way', next: 'hedge', openPositionCount: 1, sameClientKey: false })).toMatchObject({
      ok: false,
      code: 'trade.position_mode_migration_blocked',
    });
    expect(decideModeWrite({ current: 'hedge', next: 'hedge', openPositionCount: 2, sameClientKey: false })).toEqual({
      ok: true,
      mode: 'hedge',
      changed: false,
    });
  });

  it('the same client key cannot store a different mode', () => {
    expect(decideModeWrite({ current: 'one_way', next: 'hedge', openPositionCount: 0, sameClientKey: true })).toMatchObject({
      ok: false,
      code: 'trade.position_mode_conflict',
    });
  });
});
