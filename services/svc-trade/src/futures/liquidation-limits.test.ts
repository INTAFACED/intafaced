import { describe, expect, it } from 'vitest';
import { publishedLiquidationLimitsFrom } from './liquidation-limits.js';

describe('TRADE_FUTURES_LIQUIDATION_LIMITS', () => {
  it('blank or unset is unpublished: null, so the tick keeps refusing every liquidation', () => {
    expect(publishedLiquidationLimitsFrom(undefined)).toBeNull();
    expect(publishedLiquidationLimitsFrom('')).toBeNull();
    expect(publishedLiquidationLimitsFrom('   ')).toBeNull();
  });

  it('a whole publication is read as given', () => {
    expect(publishedLiquidationLimitsFrom('{"maxAgeSeconds":300,"liquidationMaxAgeSeconds":60,"maxDeviationBps":2000}')).toEqual({
      maxAgeSeconds: 300,
      liquidationMaxAgeSeconds: 60,
      maxDeviationBps: 2000,
    });
    expect(
      publishedLiquidationLimitsFrom(
        '{"maxAgeSeconds":300,"liquidationMaxAgeSeconds":60,"maxDeviationBps":2000,"liquidationQualities":["mid"]}',
      ),
    ).toEqual({ maxAgeSeconds: 300, liquidationMaxAgeSeconds: 60, maxDeviationBps: 2000, liquidationQualities: ['mid'] });
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['a missing field', '{"maxAgeSeconds":300,"liquidationMaxAgeSeconds":60}'],
    ['a zero', '{"maxAgeSeconds":300,"liquidationMaxAgeSeconds":0,"maxDeviationBps":2000}'],
    ['a fraction', '{"maxAgeSeconds":300,"liquidationMaxAgeSeconds":60,"maxDeviationBps":20.5}'],
    ['a string number', '{"maxAgeSeconds":"300","liquidationMaxAgeSeconds":60,"maxDeviationBps":2000}'],
    ['a liquidation age above the mark age', '{"maxAgeSeconds":30,"liquidationMaxAgeSeconds":60,"maxDeviationBps":2000}'],
    ['a deviation above 100%', '{"maxAgeSeconds":300,"liquidationMaxAgeSeconds":60,"maxDeviationBps":10001}'],
    [
      'the last trade as a basis',
      '{"maxAgeSeconds":300,"liquidationMaxAgeSeconds":60,"maxDeviationBps":2000,"liquidationQualities":["last"]}',
    ],
    ['no basis at all', '{"maxAgeSeconds":300,"liquidationMaxAgeSeconds":60,"maxDeviationBps":2000,"liquidationQualities":[]}'],
    ['an unknown field', '{"maxAgeSeconds":300,"liquidationMaxAgeSeconds":60,"maxDeviationBps":2000,"maxDeviation":1}'],
  ])('%s stops boot rather than being read as unpublished or a guess', (_name, raw) => {
    expect(() => publishedLiquidationLimitsFrom(raw)).toThrow(/TRADE_FUTURES_LIQUIDATION_LIMITS/);
  });
});
