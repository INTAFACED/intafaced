import { Tabs } from '@intafaced/ui/lit/templates';
import { payCopy } from './copy';

/** The P2P rooms, in the order every P2P page lists them. An order's chat sits under Your orders. */
const P2P_ROOMS = [
  { href: '/p2p', key: 'offers' },
  { href: '/uc/order', key: 'yourOrders', match: ['/p2p/orders', '/chat'] },
  { href: '/uc/ad', key: 'yourOffers', match: ['/p2p/offers'] },
  { href: '/p2p/methods', key: 'paymentMethods' },
  { href: '/p2p/access', key: 'tradingAccess' },
] as const;

/**
 * The P2P section's tab bar, the kit's: the route's room lit, unless `current` names the room a page stands in for (an
 * order opened from the board, a member's record opened from an offer). `order` marks it on an order's own page.
 */
export function P2PTabs({ current, order = false }: { current?: string; order?: boolean }) {
  return (
    <div data-testid="p2p-rooms" data-order={order || undefined}>
      <Tabs
        label={payCopy.t('p2pRooms')}
        current={current}
        items={P2P_ROOMS.map(({ href, key, ...rest }) => ({ href, label: payCopy.t(key), ...rest }))}
      />
    </div>
  );
}
