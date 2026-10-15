import { useState } from 'react';
import { useResource, type Resource } from '../../../shared/resource';
import { Button, Field, Tabs } from '../../../shared/ui';
import { PayTime, PaySection } from '../components';
import { Gate, ListShell, MoreFooter, SelectField } from './components';
import { portalCopy } from './copy';
import { useCursorList, useUrlParam, type ListState } from './hooks';
import { isDecimalThreshold } from './model';
import { refusalText } from './refusal';
import type { PortalApi } from './api';
import { notificationKinds, type Notification, type NotificationKind, type Preference } from './schemas';

type View = 'feed' | 'preferences';

/** `/pay/notifications`: what needs your attention, and which kinds you want to see. In-app only: nothing is emailed or texted. */
export function Notifications({ portal }: { portal: PortalApi }) {
  const [view, setView] = useUrlParam('view', 'feed');
  const [kind, setKind] = useUrlParam('kind', '');
  const [unread, setUnread] = useUrlParam('unread', '');
  const feed = useCursorList(
    (cursor, s) => portal.notifications(cursor, unread === '1', kind, s),
    `portal:notifications:${unread}:${kind}`,
    (n) => n.notificationId,
  );
  const prefs = useResource((s) => portal.preferences(s), 'portal:notification-prefs');
  return (
    <NotificationsView
      portal={portal}
      view={view === 'preferences' ? 'preferences' : 'feed'}
      setView={setView}
      feed={feed.state}
      kind={kind}
      setKind={setKind}
      unreadOnly={unread === '1'}
      setUnreadOnly={(on) => setUnread(on ? '1' : '')}
      prefs={prefs.resource}
      loadMore={feed.loadMore}
      reload={() => feed.reload()}
      reloadPrefs={prefs.reload}
    />
  );
}

export function NotificationsView({
  portal,
  view,
  setView,
  feed,
  kind,
  setKind,
  unreadOnly,
  setUnreadOnly,
  prefs,
  loadMore,
  reload,
  reloadPrefs,
}: {
  portal: PortalApi;
  view: View;
  setView: (view: View) => void;
  feed: ListState<Notification>;
  kind: string;
  setKind: (value: string) => void;
  unreadOnly: boolean;
  setUnreadOnly: (on: boolean) => void;
  prefs: Resource<Preference[]>;
  loadMore: () => void;
  reload: () => void;
  reloadPrefs: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const [markState, setMarkState] = useState<'idle' | 'busy' | string>('idle');
  const unread = feed.status === 'ready' ? feed.items.filter((n) => n.readAt === null).length : 0;
  return (
    <div className="stack">
      <Tabs
        items={['feed', 'preferences']}
        value={view}
        onChange={(v) => setView(v as View)}
        label={t('notifViews')}
        labels={{ feed: t('tabFeed'), preferences: t('tabPreferences') }}
      />
      {view === 'feed' ? (
        <PaySection
          title={t('feedTitle')}
          description={t('feedBody')}
          action={
            <Button
              variant="secondary"
              disabled={markState === 'busy' || unread === 0}
              onClick={async () => {
                setMarkState('busy');
                const result = await portal.markAllRead();
                if (!result.ok) return setMarkState(refusalText(result));
                setMarkState('idle');
                reload();
              }}
            >
              {markState === 'busy' ? t('marking') : t('markAllRead')}
            </Button>
          }
        >
          {markState !== 'idle' && markState !== 'busy' && (
            <p className="error-text" role="alert">
              {markState}
            </p>
          )}
          <div className="pp-filter-row">
            <SelectField
              label={t('filterKind')}
              value={kind}
              onChange={setKind}
              options={[
                ['', t('filterAll')],
                ...notificationKinds.map((k) => [k, t(`notifKind_${k}` as 'notifKind_dispute_due')] as const),
              ]}
            />
            <label className="pp-check">
              <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
              {t('unreadOnly')}
            </label>
          </div>
          <ListShell
            state={feed}
            retry={reload}
            empty={{
              title: unreadOnly || kind ? t('feedNoMatchTitle') : t('feedEmptyTitle'),
              body: unreadOnly || kind ? t('feedNoMatchBody') : t('feedEmptyBody'),
            }}
          >
            {(rows) => (
              <>
                <ul className="pp-feed" aria-label={t('feedTitle')}>
                  {rows.map((n) => (
                    <FeedItem key={n.notificationId} n={n} portal={portal} reload={reload} />
                  ))}
                </ul>
                {feed.status === 'ready' && <MoreFooter state={feed} onMore={loadMore} />}
              </>
            )}
          </ListShell>
        </PaySection>
      ) : (
        <PaySection title={t('prefsTitle')} description={t('prefsBody')}>
          <p className="pp-callout" role="note">
            {t('inAppOnly')}
          </p>
          <Gate resource={prefs} retry={reloadPrefs} rows={4}>
            {(rows) => (
              <ul className="pp-prefs">
                {rows.map((p) => (
                  <PrefRow key={p.kind} pref={p} portal={portal} />
                ))}
              </ul>
            )}
          </Gate>
        </PaySection>
      )}
    </div>
  );
}

const subjectHref = (n: Notification): string | null => {
  if (!n.subjectId) return null;
  if (n.subjectType === 'dispute') return `/pay/disputes/${encodeURIComponent(n.subjectId)}`;
  if (n.subjectType === 'export') return '/pay/exports';
  return null;
};

function FeedItem({ n, portal, reload }: { n: Notification; portal: PortalApi; reload: () => void }) {
  const { t } = portalCopy.useCopy();
  const [error, setError] = useState('');
  const href = subjectHref(n);
  return (
    <li className={`pp-feed-item${n.readAt === null ? ' pp-feed-item--unread' : ''}`}>
      <span className="pp-feed-dot" aria-hidden="true" />
      <div className="pp-feed-main">
        <span className="pp-feed-kind">
          {t(`notifKind_${n.kind}` as 'notifKind_dispute_due')}
          {n.readAt === null && <span className="pp-sr"> ({t('unread')})</span>}
        </span>
        <strong>{n.title}</strong>
        {n.body && <p className="muted">{n.body}</p>}
        <small className="muted">
          <PayTime value={n.createdAt} />
        </small>
        {error && (
          <small className="error-text" role="alert">
            {error}
          </small>
        )}
      </div>
      <div className="pp-actions">
        {href && (
          <a className="text-link" href={href}>
            {t('open')}
          </a>
        )}
        {n.readAt === null && (
          <Button
            variant="ghost"
            onClick={async () => {
              const result = await portal.markRead([n.notificationId]);
              if (!result.ok) return setError(refusalText(result));
              reload();
            }}
          >
            {t('markRead')}
          </Button>
        )}
      </div>
    </li>
  );
}

function PrefRow({ pref, portal }: { pref: Preference; portal: PortalApi }) {
  const { t } = portalCopy.useCopy();
  const [on, setOn] = useState(pref.inApp);
  const [threshold, setThreshold] = useState(pref.threshold ?? '');
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | string>('idle');
  const hasThreshold = pref.kind === 'limit_threshold';
  const invalid = hasThreshold && threshold.trim() !== '' && !isDecimalThreshold(threshold);
  const dirty = on !== pref.inApp || (hasThreshold && threshold.trim() !== (pref.threshold ?? ''));
  const kind: NotificationKind = pref.kind;
  return (
    <li className="pp-pref">
      <div>
        <strong>{t(`notifKind_${kind}` as 'notifKind_dispute_due')}</strong>
        <p className="muted">{t(`notifHelp_${kind}` as 'notifHelp_dispute_due')}</p>
        {hasThreshold && (
          <Field
            label={t('fThreshold')}
            inputMode="decimal"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            hint={t('hThreshold')}
            error={invalid ? t('err_threshold') : undefined}
          />
        )}
      </div>
      <div className="pp-pref-controls">
        <label className="pp-check">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
          {t('inApp')}
        </label>
        <Button
          variant="secondary"
          disabled={!dirty || invalid || state === 'busy'}
          onClick={async () => {
            setState('busy');
            const result = await portal.setPreference({
              kind,
              inApp: on,
              ...(hasThreshold ? { threshold: threshold.trim() === '' ? null : threshold.trim() } : {}),
            });
            setState(result.ok ? 'saved' : refusalText(result));
          }}
        >
          {state === 'busy' ? t('saving') : t('save')}
        </Button>
        {state === 'saved' && (
          <small className="pp-confirmed" role="status">
            {t('saved')}
          </small>
        )}
        {state !== 'idle' && state !== 'busy' && state !== 'saved' && (
          <small className="error-text" role="alert">
            {state}
          </small>
        )}
      </div>
    </li>
  );
}
