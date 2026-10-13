import { useEffect, useState } from 'react';
import './notifications.css';
import { Button, StateBlock, Tabs, TabsList, TabsTab } from './deps';
import { notifyCopy } from './copy';
import { useSession } from '../../features/session/session';
import { availableChannels, channelStatus } from './notify-api';
import { InboxFailure, NotificationRow } from './NotificationRow';
import { useInbox, useMarketNames } from './use-notifications';

type Tab = 'all' | 'unread';
const PAGE = 20;

/** Out-of-app channels the service can really send through. Empty (or still loading) means there is nothing to set up, so no settings link. */
function useHasChannels(): boolean {
  const { api, userId } = useSession();
  const [has, setHas] = useState(false);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void channelStatus(api, controller.signal).then((result) => {
      if (!controller.signal.aborted) setHas(result.ok && availableChannels(result.data).length > 0);
    });
    return () => controller.abort();
  }, [api, userId]);
  return has;
}

export default function NotificationsPage() {
  const copy = notifyCopy.useCopy();
  const [tab, setTab] = useState<Tab>('all');
  const inbox = useInbox({ limit: PAGE, unreadOnly: tab === 'unread' });
  const markets = useMarketNames();
  const hasChannels = useHasChannels();
  const { state } = inbox;
  const now = Date.now();
  const anyUnread = state.status === 'ready' && state.items.some((item) => !item.readAt);
  return (
    <div className="if-notify">
      <div className="nf-head">
        <h1 className="nf-h1">{copy.t('Notifications')}</h1>
        <div className="nf-head__actions">
          {hasChannels ? (
            <a className="nf-link" href="/notifications?view=settings">
              {copy.t('Notification settings')}
            </a>
          ) : null}
          <Button variant="secondary" size={32} disabled={!anyUnread} onClick={() => void inbox.readAll()}>
            {copy.t('Mark all as read')}
          </Button>
        </div>
      </div>
      <Tabs value={tab} onValueChange={(next) => setTab(next === 'unread' ? 'unread' : 'all')}>
        <TabsList divider aria-label={copy.t('Notification filters')} className="nf-tabs">
          <TabsTab value="all">{copy.t('All')}</TabsTab>
          <TabsTab value="unread">{copy.t('Unread')}</TabsTab>
        </TabsList>
      </Tabs>
      <section className="nf-card" aria-label={copy.t('Notification list')} aria-busy={state.status === 'loading' || undefined}>
        {state.status === 'loading' ? (
          <StateBlock kind="loading" rows={5} rowHeight={72} label={copy.t('Notification list')} className="nf-card__loading" />
        ) : state.status === 'failed' ? (
          <InboxFailure state={state} onRetry={inbox.reload} />
        ) : state.items.length === 0 ? (
          <StateBlock
            kind="empty"
            title={copy.t("You're all caught up.")}
            body={copy.t(tab === 'unread' ? 'Nothing unread body' : 'Caught up body')}
          />
        ) : (
          <ul className="nf-list">
            {state.items.map((item) => (
              <li key={item.id}>
                <NotificationRow item={item} markets={markets} now={now} onOpen={(row) => inbox.read(row.id)} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {inbox.actionFailed ? (
        <p className="nf-note" role="alert">
          {copy.t('Couldn’t update your notifications.')}
        </p>
      ) : null}
      {state.status === 'ready' && state.nextCursor ? (
        <div className="nf-more">
          <Button variant="secondary" size={40} loading={inbox.loadingMore} onClick={inbox.loadMore}>
            {copy.t('Load more')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
