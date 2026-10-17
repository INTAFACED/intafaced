import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../money/time';
import {
  contactsFrom,
  createActivityFeed,
  fmtAmount,
  HIDDEN_MASK,
  readSent,
  refusalCopy,
  requestPath,
  StateBlock,
  useHideBalances,
  useSession,
  type ActivityItem,
} from './deps';
import { counterpartyHandle, PAY_SENT_EVENT, paymentsEmpty, receiptHref, recentPayments, recentRecipients } from './recent-model';
import { recentCopy } from './recent-copy';

// The newest 50 ledger entries are read once; transfers are picked out of them. Older ones are one tap away.
const PAGE = 50;

/**
 * The left side of Pay: the customer's recent payments (real transfers from their activity, each with its receipt) and the
 * people they paid recently. Nothing is made up: an empty list says what will appear, a failed read says it failed.
 */
export function RecentPanel() {
  const { api, userId } = useSession();
  const copy = recentCopy.useCopy();
  const { timeZone } = usePreferences();
  const hidden = useHideBalances();
  const [revision, setRevision] = useState(0);
  const source = useMemo(() => createActivityFeed(api, { pageSize: PAGE }), [api, userId, revision]);
  const feed = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  // A payment just sent from this device shows up without a page reload.
  useEffect(() => {
    const again = () => setRevision((value) => value + 1);
    window.addEventListener(PAY_SENT_EVENT, again);
    return () => window.removeEventListener(PAY_SENT_EVENT, again);
  }, []);
  const items: readonly ActivityItem[] = feed.status === 'ready' ? feed.data.items : [];
  const hasMore = feed.status === 'ready' && feed.data.hasMore;
  const payments = recentPayments(items);
  const remembered = useMemo(() => (userId ? contactsFrom(readSent(userId)) : []), [userId, revision, feed.status]);
  const recipients = recentRecipients(items, remembered);
  const now = Date.now();
  const failed = feed.status === 'error' || feed.status === 'refused';
  const loading = feed.status === 'loading';

  const lookFurther =
    feed.status === 'ready' && feed.data.hasMore ? (
      <>
        <button type="button" className="pay-recent__link" disabled={feed.data.loadingMore} onClick={feed.data.loadMore}>
          {copy.t(feed.data.loadingMore ? 'lookingFurther' : 'lookFurther')}
        </button>
        {feed.data.moreFailed ? (
          <p className="pay-recent__note" role="alert">
            {copy.t('furtherFailed')}
          </p>
        ) : null}
      </>
    ) : null;

  const failure =
    feed.status === 'refused' ? (
      (() => {
        const words = refusalCopy(feed.code);
        return <StateBlock kind="refused" title={words.title} body={words.body} code={words.reference} action={words.action} />;
      })()
    ) : feed.status === 'error' ? (
      <StateBlock kind="error" title={copy.t('loadFailed')} onRetry={feed.retry} retryLabel={copy.t('tryAgain')} />
    ) : null;

  return (
    <div className="pay-recent" data-testid="pay-recent">
      <section className="pay-recent__section" aria-labelledby="pay-recent-payments" data-testid="recent-payments">
        <header className="pay-recent__head">
          <h2 id="pay-recent-payments">{copy.t('paymentsTitle')}</h2>
          <button type="button" className="pay-recent__link" onClick={() => setRevision((value) => value + 1)}>
            {copy.t('refresh')}
          </button>
        </header>
        {loading ? (
          <StateBlock kind="loading" rows={3} rowHeight={56} label={copy.t('loadingPayments')} />
        ) : failed ? (
          failure
        ) : payments.length === 0 ? (
          feed.status === 'empty' || paymentsEmpty(hasMore) === 'none' ? (
            <StateBlock kind="empty" title={copy.t('emptyTitle')} body={copy.t('emptyBody')} />
          ) : (
            <StateBlock kind="empty" title={copy.t('olderTitle')} body={copy.t('olderBody')} />
          )
        ) : (
          <ul className="pay-recent__list" aria-label={copy.t('paymentsLabel')}>
            {payments.map((item) => {
              const handle = counterpartyHandle(item);
              const who = handle ? `@${handle}` : copy.t('anotherAccount');
              const out = item.direction === 'out';
              const summary = copy.t(out ? 'sentTo' : 'receivedFrom', { who });
              const amount = hidden ? HIDDEN_MASK : `${out ? '−' : '+'}${fmtAmount(item.amount, { places: 18 })} ${item.asset}`;
              return (
                <li key={item.id} className="pay-recent__row" data-testid="recent-payment">
                  <span className="pay-recent__main">
                    <span className="pay-recent__who">{summary}</span>
                    <span className="pay-recent__meta">
                      <span lang="zxx">{stamp(item.postedAt, timeZone, now)}</span>
                      {' · '}
                      <span className="pay-recent__status">{copy.t('statusDone')}</span>
                    </span>
                  </span>
                  <span className="pay-recent__side">
                    <span className={`pay-recent__amount${out ? '' : ' pay-recent__amount--in'}`} lang="zxx">
                      {amount}
                    </span>
                    <a className="pay-recent__link" href={receiptHref(item)} aria-label={copy.t('receiptFor', { summary })}>
                      {copy.t('receipt')}
                    </a>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {lookFurther}
        {feed.status === 'ready' ? (
          <a className="pay-recent__link" href="/money/activity?tab=transfers">
            {copy.t('seeAll')}
          </a>
        ) : null}
      </section>

      <section className="pay-recent__section" aria-labelledby="pay-recent-recipients" data-testid="recent-recipients">
        <header className="pay-recent__head">
          <h2 id="pay-recent-recipients">{copy.t('recipientsTitle')}</h2>
        </header>
        {loading ? (
          <StateBlock kind="loading" rows={1} rowHeight={40} label={copy.t('recipientsTitle')} />
        ) : recipients.length > 0 ? (
          <>
            <ul className="pay-recent__chips" aria-label={copy.t('recipientsLabel')}>
              {recipients.map((person) => (
                <li key={person.to}>
                  <a
                    className="pay-chip"
                    href={requestPath({ to: person.to })}
                    aria-label={copy.t('payAgain', { who: person.label })}
                    data-testid="recent-recipient"
                  >
                    {person.label}
                  </a>
                </li>
              ))}
            </ul>
            <p className="pay-recent__note">{copy.t('recipientsNote')}</p>
          </>
        ) : failed ? (
          <p className="pay-recent__note">{copy.t('loadFailed')}</p>
        ) : (
          <StateBlock
            kind="empty"
            title={copy.t('recipientsEmptyTitle')}
            body={copy.t(hasMore ? 'recipientsOlderBody' : 'recipientsEmptyBody')}
          />
        )}
      </section>
    </div>
  );
}
