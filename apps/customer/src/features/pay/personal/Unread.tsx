import { useEffect, useState } from 'react';
import type { PersonalPayApi } from '../pay-api';
import { p2pChatCopy } from './p2p-chat-copy';
import { readUnreadCounts, type UnreadCount } from './p2p-chat-model';

/** How often the counts on a visible order list are read again. */
export const UNREAD_REFRESH_MS = 60_000;

/**
 * Unread messages for each order shown, one `chat.unread` read per order, a few at a time. A count that could not be
 * read is reported as failed; it is never shown as zero.
 */
export function useUnreadCounts(pay: PersonalPayApi, tradeIds: readonly string[]): Record<string, UnreadCount> {
  const key = [...new Set(tradeIds)].sort().join(',');
  const [counts, setCounts] = useState<Record<string, UnreadCount>>({});
  useEffect(() => {
    if (!key) return;
    const ids = key.split(',');
    let controller = new AbortController();
    const run = () => {
      controller.abort();
      controller = new AbortController();
      const signal = controller.signal;
      void readUnreadCounts(
        (tradeId, abort) => pay.chatUnread(tradeId, abort),
        ids,
        signal,
        (tradeId, count) => setCounts((previous) => ({ ...previous, [tradeId]: count })),
      );
    };
    run();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') run();
    }, UNREAD_REFRESH_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [pay, key]);
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
