import { groups } from '../home-layout/groups';
import { personalRoomFor } from '../../personal/rooms/rooms';

/** The personal Pay pages (the rooms in `personal/rooms` count too). Every other /pay address is the business area, known or not, so a wrong address stays in the frame. */
const PERSONAL = new Set(['/pay', '/pay/send', '/pay/receive', '/pay/request', '/pay/bills', '/pay/global']);

/** A payer's hosted checkout carries a token or session in its address; without one, `/pay/checkout` is the merchant's checkout settings. */
function isPayerCheckout(): boolean {
  if (typeof location === 'undefined') return false;
  const query = new URLSearchParams(location.search);
  return query.has('token') || query.has('session');
}

/** The merchant portal pages: every business address except the payer-facing checkout. */
export function isMerchantArea(path: string): boolean {
  if (!path.startsWith('/pay/') || PERSONAL.has(path) || personalRoomFor(path)) return false;
  return path !== '/pay/checkout' || !isPayerCheckout();
}

/** The one menu item that matches this page: the longest address it equals or sits under. */
export function currentHref(path: string): string | undefined {
  let best: string | undefined;
  for (const group of groups)
    for (const [href, , options] of group.items) {
      const prefix = options?.match ?? href;
      if ((path === prefix || path.startsWith(`${prefix}/`)) && (best === undefined || prefix.length > best.length)) best = href;
    }
  return best;
}
