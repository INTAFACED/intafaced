// volt-room: /checkuser
import { Fragment } from 'react';
import { Button, EmptyState } from '@intafaced/ui/lit';
import { MonitorTemplate, Tabs } from '@intafaced/ui/lit/templates';
import { navigate } from '../../../app/location';
import { useResource } from '../../../shared/resource';
import { payCopy } from '../copy';
import type { PersonalPayApi } from '../pay-api';
import { counterpartyCopy } from '../p2p-counterparty-copy';
import { ordinaryClick, p2pReturn, useCurrentNavigation } from '../p2p-return';
import { id, type Reputation } from '../schemas';
import { CompletionRatesByPeriod } from '../personal/completion-rates-view';
import { ContactActions } from '../personal/ContactActions';
import { MethodsLoad } from '../personal/methods-parts';
import { p2pDepth } from '../personal/p2p-depth-copy';

/** The P2P rooms, in the order the other P2P pages list them. */
const P2P_ROOMS = [
  ['/p2p', 'offers'],
  ['/uc/order', 'yourOrders'],
  ['/uc/ad', 'yourOffers'],
  ['/p2p/methods', 'paymentMethods'],
  ['/p2p/access', 'tradingAccess'],
] as const;

/**
 * `/checkuser` on the monitor template (J-p2p-12): one member's P2P record as the service computed it from trades, their
 * offers, and follow and block. The P2P rooms stay above it, with the room the person came from marked as current; an
 * address with no member id says how to open one.
 */
export function CounterpartyRoom({
  pay,
  counterparty,
  returnTo,
}: {
  pay: PersonalPayApi;
  counterparty: string | null;
  returnTo: string | null;
}) {
  const inspection = p2pReturn(returnTo);
  const mine = inspection.href.split(/[?#]/)[0] === '/uc/ad';
  const current = mine
    ? '/uc/ad'
    : inspection.kind === 'offer' || inspection.kind === 'offers'
      ? '/p2p'
      : inspection.kind === 'order' || inspection.kind === 'orders'
        ? '/uc/order'
        : '';
  const known = counterparty !== null && id.safeParse(counterparty).success;
  return (
    <MonitorTemplate
      title={payCopy.t('counterparty')}
      state={{ kind: 'ready' }}
      figures={[]}
      actions={
        <Tabs label={payCopy.t('p2pRooms')} current={current} items={P2P_ROOMS.map(([href, key]) => ({ href, label: payCopy.t(key) }))} />
      }
      panels={
        known ? (
          <P2PCounterparty pay={pay} userId={counterparty} returnTo={returnTo} />
        ) : (
          <EmptyState
            title={p2pDepth.t('cpPickTitle')}
            body={p2pDepth.t('cpPickBody')}
            action={
              <div className="lt-actions">
                <a className="lt-button lt-button-primary" href="/p2p">
                  {p2pDepth.t('cpPickOffers')}
                </a>
                <a className="lt-button lt-button-secondary" href="/uc/order">
                  {p2pDepth.t('cpPickOrders')}
                </a>
              </div>
            }
          />
        )
      }
    />
  );
}

/** "@handle" when identity gave one, otherwise "Member". Never the account id, in full or short. */
export function CounterpartyName({ resource }: { resource: ReturnType<typeof useResource<Reputation>>['resource'] }) {
  const { t } = counterpartyCopy.useCopy();
  if (resource.status === 'loading') return null;
  const handle = resource.status === 'ready' ? resource.data.handle : null;
  return (
    <p className="lt-wrap" data-testid="counterparty-name">
      {handle ? (
        <span lang="zxx">{`@${handle}`}</span>
      ) : resource.status === 'ready' && resource.data.profile?.status === 'absent' ? (
        <>
          <span aria-hidden="true">—</span> <small className="lt-hint">{p2pDepth.t('traderNoHandle')}</small>
        </>
      ) : (
        t('member')
      )}
    </p>
  );
}

/**
 * Completion rate and average release. With no trades there is no rate, and with no completed trades there is nothing
 * to average, so each shows a dash and says why, instead of a zero that reads as a bad record.
 */
export function CounterpartyMetrics({ data }: { data: Reputation }) {
  const { Copy, requestedLocale } = counterpartyCopy.useCopy();
  const count = new Intl.NumberFormat(requestedLocale, { maximumFractionDigits: 0 });
  const percent = new Intl.NumberFormat(requestedLocale, { style: 'percent', maximumFractionDigits: 2 });
  const noTrades = data.tradesTotal === 0;
  // Trades are counted when escrowed but completed or cancelled only when they finish, so until one finishes the rate is
  // 0% of nothing: a dash, not a bad record.
  const noFinished = data.completed + data.cancelled === 0;
  const noReleases = data.completed === 0;
  return (
    <div className="lt-figures" data-count={2}>
      <div className="lt-figure-cell">
        <h3>
          <Copy k="completion" />
        </h3>
        <strong data-counterparty-metric="completion" lang={requestedLocale}>
          {noFinished ? '—' : percent.format(data.completionRate)}
        </strong>
        <p className="lt-hint">
          {noFinished ? (
            <Copy k={noTrades ? 'noTradesYet' : 'noFinishedYet'} />
          ) : (
            <Copy k="completedBasis" params={{ completed: count.format(data.completed), total: count.format(data.tradesTotal) }} />
          )}
        </p>
      </div>
      <div className="lt-figure-cell">
        <h3>
          <Copy k="average" />
        </h3>
        <strong data-counterparty-metric="average">
          {noReleases ? (
            '—'
          ) : (
            <>
              <span lang={requestedLocale}>
                {count.formatToParts(data.avgReleaseSecs).map((part, index) => (
                  <Fragment key={index}>
                    {part.value}
                    {part.type === 'group' && <wbr />}
                  </Fragment>
                ))}
              </span>
              <Copy k="secondsUnit" />
            </>
          )}
        </strong>
        {noReleases ? (
          <p className="lt-hint">
            <Copy k={noTrades ? 'noTradesYet' : noFinished ? 'noFinishedYet' : 'noReleasesYet'} />
          </p>
        ) : (
          <>
            <p className="lt-hint">
              <Copy k="timingBasis" />
            </p>
            {data.avgReleaseSecs === 0 && (
              <p className="lt-hint">
                <Copy k="zeroTiming" />
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const badgeKeys = { 'first-trade': 'first', reliable: 'reliable', 'fast-release': 'fast', spotless: 'spotless' } as const;

/** One member's reported P2P record, read from svc-p2p's reputation, with a way back to where the person came from. */
function P2PCounterparty({ pay, userId, returnTo }: { pay: PersonalPayApi; userId: string; returnTo: string | null }) {
  const { Copy, t, requestedLocale, languageFor, directionFor } = counterpartyCopy.useCopy();
  const reputation = useResource((signal) => pay.reputation(userId, signal), `pay:reputation:${userId}`);
  const destination = p2pReturn(returnTo);
  const current = useCurrentNavigation();
  const count = new Intl.NumberFormat(requestedLocale, { maximumFractionDigits: 0 });
  const back = { offer: 'backOffer', order: 'backOrder', offers: 'backOffers', orders: 'backOrders' } as const;
  return (
    <div className="lt-stack" data-testid="counterparty-page" lang={languageFor('record')} dir={directionFor('record')}>
      <a
        className="lt-link"
        data-testid="counterparty-return"
        href={destination.href}
        onClick={(event) => {
          if (!ordinaryClick(event)) return;
          event.preventDefault();
          if (!current()) return;
          navigate(destination.href);
        }}
      >
        <Copy k={back[destination.kind]} />
      </a>
      <section data-testid="pay-section" className="lt-stack">
        <h2>{t('record')}</h2>
        <CounterpartyName resource={reputation.resource} />
        <MethodsLoad resource={reputation.resource} retry={reputation.reload}>
          {(data) => (
            <div className="lt-grid lt-grid-main-side">
              <div className="lt-col-main lt-stack">
                <CounterpartyMetrics data={data} />
                <CompletionRatesByPeriod data={data} />
                <dl className="lt-kv">
                  <div>
                    <dt>{t('cancelled')}</dt>
                    <dd>
                      <span data-counterparty-metric="cancelled" lang={requestedLocale}>
                        {count.format(data.cancelled)}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>{t('disputed')}</dt>
                    <dd>
                      <span data-counterparty-metric="disputed" lang={requestedLocale}>
                        {count.format(data.disputed)}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>{t('lost')}</dt>
                    <dd>
                      <span data-counterparty-metric="lost" lang={requestedLocale}>
                        {count.format(data.disputesLost)}
                      </span>
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="lt-col-side lt-stack">
                <h3>
                  <Copy k="programme" />
                </h3>
                <p>
                  <Copy k={data.merchant === null ? 'unavailable' : data.merchant ? 'approved' : 'notApproved'} />
                </p>
                <h3>
                  <Copy k="badges" />
                </h3>
                {data.badges.length ? (
                  <ul className="lt-rows">
                    {data.badges.map((badge, index) => (
                      <li key={`${badge}:${index}`}>
                        {Object.hasOwn(badgeKeys, badge) ? (
                          <Copy k={badgeKeys[badge as keyof typeof badgeKeys]} />
                        ) : (
                          <span lang="zxx">{badge}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    <Copy k="none" />
                  </p>
                )}
                <p className="lt-hint">
                  <Copy k="limits" />
                </p>
              </div>
            </div>
          )}
        </MethodsLoad>
        {reputation.resource.status === 'ready' && (
          <Button tone="secondary" onClick={reputation.reload}>
            <Copy k="refresh" />
          </Button>
        )}
        <div className="lt-actions" data-testid="counterparty-actions">
          <a className="lt-button lt-button-secondary" href={`/p2p?makerId=${encodeURIComponent(userId)}`}>
            {p2pDepth.t('cpTheirOffers')}
          </a>
        </div>
        <ContactActions pay={pay} peerId={userId} />
      </section>
    </div>
  );
}
