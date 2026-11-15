import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseVenueMarketsView } from '@/lib/trade-ops/venue-markets-model';
import { wireView } from '@/lib/trade-ops/venue-markets-fixtures.test-util';
import { VenueMarketsPanel } from './venue-markets-panel';

const view = (over: Record<string, unknown> = {}) => parseVenueMarketsView(wireView(over))!;

describe('venue markets section of the Markets room (J-cex-spot-16)', () => {
  it('shows each market: whether we show it, our routing beside the venue own state, our limits beside the venue own', () => {
    const html = renderToStaticMarkup(<VenueMarketsPanel initial={view()} />);
    expect(html).toContain('data-venue-market="T16AB-USDC"');
    expect(html).toContain('data-shown="yes"');
    expect(html).toContain('Shown · v2 · open');
    expect(html).toContain('Stop routing (no new orders)');
    expect(html).toContain('data-venue-status="trading"');
    expect(html).toContain('2 size · 200 notional');
    expect(html).toContain('v1 · proposed by founder-a · approved by founder-b');
    expect(html).toContain('10 size · 1000 notional');
    expect(html).toContain('No delisting scheduled');
  });

  it('names what the venue does not report and a market we do not show, never a guess', () => {
    const html = renderToStaticMarkup(<VenueMarketsPanel initial={view()} />);
    expect(html).toContain('data-venue-market="ETH-USDC"');
    expect(html).toContain('data-shown="no"');
    expect(html).toContain('Not shown: no approved listing');
    expect(html).toContain('Not reported by the venue');
    expect(html).toContain('None of ours: the venue&#x27;s own applies');
  });

  it('labels a TEST venue TEST, and offers every change as a two-person request', () => {
    const html = renderToStaticMarkup(<VenueMarketsPanel initial={view()} />);
    expect(html).toMatch(/data-test-label="">TEST</);
    for (const name of ['List a venue market', 'Set a routing state', 'Edit our routed-order limits', 'Schedule a delisting'])
      expect(html).toContain(`aria-label="${name}"`);
    expect((html.match(/Ask a second founder to approve/g) ?? []).length).toBe(4);
    expect(html).toContain('Apply the approved change');
  });

  it('shows no TEST label on a venue that is not TEST', () => {
    const html = renderToStaticMarkup(<VenueMarketsPanel initial={view({ test: false, label: undefined })} />);
    expect(html).not.toContain('data-test-label');
  });
});
