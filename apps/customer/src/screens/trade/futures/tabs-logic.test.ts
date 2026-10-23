import { describe, expect, it } from 'vitest';
import type { Position } from '@intafaced/exchange-contract/schemas';
import {
  countdownText,
  csvCell,
  historyCsv,
  historyRows,
  liquidatedRows,
  nextFundingAt,
  pastCallCap,
  percentOfBps,
  sameContract,
  signedAmount,
} from './tabs-logic';

// TEST data only: illustrative rows, not market figures.
const row = (over: Partial<Position>): Position => ({
  id: 'p1',
  symbol: 'BTC/USDT:USDT',
  timestamp: 1_000,
  datetime: '2026-01-01T00:00:00.000Z',
  side: 'long',
  status: 'closed',
  contracts: '1.5',
  contractSize: '1',
  entryPrice: '100',
  markPrice: '110',
  notional: '150',
  leverage: '5',
  collateral: '30',
  initialMargin: '30',
  maintenanceMargin: '5',
  unrealizedPnl: null,
  realizedPnl: '15',
  liquidationPrice: null,
  marginMode: 'isolated',
  percentage: null,
  ...over,
});

describe('csvCell', () => {
  it('prefixes formula starters with an apostrophe', () => {
    for (const c of ['=SUM(A1)', '+1', '-5x', '@x']) expect(csvCell(c)).toBe(`'${c}`);
  });
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });
  it('quotes a formula starter that also needs quoting', () => {
    expect(csvCell('=A,B')).toBe(`"'=A,B"`);
  });
  it('writes null as empty', () => {
    expect(csvCell(null)).toBe('');
  });
});

describe('historyRows and historyCsv', () => {
  const rows = [
    row({ id: 'a', timestamp: 1 }),
    row({ id: 'b', timestamp: 3, status: 'liquidated', realizedPnl: '-30' }),
    row({ id: 'c', timestamp: 2, status: 'open' }),
  ];
  it('keeps closed and liquidated, newest first', () => {
    expect(historyRows(rows).map((p) => p.id)).toEqual(['b', 'a']);
    expect(liquidatedRows(rows).map((p) => p.id)).toEqual(['b']);
  });
  it('builds the csv with a header, protected negative cells and blanks for unknowns', () => {
    const csv = historyCsv([row({ realizedPnl: '-30', markPrice: null }), row({ realizedPnl: '7', fees: '0.4' })]);
    const [head, line, paid] = csv.split('\r\n');
    expect(head).toBe('Contract,Side,Size,Entry,Exit,Realised PnL,Fees,Status,Opened at');
    expect(line).toBe('BTC/USDT:USDT,long,1.5,100,,-30,,closed,2026-01-01T00:00:00.000Z');
    expect(paid).toBe('BTC/USDT:USDT,long,1.5,100,110,7,0.4,closed,2026-01-01T00:00:00.000Z');
  });
});

describe('countdownText', () => {
  it('formats hours, minutes and seconds', () => {
    expect(countdownText(10_000 + 3725_000, 10_000)).toBe('1h 02m 05s');
    expect(countdownText(10_000 + 249_000, 10_000)).toBe('4m 09s');
    expect(countdownText(10_000 + 12_000, 10_000)).toBe('12s');
  });
  it('says now when passed and null when unknown', () => {
    expect(countdownText(5_000, 10_000)).toBe('now');
    expect(countdownText(null, 10_000)).toBeNull();
  });
});

describe('nextFundingAt', () => {
  it('prefers the funding read, falls back to the strip, else null', () => {
    expect(nextFundingAt(5, '2026-01-01T00:00:00.000Z')).toBe(5);
    expect(nextFundingAt(null, '2026-01-01T00:00:00.000Z')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(nextFundingAt(null, 'nope')).toBeNull();
    expect(nextFundingAt(undefined, null)).toBeNull();
  });
});

describe('pastCallCap', () => {
  it('is true only above the cap', () => {
    expect(pastCallCap(20, 20)).toBe(false);
    expect(pastCallCap(21, 20)).toBe(true);
  });
});

describe('signedAmount', () => {
  it('signs gains, keeps the minus, dashes unknowns', () => {
    expect(signedAmount('15')).toBe('+15');
    expect(signedAmount('-30')).toBe('\u221230');
    expect(signedAmount('0')).toBe('0');
    expect(signedAmount(null)).toBe('\u2014');
  });
});

describe('sameContract', () => {
  it('matches across separators and case, never on empty', () => {
    expect(sameContract('BTC/USDT:USDT', 'btc-usdt-usdt')).toBe(true);
    expect(sameContract('BTC/USDT', 'ETH/USDT')).toBe(false);
    expect(sameContract(null, null)).toBe(false);
  });
});

describe('percentOfBps', () => {
  it('writes whole bps as a percent by place value, with no float', () => {
    expect(percentOfBps(500)).toBe('5.00');
    expect(percentOfBps(2_000)).toBe('20.00');
    expect(percentOfBps(5)).toBe('0.05');
    expect(percentOfBps(0)).toBe('0.00');
  });
});
