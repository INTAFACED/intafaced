import { useEffect, useState } from 'react';
import type { PersonalPayApi } from '../pay-api';
import type { Trade } from '../schemas';
import { p2pChatCopy } from './p2p-chat-copy';
import { readUnreadCounts, type UnreadCount } from './p2p-chat-model';

/** How often the counts on a visible order list are read again. */
export const UNREAD_REFRESH_MS = 60_000;

/**
 * Which orders to read: every one once, and on the timer only those still open. A closed order's count changes only if
 * the other person writes after it closed, which the next visit to the list shows.
 */
export function unreadTargets(trades: ReadonlyArray<{ id: string; status: Trade['status'] }>): { all: string; open: string } {
  const ids = (list: ReadonlyArray<{ id: string }>) => [...new Set(list.map((trade) => trade.id))].sort().join(',');
  return { all: ids(trades), open: ids(trades.filter((trade) => trade.status !== 'released' && trade.status !== 'cancelled')) };
}

/**
 * Unread messages for each order shown, one `chat.unread` read per order, a few at a time. A count that could not be
 * read is reported as failed; it is never shown as zero.
 */
export function useUnreadCounts(
  pay: PersonalPayApi,
  trades: ReadonlyArray<{ id: string; status: Trade['status'] }>,
): Record<string, UnreadCount> {
  const { all, open } = unreadTargets(trades);
  const [counts, setCounts] = useState<Record<string, UnreadCount>>({});
  useEffect(() => {
    if (!all) return;
    let controller = new AbortController();
    const run = (key: string) => {
      if (!key) return;
      controller.abort();
      controller = new AbortController();
      void readUnreadCounts(
        (tradeId, abort) => pay.chatUnread(tradeId, abort),
        key.split(','),
        controller.signal,
        (tradeId, count) => setCounts((previous) => ({ ...previous, [tradeId]: count })),
      );
    };
    run(all);
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') run(open);
    }, UNREAD_REFRESH_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [pay, all, open]);
  return counts;
}

/** The "3 new" mark beside an order. Nothing for zero; a plain note when the count could not be read. */
export function UnreadBadge({ count }: { count: UnreadCount | undefined }) {
  const { t } = p2pChatCopy.useCopy();
  if (!count) return null;
  if (count.status === 'failed')
    return (
      <span className="p2p-unread p2p-unread--off" role="img" aria-label={t('unreadOff')} title={t('unreadOff')}>
        –
      </span>
    );
  if (count.count === 0) return null;
  return (
    <span className="p2p-unread" data-testid="unread-badge" role="img" aria-label={t('unreadLabel', { count: count.count })}>
      {t('unreadBadge', { count: count.count })}
    </span>
  );
}
