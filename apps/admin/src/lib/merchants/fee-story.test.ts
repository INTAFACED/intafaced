import { describe, expect, it } from 'vitest';
import { feeLines, percentText } from './fee-story';

const rule = (layer: 'global' | 'tier' | 'merchant', bands: Array<{ fromAmount: string; feeBps: number; flatFee: string | null }>) => ({
  layer,
  scopeId: null,
  assetCode: 'USDT',
  bands,
  spreadBps: null,
  roundingBeneficiary: 'platform' as const,
});

describe('fee story', () => {
  it('prints percent, never basis points', () => {
    expect(percentText(250)).toBe('2.5%');
    expect(percentText(100)).toBe('1%');
    expect(percentText(125)).toBe('1.25%');
    expect(percentText(5)).toBe('0.05%');
    expect(percentText(0)).toBe('0%');
  });

  it('the most specific layer wins per asset', () => {
    const lines = feeLines([
      rule('global', [{ fromAmount: '0', feeBps: 250, flatFee: null }]),
      rule('tier', [{ fromAmount: '0', feeBps: 200, flatFee: null }]),
    ]);
    expect(lines).toEqual([{ assetCode: 'USDT', percent: '2%', stepped: false, layerWords: 'its tier’s rule' }]);
  });

  it('puts a flat fee only on the band it belongs to', () => {
    const [line] = feeLines([
      rule('merchant', [
        { fromAmount: '0', feeBps: 250, flatFee: '0.30' },
        { fromAmount: '1000', feeBps: 200, flatFee: null },
      ]),
    ]);
    expect(line?.percent).toBe('from 0.00: 2.5% + 0.30 USDT flat, from 1,000.00: 2%');
    expect(line?.stepped).toBe(true);
  });

  it('no rules means no lines', () => {
    expect(feeLines(null)).toEqual([]);
    expect(feeLines([])).toEqual([]);
  });
});
