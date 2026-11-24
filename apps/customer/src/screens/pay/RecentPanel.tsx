import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../money/time';
import { Button, EmptyState, HIDDEN_MASK, StatusNote } from '@intafaced/ui/lit';
import { RefusalBox, Skeleton, StatusChip } from '@intafaced/ui/lit/templates';
import {
  contactsFrom,
  createActivityFeed,
  fmtAmount,
  readSent,
  refusalCopy,
  requestPath,
  useSession,
  withDeviceHandles,
  type ActivityItem,
} from './deps';
import {
  counterpartyHandle,
  PAY_SENT_EVENT,
  paymentsEmpty,
  receiptHref,
  recentPayments,
  recentRecipients,
  unnamedSends,
} from './recent-model';
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
  const { timeZone, hideBalances: hidden } = usePreferences();
  const [revision, setRevision] = useState(0);
  const source = useMemo(() => createActivityFeed(api, { pageSize: PAGE }), [api, userId, revision]);
  const feed = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  // A payment just sent from this device shows up without a page reload.
  useEffect(() => {
    const again = () => setRevision((value) => value + 1);
    window.addEventListener(PAY_SENT_EVENT, again);
    return () => window.removeEventListener(PAY_SENT_EVENT, again);
  }, []);
  const sent = useMemo(() => (userId ? readSent(userId) : []), [userId, revision, feed.status]);
  // The bank does not always name the other person. A payment this device sent is named from the confirmation it kept.
  const rows = feed.status === 'ready' ? feed.data.items : null;
  const items: readonly ActivityItem[] = useMemo(() => (rows ? withDeviceHandles(rows, sent) : []), [rows, sent]);
  const hasMore = feed.status === 'ready' && feed.data.hasMore;
  const payments = recentPayments(items);
  const remembered = useMemo(() => contactsFrom(sent), [sent]);
  const recipients = recentRecipients(items, remembered);
  const unnamed = recipients.length === 0 ? unnamedSends(items) : [];
  const now = Date.now();
  const failed = feed.status === 'error' || feed.status === 'refused';
  const loading = feed.status === 'loading';

  const lookFurther =
    feed.status === 'ready' && feed.data.hasMore ? (
      <>
        <div className="lt-actions">
          <Button tone="quiet" disabled={feed.data.loadingMore} onClick={feed.data.loadMore}>
            {copy.t(feed.data.loadingMore ? 'lookingFurther' : 'lookFurther')}
          </Button>
        </div>
        {feed.data.moreFailed ? <StatusNote tone="error">{copy.t('furtherFailed')}</StatusNote> : null}
      </>
    ) : null;

  const failure =
    feed.status === 'refused' ? (
      (() => {
        const words = refusalCopy(feed.code);
        return (
          <RefusalBox
            refusal={{ variant: 'refused', title: words.title, body: words.body, reference: words.reference, action: words.action }}
          />
        );
      })()
    ) : feed.status === 'error' ? (
      <StatusNote tone="error" title={copy.t('loadFailed')} actions={<Button onClick={feed.retry}>{copy.t('tryAgain')}</Button>} />
    ) : null;

  return (
    <div className="lt-stack" data-testid="pay-recent">
      <section className="lt-stack" aria-labelledby="pay-recent-payments" data-testid="recent-payments">
        <div className="lt-title-row">
          <h2 id="pay-recent-payments">{copy.t('paymentsTitle')}</h2>
          <Button tone="quiet" onClick={() => setRevision((value) => value + 1)}>
            {copy.t('refresh')}
          </Button>
        </div>
        {loading ? (
          <div role="status" aria-busy="true" aria-label={copy.t('loadingPayments')}>
            <Skeleton shape="rows" count={3} />
          </div>
        ) : failed ? (
          failure
        ) : payments.length === 0 ? (
          feed.status === 'empty' || paymentsEmpty(hasMore) === 'none' ? (
            <EmptyState title={copy.t('emptyTitle')} body={copy.t('emptyBody')} />
          ) : (
            <EmptyState title={copy.t('olderTitle')} body={copy.t('olderBody')} />
          )
        ) : (
          <ul className="lt-rows" aria-label={copy.t('paymentsLabel')}>
            {payments.map((item) => {
              const handle = counterpartyHandle(item);
              const who = handle ? `@${handle}` : copy.t('anotherAccount');
              const out = item.direction === 'out';
              const summary = copy.t(out ? 'sentTo' : 'receivedFrom', { who });
              const amount = hidden ? HIDDEN_MASK : `${out ? '−' : '+'}${fmtAmount(item.amount, { places: 18 })} ${item.asset}`;
              return (
                <li key={item.id} data-testid="recent-payment">
                  <span className="lt-title-row">
                    <span className="lt-lines">
                      <span data-testid="recent-payment-who">{summary}</span>
                      {item.paymentNote ? (
                        <span className="lt-hint" data-testid="recent-payment-note">
                          {item.paymentNote}
                        </span>
                      ) : null}
                      <span className="lt-hint">
                        <span lang="zxx">{stamp(item.postedAt, timeZone, now)}</span>
                        {' · '}
                        <span data-testid="recent-payment-status">
                          <StatusChip status="done" label={copy.t('statusDone')} />
                        </span>
                      </span>
                    </span>
                    <span className="lt-lines">
                      <span className="lt-num" lang="zxx" data-dir={out ? undefined : 'up'} data-testid="recent-payment-amount">
                        {amount}
                      </span>
                      <a className="lt-link" href={receiptHref(item)} aria-label={copy.t('receiptFor', { summary })}>
                        {copy.t('receipt')}
                      </a>
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {lookFurther}
        {feed.status === 'ready' ? (
          <a className="lt-link" href="/money/activity?tab=transfers">
            {copy.t('seeAll')}
          </a>
        ) : null}
      </section>

      {/* A refused read is said once, in its own words, under Recent payments; nothing more is said about it here. */}
      {feed.status === 'refused' ? null : (
        <section className="lt-stack" aria-labelledby="pay-recent-recipients" data-testid="recent-recipients">
          <h2 id="pay-recent-recipients">{copy.t('recipientsTitle')}</h2>
          {loading ? (
            <div role="status" aria-busy="true" aria-label={copy.t('recipientsTitle')}>
              <Skeleton shape="keys" count={1} />
            </div>
          ) : recipients.length > 0 ? (
            <>
              <ul className="lt-actions" aria-label={copy.t('recipientsLabel')}>
                {recipients.map((person) => (
                  <li key={person.to}>
                    <a
                      className="lt-button lt-button-secondary"
                      href={requestPath({ to: person.to })}
                      aria-label={copy.t('payAgain', { who: person.label })}
                      data-testid="recent-recipient"
                    >
                      {person.label}
                    </a>
                  </li>
                ))}
              </ul>
              <p className="lt-hint">{copy.t('recipientsNote')}</p>
            </>
          ) : failed ? (
            <p className="lt-hint">{copy.t('loadFailed')}</p>
          ) : unnamed.length > 0 ? (
            <>
              <ul className="lt-rows" aria-label={copy.t('recipientsLabel')}>
                {unnamed.map((item) => (
                  <li key={item.id} data-testid="recent-unnamed-send">
                    <span className="lt-title-row">
                      <span className="lt-lines">
                        <span>{copy.t('recipientUnknown')}</span>
                        <span className="lt-hint" lang="zxx">
                          {stamp(item.postedAt, timeZone, now)}
                        </span>
                      </span>
                      <a className="lt-link" href={receiptHref(item)}>
                        {copy.t('receipt')}
                      </a>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="lt-hint">{copy.t('recipientUnknownNote')}</p>
            </>
          ) : (
            <EmptyState title={copy.t('recipientsEmptyTitle')} body={copy.t(hasMore ? 'recipientsOlderBody' : 'recipientsEmptyBody')} />
          )}
        </section>
      )}
    </div>
  );
}
