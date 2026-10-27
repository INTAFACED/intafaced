import { useState } from 'react';
import './notifications.css';
import { StateBlock } from './deps';
import { usePreferences } from '../../shared/preferences';
import { useSession } from '../../features/session/session';
import { stamp } from '../money/time';
import { centreCopy } from './centre-copy';
import { notifyCopy } from './copy';
import { NotifyNav } from './NotifyNav';
import { deliveries, type Delivery, type Notification } from './notify-api';
import { describe } from './notify-view';
import { deliveryWords, refusalKey, sortDeliveries } from './prefs';
import { useInbox, useMarketNames } from './use-notifications';

const CHANNEL = { inapp: 'channelInbox', email: 'channelEmail', push: 'channelPush', sms: 'channelSms' } as const;

/**
 * Delivery history (`/notifications?view=delivery`): the newest updates, and for each one on request where it was sent and what
 * happened. The record comes from the service per update; nothing here is computed or guessed.
 */
export default function DeliveryLog() {
  const copy = centreCopy.useCopy();
  const base = notifyCopy.useCopy();
  const { timeZone } = usePreferences();
  const inbox = useInbox({ limit: 20, unreadOnly: false });
  const markets = useMarketNames();
  const { state } = inbox;
  return (
    <div data-testid="if-notify" className="if-notify">
      <div className="nf-head">
        <h1 data-testid="nf-h1" className="nf-h1">
          {copy.t('deliveryTitle')}
        </h1>
      </div>
      <NotifyNav current="delivery" />
      <p className="nf-intro">{copy.t('deliveryIntro')}</p>
      <p className="nf-note">{copy.t('deliveryBoundary')}</p>
      <section
        data-testid="nf-card"
        className="nf-card"
        aria-label={copy.t('deliveryTitle')}
        aria-busy={state.status === 'loading' || undefined}
      >
        {state.status === 'loading' ? (
          <StateBlock kind="loading" rows={5} rowHeight={72} label={copy.t('deliveryTitle')} className="nf-card__loading" />
        ) : state.status === 'failed' ? (
          <StateBlock
            kind="error"
            title={base.t('Couldn’t load your notifications.')}
            onRetry={inbox.reload}
            retryLabel={base.t('Try again')}
          />
        ) : state.items.length === 0 ? (
          <StateBlock kind="empty" title={copy.t('deliveryEmpty')} body={copy.t('deliveryEmptyBody')} />
        ) : (
          <ul className="nf-list">
            {state.items.map((item) => (
              <li key={item.id}>
                <Row item={item} markets={markets} zone={timeZone} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {state.status === 'ready' && state.nextCursor ? (
        <div className="nf-more">
          <button type="button" className="nf-link nf-linkbutton" disabled={inbox.loadingMore} onClick={inbox.loadMore}>
            {base.t('Load more')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

type Records = { status: 'idle' } | { status: 'loading' } | { status: 'failed' } | { status: 'ready'; rows: Delivery[] };

function Row({
  item,
  markets,
  zone,
}: {
  item: Notification;
  markets: ReturnType<typeof useMarketNames>;
  zone: ReturnType<typeof usePreferences>['timeZone'];
}) {
  const copy = centreCopy.useCopy();
  const base = notifyCopy.useCopy();
  const { api } = useSession();
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<Records>({ status: 'idle' });
  const words = describe(item, markets, base);
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || records.status === 'ready' || records.status === 'loading') return;
    setRecords({ status: 'loading' });
    const result = await deliveries(api, item.id);
    setRecords(result.ok ? { status: 'ready', rows: sortDeliveries(result.data) } : { status: 'failed' });
  }
  return (
    <div className="nf-delivery">
      <div className="nf-delivery__head">
        <span className="nf-text">
          <span data-testid="nf-title" className="nf-title">
            {words.title}
          </span>
          <span data-testid="nf-body" className="nf-body nf-body--wrap">
            {words.body ? `${words.body} · ` : ''}
            <span lang="zxx">{stamp(item.createdAt, zone)}</span>
          </span>
        </span>
        <button type="button" className="nf-link nf-linkbutton" aria-expanded={open} onClick={() => void toggle()}>
          {copy.t(open ? 'hideDelivery' : 'showDelivery')}
        </button>
      </div>
      {open && (
        <div className="nf-delivery__body" aria-live="polite">
          {records.status === 'loading' || records.status === 'idle' ? (
            <p className="nf-muted">{copy.t('deliveryLoading')}</p>
          ) : records.status === 'failed' ? (
            <p className="nf-note">{copy.t('deliveryFailedLoad')}</p>
          ) : records.rows.length === 0 ? (
            <p className="nf-muted">{copy.t('deliveryNone')}</p>
          ) : (
            <ul className="nf-deliveries">
              {records.rows.map((row, index) => (
                <li key={`${row.channel}-${index}`}>
                  <span data-testid="nf-title" className="nf-title">
                    {copy.t(CHANNEL[row.channel])}
                  </span>
                  <span className={`nf-pill${row.status === 'accepted' ? ' nf-pill--ok' : ''}`}>{copy.t(deliveryWords(row))}</span>
                  <span className="nf-muted">
                    {row.attempts === 1 ? copy.t('attemptsOne') : copy.t('attempts', { count: row.attempts })}
                    {row.attemptedAt ? ` · ${copy.t('lastTried', { when: stamp(row.attemptedAt, zone) })}` : ''}
                  </span>
                  {(row.status === 'refused' || row.status === 'failed' || row.status === 'abandoned') && (
                    <span className="nf-why">
                      {copy.t('reasonLabel')}: {copy.t(refusalKey(row.refusalCode))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
