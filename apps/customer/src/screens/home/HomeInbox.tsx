import { useEffect } from 'react';
import '../notifications/notifications.css';
import { homeCopy } from './copy';
import { NotificationRow, useInboxView } from './deps';

/**
 * The newest notification in the inbox, drawn as the inbox draws it (the same row, with its TEST tag on a test build), and a link to
 * the rest. Like the notice board it draws nothing while it loads, when the inbox is empty or when the inbox does not answer; a failed
 * read goes to the console so the gap is not silent. The full list, with its own empty and refusal states, is Notifications.
 */
export function HomeInbox() {
  const { t } = homeCopy.useCopy();
  const { inbox, state, markets } = useInboxView({ limit: 1, unreadOnly: false });
  const code = state.status === 'failed' ? state.failure.code : null;
  useEffect(() => {
    if (code) console.warn(`home inbox: unread (${code})`);
  }, [code]);
  const latest = state.status === 'ready' ? state.items[0] : undefined;
  if (!latest) return null;
  return (
    <section data-testid="home-inbox" className="home-inbox" aria-labelledby="home-inbox-title">
      <div className="home-section__head">
        <h2 className="home-h2" id="home-inbox-title">
          {t('Latest in your inbox')}
        </h2>
        <a className="home-link" href="/notifications">
          {t('See all')}
        </a>
      </div>
      <ul className="nf-list">
        <li>
          <NotificationRow item={latest} markets={markets} now={Date.now()} onOpen={(row) => inbox.read(row.id)} />
        </li>
      </ul>
    </section>
  );
}
