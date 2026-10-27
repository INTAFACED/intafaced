import { describe, expect, it } from 'vitest';
import { moversOf } from './movers-model';
import type { MoneyRow } from './portfolio-source';

const row = (asset: string, changeRatio: string | null, extra: Partial<MoneyRow> = {}): MoneyRow => ({
  asset,
  class: 'crypto',
  amount: '1',
  usdValue: '100',
  usdChange24h: changeRatio === null ? null : '1',
  changeRatio,
  share: null,
  priceSymbol: `${asset}-USDT`,
  priceUsd: '100',
  ...extra,
});

describe('moversOf', () => {
  it('ranks rises biggest first and falls biggest first, at most three a side', () => {
    const view = {
      rows: [
        row('A', '0.01'),
        row('B', '0.05'),
        row('C', '-0.02'),
        row('D', '-0.10'),
        row('E', '0.02'),
        row('F', '0.03'),
        row('G', '-0.01'),
      ],
    };
    const movers = moversOf(view);
    expect(movers.best.map((r) => r.asset)).toEqual(['B', 'F', 'E']);
    expect(movers.worst.map((r) => r.asset)).toEqual(['D', 'C', 'G']);
    expect(movers.flat).toEqual([]);
    expect(movers.unranked).toEqual([]);
  });

  it('leaves dollar coins and unpriced coins out, names coins with no 24 h figure, and keeps a flat coin apart', () => {
    const view = {
      rows: [
        row('USDT', '0', { class: 'cash' }),
        row('ZED', null, { usdValue: null, priceUsd: null, priceSymbol: null }),
        row('NEW', null),
        row('FLAT', '0'),
        row('UP', '0.001'),
      ],
    };
    const movers = moversOf(view);
    expect(movers.best.map((r) => r.asset)).toEqual(['UP']);
    expect(movers.worst).toEqual([]);
    expect(movers.flat.map((r) => r.asset)).toEqual(['FLAT']);
    expect(movers.unranked).toEqual(['NEW']);
  });
});
