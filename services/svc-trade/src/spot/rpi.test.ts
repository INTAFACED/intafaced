import { describe, expect, it } from 'vitest';
import { RPI_FLAGS, refuseRetailPriceImprovement } from './rpi.js';

describe('retail price improvement (SP-markets-data-04, not built)', () => {
  it('refuses any order body that asks for the layer, whatever the flag value', () => {
    for (const key of RPI_FLAGS) {
      for (const value of [true, false, 'yes', null]) {
        expect(() => refuseRetailPriceImprovement({ symbol: 'BTC/USDT', type: 'limit', [key]: value })).toThrow(
          expect.objectContaining({ code: 'trade.rpi_unavailable' }),
        );
      }
    }
  });

  it('leaves an ordinary order alone', () => {
    expect(() => refuseRetailPriceImprovement({ symbol: 'BTC/USDT', type: 'limit', postOnly: true })).not.toThrow();
    expect(() => refuseRetailPriceImprovement(null)).not.toThrow();
    expect(() => refuseRetailPriceImprovement([{ rpi: true }])).not.toThrow();
  });
});
