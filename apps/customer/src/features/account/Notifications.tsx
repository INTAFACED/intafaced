import { Fragment, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { customerRoomHref } from '../../app/navigation';
import { useResource, type Resource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, EmptyState, Failure, Loading, Page } from '../../shared/ui';
import { useSession } from '../session/session';
import { notificationsCopy as copy } from './notifications-copy';
import { NotificationTargets } from './NotificationTargets';
import './notifications.css';

const date = z.string().datetime({ offset: true });
const notification = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  titleKey: z.string(),
  bodyKey: z.string(),
  title: z.string(),
  body: z.string(),
  href: z.string().nullable(),
  severity: z.enum(['info', 'action', 'critical']),
  readAt: date.nullable(),
  createdAt: date,
});
const channel = z.enum(['inapp', 'email', 'push', 'sms']);
const outOfApp = z.enum(['email', 'push', 'sms']);
const unique = <T extends { channel: string }>(rows: T[]) => new Set(rows.map((row) => row.channel)).size === rows.length;
const preference = z.object({ channel: outOfApp, muted: z.boolean() });
const preferences = z.array(preference).max(3).refine(unique, 'Duplicate notification preferences');
const channels = z
  .array(
    z.object({
      channel,
      configured: z.boolean(),
      available: z.boolean(),
      reason: z.string().nullable(),
      requires: z.array(z.string()),
      socket: z.string().nullable(),
    }),
  )
  .max(4)
  .refine(unique, 'Duplicate notification channels');
const targets = z
  .array(z.object({ channel: outOfApp, address: z.string().min(1), locale: z.string(), verifiedAt: date.nullable() }))
  .max(3)
  .refine(unique, 'Duplicate notification targets');
const deliveries = z
  .array(
    z.object({
      channel,
      status: z.enum(['pending', 'accepted', 'refused', 'failed', 'abandoned']),
      attempts: z.number().int().nonnegative(),
      attemptedAt: date.nullable(),
      acceptedAt: date.nullable(),
      refusalCode: z.string().nullable(),
    }),
  )
  .max(4)
  .refine(unique, 'Duplicate notification delivery channels');
type Notification = z.infer<typeof notification>;
type OutOfApp = z.infer<typeof outOfApp>;

function Read<T>({ resource, retry, children }: { resource: Resource<T>; retry: () => void; children: (data: T) => React.ReactNode }) {
  return resource.status === 'loading' ? (
    <Loading />
  ) : resource.status === 'failed' ? (
    <div lang="und">
      <Failure result={resource.failure} retry={retry} />
    </div>
  ) : (
    children(resource.data)
  );
}

/** Account keys remount local selection/actions before another owner's data can appear. */
export function Notifications() {
  const { userId } = useSession();
  return userId ? <NotificationRoom key={userId} userId={userId} /> : null;
}

function NotificationRoom({ userId }: { userId: string }) {
  const { api } = useSession();
  const { t, Copy, requestedLocale, languageFor } = copy.useCopy();
  const [cursor, setCursor] = useState<string | undefined>();
  const [unread, setUnread] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [readCycle, setReadCycle] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiResult<{ marked: number }> | null>(null);
  const running = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const inbox = useResource(
    (signal) =>
      api.query(
        'notify',
        'notify.list',
        { limit: 50, ...(cursor ? { cursor } : {}), unreadOnly: unread },
        z
          .object({ items: z.array(notification).max(50), nextCursor: z.string().guid().nullable() })
          .refine(
            (data) =>
              data.items.every((row) => row.userId === userId) &&
              new Set(data.items.map((row) => row.id)).size === data.items.length &&
              (!cursor || data.nextCursor !== cursor),
            'Inbox ownership, IDs or continuation are invalid',
          ),
        { signal },
      ),
    `notifications:${userId}:${cursor}:${unread}:${readCycle}`,
  );
  const selectedRow = inbox.resource.status === 'ready' ? inbox.resource.data.items.find((row) => row.id === selected) : undefined;
  function refresh() {
    setReadCycle((cycle) => cycle + 1);
    setResult(null);
  }
  async function mark(id: string) {
    if (
      running.current ||
      (result?.ok === false && result.reason === 'uncertain') ||
      inbox.resource.status !== 'ready' ||
      !inbox.resource.data.items.some((row) => row.id === id && row.userId === userId && !row.readAt)
    )
      return;
    running.current = true;
    setBusy(true);
    const outcome = await api.mutate('notify', 'notify.markRead', { ids: [id] }, z.object({ marked: z.number().int().min(0).max(1) }));
    running.current = false;
    if (!mounted.current) return;
    setBusy(false);
    setResult(outcome);
    if (outcome.ok) setReadCycle((cycle) => cycle + 1);
  }
  const uncertain = result?.ok === false && result.reason === 'uncertain';
  return (
    <div lang={languageFor('title')}>
      <Page eyebrow={<Copy k="personal" />} title={<Copy k="title" />} description={<Copy k="description" />}>
        <div className="notifications-layout">
          <section aria-label={t('inbox')}>
            <header className="notifications-section-heading">
              <h2>
                <Copy k="inbox" />
              </h2>
              <div className="actions">
                <Button
                  variant="secondary"
                  aria-pressed={unread}
                  onClick={() => {
                    setUnread(!unread);
                    setCursor(undefined);
                  }}
                >
                  <Copy k={unread ? 'showAll' : 'unreadOnly'} />
                </Button>
                <Button variant="ghost" onClick={refresh} disabled={busy}>
                  <Copy k="refreshInbox" />
                </Button>
              </div>
            </header>
            {result &&
              (result.ok ? (
                <p className="notice" role="status">
                  <Copy k={result.data.marked ? 'marked' : 'unchanged'} />
                </p>
              ) : (
                <div lang="und">
                  <Failure result={result} />
                </div>
              ))}
            <Read resource={inbox.resource} retry={refresh}>
              {(data) =>
                data.items.length ? (
                  data.items.map((item) => (
                    <Fragment key={item.id}>
                      <article
                        data-testid="notifications-item"
                        className={`notifications-item ${item.readAt ? 'read' : 'unread'}`}
                        lang="und"
                        aria-labelledby={`notification-title-${item.id}`}
                      >
                        <div className="notifications-meta" lang={languageFor('unread')}>
                          <span>
                            <Copy k={item.severity} /> · <Copy k={item.readAt ? 'read' : 'unread'} />
                          </span>
                          <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(requestedLocale)}</time>
                        </div>
                        <h3 id={`notification-title-${item.id}`} lang="und">
                          {!item.title || item.title === item.titleKey ? <Copy k="titleAbsent" /> : item.title}
                        </h3>
                        <p lang="und">{!item.body || item.body === item.bodyKey ? <Copy k="bodyAbsent" /> : item.body}</p>
                        <div className="actions" lang={languageFor('inspect')}>
                          {customerRoomHref(item.href) && (
                            <a className="text-link" href={customerRoomHref(item.href)}>
                              <Copy k="related" />
                            </a>
                          )}
                          {!item.readAt && (
                            <Button variant="ghost" disabled={busy || uncertain} onClick={() => void mark(item.id)}>
                              <Copy k={busy ? 'marking' : 'markRead'} />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            aria-expanded={selected === item.id}
                            onClick={() => setSelected(selected === item.id ? null : item.id)}
                          >
                            <Copy k={selected === item.id ? 'hideDelivery' : 'inspect'} />
                          </Button>
                        </div>
                      </article>
                      {selected === item.id && <DeliveryDetails key={`${item.id}:${cursor}:${unread}:${readCycle}`} item={item} />}
                    </Fragment>
                  ))
                ) : (
                  <EmptyState title={<Copy k="empty" />}>
                    <Copy k="emptyBody" />
                  </EmptyState>
                )
              }
            </Read>
            {selected && !selectedRow && (
              <section className="notifications-selection" aria-label={t('selection')}>
                <h3>
                  <Copy k="selection" />
                </h3>
                <p className="muted">
                  <Copy k="selectedId" />
                </p>
                <p className="numeric" lang="zxx">
                  {selected}
                </p>
                <p>
                  <Copy k="selectionMissing" />
                </p>
                <Button variant="secondary" onClick={refresh} disabled={busy}>
                  <Copy k="refreshInbox" />
                </Button>
              </section>
            )}
            <p className="muted">
              <Copy k="window" />
            </p>
            <div className="notifications-controls">
              {inbox.resource.status === 'ready' && inbox.resource.data.nextCursor && (
                <Button
                  variant="secondary"
                  onClick={() => setCursor(inbox.resource.status === 'ready' ? (inbox.resource.data.nextCursor ?? undefined) : undefined)}
                >
                  <Copy k="next" />
                </Button>
              )}
              {cursor && (
                <Button variant="ghost" onClick={() => setCursor(undefined)}>
                  <Copy k="latest" />
                </Button>
              )}
            </div>
          </section>
          <NotificationSettings userId={userId} />
        </div>
      </Page>
    </div>
  );
}

function DeliveryDetails({ item }: { item: Notification }) {
  const { api } = useSession();
  const { t, Copy, requestedLocale } = copy.useCopy();
  const records = useResource(
    (signal) => api.query('notify', 'notify.deliveries', { notificationId: item.id }, deliveries, { signal }),
    `deliveries:${item.userId}:${item.id}`,
  );
  return (
    <section className="notifications-delivery" aria-label={t('delivery')}>
      <h4>
        <Copy k="delivery" />
      </h4>
      <p className="muted">
        <Copy k="selectedId" />:{' '}
        <span className="numeric" lang="zxx">
          {item.id}
        </span>
      </p>
      <p className="muted">
        <Copy k="deliveryMeaning" />
      </p>
      <Read resource={records.resource} retry={records.reload}>
        {(rows) =>
          rows.length ? (
            <ol>
              {rows.map((row) => (
                <li key={row.channel}>
                  <strong>
                    <Copy k={row.channel} />
                  </strong>
                  <div>
                    <span>
                      <Copy k={row.status} /> ·{' '}
                      {row.attempts === 1 ? <Copy k="oneAttempt" /> : <Copy k="attempts" params={{ count: row.attempts }} />}
                    </span>
                    {row.attemptedAt && (
                      <time dateTime={row.attemptedAt}>
                        <Copy k="attemptedAt" />: {new Date(row.attemptedAt).toLocaleString(requestedLocale)}
                      </time>
                    )}
                    {row.acceptedAt && (
                      <time dateTime={row.acceptedAt}>
                        <Copy k="acceptedAt" />: {new Date(row.acceptedAt).toLocaleString(requestedLocale)}
                      </time>
                    )}
                    {row.refusalCode && (
                      <span className="notifications-reason">
                        <Copy k="reason" />: <span lang="zxx">{row.refusalCode}</span>
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title={<Copy k="deliveryEmpty" />}>
              <Copy k="deliveryEmptyBody" />
            </EmptyState>
          )
        }
      </Read>
      <Button variant="ghost" onClick={records.reload}>
        <Copy k="refreshDelivery" />
      </Button>
    </section>
  );
}

function NotificationSettings({ userId }: { userId: string }) {
  const { api } = useSession();
  const { t, Copy } = copy.useCopy();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<OutOfApp | null>(null);
  const [blocked, setBlocked] = useState<{ channel: OutOfApp; revision: number } | null>(null);
  const [result, setResult] = useState<ApiResult<z.infer<typeof preferences>> | null>(null);
  const [confirmed, setConfirmed] = useState<{ channel: OutOfApp; muted: boolean } | null>(null);
  const [readNote, setReadNote] = useState(false);
  const running = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const status = useResource(
    (signal) => api.query('notify', 'notify.channels', undefined, channels, { signal }),
    `notification-channels:${userId}:${revision}`,
  );
  const target = useResource(
    (signal) => api.query('notify', 'notify.targets', undefined, targets, { signal }),
    `notification-targets:${userId}:${revision}`,
  );
  const prefs = useResource(
    (signal) => api.query('notify', 'notify.mutePrefs', undefined, preferences, { signal }),
    `notification-preferences:${userId}:${revision}`,
  );
  useEffect(() => {
    if (blocked && revision > blocked.revision && prefs.resource.status === 'ready') {
      setBlocked(null);
      setResult(null);
      setReadNote(true);
    }
  }, [blocked, revision, prefs.resource]);
  function refresh() {
    setRevision((value) => value + 1);
    setConfirmed(null);
    setReadNote(false);
  }
  async function change(channel: OutOfApp, muted: boolean) {
    if (running.current || blocked || prefs.resource.status !== 'ready' || !prefs.resource.data.some((row) => row.channel === channel))
      return;
    running.current = true;
    setBusy(channel);
    setConfirmed(null);
    setReadNote(false);
    setResult(null);
    const outcome = await api.mutate(
      'notify',
      'notify.setMute',
      { channel, muted },
      preferences.refine(
        (rows) => rows.some((row) => row.channel === channel && row.muted === muted),
        'Returned preference does not match the requested setting',
      ),
    );
    running.current = false;
    if (!mounted.current) return;
    setBusy(null);
    setResult(outcome);
    if (outcome.ok) {
      setConfirmed({ channel, muted });
      prefs.reload();
    } else if (outcome.reason === 'uncertain') setBlocked({ channel, revision });
  }
  return (
    <section className="notifications-settings" aria-label={t('settings')}>
      <header className="notifications-section-heading">
        <h2>
          <Copy k="settings" />
        </h2>
      </header>
      <p className="muted">
        <Copy k="policy" />
      </p>
      {blocked && (
        <div className="notice" role="alert">
          <h3>
            <Copy k="unconfirmed" params={{ channel: t(blocked.channel) }} />
          </h3>
          <p>
            <Copy k="recheck" />
          </p>
        </div>
      )}
      {result && !result.ok && (
        <div lang="und">
          <Failure result={result} />
        </div>
      )}
      {confirmed && (
        <p className="notice" role="status">
          <Copy k={confirmed.muted ? 'confirmedMute' : 'confirmedUnmute'} params={{ channel: t(confirmed.channel) }} />
        </p>
      )}
      {readNote && (
        <p className="notice" role="status">
          <Copy k="readCurrent" />
        </p>
      )}
      <Read resource={prefs.resource} retry={refresh}>
        {(values) => (
          <div>
            {(['email', 'push', 'sms'] as const).map((id) => {
              const preference = values.find((row) => row.channel === id);
              return (
                <section key={id} className="notifications-channel" aria-label={t(id)}>
                  <div className="notifications-channel-heading">
                    <h3>
                      <Copy k={id} />
                    </h3>
                    <Button
                      variant="secondary"
                      disabled={!preference || Boolean(busy) || Boolean(blocked)}
                      aria-pressed={preference?.muted}
                      onClick={() => preference && void change(id, !preference.muted)}
                    >
                      {preference ? (
                        <Copy k={busy === id ? 'saving' : preference.muted ? 'unmute' : 'mute'} params={{ channel: t(id) }} />
                      ) : (
                        <Copy k="preferenceAbsent" />
                      )}
                    </Button>
                  </div>
                  <p className="muted">
                    <Copy k={preference ? (preference.muted ? 'muted' : 'unmuted') : 'preferenceAbsent'} />
                  </p>
                  <Read resource={status.resource} retry={refresh}>
                    {(rows) => {
                      const row = rows.find((item) => item.channel === id);
                      return (
                        <p className="muted">
                          <Copy
                            k={!row ? 'channelAbsent' : !row.configured ? 'notConnected' : row.available ? 'available' : 'configured'}
                          />
                        </p>
                      );
                    }}
                  </Read>
                  <Read resource={target.resource} retry={refresh}>
                    {(rows) => {
                      const row = rows.find((item) => item.channel === id);
                      return (
                        <p className="muted notifications-target">
                          {row ? (
                            <>
                              <Copy k={row.verifiedAt ? 'targetVerified' : 'targetUnverified'} /> ·{' '}
                              {id === 'push' ? <Copy k="device" /> : <span lang="zxx">{row.address}</span>}
                            </>
                          ) : (
                            <Copy k="targetAbsent" />
                          )}
                        </p>
                      );
                    }}
                  </Read>
                </section>
              );
            })}
          </div>
        )}
      </Read>
      <div className="notifications-controls">
        <Button variant="ghost" disabled={Boolean(busy)} onClick={refresh}>
          <Copy k="refreshSettings" />
        </Button>
      </div>
      <NotificationTargets userId={userId} revision={revision} onChanged={refresh} />
    </section>
  );
}
