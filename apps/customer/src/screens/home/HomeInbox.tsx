import { useEffect, useRef, useState } from 'react';
import { homeCopy } from './copy';
import { NotificationRow, useInboxView, type Notification } from './deps';
import { HOME_LINKS } from './links';

/** How often an open Home reads the inbox again, as the notice board does, so a new row shows and a read one loses its dot. */
const REREAD_MS = 60_000;

/**
 * The newest notification in the inbox, drawn as the inbox draws it (the same row, with its TEST tag on a test build), and a link to
 * the rest, read again every minute. Like the notice board it draws nothing while it first loads, when the inbox is empty or when the
 * inbox does not answer; a failed read goes to the console so the gap is not silent. The full list, with its own empty and refusal states, is Notifications.
 */
export function HomeInbox() {
  const { t } = homeCopy.useCopy();
  const { inbox, state, markets } = useInboxView({ limit: 1, unreadOnly: false });
  const [now, setNow] = useState(() => Date.now());
  const reread = useRef(() => {});
  reread.current = () => {
    setNow(Date.now());
    inbox.reload();
  };
  useEffect(() => {
    const timer = setInterval(() => reread.current(), REREAD_MS);
    return () => clearInterval(timer);
  }, []);
  const code = state.status === 'failed' ? state.failure.code : null;
  useEffect(() => {
    if (code) console.warn(`home inbox: unread (${code})`);
  }, [code]);
  // A re-read keeps the last answer on screen while it loads; a failed read draws nothing, as on first load.
  const last = useRef<Notification | undefined>(undefined);
  if (state.status === 'ready') last.current = state.items[0];
  else if (state.status === 'failed') last.current = undefined;
  const latest = last.current;
  if (!latest) return null;
  return (
    <section data-testid="home-inbox" className="home-inbox" aria-labelledby="home-inbox-title">
      <div className="home-section__head">
        <h2 className="home-h2" id="home-inbox-title">
          {t('Latest in your inbox')}
        </h2>
        <a className="home-link" href={HOME_LINKS.inbox}>
          {t('See all')}
        </a>
      </div>
      <ul className="nf-list">
        <li>
          <NotificationRow item={latest} markets={markets} now={now} onOpen={(row) => inbox.read(row.id)} />
        </li>
      </ul>
    </section>
  );
}
