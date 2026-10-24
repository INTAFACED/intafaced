import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { currentReturnLocation, navigate } from '../../app/location';
import { safeReturnTo } from '../../app/navigation';
import { BOARD_SORTS, id, type BoardQuery } from './schemas';

export type P2PReturn = { href: string; kind: 'offer' | 'order' | 'offers' | 'orders' };
const offerPaths = new Set(['/p2p', '/uc/ad']);
/** Only public selection/filter references travel with this inspection. No
 * payment amounts, private terms, review state or authority are serialized. */
export function p2pReturn(candidate: string | null): P2PReturn {
  const fallback: P2PReturn = { href: '/p2p', kind: 'offers' };
  const safe = safeReturnTo(candidate);
  const url = new URL(safe, 'https://intafaced.invalid');
  const offer = offerPaths.has(url.pathname);
  if (!offer && url.pathname !== '/chat' && url.pathname !== '/uc/order') return fallback;
  const params = new URLSearchParams();
  const reference = offer ? 'offerId' : url.pathname === '/chat' && !url.searchParams.has('tradeId') ? 'id' : 'tradeId';
  for (const [key, value] of url.searchParams) {
    if (url.searchParams.getAll(key).length !== 1) continue;
    const valid =
      (key === reference && id.safeParse(value).success) ||
      (offer && key === 'asset' && /^[A-Z0-9._-]{1,16}$/.test(value)) ||
      (offer && key === 'fiatCurrency' && /^[A-Z]{3}$/.test(value)) ||
      (offer && key === 'side' && ['buy', 'sell'].includes(value)) ||
      (offer && key === 'limit' && ['50', '200'].includes(value)) ||
      (offer && key === 'makerId' && id.safeParse(value).success) ||
      (offer && key === 'methodId' && /^[A-Za-z0-9._-]{1,64}$/.test(value)) ||
      (offer && key === 'fiatAmount' && /^\d{1,18}(\.\d{1,18})?$/.test(value)) ||
      (offer && key === 'sort' && (BOARD_SORTS as readonly string[]).includes(value));
    if (valid) params.append(key, value);
  }
  if (url.pathname === '/chat' && !params.has(reference)) return fallback;
  const hash = /^#[A-Za-z0-9._:-]{1,128}$/.test(url.hash) ? url.hash : '';
  return {
    href: url.pathname + (params.size ? '?' + params.toString() : '') + hash,
    kind: params.has(reference) ? (offer ? 'offer' : 'order') : offer ? 'offers' : 'orders',
  };
}
export function offerReturn(offerId: string, filters: Partial<Record<keyof BoardQuery, string>>, limit: number) {
  const url = new URL(currentReturnLocation(), 'https://intafaced.invalid');
  for (const key of ['asset', 'fiatCurrency', 'side', 'methodId', 'fiatAmount', 'sort']) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offerId', offerId);
  return p2pReturn(url.pathname + url.search + url.hash);
}
export function CounterpartyLink({ userId, returnTo, children }: { userId: string; returnTo: P2PReturn; children: ReactNode }) {
  const current = useCurrentNavigation();
  const href = `/checkuser?userId=${encodeURIComponent(userId)}&returnTo=${encodeURIComponent(returnTo.href)}`;
  return (
    <a
      className="text-link"
      href={href}
      onClick={(event) => {
        if (!ordinaryClick(event)) return;
        event.preventDefault();
        if (!current()) return;
        // Add the public pointer to the departing history entry. The next
        // observed navigation retires the private view; Back mounts a fresh GET.
        history.replaceState(history.state, '', returnTo.href);
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
export function useCurrentNavigation() {
  const mounted = useRef(true);
  const href = location.href;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => mounted.current && location.href === href;
}
export function ordinaryClick(event: MouseEvent<HTMLAnchorElement>) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
let marketArrival: { owner: string | null; href: string } | undefined;
export function closeReturnedOffer(owner: string | null) {
  const url = new URL(location.href);
  url.searchParams.delete('offerId');
  const href = url.pathname + url.search + url.hash;
  marketArrival = { owner, href };
  navigate(href, true);
}
export function consumeMarketArrival(owner: string | null) {
  const matches = marketArrival?.owner === owner && marketArrival.href === currentReturnLocation();
  marketArrival = undefined;
  return matches;
}
