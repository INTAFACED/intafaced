import { describe, expect, it } from 'vitest';
import type { JournalTrade, TradeJournal } from '@intafaced/contracts/trade-journal-procedures';
import { equityOf, minusOneRLessFees } from './journal-model';

// J-portfolio-19 #1: two running totals over the same trades, oldest closed first, and the gap at the end as the
// service's own totals give it. Hand-worked: made −8.2, 7.8, 3 → −8.2, −0.4, 2.6; rules −5.2, −5.2, 0 → −5.2, −10.4, −10.4.
const trade = (id: string, closedAt: string, net: string, rules: string, verdict: JournalTrade['rules']['verdict']): JournalTrade =>
  ({
    tradeId: id,
    closedAt,
    netPnl: net,
    venueFees: '0.2',
    builderFees: '0',
    feeAsset: 'USDC',
    rules: { verdict, netPnl: rules, oneR: '5', widenedStop: null, dailyLoss: null },
  }) as JournalTrade;

describe('the journal equity lines', () => {
  const journal = {
    trades: [
      trade('c', '2026-11-28T10:03:00.000Z', '3', '0', 'left_out'),
      trade('a', '2026-11-28T10:01:00.000Z', '-8.2', '-5.2', 'capped'),
      trade('b', '2026-11-28T10:02:00.000Z', '7.8', '-5.2', 'stopped'),
    ],
    totals: { netPnl: '2.6', rulesNetPnl: '-10.4' },
  } as TradeJournal;

  it('runs both totals oldest first and gives the gap from the same trades', () => {
    const e = equityOf(journal);
    expect(e.points.map((p) => [p.trade.tradeId, p.made, p.rules])).toEqual([
      ['a', '-8.2', '-5.2'],
      ['b', '-0.4', '-10.4'],
      ['c', '2.6', '-10.4'],
    ]);
    expect([e.made, e.rules, e.gap]).toEqual(['2.6', '-10.4', '-13']);
  });

  it('works minus 1R less fees from the trade’s own figures', () => {
    expect(minusOneRLessFees(journal.trades[1]!)).toBe('-5.2');
  });
});
