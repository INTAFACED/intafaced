import { describe, expect, it } from 'vitest';
import { buildProposal, draftFrom, parseDraft, shownVersions, type FeeVersionRow } from './fees-versions-model';
import { builderFeeViews, builderRateText, parseBuilderCaps, type BuilderCaps } from './builder-fees-model';

const NOW = new Date('2026-11-09T10:00:00.000Z');
const LATER = '2026-11-09T11:00:00Z';
const reason = 'TEST builder fee change';
const VENUE = 'test-venue-sim';
const CAPS: BuilderCaps = {
  venueId: VENUE,
  displayName: 'TEST venue simulator',
  test: true,
  asOf: '2026-11-09T09:59:00.000Z',
  markets: [
    { symbol: 'BTC-USDC', kind: 'spot', capBps: '100' },
    { symbol: 'BTC-PERP', kind: 'perpetual', capBps: '10' },
  ],
};
const row = (version: string, effectiveAt: string, spot: string, perp = '1'): FeeVersionRow => ({
  version,
  effectiveAt,
  operatorId: 'a',
  approverId: 'b',
  reason: 'TEST',
  createdAt: effectiveAt,
  schedule: {
    makerBps: '8',
    takerBps: '10',
    builderFees: { [VENUE]: { defaultGroup: 'spot', marketGroups: { 'BTC-PERP': 'perpetuals' }, groups: { spot, perpetuals: perp } } },
  },
});

describe('builder-fee versions in the Fees room', () => {
  it('writes an exact decimal rate as a percent with its bps, never through a float', () => {
    expect(builderRateText('2')).toBe('0.02% (2 bps)');
    expect(builderRateText('1.5')).toBe('0.015% (1.5 bps)');
    expect(builderRateText('100')).toBe('1.00% (100 bps)');
    expect(builderRateText('0.0005')).toBe('0.000005% (0.0005 bps)');
    expect(builderRateText('9999.9999')).toBe('99.999999% (9999.9999 bps)');
    expect(builderRateText(null)).toBe('not set');
  });

  it('#1 shows every version by venue and market group: current and previous, with effective times and exact rates', () => {
    const history = [row('1', '2026-11-09T09:00:00.000Z', '1'), row('2', '2026-11-09T09:30:00.000Z', '2'), row('3', LATER, '3')];
    const [venue] = builderFeeViews(shownVersions(history, NOW));
    expect(venue!.venueId).toBe(VENUE);
    expect(venue!.groups.map((g) => [g.group, g.markets])).toEqual([
      ['spot', null],
      ['perpetuals', ['BTC-PERP']],
    ]);
    expect(venue!.groups[0]!.lines).toEqual([
      { version: '3', state: 'scheduled', effectiveAt: LATER, rate: '0.03% (3 bps)' },
      { version: '2', state: 'current', effectiveAt: '2026-11-09T09:30:00.000Z', rate: '0.02% (2 bps)' },
      { version: '1', state: 'previous', effectiveAt: '2026-11-09T09:00:00.000Z', rate: '0.01% (1 bps)' },
    ]);
  });

  it('#3 a complete version within the cap is proposed with exactly its rates; everything else is kept', () => {
    const base = row('2', '2026-11-09T09:30:00.000Z', '2');
    const draft = draftFrom(base);
    expect(draft.builderFees).toEqual([
      { venueId: VENUE, group: 'spot', feeBps: '2' },
      { venueId: VENUE, group: 'perpetuals', feeBps: '1' },
    ]);
    const edited = { ...draft, effectiveAt: LATER, builderFees: [{ ...draft.builderFees![0]!, feeBps: '100' }, draft.builderFees![1]!] };
    const check = buildProposal(base, edited, reason, NOW, CAPS);
    expect(check.ok && check.schedule.builderFees).toEqual({
      [VENUE]: { defaultGroup: 'spot', marketGroups: { 'BTC-PERP': 'perpetuals' }, groups: { spot: '100', perpetuals: '1' } },
    });
    expect(base.schedule.builderFees).toEqual(row('2', '', '2').schedule.builderFees);
    // The route reads the same draft back from the browser's body.
    expect(parseDraft(JSON.parse(JSON.stringify(edited)))).toEqual(edited);
  });

  it("#3 refuses, before anything is sent, a rate above the venue's cap, a blank rate, or caps it could not read", () => {
    const base = row('2', '2026-11-09T09:30:00.000Z', '2');
    const d = { ...draftFrom(base), effectiveAt: LATER };
    const withSpot = (feeBps: string) => ({ ...d, builderFees: [{ venueId: VENUE, group: 'spot', feeBps }, d.builderFees![1]!] });
    expect(buildProposal(base, withSpot('100.0001'), reason, NOW, CAPS)).toEqual({
      ok: false,
      code: 'trade.builder_fee_above_venue_cap',
      message: "The builder fee of test-venue-sim / spot is 100.0001 bps, above the venue's cap of 100 bps on BTC-USDC.",
    });
    const perp = { ...d, builderFees: [d.builderFees![0]!, { venueId: VENUE, group: 'perpetuals', feeBps: '10.5' }] };
    expect(buildProposal(base, perp, reason, NOW, CAPS)).toMatchObject({ ok: false, code: 'trade.builder_fee_above_venue_cap' });
    expect(buildProposal(base, withSpot(''), reason, NOW, CAPS)).toMatchObject({ ok: false, code: 'trade.builder_fee_blank' });
    expect(buildProposal(base, withSpot('1.23456'), reason, NOW, CAPS)).toMatchObject({ ok: false, code: 'trade.builder_fee_blank' });
    expect(buildProposal(base, withSpot('2'), reason, NOW, null)).toMatchObject({ ok: false, code: 'trade.builder_fee_venue_unknown' });
    const uncapped = { ...CAPS, markets: [{ symbol: 'BTC-USDC', kind: 'spot', capBps: null }] };
    expect(buildProposal(base, withSpot('2'), reason, NOW, uncapped)).toMatchObject({ ok: false, code: 'trade.builder_fee_cap_unknown' });
  });

  it('parses the caps read, and refuses a body that is not that shape', () => {
    expect(parseBuilderCaps(JSON.parse(JSON.stringify(CAPS)))).toEqual(CAPS);
    expect(parseBuilderCaps({ ...CAPS, markets: [{ symbol: 'BTC-USDC', kind: 'spot', capBps: 100 }] })).toBeNull();
    expect(parseBuilderCaps({ ...CAPS, test: 'yes' })).toBeNull();
  });
});
