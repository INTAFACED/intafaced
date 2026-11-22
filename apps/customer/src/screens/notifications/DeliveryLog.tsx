import { useState } from 'react';
import { Button, EmptyState } from '@intafaced/ui/lit';
import { usePreferences } from '../../shared/preferences';
import { useSession } from '../../features/session/session';
import { stamp } from '../money/time';
import { centreCopy } from './centre-copy';
import { notifyCopy } from './copy';
import { TestFigureTag } from './InboxRow';
import { channelStatus, deliveries, type Delivery, type Notification } from './notify-api';
import { ServiceOffNotice } from '../../shared/service-off';
import { LoadFailed, Loading, StateTag } from './parts';
import { describe } from './notify-view';
import { deliveryWords, refusalKey, sortDeliveries } from './prefs';
import { useInboxView } from './use-notifications';

const CHANNEL = { inapp: 'channelInbox', email: 'channelEmail', push: 'channelPush', sms: 'channelSms' } as const;

/**
 * Delivery history (`/notifications?view=delivery`): the newest updates, and for each one on request where it was sent and what
 * happened. The record comes from the service per update; nothing here is computed or guessed.
 */
export default function DeliveryLog() {
  const copy = centreCopy.useCopy();
  const base = notifyCopy.useCopy();
  const { timeZone } = usePreferences();
  const { inbox, state, markets } = useInboxView({ limit: 20, unreadOnly: false });
  return (
    <>
      <p className="lt-hint">{copy.t('deliveryIntro')}</p>
      <p className="lt-hint">{copy.t('deliveryBoundary')}</p>
      <section
        data-testid="nf-card"

        aria-label={copy.t('deliveryTitle')}
        aria-busy={state.status === 'loading' || undefined}
      >
        {state.status === 'loading' ? (
          <Loading label={copy.t('deliveryTitle')} rows={5} />
        ) : state.status === 'failed' ? (
          <LoadFailed title={base.t('Couldn’t load your notifications.')} onRetry={inbox.reload} retryLabel={base.t('Try again')} />
        ) : state.items.length === 0 ? (
          <EmptyState title={copy.t('deliveryEmpty')} body={copy.t('deliveryEmptyBody')} />
        ) : (
          <ul className="lt-rows">
            {state.items.map((item) => (
              <li key={item.id}>
                <Row item={item} markets={markets} zone={timeZone} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {state.status === 'ready' && state.nextCursor ? (
        <div className="lt-actions">
          <Button tone="quiet" disabled={inbox.loadingMore} onClick={inbox.loadMore}>
            {base.t('Load more')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

type Records = { status: 'idle' } | { status: 'loading' } | { status: 'failed' } | { status: 'ready'; rows: Delivery[]; emailOff: boolean };

function Row({
  item,
  markets,
  zone,
}: {
  item: Notification;
  markets: ReturnType<typeof useInboxView>['markets'];
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
    // The platform's own channel state beside the record: with no email sender, no email copy can exist, and the record says
    // which outside service that waits on (vendor.email) rather than leaving the missing row unexplained.
    const [result, channels] = await Promise.all([deliveries(api, item.id), channelStatus(api)]);
    const emailOff = channels.ok && channels.data.some((c) => c.channel === 'email' && !c.configured);
    setRecords(result.ok ? { status: 'ready', rows: sortDeliveries(result.data), emailOff } : { status: 'failed' });
  }
  return (
    <div>
      <div className="lt-actions">
        <span className="lt-lines">
          <span data-testid="nf-title">{words.title}</span>
          <span data-testid="nf-body">
            {words.body ? `${words.body} · ` : ''}
            <span lang="zxx">{stamp(item.createdAt, zone)}</span>
          </span>
          <TestFigureTag item={item} />
        </span>
        <Button tone="quiet" aria-expanded={open} onClick={() => void toggle()}>
          {copy.t(open ? 'hideDelivery' : 'showDelivery')}
        </Button>
      </div>
      {open && (
        <div aria-live="polite">
          {records.status === 'loading' || records.status === 'idle' ? (
            <p className="lt-hint">{copy.t('deliveryLoading')}</p>
          ) : records.status === 'failed' ? (
            <p className="lt-hint">{copy.t('deliveryFailedLoad')}</p>
          ) : records.rows.length === 0 ? (
            <p className="lt-hint">{copy.t('deliveryNone')}</p>
          ) : (
            <ul className="lt-rows">
              {records.rows.map((row, index) => (
                <li key={`${row.channel}-${index}`}>
                  <span data-testid="nf-title">{copy.t(CHANNEL[row.channel])}</span>
                  <StateTag ok={row.status === 'accepted'}>{copy.t(deliveryWords(row))}</StateTag>
                  <span className="lt-hint">
                    {row.attempts === 1 ? copy.t('attemptsOne') : copy.t('attempts', { count: row.attempts })}
                    {row.attemptedAt ? ` · ${copy.t('lastTried', { when: stamp(row.attemptedAt, zone) })}` : ''}
                  </span>
                  {(row.status === 'refused' || row.status === 'failed' || row.status === 'abandoned') && (
                    <span className="lt-hint">
                      {copy.t('reasonLabel')}: {copy.t(refusalKey(row.refusalCode))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {records.status === 'ready' && records.emailOff && !records.rows.some((row) => row.channel === 'email') && (
            <ServiceOffNotice code="vendor.email" action={copy.t('emailCopyAction')} className="lt-hint" role="note" />
          )}
        </div>
      )}
    </div>
  );
}
