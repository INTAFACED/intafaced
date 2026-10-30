/**
 * What a notification says and where it goes. Pure functions, no React.
 *
 * The service's own `title` and `body` are used only when they are plain sentences. For the kinds this app knows
 * (fills, ended orders, verification, rank) the text is written here from the structured `params`, because the service's
 * body names a market by its internal id ("buy 0.00015 on 0f7bf12e-... at 64733.35"), which a person can't read.
 */
import { customerRoomHref, normalizePair } from '../../app/navigation';
import { isHiddenPath } from '../../app/feature-registry';
import { dec } from '../../data/decimal';
import { fmtAmount, fmtPrice } from '../../data/format';
import type { Preferences } from '../../shared/preferences';
import { stamp } from '../money/time';
import type { notifyCopy } from './copy';
import type { Notification } from './notify-api';

type Copy = Pick<typeof notifyCopy, 't'>;
export type NotifyIcon = 'fill' | 'ended' | 'verified' | 'rank' | 'bell';

export interface NotifyMarket {
  id: string;
  base: string;
  quote: string;
}

export interface Described {
  title: string;
  body: string;
  icon: NotifyIcon;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** "notify.trade.fill.title": a catalogue key the service could not turn into a sentence. */
const KEY = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/i;
const plain = (text: string) => text.trim() !== '' && !UUID.test(text) && !KEY.test(text.trim());

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function priceText(price: unknown, market: NotifyMarket): string | null {
  const value = text(price);
  if (value === null || dec(value) === null) return null;
  // Same as the trade desk: the number with no currency sign, then the quote coin.
  return `${fmtPrice(value, null)} ${market.quote}`;
}

const TERMINAL_TITLE = {
  cancelled: 'Order cancelled',
  rejected: 'Order rejected',
  expired: 'Order expired',
} as const;

export function describe(item: Notification, markets: ReadonlyMap<string, NotifyMarket>, copy: Copy): Described {
  const { t } = copy;
  const market = markets.get(text(item.params.marketId) ?? '');
  const side = item.params.side === 'sell' ? 'sell' : 'buy';
  const qty = text(item.params.qty);

  if (item.kind === 'trade.fill') {
    const price = market ? priceText(item.params.price, market) : null;
    const amount = qty !== null && dec(qty) !== null ? fmtAmount(qty) : null;
    const body =
      market && price && amount
        ? side === 'sell'
          ? t('Sold {amount} {asset} at {price}', { amount, asset: market.base, price })
          : t('Bought {amount} {asset} at {price}', { amount, asset: market.base, price })
        : side === 'sell'
          ? t('Your sell order was filled.')
          : t('Your buy order was filled.');
    return { title: t('Order filled'), body, icon: 'fill' };
  }

  if (item.kind === 'trade.order.terminal') {
    const status = text(item.params.status);
    const title = status && status in TERMINAL_TITLE ? t(TERMINAL_TITLE[status as keyof typeof TERMINAL_TITLE]) : t('Order update');
    const amount = qty !== null && dec(qty) !== null ? fmtAmount(qty) : null;
    let body = side === 'sell' ? t('Your sell order ended.') : t('Your buy order ended.');
    if (market && amount) {
      const price = priceText(item.params.price, market);
      body = price
        ? side === 'sell'
          ? t('Sell {amount} {asset} at {price}', { amount, asset: market.base, price })
          : t('Buy {amount} {asset} at {price}', { amount, asset: market.base, price })
        : side === 'sell'
          ? t('Sell {amount} {asset}', { amount, asset: market.base })
          : t('Buy {amount} {asset}', { amount, asset: market.base });
      const filled = text(item.params.filledQty);
      const filledValue = dec(filled);
      // Only a part-filled order says so; "nothing filled" is what a cancelled order already means.
      if (filled !== null && filledValue !== null && filledValue > 0n) body += ` · ${t('{amount} filled', { amount: fmtAmount(filled) })}`;
    }
    return { title, body, icon: 'ended' };
  }

  if (item.kind === 'identity.kyc.approved') return { title: t('Verification approved'), body: t('Verification body'), icon: 'verified' };
  if (item.kind === 'identity.rank.updated') return { title: t('Rank updated'), body: t('Rank body'), icon: 'rank' };

  return {
    title: plain(item.title) ? item.title.trim() : t('Account update'),
    body: plain(item.body) ? item.body.trim() : '',
    icon: 'bell',
  };
}

/** Whether a notification names an amount of money (a credited amount, a filled quantity): on a test build it is TEST. */
export function carriesFigure(item: Pick<Notification, 'params'>): boolean {
  return [item.params.amount, item.params.qty].some((value) => dec(text(value)) !== null);
}

/** Where each known kind opens. A fill is a trade; an ended order is an order. Anything else keeps the service's own link, if it is a live screen. */
const KIND_LINK: Readonly<Record<string, string>> = {
  'trade.fill': '/money/activity?tab=trades',
  'trade.order.terminal': '/money/activity?tab=orders',
  'identity.kyc.approved': '/verification',
  'identity.rank.updated': '/uc/account',
};

/**
 * Stored links with no live room of their own, each to the nearest live room (HM-notifications-01). Rows stored before
 * svc-notify moved its targets (#5435) are never rewritten, the detail rows IA-SPEC gives other modules open their room's
 * own detail or list, and a market named by its id (a halt, a price alert) opens that market's desk, or Markets when the
 * market is not known. Checked before the link's own address, since `/token/*` answers anything with "no customer route".
 */
/** One path segment, never `.` or `..`, which the URL would fold into the parent. */
const ID = '(?!\\.\\.?$)([^/?#\\\\]+)';
const STORED_LINK: readonly (readonly [RegExp, (id: string, markets?: ReadonlyMap<string, NotifyMarket>) => string])[] = [
  [new RegExp(`^/p2p/trades/${ID}$`), (id) => `/p2p/orders/${encodeURIComponent(decoded(id))}`],
  [/^\/settings\/verification$/, () => '/verification'],
  [/^\/profile\/rank$/, () => '/uc/account'],
  [new RegExp(`^/token/stakes/${ID}$`), () => '/token'],
  [new RegExp(`^/trade/futures/positions/${ID}$`), () => '/trade/futures'],
  [new RegExp(`^/bank/loans/${ID}$`), (id) => `/bank/loans/detail?loan=${encodeURIComponent(decoded(id))}`],
  [new RegExp(`^/agents/sessions/${ID}$`), () => '/agents'],
  [new RegExp(`^/(?:trade|markets)/(${UUID.source})$`, 'i'), (id, markets) => marketDesk(markets?.get(id))],
];

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?:[/?#]|$)/i;

const marketDesk = (market: NotifyMarket | undefined) =>
  market ? `/trade/spot/${normalizePair(`${market.base}-${market.quote}`)}` : '/trade';

/** The stored link's fallback room when it has one, else its own address if that is a customer room. */
function storedLink(href: string | null | undefined, markets?: ReadonlyMap<string, NotifyMarket>): string | undefined {
  // A `.` or `..` segment, plain or escaped, would fold into another room: no link at all.
  if (!href || DOT_SEGMENT.test(href)) return undefined;
  for (const [pattern, to] of STORED_LINK) {
    const match = pattern.exec(href);
    if (match) return customerRoomHref(to(match[1] ?? '', markets));
  }
  return customerRoomHref(href);
}

/** A live customer screen for this notification, or null (the row then just marks itself read). Never a hidden feature. */
export function linkFor(
  item: Pick<Notification, 'kind' | 'href'> & Partial<Pick<Notification, 'params'>>,
  markets?: ReadonlyMap<string, NotifyMarket>,
): string | null {
  let target = KIND_LINK[item.kind] ?? storedLink(item.href, markets);
  if (!target) return null;
  // A fill opens Trades filtered to the coin and on its own trade (`fill`), which Trades marks. Orders has no coin filter, so an ended order gets none.
  if (item.kind === 'trade.fill') {
    const market = markets?.get(text(item.params?.marketId) ?? '');
    if (market) target += `&asset=${encodeURIComponent(market.base)}`;
    const fill = text(item.params?.fillId);
    if (fill) target += `&fill=${encodeURIComponent(fill)}`;
  }
  return isHiddenPath(target.split('?')[0] ?? target) ? null : target;
}

/** "Just now", "5 min ago", "3 h ago", "Yesterday", then "14 Oct, 19:29" in the viewer's zone. An unreadable time shows "—". */
export function whenLabel(iso: string, now: number, zone: Preferences['timeZone'], copy: Copy): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return copy.t('Just now');
  if (minutes < 60) return copy.t('{count} min ago', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return copy.t('{count} h ago', { count: hours });
  if (hours < 48) return copy.t('Yesterday');
  return stamp(iso, zone, now);
}

/** The full date and time, for the hover title. */
export const fullTime = (iso: string, zone: Preferences['timeZone'], now: number) => stamp(iso, zone, now);
