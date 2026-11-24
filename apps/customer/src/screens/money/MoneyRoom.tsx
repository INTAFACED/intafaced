// volt-room: /money
import type { ReactNode } from 'react';
import { OverviewTemplate, type OverviewProps } from '@intafaced/ui/lit/templates';
import { useVenueMode } from '../../features/trade/use-venue-mode';
import { usePreferences } from '../../shared/preferences';
import { isHiddenPath } from './deps';
import Portfolio from './Portfolio';
import { WhereItSits } from './WhereItSits';
import { whereCopy } from './where-it-sits-copy';

/**
 * `/money`, Assets, on the Volt kit's overview template. With svc-trade's user-venue door on (the launch model, OWNER
 * 226), what the person holds is where it sits: their own wallet, read from the chain, and their venue account, read from
 * the venue (J-wallet-01). With the door off, and while its first answer is on its way, today's portfolio.
 */
export function MoneyRoom() {
  const venue = useVenueMode();
  if (venue.mode === 'on' && venue.status.available) return <WhereItSits status={venue.status} />;
  return <Portfolio />;
}

export type MoneyOverviewProps = Omit<OverviewProps, 'state' | 'mode'> & {
  /** Ready unless given: the room draws its own figures' states inside its regions. */
  state?: OverviewProps['state'];
  hero: ReactNode;
};

/** Links to the live Money helper rooms reachable from Assets on the hosted beta (J-wallet-01 #3 and #5). */
export function MoneyRoomLinks() {
  const { t } = whereCopy.useCopy();
  const links = [
    ...(!isHiddenPath('/bank/ramps/new') ? [{ href: '/bank/ramps/new', label: t('Add money') }] : []),
    ...(!isHiddenPath('/uc/assets') ? [{ href: '/uc/assets', label: t('Supported assets') }] : []),
  ];
  if (links.length === 0) return null;
  return (
    <div className="lt-actions">
      {links.map((link) => (
        <a key={link.href} className="lt-button lt-button-secondary" href={link.href}>
          {link.label}
        </a>
      ))}
    </div>
  );
}

/** The overview template as both views of `/money` use it: the person's Simple or Pro choice, and ready by default. */
export function MoneyOverview({ state = { kind: 'ready' }, ...props }: MoneyOverviewProps) {
  const { layoutMode } = usePreferences();
  return <OverviewTemplate {...props} state={state} mode={layoutMode === 'pro' ? 'pro' : 'simple'} />;
}
