import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OpsVenueEconomics } from '@intafaced/contracts';
import { VenueEconomicsReport } from './report';

const entry = (category: 'custody' | 'data', version: number, amount: string) => ({
  key: `venue-cost:2026-10:${category}:${version}`,
  period: '2026-10',
  category,
  version,
  amount,
  asset: 'USD',
  sourceNote: 'TEST invoice',
  enteredBy: 'u1',
  approverId: 'u2',
  enteredAt: '2026-10-20T01:00:00.000Z',
});

const lines = (entered: readonly ('custody' | 'data')[]): OpsVenueEconomics['costs'] => [
  { status: 'not_entered', category: 'liquidity' },
  { status: 'not_entered', category: 'insurance_default_capital' },
  entered.includes('custody')
    ? {
        status: 'entered',
        category: 'custody',
        current: entry('custody', 2, '90'),
        history: [entry('custody', 1, '100.5'), entry('custody', 2, '90')],
      }
    : { status: 'not_entered', category: 'custody' },
  entered.includes('data')
    ? { status: 'entered', category: 'data', current: entry('data', 1, '4'), history: [entry('data', 1, '4')] }
    : { status: 'not_entered', category: 'data' },
  { status: 'not_entered', category: 'support' },
  { status: 'not_entered', category: 'compliance' },
  { status: 'not_entered', category: 'infrastructure' },
];

const base: OpsVenueEconomics = {
  asOf: '2026-10-20T10:00:00.000Z',
  period: '2026-10',
  revenue: {
    status: 'unavailable',
    code: 'ops.warehouse_unwired',
    message: 'Analytics warehouse replica is not wired. No invented revenue.',
  },
  costs: lines(['custody', 'data']),
  completeness: { status: 'incomplete', missing: ['liquidity', 'insurance_default_capital', 'support', 'compliance', 'infrastructure'] },
  costTotals: { partial: true, byAsset: [{ asset: 'USD', amount: '94' }] },
  net: { status: 'unavailable', reason: 'revenue_asset_unknown' },
};

describe('venue economics report', () => {
  it('names the missing lines, labels the sum partial, shows no net and keeps the cost side when revenue is unwired', () => {
    const html = renderToStaticMarkup(<VenueEconomicsReport report={base} asOf={base.asOf} />);
    expect(html).toContain('Incomplete: no total for 2026-10');
    expect(html).toContain('Liquidity, Insurance and default capital, Support, Compliance, Infrastructure');
    expect(html).toContain('Not entered');
    expect(html).toContain('partial, not the month');
    expect(html).toContain('94 USD');
    expect(html).toContain('Revenue not available');
    expect(html).toContain('ops.warehouse_unwired');
    expect(html).toContain('Net is not worked out here');
  });

  it('uses the latest version and offers the history', () => {
    const html = renderToStaticMarkup(<VenueEconomicsReport report={base} asOf={base.asOf} />);
    expect(html).toContain('90 USD');
    expect(html).toContain('2 (latest is used)');
    expect(html).toContain('v1: 100.5 USD');
  });

  it('says empty revenue is empty, not zero', () => {
    const html = renderToStaticMarkup(
      <VenueEconomicsReport
        report={{ ...base, revenue: { status: 'ok', empty: true, freshness: 'fresh', points: [] } }}
        asOf={base.asOf}
      />,
    );
    expect(html).toContain('not as zero');
  });

  it('shows a complete month as a total without a net', () => {
    const complete: OpsVenueEconomics = {
      ...base,
      completeness: { status: 'complete' },
      costTotals: { partial: false, byAsset: [{ asset: 'USD', amount: '94' }] },
    };
    const html = renderToStaticMarkup(<VenueEconomicsReport report={complete} asOf={base.asOf} />);
    expect(html).not.toContain('Incomplete');
    expect(html).toContain('Total cost: 94 USD.');
    expect(html).toContain('Net is not worked out here');
  });

  const complete: OpsVenueEconomics = {
    ...base,
    completeness: { status: 'complete' },
    costTotals: { partial: false, byAsset: [{ asset: 'USD', amount: '94' }] },
  };
  const fees = {
    status: 'ok' as const,
    assets: [{ assetId: 'USD', collected: '120.5', returned: '0.5', net: '120' }],
  };

  it('shows the ledger fee revenue per asset and a net per asset, a loss with its sign', () => {
    const html = renderToStaticMarkup(
      <VenueEconomicsReport
        report={{
          ...complete,
          feeRevenue: fees,
          net: {
            status: 'ok',
            byAsset: [
              { asset: 'USD', revenue: '120', costs: '94', net: '26' },
              { asset: 'BTC', revenue: '0', costs: '0.5', net: '-0.5' },
            ],
          },
        }}
        asOf={base.asOf}
      />,
    );
    expect(html).toContain('data-testid="fees-table"');
    expect(html).toContain('120.5');
    expect(html).toContain('data-testid="net-table"');
    expect(html).toContain('-0.5');
    expect(html).toContain('Units are never mixed');
    expect(html).not.toContain('net-unavailable');
  });

  it('says net waits on the cost lines while any is missing, and still shows the fees', () => {
    const html = renderToStaticMarkup(
      <VenueEconomicsReport
        report={{ ...base, feeRevenue: fees, net: { status: 'unavailable', reason: 'costs_incomplete' } }}
        asOf={base.asOf}
      />,
    );
    expect(html).toContain('Net needs every cost line entered');
    expect(html).toContain('data-testid="fees-table"');
    expect(html).not.toContain('data-testid="net-table"');
  });

  it('names the code and does not read fees as zero when the ledger could not be read', () => {
    const html = renderToStaticMarkup(
      <VenueEconomicsReport
        report={{
          ...complete,
          feeRevenue: {
            status: 'unavailable',
            code: 'ops.fee_revenue_unavailable',
            message: 'The ledger did not answer the fee revenue read.',
          },
          net: { status: 'unavailable', reason: 'revenue_unavailable' },
        }}
        asOf={base.asOf}
      />,
    );
    expect(html).toContain('Fee revenue not available');
    expect(html).toContain('ops.fee_revenue_unavailable');
    expect(html).toContain('It is not read as zero');
    expect(html).toContain('Net needs the ledger’s fee revenue, which could not be read (ops.fee_revenue_unavailable)');
  });

  it('shows a month the ledger booked no fees as the ledger’s answer', () => {
    const html = renderToStaticMarkup(
      <VenueEconomicsReport report={{ ...complete, feeRevenue: { status: 'ok', assets: [] } }} asOf={base.asOf} />,
    );
    expect(html).toContain('data-testid="fees-empty"');
    expect(html).toContain('the ledger’s answer, not a missing read');
  });
});
