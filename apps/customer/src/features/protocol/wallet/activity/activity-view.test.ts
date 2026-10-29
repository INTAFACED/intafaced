import { describe, expect, it } from 'vitest';
import { activityCsv, visibleRows, type AddressTx } from './activity-view';

const row = (hash: string, status: AddressTx['status']): AddressTx => ({
  hash,
  blockHeight: 10,
  timestamp: 1_700_000_000,
  from: '0x00000000000000000000000000000000000000aa',
  to: '0x00000000000000000000000000000000000000bb',
  status,
  token: { address: '0x00000000000000000000000000000000000a11ce', symbol: 'TKA', decimals: 6 },
  amount: '1.5',
  direction: 'out',
});

describe('wallet activity view', () => {
  const rows = [row('0x01', 'success'), row('0x02', 'failed'), row('0x03', 'pending')];

  it('hides failed rows only while the toggle is on, and never changes the list', () => {
    expect(visibleRows(rows, { hideFailed: true }).map((r) => r.hash)).toEqual(['0x01', '0x03']);
    expect(visibleRows(rows, { hideFailed: false }).map((r) => r.hash)).toEqual(['0x01', '0x02', '0x03']);
    expect(rows).toHaveLength(3);
  });

  it('exports exactly the rows given, in order, after one header line', () => {
    const shown = visibleRows(rows, { hideFailed: true });
    const lines = activityCsv(shown).trim().split('\r\n');
    expect(lines).toHaveLength(shown.length + 1);
    expect(lines[1]).toContain('0x01');
    expect(lines[2]).toContain('0x03');
  });
});
