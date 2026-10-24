import { describe, expect, it } from 'vitest';
import { groupSlices, type ServerAllocation } from './allocation-source';

// TEST data, not real balances.
const answer = (over: Partial<ServerAllocation> = {}): ServerAllocation => ({
  totalValueUsd: '52750',
  classes: [
    { class: 'fiat', valueUsd: '250', share: '0.004739336492890995', assets: [] },
    { class: 'stablecoin', valueUsd: '1500', share: '0.028436018957345972', assets: [] },
    { class: 'crypto', valueUsd: '51000', share: '0.966824644549763033', assets: [] },
  ],
  types: [
    { type: 'available', valueUsd: '31750', share: '0.601895734597156398' },
    { type: 'locked', valueUsd: '21000', share: '0.398104265402843602' },
  ],
  unpriced: [],
  asOf: 1,
  ...over,
});

describe('groupSlices', () => {
  it('names earn, commodities and unclassified, and carries each class its coins', () => {
    const slices = groupSlices(
      answer({
        classes: [
          { class: 'commodity', valueUsd: '10', share: '0.1', assets: [{ asset: 'XAU', valueUsd: '10', share: '0.1' }] },
          { class: 'earn', valueUsd: '30', share: '0.3', assets: [{ asset: 'USDT', valueUsd: '30', share: '0.3' }] },
          { class: 'unclassified', valueUsd: '60', share: '0.6', assets: [{ asset: 'BTC', valueUsd: '60', share: '0.6' }] },
        ],
      }),
      'class',
    );
    expect(slices?.map((s) => [s.key, s.labelKey, s.assets])).toEqual([
      ['unclassified', 'Unclassified', ['BTC']],
      ['earn', 'Earn', ['USDT']],
      ['commodity', 'Commodities', ['XAU']],
    ]);
  });

  it('orders the classes biggest first and names them by key', () => {
    expect(groupSlices(answer(), 'class')?.map((s) => [s.key, s.labelKey])).toEqual([
      ['crypto', 'Other crypto'],
      ['stablecoin', 'Dollar coins'],
      ['fiat', 'Cash'],
    ]);
  });

  it('gives the type split as it came, keeping the shares as strings', () => {
    expect(groupSlices(answer(), 'type')).toEqual([
      { key: 'available', labelKey: 'Spendable', share: '0.601895734597156398', assets: [] },
      { key: 'locked', labelKey: 'Locked', share: '0.398104265402843602', assets: [] },
    ]);
  });

  it('leaves a group of nothing out and returns an empty list for an empty book', () => {
    expect(
      groupSlices(
        answer({
          types: [
            { type: 'available', valueUsd: '1', share: '1' },
            { type: 'locked', valueUsd: '0', share: '0' },
          ],
        }),
        'type',
      ),
    ).toHaveLength(1);
    expect(groupSlices(answer({ classes: [], types: [] }), 'class')).toEqual([]);
  });

  it('refuses the whole grouping when one share does not parse, never showing it as zero', () => {
    const bad = answer({
      types: [
        { type: 'available', valueUsd: '1', share: 'abc' },
        { type: 'locked', valueUsd: '0', share: '0' },
      ],
    });
    expect(groupSlices(bad, 'type')).toBeNull();
  });
});
