import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { VenueConnection } from './venue-wallet-api';
import { AccountLinkNote, accountLinkOf } from './AccountLink';
import { NetworkSwitch } from './VenueWalletRoom';
import { venueWalletCopy } from './venue-wallet-copy';

/**
 * A browser wallet connected only in this browser is not yet the account's, so no testnet grant reaches it;
 * the wallet panels say so and lead to the one signed connection, and /wallet/venue switches network itself.
 */
const { t } = venueWalletCopy.forLocale('en');
const ADDRESS = '0x' + 'ab'.repeat(20);
const NOW = Date.parse('2026-11-27T10:00:00.000Z');
const conn = (over: Partial<VenueConnection>): VenueConnection =>
  ({ address: ADDRESS, status: 'live', expiresAt: '2026-11-28T10:00:00.000Z', ...over }) as VenueConnection;

describe('a browser wallet and the account (the grant needs the account’s record)', () => {
  it('reads the account’s own record of this wallet: none, live, expired (by the clock too) or blocked', () => {
    expect(accountLinkOf([], ADDRESS, NOW)).toBe('none');
    expect(accountLinkOf([conn({ address: '0x' + 'cd'.repeat(20) })], ADDRESS, NOW)).toBe('none');
    expect(accountLinkOf([conn({ address: ADDRESS.toUpperCase().replace('0X', '0x') })], ADDRESS, NOW)).toBe('live');
    expect(accountLinkOf([conn({ status: 'expired' })], ADDRESS, NOW)).toBe('expired');
    expect(accountLinkOf([conn({ expiresAt: '2026-11-27T09:59:59.000Z' })], ADDRESS, NOW)).toBe('expired');
    expect(accountLinkOf([conn({ status: 'blocked' })], ADDRESS, NOW)).toBe('blocked');
  });

  it('a wallet connected in the browser only is told to connect it to the account, with the one link to do it', () => {
    const html = renderToStaticMarkup(<AccountLinkNote link="none" href="/wallet/venue" t={t} />);
    expect(html).toContain('Connected in this browser only');
    expect(html).toContain('href="/wallet/venue"');
    expect(html).toContain('Connect to my account');
    const expired = renderToStaticMarkup(<AccountLinkNote link="expired" href="/wallet/venue" t={t} />);
    expect(expired).toContain('href="/wallet/venue"');
    expect(expired).toContain('Sign again');
    const live = renderToStaticMarkup(<AccountLinkNote link="live" href="/wallet/venue" t={t} />);
    expect(live).toContain('Connected to your account');
    expect(live).not.toContain('href="/wallet/venue"');
    // The room is not in this build: the note still says what is missing, with no dead link.
    expect(renderToStaticMarkup(<AccountLinkNote link="none" href={null} t={t} />)).not.toContain('href=');
  });
});

describe('/wallet/venue on another network (the room switches the wallet itself)', () => {
  it('a wallet on another network gets a Switch network button in the room; on the right one, nothing', () => {
    let switched = 0;
    const wrong = renderToStaticMarkup(
      <NetworkSwitch
        guard={{ ok: false, code: 'chain_mismatch', configured: 84532, observed: 421614 }}
        problem={null}
        onSwitch={() => switched++}
        t={t}
      />,
    );
    expect(wrong).toContain('Switch network');
    expect(wrong).toContain('data-venue-network="chain_mismatch"');
    expect(renderToStaticMarkup(<NetworkSwitch guard={{ ok: true }} problem={null} onSwitch={() => undefined} t={t} />)).toBe('');
    expect(renderToStaticMarkup(<NetworkSwitch guard={null} problem={null} onSwitch={() => undefined} t={t} />)).toBe('');
    const failed = renderToStaticMarkup(
      <NetworkSwitch
        guard={{ ok: false, code: 'chain_mismatch', configured: 84532, observed: 421614 }}
        problem="did not switch"
        onSwitch={() => undefined}
        t={t}
      />,
    );
    expect(failed).toContain('did not switch');
    expect(switched).toBe(0);
  });
});
