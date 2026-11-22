import { Button } from '@intafaced/ui/lit';
import { Award, Bell, CircleCheck, CircleX, ShieldCheck, type LucideIcon } from 'lucide-react';
import { usePreferences } from '../../shared/preferences';
import { isTestBuild } from '../../shared/test-build';
import { notifyCopy } from './copy';
import { refusalCopy } from './data';
import type { Notification } from './notify-api';
import { carriesFigure, describe, fullTime, linkFor, whenLabel, type NotifyIcon, type NotifyMarket } from './notify-view';
import { LoadFailed, Refused } from './parts';
import type { InboxState } from './use-notifications';

const ICONS: Record<NotifyIcon, LucideIcon> = { fill: CircleCheck, ended: CircleX, verified: ShieldCheck, rank: Award, bell: Bell };

/**
 * One notification in the centre's inbox, drawn with the Volt kit: type icon, title, one line of body, relative time and,
 * while unread, a dot. It is a link when the notification opens a live screen; otherwise a button that only marks it read.
 * `onOpen` is called for every click on an unread row (the caller marks it read). The bell and Home draw the same
 * notification with `NotificationRow`, on their own kit.
 */
export function InboxRow({
  item,
  markets,
  now,
  onOpen,
}: {
  item: Notification;
  markets: ReadonlyMap<string, NotifyMarket>;
  now: number;
  onOpen: (item: Notification) => void;
}) {
  const copy = notifyCopy.useCopy();
  const { timeZone } = usePreferences();
  const { title, body, icon } = describe(item, markets, copy);
  const Icon = ICONS[icon];
  const href = linkFor(item, markets);
  const unread = !item.readAt;
  const label = whenLabel(item.createdAt, now, timeZone, copy);
  const inner = (
    <span className="lt-actions">
      <span aria-hidden="true">
        <Icon size={18} strokeWidth={2} />
      </span>
      <span className="lt-lines">
        <span data-testid="nf-title">{title}</span>
        {body ? <span data-testid="nf-body">{body}</span> : null}
      </span>
      <span className="lt-actions">
        <TestFigureTag item={item} />
        <time dateTime={item.createdAt} title={fullTime(item.createdAt, timeZone, now)}>
          {label}
        </time>
        {unread ? <span data-testid="nf-dot" className="lt-chip-mark" role="img" aria-label={copy.t('Unread')} /> : null}
      </span>
    </span>
  );
  const handle = () => {
    if (unread) onOpen(item);
  };
  return href ? (
    <a data-testid="nf-row" className="lt-row-link" data-unread={unread || undefined} href={href} onClick={handle}>
      {inner}
    </a>
  ) : (
    <Button tone="quiet" block data-testid="nf-row" data-unread={unread || undefined} onClick={handle}>
      {inner}
    </Button>
  );
}

/** On a test build every amount is TEST money, so a notification that names one says so (inbox and delivery log). */
export function TestFigureTag({ item }: { item: Pick<Notification, 'params'> }) {
  const copy = notifyCopy.useCopy();
  return isTestBuild() && carriesFigure(item) ? (
    <span data-testid="nf-test" data-status="test" className="lt-test">
      {copy.t('TEST')}
    </span>
  ) : null;
}

/** The inbox's failure: refused words from the data layer, or "Couldn't load" with Try again (as the bell's InboxFailure). */
export function InboxFailure({ state, onRetry }: { state: Extract<InboxState, { status: 'failed' }>; onRetry: () => void }) {
  const copy = notifyCopy.useCopy();
  const { failure } = state;
  if (failure.code && (failure.reason === 'forbidden' || failure.reason === 'error')) {
    const words = refusalCopy(failure.code);
    return <Refused title={words.title} body={words.body} code={words.reference} action={words.action} />;
  }
  return <LoadFailed title={copy.t('Couldn’t load your notifications.')} onRetry={onRetry} retryLabel={copy.t('Try again')} />;
}
