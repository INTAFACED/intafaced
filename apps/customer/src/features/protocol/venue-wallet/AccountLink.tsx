import { useMemo } from 'react';
import { ButtonLink } from '@intafaced/ui/lit';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { createVenueWalletApi, type VenueConnection } from './venue-wallet-api';
import { venueWalletCopy } from './venue-wallet-copy';

type T = ReturnType<typeof venueWalletCopy.useCopy>['t'];

/** Whether the account holds a signed connection for this browser wallet: the record svc-protocol keeps, never the page's. */
export type AccountLink = 'live' | 'expired' | 'blocked' | 'none';

/** The account's own record of this wallet. A live one past its expiry on this clock reads as expired. */
export function accountLinkOf(connections: readonly VenueConnection[], address: string, now: number): AccountLink {
  const found = connections.find((c) => c.address.toLowerCase() === address.toLowerCase());
  if (!found) return 'none';
  if (found.status === 'blocked') return 'blocked';
  if (found.status === 'expired' || Date.parse(found.expiresAt) <= now) return 'expired';
  return 'live';
}

/**
 * The line under a wallet connected in this browser: connected to the account, or not yet (and so given nothing, the
 * testnet grant included), with the one link to the signed connection on /wallet/venue. `href` null: that room is not in
 * this build, and the line says so with no dead link.
 */
export function AccountLinkNote({ link, href, t }: { link: AccountLink | 'unread'; href: string | null; t: T }) {
  if (link === 'live')
    return (
      <p className="lt-hint" data-account-link="live">
        {t('linkLive')}
      </p>
    );
  if (link === 'blocked')
    return (
      <p className="lt-refusal" data-account-link="blocked">
        {t('linkBlocked')}
      </p>
    );
  if (link === 'unread')
    return (
      <p className="lt-hint" data-account-link="unread">
        {t('linkUnread')}
      </p>
    );
  return (
    <div className="lt-stack lt-stack-tight" data-account-link={link}>
      <p className="lt-hint">{t(link === 'none' ? 'linkNone' : 'linkExpired')}</p>
      {href ? (
        <ButtonLink tone="primary" size="sm" href={href} data-testid="account-link-connect">
          {t(link === 'none' ? 'linkNoneAction' : 'linkExpiredAction')}
        </ButtonLink>
      ) : (
        <p className="lt-hint">{t('linkHidden')}</p>
      )}
    </div>
  );
}

/** The account-link line for a wallet connected in this browser, read from svc-protocol for the signed-in person. */
export function WalletAccountLink({ address, href }: { address: string; href: string | null }) {
  const { t } = venueWalletCopy.useCopy();
  const { api, userId } = useSession();
  const venue = useMemo(() => createVenueWalletApi(api), [api]);
  const { resource } = useResource((signal) => venue.status(signal), `venue-wallet:${userId ?? 'out'}`);
  if (!userId || resource.status === 'loading') return null;
  const link = resource.status === 'failed' ? 'unread' : accountLinkOf(resource.data.connections, address, Date.now());
  return <AccountLinkNote link={link} href={href} t={t} />;
}
