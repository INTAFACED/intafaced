import { useState } from 'react';
import { Button, EmptyState, ToggleChips } from '@intafaced/ui/lit';
import { notifyCopy } from './copy';
import { centreCopy } from './centre-copy';
import { InboxFailure, InboxRow } from './InboxRow';
import { Loading, Refused } from './parts';
import { CATEGORIES, categoryOf, type Category } from './prefs';
import { useInboxPolicy, useInboxView, type InboxState } from './use-notifications';

type Tab = 'all' | 'unread';
const TABS: readonly Tab[] = ['all', 'unread'];
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

export default function NotificationsPage() {
  const copy = notifyCopy.useCopy();
  const [tab, setTab] = useState<Tab>('all');
  // The owner's page size (notify.inboxPolicy). Unset, the list is never asked for: the page says why instead.
  const policy = useInboxPolicy();
  const pageSize = policy.status === 'ready' ? policy.data.pageSize : null;
  const view = useInboxView({ limit: pageSize ?? 1, unreadOnly: tab === 'unread', enabled: pageSize !== null });
  const { inbox, markets } = view;
  // The settings read itself failing shows as the list failing, in the same plain words.
  const state: InboxState =
    policy.status === 'ready'
      ? view.state
      : policy.status === 'refused'
        ? { status: 'failed', failure: { ok: false, reason: 'forbidden', code: policy.code, message: policy.code } }
        : policy.status === 'error'
          ? { status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'inbox settings unreadable' } }
          : { status: 'loading' };
  const retry = policy.status === 'error' ? policy.retry : inbox.reload;
  const centre = centreCopy.useCopy();
  const [topic, setTopic] = useState<Topic>('all');
  const now = Date.now();
  const present = new Set(state.status === 'ready' ? state.items.map((item) => categoryOf(item.kind)) : []);
  const shown = state.status === 'ready' ? state.items.filter((item) => topic === 'all' || categoryOf(item.kind) === topic) : [];
  const anyUnread = state.status === 'ready' && state.items.some((item) => !item.readAt);
  return (
    <>
      <div className="lt-actions">
        <div className="lt-tabs" role="tablist" aria-label={copy.t('Notification filters')}>
          {TABS.map((value) => (
            <button key={value} type="button" role="tab" className="lt-tab" aria-selected={tab === value} onClick={() => setTab(value)}>
              {copy.t(value === 'unread' ? 'Unread' : 'All')}
            </button>
          ))}
        </div>
        <Button tone="secondary" disabled={!anyUnread} onClick={() => void inbox.readAll()}>
          {copy.t('Mark all as read')}
        </Button>
      </div>
      {state.status === 'ready' && state.items.length > 0 ? (
        <ToggleChips
          label={centre.t('topicsLabel')}
          value={topic}
          onChange={(next) => {
            if (next) setTopic(next);
          }}
          options={(['all', ...CATEGORIES] as const)
            .filter((id) => id === 'all' || id === topic || present.has(id))
            .map((id) => ({ value: id, label: centre.t(TOPIC[id]) }))}
        />
      ) : null}
      <section data-testid="nf-card" aria-label={copy.t('Notification list')} aria-busy={state.status === 'loading' || undefined}>
        {policy.status === 'ready' && pageSize === null ? (
          <Refused title={copy.t('Inbox not set up title')} body={copy.t('Inbox not set up body')} />
        ) : state.status === 'loading' ? (
          <Loading label={copy.t('Notification list')} rows={5} />
        ) : state.status === 'failed' ? (
          <InboxFailure state={state} onRetry={retry} />
        ) : state.items.length === 0 ? (
          <EmptyState title={copy.t("You're all caught up.")} body={copy.t(tab === 'unread' ? 'Nothing unread body' : 'Caught up body')} />
        ) : shown.length === 0 ? (
          <EmptyState title={centre.t('topicEmpty')} body={state.nextCursor ? centre.t('topicEmptyMore') : undefined} />
        ) : (
          <ul className="lt-rows">
            {shown.map((item) => (
              <li key={item.id}>
                <InboxRow item={item} markets={markets} now={now} onOpen={(row) => inbox.read(row.id)} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {inbox.actionFailed ? (
        <p className="lt-refusal" role="alert">
          {copy.t('Couldn’t update your notifications.')}
        </p>
      ) : null}
      {state.status === 'ready' && state.nextCursor ? (
        <div className="lt-actions">
          <Button tone="secondary" aria-busy={inbox.loadingMore || undefined} disabled={inbox.loadingMore} onClick={inbox.loadMore}>
            {copy.t('Load more')}
          </Button>
        </div>
      ) : null}
    </>
  );
}
