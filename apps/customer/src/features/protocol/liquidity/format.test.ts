import { describe, expect, it } from 'vitest';
import { amountText, bpsPercent, percentToBps, priceText, toUnits } from './format';

describe('liquidity formats (J-dex-protocol-12)', () => {
  it('shows base units as whole tokens, cut and never rounded up', () => {
    expect(amountText(50_000_000n, 6)).toBe('50');
    expect(amountText('1414213562373095048801', 18)).toBe('1414.213562');
    expect(amountText(-1_500_000n, 6)).toBe('-1.5');
  });
  it('reads a typed percent as whole bps, so "99" is 9900 and is refused by the cap, not here', () => {
    expect(percentToBps('0.05')).toBe(5);
    expect(percentToBps('0.3')).toBe(30);
    expect(percentToBps('99')).toBe(9900);
    expect(percentToBps('0.055')).toBeNull();
    expect(percentToBps('-1')).toBeNull();
    expect(bpsPercent(-571)).toBe('-5.71');
    expect(bpsPercent(5)).toBe('0.05');
  });
  it('turns typed amounts into base units and states the starting price as the deposit ratio', () => {
    expect(toUnits('1000', 6)).toBe(1_000_000_000n);
    expect(toUnits('0.0000001', 6)).toBeNull();
    expect(toUnits('0', 6)).toBeNull();
    expect(priceText(1000n * 10n ** 6n, 6, 2000n * 10n ** 18n, 18)).toBe('2');
  });
});
