import { describe, expect, it } from 'vitest';
import { csvCell, exportFilename, killSwitchRows, neutraliseCell, orderRows, toCsv } from './csv';
import type { AdminOrderRow } from './reads';

describe('csvCell', () => {
  it('quotes commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvCell('l1\r\nl2')).toBe('"l1\r\nl2"');
    expect(csvCell('plain')).toBe('plain');
  });
  it('writes null and undefined as an empty cell, never 0', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});

describe('formula injection', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx', '=HYPERLINK("http://x","y")'])('neutralises %j', (v) => {
    expect(neutraliseCell(v).startsWith("'")).toBe(true);
  });
  it('keeps the apostrophe inside the quotes when the cell also needs quoting', () => {
    expect(csvCell('=A1,B1')).toBe('"\'=A1,B1"');
  });
  it('leaves exact decimals untouched, including negatives', () => {
    for (const d of ['-12.50', '0.00000001', '123456789012345678901234567890.123456789', '-0.1', '7']) expect(neutraliseCell(d)).toBe(d);
  });
  it('still guards things that merely look numeric', () => {
    expect(neutraliseCell('-1e9')).toBe("'-1e9");
    expect(neutraliseCell('+5')).toBe("'+5");
    expect(neutraliseCell('-5 ')).toBe("'-5 ");
  });
  it('does not touch a formula character in the middle', () => {
    expect(neutraliseCell('a=b')).toBe('a=b');
  });
});

describe('toCsv', () => {
  it('writes a header, CRLF lines and no footer', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['1', 'x,y'],
          ['2', null],
        ],
      ),
    ).toBe('a,b\r\n1,"x,y"\r\n2,\r\n');
  });
  it('writes only the header for no rows', () => {
    expect(toCsv(['a'], [])).toBe('a\r\n');
  });
  it('pads short rows to the header width', () => {
    expect(toCsv(['a', 'b', 'c'], [['1']])).toBe('a,b,c\r\n1,,\r\n');
  });
});

describe('exportFilename', () => {
  it('carries the scope and the as-of in UTC', () => {
    expect(exportFilename('Open orders', '2026-10-17T03:15:00.123Z')).toBe('intafaced-open-orders-20261017T031500Z.csv');
  });
  it('cleans an unsafe scope and survives a bad time', () => {
    expect(exportFilename('../a b', 'nope')).toBe('intafaced-a-b-unknown-time.csv');
  });
});

const order = (over: Partial<AdminOrderRow>): AdminOrderRow => ({
  id: 'o1',
  userId: 'u1',
  symbol: 'BTC/USDT',
  side: 'buy',
  type: 'limit',
  timeInForce: 'GTC',
  price: '100.10',
  amount: '1.5',
  filled: '0',
  remaining: '1.5',
  cost: null,
  status: 'open',
  held: false,
  recoveryReason: null,
  reconciliationKey: null,
  seeded: false,
  datetime: '2026-10-17T00:00:00.000Z',
  clientOrderId: null,
  ...over,
});

describe('orderRows', () => {
  it('keeps decimals as sent and marks held and seeded in words', () => {
    expect(orderRows([order({ held: true, seeded: true, price: null })], true)).toEqual([
      ['o1', 'u1', 'BTC/USDT', 'buy', 'limit', '', '1.5', '0', '1.5', 'open', 'yes', 'yes', '2026-10-17T00:00:00.000Z'],
    ]);
  });
  it('drops seeded rows unless asked', () => {
    const rows = [order({ id: 'a' }), order({ id: 'b', seeded: true })];
    expect(orderRows(rows, false).map((r) => r[0])).toEqual(['a']);
    expect(orderRows(rows, true).map((r) => r[0])).toEqual(['a', 'b']);
  });
});

describe('killSwitchRows', () => {
  it('writes running / stopped and an empty confirming operator when none', () => {
    expect(killSwitchRows([{ at: 't', module: 'trade', actor: 'a', reason: 'r', previous: false, next: true }])).toEqual([
      ['t', 'a', '', 'trade', 'r', 'running', 'stopped'],
    ]);
  });
});
