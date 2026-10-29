import type { MouseEvent } from 'react';
import { Award, Bell, CircleCheck, CircleX, ShieldCheck, type LucideIcon } from 'lucide-react';
import { usePreferences } from '../../shared/preferences';
import { isTestBuild } from '../../shared/test-build';
import { navigate, refusalCopy, StateBlock, StatusTag } from './deps';
import { notifyCopy } from './copy';
import type { Notification } from './notify-api';
import { carriesFigure, describe, fullTime, linkFor, whenLabel, type NotifyIcon, type NotifyMarket } from './notify-view';
import type { InboxState } from './use-notifications';

const ICONS: Record<NotifyIcon, LucideIcon> = { fill: CircleCheck, ended: CircleX, verified: ShieldCheck, rank: Award, bell: Bell };

/**
 * One notification, 72 px: type icon, title, one line of body, relative time and, while unread, a lime dot.
 * It is a link when the notification opens a live screen; otherwise a button that only marks it read.
 * `onOpen` is called for every click on an unread row (the caller marks it read).
 */
export function NotificationRow({
  item,
  markets,
  now,
  onOpen,
  onNavigate,
}: {
  item: Notification;
  markets: ReadonlyMap<string, NotifyMarket>;
  now: number;
  onOpen: (item: Notification) => void;
  /** Set by the popover: called with the destination before the app navigates, so it can close itself. */
  onNavigate?: (href: string) => void;
}) {
  const copy = notifyCopy.useCopy();
  const { timeZone } = usePreferences();
  const { title, body, icon } = describe(item, markets, copy);
  const Icon = ICONS[icon];
  const href = linkFor(item, markets);
  const unread = !item.readAt;
  const label = whenLabel(item.createdAt, now, timeZone, copy);
  const inner = (
    <>
      <span className="nf-icon" aria-hidden="true">
        <Icon size={18} strokeWidth={2} />
      </span>
      <span className="nf-text">
        <span data-testid="nf-title" className="nf-title">
          {title}
        </span>
        {body ? (
          <span data-testid="nf-body" className="nf-body">
            {body}
          </span>
        ) : null}
      </span>
      <span className="nf-meta">
        {/* On a test build every amount is TEST money, so a row that names one says so. */}
        {isTestBuild() && carriesFigure(item) ? <StatusTag data-testid="nf-test" status="pending" label={copy.t('TEST')} /> : null}
        <time dateTime={item.createdAt} title={fullTime(item.createdAt, timeZone, now)}>
          {label}
        </time>
        {unread ? (
          <span data-testid="nf-dot" className="nf-dot" role="img" aria-label={copy.t('Unread')} />
        ) : (
          <span className="nf-dot-gap" aria-hidden="true" />
        )}
      </span>
    </>
  );
  const handle = (event: MouseEvent) => {
    if (unread) onOpen(item);
    if (!href) return;
    onNavigate?.(href);
    // Popover only: it sits outside the page's own link handler, so a plain left-click goes there from here.
    if (onNavigate && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      navigate(href);
    }
  };
  return href ? (
    <a data-testid="nf-row" className="nf-row" data-unread={unread || undefined} href={href} onClick={handle}>
      {inner}
    </a>
  ) : (
    <button type="button" data-testid="nf-row" className="nf-row" data-unread={unread || undefined} onClick={handle}>
      {inner}
    </button>
  );
}

/** The failure state shared by the popover and the page: refused words from the data layer, or "Couldn't load" with Try again. */
export function InboxFailure({ state, onRetry }: { state: Extract<InboxState, { status: 'failed' }>; onRetry: () => void }) {
  const copy = notifyCopy.useCopy();
  const { failure } = state;
  if (failure.code && (failure.reason === 'forbidden' || failure.reason === 'error')) {
    const words = refusalCopy(failure.code);
    return <StateBlock kind="refused" title={words.title} body={words.body} code={words.reference} action={words.action} />;
  }
  return <StateBlock kind="error" title={copy.t('Couldn’t load your notifications.')} onRetry={onRetry} retryLabel={copy.t('Try again')} />;
}
