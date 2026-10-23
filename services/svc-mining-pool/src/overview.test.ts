import { describe, expect, it } from 'vitest';
import { MiningError } from './errors.js';
import { readPoolOverview } from './overview.js';

const published = {
  MINING_OVERVIEW_VERSION: 'TEST-1',
  MINING_OVERVIEW_WHAT: 'A pool that counts accepted work.',
  MINING_OVERVIEW_COIN: 'TEST-COIN',
  MINING_OVERVIEW_HARDWARE: 'TEST-RIG',
  MINING_OVERVIEW_REVENUE_SPLIT: 'Split in proportion to accepted work.',
  MINING_OVERVIEW_NOT_SUPPORTED: 'No hardware is promised.',
};

describe('pool overview', () => {
  it('returns the published sections and does not copy the fee', () => {
    const overview = readPoolOverview({ ...published, MINING_POOL_FEE_BPS: '100' });
    expect(overview).toEqual({
      version: 'TEST-1',
      what: 'A pool that counts accepted work.',
      coin: 'TEST-COIN',
      hardware: 'TEST-RIG',
      revenueSplit: 'Split in proportion to accepted work.',
      notSupported: 'No hardware is promised.',
    });
    expect(overview).not.toHaveProperty('feeBps');
  });

  it('a blank section is null and no coin or hardware sentence is invented', () => {
    const overview = readPoolOverview({
      ...published,
      MINING_OVERVIEW_COIN: '   ',
      MINING_OVERVIEW_HARDWARE: undefined,
    });
    expect(overview.coin).toBeNull();
    expect(overview.hardware).toBeNull();
    expect(overview.what).toBe(published.MINING_OVERVIEW_WHAT);
    expect(JSON.stringify(overview)).not.toContain('3336');
  });

  it('a wholly blank overview refuses, including whitespace and a version with no sections', () => {
    for (const env of [{}, { MINING_OVERVIEW_WHAT: '  ', MINING_OVERVIEW_VERSION: 'v1' }, { MINING_OVERVIEW_VERSION: 'v1' }]) {
      expect(() => readPoolOverview(env)).toThrow(MiningError);
      try {
        readPoolOverview(env);
      } catch (err) {
        expect(err).toMatchObject({ code: 'mining.overview_unset' });
      }
    }
  });

  it('a published section with no version refuses, and an unusable section is not truncated', () => {
    expect(() => readPoolOverview({ MINING_OVERVIEW_WHAT: 'Hello' })).toThrowError(/not published/);
    expect(() => readPoolOverview({ ...published, MINING_OVERVIEW_WHAT: `x\u0000y` })).toThrowError(
      expect.objectContaining({ code: 'mining.overview_unset' }),
    );
    expect(() => readPoolOverview({ ...published, MINING_OVERVIEW_COIN: 'c'.repeat(4001) })).toThrowError(
      expect.objectContaining({ code: 'mining.overview_unset' }),
    );
  });
});
