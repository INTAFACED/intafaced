import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ok, refused } from '@/lib/trade-ops/outcome';
import type { FeeVersionRow } from '@/lib/trade-ops/fees-versions-model';
import { BuilderFeeVersions } from './builder-fees';

const AS_OF = '2026-11-09T10:00:00.000Z';
const row = (version: string, effectiveAt: string, spot: string): FeeVersionRow => ({
  version,
  effectiveAt,
  operatorId: 'a',
  approverId: 'b',
  reason: 'TEST',
  createdAt: effectiveAt,
  schedule: { makerBps: '8', takerBps: '10', builderFees: { 'test-venue-sim': { defaultGroup: 'spot', groups: { spot } } } },
});
const history = { version: '2', history: [row('1', '2026-11-09T09:00:00.000Z', '1.5'), row('2', '2026-11-09T09:30:00.000Z', '2')] };
const caps = ok(
  {
    venueId: 'test-venue-sim',
    displayName: 'TEST venue simulator',
    test: true,
    asOf: AS_OF,
    markets: [{ symbol: 'BTC-USDC', kind: 'spot', capBps: '100' }],
  },
  AS_OF,
);

describe('Builder-fee versions by venue and market group', () => {
  it('lists current and previous versions with their times and exact rates, beside the TEST venue cap', () => {
    const html = renderToStaticMarkup(<BuilderFeeVersions history={history} now={new Date(AS_OF)} caps={caps} />);
    expect(html).toContain('data-builder-venue="test-venue-sim"');
    expect(html).toMatch(/data-version="v2" data-state="current">.*Current.*2026-11-09 09:30:00 UTC.*0\.02% \(2 bps\)/);
    expect(html).toMatch(/data-version="v1" data-state="previous">.*Previous.*2026-11-09 09:00:00 UTC.*0\.015% \(1\.5 bps\)/);
    expect(html).toMatch(/data-builder-cap="BTC-USDC">.*spot.*1\.00% \(100 bps\)/);
    expect(html).toContain('TEST · TEST venue simulator');
  });

  it('says when the cap could not be read, with the refusal, and never shows a cap of its own', () => {
    const html = renderToStaticMarkup(
      <BuilderFeeVersions
        history={history}
        now={new Date(AS_OF)}
        caps={refused('trade.user_venue_off', 'TEST: the door is off', 400, null, AS_OF)}
      />,
    );
    expect(html).toContain('data-fees="builder-caps-unread"');
    expect(html).toContain('trade.user_venue_off');
    expect(html).not.toContain('data-builder-cap=');
  });
});
