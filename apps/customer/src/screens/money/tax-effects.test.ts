import { describe, expect, it } from 'vitest';
import { groupKindsByEffect } from './tax-effects';

// TEST DATA written for these tests: the owner has published no map, so every map here is made up.
describe('groupKindsByEffect', () => {
  it('groups kinds under income, disposal and neutral in that order, then any other effect by name', () => {
    const { groups, unset } = groupKindsByEffect({
      trade: 'disposal',
      deposit: 'neutral',
      fee: 'zz other',
      welcome_funds: 'income',
      space_move: 'neutral',
    });
    expect(groups).toEqual([
      { effect: 'income', kinds: ['welcome_funds'] },
      { effect: 'disposal', kinds: ['trade'] },
      { effect: 'neutral', kinds: ['deposit', 'space_move'] },
      { effect: 'zz other', kinds: ['fee'] },
    ]);
    expect(unset).not.toContain('trade');
    expect(unset).toContain('withdrawal');
  });

  it('puts no kind in a group the map does not name, and a blank effect counts as not set', () => {
    const { groups, unset } = groupKindsByEffect({ trade: '  ' });
    expect(groups).toEqual([]);
    expect(unset).toContain('trade');
  });
});
