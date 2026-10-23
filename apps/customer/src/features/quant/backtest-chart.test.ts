import { describe, expect, it } from 'vitest';
import { equityGeometry, tradesCsv, tradesCsvName } from './backtest-chart';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 20, 0, minute)).toISOString();
const trade = (minute: number, side: 'buy' | 'sell', price: string) => ({
  ts: at(minute),
  side,
  reason: 'signal' as const,
  qty: '1',
  barPrice: price,
  price,
  fee: '0.1',
  slippage: '0',
});

describe('backtest equity chart', () => {
  it('draws the curve from the stored points and puts each fill on its bar', () => {
    const geometry = equityGeometry(
      {
        equity: [
          { ts: at(0), equity: '1000' },
          { ts: at(1), equity: '1010' },
          { ts: at(2), equity: '990' },
        ],
        trades: [trade(1, 'buy', '100'), trade(2, 'sell', '99')],
      },
      100,
      20,
    );
    expect(geometry?.line).toBe('0,10 50,0 100,20');
    expect(geometry?.markers).toEqual([
      { x: '50', y: '0', side: 'buy', ts: at(1) },
      { x: '100', y: '20', side: 'sell', ts: at(2) },
    ]);
    expect(geometry?.unmatched).toBe(0);
  });

  it('matches a fill to its point by the instant, and counts a fill with no point instead of hiding it', () => {
    const geometry = equityGeometry(
      {
        equity: [
          { ts: '2026-10-20T00:00:00Z', equity: '1' },
          { ts: '2026-10-20T00:01:00Z', equity: '2' },
        ],
        trades: [trade(1, 'buy', '1'), trade(7, 'sell', '2')],
      },
      100,
      20,
    );
    expect(geometry?.markers.map((marker) => marker.x)).toEqual(['100']);
    expect(geometry?.unmatched).toBe(1);
  });

  it('has no curve for fewer than two points, and a flat curve sits in the middle', () => {
    expect(equityGeometry({ equity: [{ ts: at(0), equity: '1' }], trades: [] }, 100, 20)).toBeNull();
    expect(
      equityGeometry(
        {
          equity: [
            { ts: at(0), equity: '1' },
            { ts: at(1), equity: '1' },
          ],
          trades: [],
        },
        100,
        20,
      )?.line,
    ).toBe('0,10 100,10');
  });
});

describe('backtest trades CSV', () => {
  it('writes one row per fill with its side, and neutralises a cell a spreadsheet would run', () => {
    const csv = tradesCsv({ trades: [trade(1, 'buy', '100'), { ...trade(2, 'sell', '99'), reason: '=HYPERLINK("x")' as 'signal' }] });
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('time_utc,side,reason,quantity,bar_price,fill_price,fee,slippage');
    expect(lines[1]).toBe(`${at(1)},buy,signal,1,100,100,0.1,0`);
    expect(lines[2]).toBe(`${at(2)},sell,"'=HYPERLINK(""x"")",1,99,99,0.1,0`);
  });

  it('names the file after the run', () => {
    expect(tradesCsvName('run_abc/1')).toBe('backtest-run_abc_1-trades.csv');
  });
});
