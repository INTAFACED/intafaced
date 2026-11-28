import { describe, expect, it } from 'vitest';
import { venueEntries } from './TradingStatement';

describe('venueEntries (J-derivatives-25 #12)', () => {
  it('lists every move, fill and fee with the venue’s reference, a withdrawal with its chain transaction, and no order', () => {
    const tx = `0x${'ab'.repeat(32)}`;
    const rows: Record<string, string>[] = [
      { record: 'order', id: 'o1', source_ref: 'vo1', source: 'TEST venue', market: 'BTC-USDC' },
      {
        record: 'trade',
        id: 'f1',
        time: '2026-11-28T01:00:00.000Z',
        source: 'TEST venue',
        market: 'BTC-USDC',
        side: 'buy',
        amount: '0.01',
        fee: '0.08',
        fee_asset: 'USDC',
        source_ref: 'f1',
      },
      {
        record: 'deposit',
        id: 'a1',
        time: '2026-11-28T00:00:00.000Z',
        source: 'TEST venue',
        asset: 'USDC',
        amount: '600',
        source_ref: 'a1',
      },
      {
        record: 'withdrawal',
        id: 'n1',
        time: '2026-11-28T02:00:00.000Z',
        source: 'TEST venue',
        asset: 'USDC',
        amount: '10',
        fee: '',
        source_ref: tx,
      },
    ];
    const entries = venueEntries(rows, 'TEST venue');
    expect(entries.map((e) => e.record)).toEqual(['trade', 'deposit', 'withdrawal']);
    expect(entries[0]).toMatchObject({ what: 'BTC-USDC · buy', amount: '0.01', fee: '0.08 USDC', ref: 'f1', chainTx: null });
    expect(entries[1]).toMatchObject({ what: 'USDC', amount: '600 USDC', fee: null, ref: 'a1' });
    // A fee the venue reports none for stays null (shown "not known"), never 0.
    expect(entries[2]).toMatchObject({ fee: null, ref: tx, chainTx: tx });
  });
});
