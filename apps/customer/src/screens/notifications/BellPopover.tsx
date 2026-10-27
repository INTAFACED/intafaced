import { useEffect, useRef, useState, type RefObject } from 'react';
import { Bell } from 'lucide-react';
import './notifications.css';
import { Button, Popover, PopoverContent, PopoverTitle, PopoverTrigger, StateBlock, navigate } from './deps';
import { notifyCopy } from './copy';
import { announceChange } from './notify-api';
import { InboxFailure, NotificationRow } from './NotificationRow';
import { useInbox, useMarketNames, useUnreadCount } from './use-notifications';

/** How many notifications the popover lists; the rest are one click away under "See all". */
export const POPOVER_ITEMS = 8;

/**
 * The bell in the top bar (UI-SPEC 5.12): the button with its unread badge, and a 400 px popover under it.
 *
 * Props: `path` is the current route; when it changes the unread count is read again (otherwise the count is polled every
 * 60 s). Render it only for a signed-in person and only while the registry says Notifications is live. It brings its own
 * button (`tb-icon-button tb-bell`, `tb-badge` from the shell's CSS), so the top bar passes nothing else. Errors show inside the
 * popover; if the count can't be read the bell simply has no badge.
 */
export function BellPopover({ path }: { path?: string }) {
  const copy = notifyCopy.useCopy();
  const unread = useUnreadCount();
  const [open, setOpen] = useState(false);
  const first = useRef(true);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    announceChange();
  }, [path]);
  const shown = unread && unread > 99 ? '99+' : unread;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<button type="button" />}
        data-testid="tb-bell"
        className="tb-icon-button tb-bell"
        aria-label={unread ? copy.t('Notifications, {count} unread', { count: shown ?? 0 }) : copy.t('Notifications')}
      >
        <Bell size={18} aria-hidden="true" />
        {unread ? (
          <span data-testid="tb-badge" className="tb-badge">
            {shown}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        data-testid="nf-pop"
        className="nf-pop w-[400px] max-w-[calc(100vw-16px)] p-0"
        initialFocus={inner}
      >
        <BellContent unread={unread ?? 0} onClose={() => setOpen(false)} innerRef={inner} />
      </PopoverContent>
    </Popover>
  );
}

function BellContent({ unread, onClose, innerRef }: { unread: number; onClose: () => void; innerRef: RefObject<HTMLDivElement | null> }) {
  const copy = notifyCopy.useCopy();
  const inbox = useInbox({ limit: POPOVER_ITEMS, unreadOnly: false });
  const markets = useMarketNames();
  const { state } = inbox;
  const anyUnread = state.status === 'ready' ? state.items.some((item) => !item.readAt) : unread > 0;
  const now = Date.now();
  return (
    // Focus starts on the popover itself (not on its last link), so Tab then goes down the list in order.
    <div className="nf-pop__inner" ref={innerRef} tabIndex={-1}>
      <div className="nf-pop__head">
        <PopoverTitle data-testid="nf-pop__title" className="nf-pop__title">
          {copy.t('Notifications')}
        </PopoverTitle>
        <Button variant="ghost" size={28} disabled={!anyUnread || state.status !== 'ready'} onClick={() => void inbox.readAll()}>
          {copy.t('Mark all as read')}
        </Button>
      </div>
      <div className="nf-pop__body">
        {state.status === 'loading' ? (
          <StateBlock kind="loading" rows={3} rowHeight={72} label={copy.t('Latest notifications')} className="nf-pop__loading" />
        ) : state.status === 'failed' ? (
          <InboxFailure state={state} onRetry={inbox.reload} />
        ) : state.items.length === 0 ? (
          <StateBlock kind="empty" title={copy.t("You're all caught up.")} body={copy.t('Caught up body')} />
        ) : (
          <ul className="nf-list" aria-label={copy.t('Latest notifications')}>
            {state.items.slice(0, POPOVER_ITEMS).map((item) => (
              <li key={item.id}>
                <NotificationRow item={item} markets={markets} now={now} onOpen={(row) => inbox.read(row.id)} onNavigate={onClose} />
              </li>
            ))}
          </ul>
        )}
        {inbox.actionFailed && state.status === 'ready' ? (
          <p className="nf-pop__note" role="alert">
            {copy.t('Couldn’t update your notifications.')}
          </p>
        ) : null}
      </div>
      <div className="nf-pop__foot">
        <a
          data-testid="nf-pop__all"
          className="nf-pop__all"
          href="/notifications"
          onClick={(event) => {
            onClose();
            if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
              event.preventDefault();
              navigate('/notifications');
            }
          }}
        >
          {copy.t('See all')}
        </a>
      </div>
    </div>
  );
}
