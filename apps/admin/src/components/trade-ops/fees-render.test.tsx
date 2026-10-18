import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { parseEffectiveFees } from '@/lib/trade-ops/fees-model';
import { ok, refused } from '@/lib/trade-ops/outcome';
import type { MarketRow } from '@/lib/trade-ops/reads';
import { feeCellFor } from '@/lib/trade-ops/fees-model';
import type { MarketRowView } from '@/lib/trade-ops/markets-model';
import { FeeScheduleNote } from './fee-schedule-note';
import { MarketRules } from './markets-rules';
import { MarketsTable } from './markets-table';
import { RiskLimitsTable } from './risk-limits-table';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

// Listing-row bps 10/20 are deliberately NOT the charged 8/10, so any leak of the listing numbers into a charged cell fails.
const market: MarketRow = {
  id: '00000000-0000-4000-8000-0000000000aa',
  symbol: 'BTC/USDT',
  base: 'BTC',
  quote: 'USDT',
  kind: 'spot',
  status: 'active',
  tickSize: '0.01',
  lotSize: '0.0001',
  minQty: '0.0001',
  maxQty: null,
  minNotional: '5',
  makerBps: 10,
  takerBps: 20,
  listedAt: null,
};
const schedule = ok(
  parseEffectiveFees({
    source: 'TRADE_FEE_SCHEDULE',
    version: 'desk',
    markets: [
      {
        symbol: 'BTC/USDT',
        kind: 'spot',
        product: 'spot',
        charged: { makerBps: '8', takerBps: '10', makerRate: '0.0008', takerRate: '0.001' },
        refusal: null,
      },
    ],
  })!,
);
const blank = refused('trade.fee_schedule_blank', 'Trading fees are not available: the maker and taker schedule is not set.', 503);

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('trade desk fee display', () => {
  it('risk limits shows the charged 0.08% / 0.10% and labels the listing 10 / 20 as not charged', () => {
    const t = text(renderToStaticMarkup(<RiskLimitsTable markets={[market]} fees={schedule} />));
    expect(t).toContain('Fee charged (maker / taker)');
    expect(t).toContain('0.08% / 0.10%');
    expect(t).toContain('Listing bps, not charged');
    expect(t).toContain('10 / 20');
  });

  it('markets list shows the charged fee and no listing bps column', () => {
    const view: MarketRowView = { market, lifecycle: null, orders: null, fee: feeCellFor(schedule, market.symbol) };
    const t = text(renderToStaticMarkup(<MarketsTable rows={[view]} />));
    expect(t).toContain('Fee charged (maker / taker)');
    expect(t).toContain('0.08% / 0.10%');
    expect(t).not.toContain('10 / 20');
  });

  it('market detail lists the charged fee first and the listing bps labelled not charged', () => {
    const t = text(renderToStaticMarkup(<MarketRules market={market} asOf="2026-10-17T00:00:00Z" fees={schedule} />));
    expect(t).toContain('Maker fee charged');
    expect(t).toContain('0.08% (8 bps)');
    expect(t).toContain('Taker fee charged');
    expect(t).toContain('0.10% (10 bps)');
    expect(t).toContain('Listing maker fee (bps), not charged');
  });

  it('a blank schedule shows the typed refusal everywhere and no number', () => {
    const view: MarketRowView = { market, lifecycle: null, orders: null, fee: feeCellFor(blank, market.symbol) };
    const list = text(renderToStaticMarkup(<MarketsTable rows={[view]} />));
    expect(list).toContain('Refused (trade.fee_schedule_blank)');
    expect(list).not.toMatch(/\d\.\d\d% \/ \d\.\d\d%/);
    const limits = text(renderToStaticMarkup(<RiskLimitsTable markets={[market]} fees={blank} />));
    expect(limits).toContain('Refused (trade.fee_schedule_blank)');
    expect(limits).not.toMatch(/\d\.\d\d% \/ \d\.\d\d%/);
    const rules = text(renderToStaticMarkup(<MarketRules market={market} asOf="2026-10-17T00:00:00Z" fees={blank} />));
    expect(rules).toContain('Refusal code');
    expect(rules).toContain('trade.fee_schedule_blank');
    expect(rules).not.toContain('Maker fee charged');
    const note = text(renderToStaticMarkup(<FeeScheduleNote fees={blank} />));
    expect(note).toContain('trade.fee_schedule_blank');
  });

  it('the note names the source and says listing bps are not charged', () => {
    const t = text(renderToStaticMarkup(<FeeScheduleNote fees={schedule} />));
    expect(t).toContain('TRADE_FEE_SCHEDULE');
    expect(t).toContain('version desk');
    expect(t).toContain('not charged');
  });
});
