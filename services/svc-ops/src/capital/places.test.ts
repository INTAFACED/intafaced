/**
 * Our own funds at each named place, beside the outside figure it is checked against (project-state OWNER.md item 288;
 * b2 change 3). The ledger's figure and the outside party's figure with its own time; a place nobody reads, a read that
 * failed, or a figure in another asset says so, never a zero.
 */
import { describe, expect, it } from 'vitest';
import type { BankPartnerReserves, LedgerOwnFunds, OpsCapitalVenues } from '@intafaced/contracts';
import { opsCapitalPlacesSchema } from '@intafaced/contracts';
import { composePlaces, VENUES_NOT_CONNECTED } from './desk.js';
import type { SourceRead } from './sources.js';

const AT = '2026-11-10T23:00:00.000Z';
const VENUE_AT = '2026-11-10T22:59:30.000Z';
const PARTNER_AT = '2026-11-10T22:00:00.000Z';

const ledger: SourceRead<LedgerOwnFunds> = {
  ok: true,
  value: {
    asOf: AT,
    accounts: [],
    places: [
      { kind: 'venue_builder_account', placeId: 'test-venue', assetId: 'USDC', held: '2.5' },
      { kind: 'venue_builder_account', placeId: 'gone-venue', assetId: 'USDC', held: '1' },
      { kind: 'partner_reserve', placeId: 'bank', assetId: 'USD', held: '1.5' },
      { kind: 'partner_reserve', placeId: 'card', assetId: 'USD', held: '0' },
      { kind: 'treasury_wallet', placeId: 'base:ops', assetId: 'USDC', held: '9' },
    ],
  },
};
const venues: OpsCapitalVenues = {
  status: 'read',
  venues: [
    {
      venueId: 'test-venue',
      displayName: 'TEST venue',
      test: true,
      builderAccount: '0xb1',
      balance: { status: 'read', assetId: 'USDC', amount: '2.5', asOf: VENUE_AT },
      minimum: { status: 'not_published' },
    },
  ],
};
const reserves: SourceRead<BankPartnerReserves> = {
  ok: true,
  value: {
    asOf: AT,
    partners: [
      {
        partner: 'bank',
        label: 'TEST partner bank',
        test: true,
        reserve: { status: 'reported', assetId: 'USD', amount: '1.4', asOf: PARTNER_AT },
      },
      { partner: 'card', label: 'TEST partner card', test: true, reserve: { status: 'none' } },
    ],
  },
};

describe('composePlaces', () => {
  it('sets each place the book names beside the venue’s or partner’s own figure and its own time', () => {
    const out = composePlaces(ledger, venues, reserves);
    expect(opsCapitalPlacesSchema.parse(out)).toEqual(out);
    if (out.status !== 'read') throw new Error('expected read');
    expect(out.asOf).toBe(AT);
    expect(out.places.map((p) => [p.kind, p.placeId, p.held, p.outside])).toEqual([
      [
        'venue_builder_account',
        'test-venue',
        '2.5',
        { status: 'read', source: 'the venue’s own record for 0xb1 (TEST)', amount: '2.5', asOf: VENUE_AT },
      ],
      [
        'venue_builder_account',
        'gone-venue',
        '1',
        { status: 'not_connected', message: 'No venue adapter reports a builder account at gone-venue.' },
      ],
      // The partner's time, not ours: 1.4 as of 22:00 against the book's 1.5 now. The difference stands, shown as read.
      ['partner_reserve', 'bank', '1.5', { status: 'read', source: 'TEST partner bank (TEST)', amount: '1.4', asOf: PARTNER_AT }],
      ['partner_reserve', 'card', '0', { status: 'none', source: 'TEST partner card (TEST)' }],
      [
        'treasury_wallet',
        'base:ops',
        '9',
        { status: 'not_connected', message: 'No chain reader reports INTAFACED’s treasury wallets to this console yet.' },
      ],
    ]);
  });

  it('never reads a failed or absent outside source as zero', () => {
    const noVenues = composePlaces(ledger, VENUES_NOT_CONNECTED, {
      ok: false,
      code: 'ops.capital.source_unavailable',
      message: 'svc-bank: down',
    });
    if (noVenues.status !== 'read') throw new Error('expected read');
    for (const p of noVenues.places) expect(p.outside.status === 'read' || p.outside.status === 'none').toBe(false);
    expect(noVenues.places.find((p) => p.placeId === 'bank')!.outside).toEqual({
      status: 'unknown',
      code: 'ops.capital.source_unavailable',
      message: 'svc-bank: down',
    });

    const venueDown: OpsCapitalVenues = {
      status: 'read',
      venues: [
        {
          ...(venues.status === 'read' ? venues.venues[0]! : ({} as never)),
          balance: { status: 'unknown', code: 'ops.capital.venue_read_failed', message: 'timeout' },
        },
      ],
    };
    const down = composePlaces(ledger, venueDown, reserves);
    if (down.status !== 'read') throw new Error('expected read');
    expect(down.places[0]!.outside).toEqual({ status: 'unknown', code: 'ops.capital.venue_read_failed', message: 'timeout' });
  });

  it('does not compare a figure in another asset', () => {
    const otherAsset: OpsCapitalVenues = {
      status: 'read',
      venues: [
        {
          ...(venues.status === 'read' ? venues.venues[0]! : ({} as never)),
          balance: { status: 'read', assetId: 'USDT', amount: '2.5', asOf: VENUE_AT },
        },
      ],
    };
    const out = composePlaces(ledger, otherAsset, reserves);
    if (out.status !== 'read') throw new Error('expected read');
    expect(out.places[0]!.outside).toEqual({
      status: 'not_connected',
      message: 'TEST venue reports the builder account in USDT, not USDC.',
    });
  });

  it('is unknown, as a whole, when the ledger could not be read', () => {
    expect(composePlaces({ ok: false, code: 'ops.capital.source_unavailable', message: 'svc-ledger: down' }, venues, reserves)).toEqual({
      status: 'unknown',
      code: 'ops.capital.source_unavailable',
      message: 'svc-ledger: down',
    });
  });
});
