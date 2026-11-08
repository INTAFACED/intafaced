import { describe, expect, it } from 'vitest';
import { venueRefusal } from './VenueWalletRoom';
import { venueWalletCopy } from './venue-wallet-copy';

/** J-wallet-09: every refusal the venue room can meet reads in the room's own words, with its code as the reference. */
const { t } = venueWalletCopy.forLocale('en');
const failed = (code: string | undefined, message = '', reason: 'error' | 'unreachable' = 'error') =>
  ({ ok: false, reason, code, message }) as Parameters<typeof venueRefusal>[0];

describe('venue room refusals', () => {
  it('a listed wallet and a blank list are refused by name, with the code shown', () => {
    expect(venueRefusal(failed('protocol.wallet_sanctioned'), t)).toEqual({
      variant: 'refused',
      title: 'This wallet can’t be connected',
      body: 'This wallet is on the sanctions list, so it cannot be connected or used. Nothing was connected.',
      reference: 'protocol.wallet_sanctioned',
    });
    expect(venueRefusal(failed('protocol.wallet_sanctions_unset'), t).title).toBe('No wallet can be screened');
  });

  it('a blocked region names its reason, the owner’s words on the per-country switch', () => {
    const r = venueRefusal(failed('denied.region_blocked', 'Not served in US (sanctions screening, §24 Lane A)'), t);
    expect(r.title).toBe('Not available in your region');
    expect(r.body).toContain('Not served in US');
    expect(r.reference).toBe('denied.region_blocked');
  });

  it('an expired connection asks the wallet to sign again; a code that leads the message is read too', () => {
    expect(venueRefusal(failed(undefined, 'protocol.venue_connection_expired: ended'), t)).toMatchObject({
      title: 'Your wallet must sign again',
      reference: 'protocol.venue_connection_expired',
    });
    expect(venueRefusal(failed('protocol.venue_unwired'), t).title).toBe('There is no venue in this build');
  });

  it('anything else says nothing went through, and an unreachable service says so', () => {
    expect(venueRefusal(failed('protocol.something_new'), t).title).toBe('That did not go through');
    expect(venueRefusal(failed(undefined, '', 'unreachable'), t).variant).toBe('unreachable');
  });
});
