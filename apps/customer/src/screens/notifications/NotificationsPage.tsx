import { useState } from 'react';
import './notifications.css';
import { Button, StateBlock, Tabs, TabsList, TabsTab } from './deps';
import { notifyCopy } from './copy';
import { centreCopy } from './centre-copy';
import { NotifyNav } from './NotifyNav';
import { CATEGORIES, categoryOf, type Category } from './prefs';
import { InboxFailure, NotificationRow } from './NotificationRow';
import { useInbox, useMarketNames } from './use-notifications';

type Tab = 'all' | 'unread';
type Topic = 'all' | Category;
const TOPIC = {
  all: 'topicAll',
  trading: 'topicTrading',
  p2p: 'topicP2p',
  account: 'topicAccount',
  money: 'topicMoney',
  token: 'topicToken',
  agents: 'topicAgents',
} as const satisfies Record<Topic, string>;
const PAGE = 20;

export default function NotificationsPage() {
  const copy = notifyCopy.useCopy();
  const [tab, setTab] = useState<Tab>('all');
  const inbox = useInbox({ limit: PAGE, unreadOnly: tab === 'unread' });
  const markets = useMarketNames();
  const centre = centreCopy.useCopy();
  const [topic, setTopic] = useState<Topic>('all');
  const { state } = inbox;
  const now = Date.now();
  const present = new Set(state.status === 'ready' ? state.items.map((item) => categoryOf(item.kind)) : []);
  const shown = state.status === 'ready' ? state.items.filter((item) => topic === 'all' || categoryOf(item.kind) === topic) : [];
  const anyUnread = state.status === 'ready' && state.items.some((item) => !item.readAt);
  return (
    <div data-testid="if-notify" className="if-notify">
      <div className="nf-head">
        <h1 data-testid="nf-h1" className="nf-h1">
          {copy.t('Notifications')}
        </h1>
        <div className="nf-head__actions">
          <Button variant="secondary" size={32} disabled={!anyUnread} onClick={() => void inbox.readAll()}>
            {copy.t('Mark all as read')}
          </Button>
        </div>
      </div>
      <NotifyNav current="inbox" />
      <Tabs value={tab} onValueChange={(next) => setTab(next === 'unread' ? 'unread' : 'all')}>
        <TabsList divider aria-label={copy.t('Notification filters')} className="nf-tabs">
          <TabsTab value="all">{copy.t('All')}</TabsTab>
          <TabsTab value="unread">{copy.t('Unread')}</TabsTab>
        </TabsList>
      </Tabs>
      {state.status === 'ready' && state.items.length > 0 ? (
        <div className="nf-chips" role="group" aria-label={centre.t('topicsLabel')}>
          {(['all', ...CATEGORIES] as const)
            .filter((id) => id === 'all' || id === topic || present.has(id))
            .map((id) => (
              <button
                type="button"
                key={id}
                className={`nf-chip${topic === id ? ' nf-chip--on' : ''}`}
                aria-pressed={topic === id}
                onClick={() => setTopic(id)}
              >
                {centre.t(TOPIC[id])}
              </button>
            ))}
        </div>
      ) : null}
      <section
        data-testid="nf-card"
        className="nf-card"
        aria-label={copy.t('Notification list')}
        aria-busy={state.status === 'loading' || undefined}
      >
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
        ) : shown.length === 0 ? (
          <StateBlock kind="empty" title={centre.t('topicEmpty')} body={state.nextCursor ? centre.t('topicEmptyMore') : undefined} />
        ) : (
          <ul className="nf-list">
            {shown.map((item) => (
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
