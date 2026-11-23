import type { MouseEvent } from 'react';
import { Award, Bell, CircleCheck, CircleX, ShieldCheck, type LucideIcon } from 'lucide-react';
import { usePreferences } from '../../shared/preferences';
import { isTestBuild } from '../../shared/test-build';
import { Button } from '@intafaced/ui/lit';
import { navigate, refusalCopy } from './data';
import { notifyCopy } from './copy';
import type { Notification } from './notify-api';
import { carriesFigure, describe, fullTime, linkFor, whenLabel, type NotifyIcon, type NotifyMarket } from './notify-view';
import type { InboxState } from './use-notifications';

const ICONS: Record<NotifyIcon, LucideIcon> = { fill: CircleCheck, ended: CircleX, verified: ShieldCheck, rank: Award, bell: Bell };

/**
 * One notification, drawn from the Volt kit wherever it shows (the inbox, the bell, Home): type icon, title, one line of
 * body, relative time and, while unread, a dot.
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
      <span aria-hidden="true">
        <Icon size={18} strokeWidth={2} />
      </span>
      <span className="lt-lines">
        <span data-testid="nf-title">{title}</span>
        {body ? (
          <span data-testid="nf-body" className="lt-hint">
            {body}
          </span>
        ) : null}
      </span>
      <span className="lt-actions">
        <TestFigureTag item={item} />
        <time className="lt-hint" dateTime={item.createdAt} title={fullTime(item.createdAt, timeZone, now)}>
          {label}
        </time>
        {unread ? (
          <span data-testid="nf-dot" className="lt-chip" data-status="done" role="img" aria-label={copy.t('Unread')}>
            <span className="lt-chip-mark" aria-hidden="true" />
          </span>
        ) : null}
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
    <a data-testid="nf-row" className="lt-row-link" data-unread={unread || undefined} href={href} onClick={handle}>
      {inner}
    </a>
  ) : (
    <Button tone="quiet" data-testid="nf-row" data-unread={unread || undefined} onClick={handle}>
      {inner}
    </Button>
  );
}

/** On a test build every amount is TEST money, so a notification that names one says so (inbox and delivery log). */
function TestFigureTag({ item }: { item: Pick<Notification, 'params'> }) {
  const copy = notifyCopy.useCopy();
  return isTestBuild() && carriesFigure(item) ? (
    <span data-testid="nf-test" className="lt-test" data-slot="status-tag" data-status="test">
      {copy.t('TEST')}
    </span>
  ) : null;
}

/** The failure state shared by the popover and the page: refused words from the data layer, or "Couldn't load" with Try again. */
export function InboxFailure({ state, onRetry }: { state: Extract<InboxState, { status: 'failed' }>; onRetry: () => void }) {
  const copy = notifyCopy.useCopy();
  const { failure } = state;
  if (failure.code && (failure.reason === 'forbidden' || failure.reason === 'error')) {
    const words = refusalCopy(failure.code);
    return (
      <div data-slot="state-block" data-kind="refused" className="lt-refusal" data-refusal="refused">
        <p className="lt-refusal-title">{words.title}</p>
        <p className="lt-refusal-body">{words.body}</p>
        {words.action ? (
          <a className="lt-button lt-button-secondary" href={words.action.href}>
            {words.action.label}
          </a>
        ) : null}
        {words.reference ? <p className="lt-ref">{words.reference}</p> : null}
      </div>
    );
  }
  return (
    <div data-slot="state-block" data-kind="error" role="alert" className="lt-refusal" data-refusal="unreachable">
      <p className="lt-refusal-title">{copy.t('Couldn’t load your notifications.')}</p>
      <Button tone="secondary" onClick={onRetry}>
        {copy.t('Try again')}
      </Button>
    </div>
  );
}
