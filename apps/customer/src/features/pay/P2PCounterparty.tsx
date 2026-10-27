import { Fragment } from 'react';
import { useResource } from '../../shared/resource';
import { Button } from '@intafaced/ui';
import { navigate } from '../../app/location';
import { PayDetails, PaySection, PayState } from './components';
import type { PersonalPayApi } from './pay-api';
import type { Reputation } from './schemas';
import { counterpartyCopy } from './p2p-counterparty-copy';
import { ordinaryClick, p2pReturn, useCurrentNavigation } from './p2p-return';
import './p2p-counterparty.css';
import { p2pDepth } from './personal/p2p-depth-copy';
import { ContactActions } from './personal/ContactActions';
import './personal/p2p-depth.css';

/** "@handle" when identity gave one, otherwise "Member". Never the account id, in full or short. */
export function CounterpartyName({ resource }: { resource: ReturnType<typeof useResource<Reputation>>['resource'] }) {
  const { t } = counterpartyCopy.useCopy();
  if (resource.status === 'loading') return null;
  const handle = resource.status === 'ready' ? resource.data.handle : null;
  return (
    <p className="p2p-counterparty-id" data-testid="counterparty-name">
      {handle ? (
        <span lang="zxx">{`@${handle}`}</span>
      ) : resource.status === 'ready' && resource.data.profile?.status === 'absent' ? (
        <>
          <span aria-hidden="true">—</span> <small className="muted">{p2pDepth.t('traderNoHandle')}</small>
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
    <div className="p2p-counterparty-metrics">
      <div>
        <h3>
          <Copy k="completion" />
        </h3>
        <strong data-counterparty-metric="completion" lang={requestedLocale}>
          {noFinished ? '—' : percent.format(data.completionRate)}
        </strong>
        <div className="p2p-counterparty-basis">
          <p>
            {noFinished ? (
              <Copy k={noTrades ? 'noTradesYet' : 'noFinishedYet'} />
            ) : (
              <Copy k="completedBasis" params={{ completed: count.format(data.completed), total: count.format(data.tradesTotal) }} />
            )}
          </p>
        </div>
      </div>
      <div>
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
        <div className="p2p-counterparty-basis">
          {noReleases ? (
            <p>
              <Copy k={noTrades ? 'noTradesYet' : noFinished ? 'noFinishedYet' : 'noReleasesYet'} />
            </p>
          ) : (
            <>
              <p className="muted">
                <Copy k="timingBasis" />
              </p>
              {data.avgReleaseSecs === 0 && (
                <p>
                  <Copy k="zeroTiming" />
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const badgeKeys = { 'first-trade': 'first', reliable: 'reliable', 'fast-release': 'fast', spotless: 'spotless' } as const;
export function P2PCounterparty({ pay, userId, returnTo }: { pay: PersonalPayApi; userId: string; returnTo: string | null }) {
  const { Copy, t, requestedLocale, languageFor, directionFor } = counterpartyCopy.useCopy();
  const reputation = useResource((signal) => pay.reputation(userId, signal), `pay:reputation:${userId}`);
  const destination = p2pReturn(returnTo);
  const current = useCurrentNavigation();
  const count = new Intl.NumberFormat(requestedLocale, { maximumFractionDigits: 0 });
  const back = { offer: 'backOffer', order: 'backOrder', offers: 'backOffers', orders: 'backOrders' } as const;
  return (
    <div data-testid="p2p-counterparty" className="p2p-counterparty" lang={languageFor('record')} dir={directionFor('record')}>
      <a
        data-testid="p2p-counterparty-return"
        className="text-link p2p-counterparty-return"
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
      <PaySection title={t('record')}>
        <CounterpartyName resource={reputation.resource} />
        <PayState resource={reputation.resource} retry={reputation.reload}>
          {(data) => (
            <div className="p2p-counterparty-record">
              <div className="p2p-counterparty-history">
                <CounterpartyMetrics data={data} />
                <PayDetails
                  values={[
                    [t('cancelled'), count.format(data.cancelled)],
                    [t('disputed'), count.format(data.disputed)],
                    [
                      t('lost'),
                      <span data-counterparty-metric="lost" lang={requestedLocale}>
                        {count.format(data.disputesLost)}
                      </span>,
                    ],
                  ]}
                />
              </div>
              <div className="p2p-counterparty-programme">
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
                  <ul className="p2p-counterparty-badges">
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
                <p className="muted">
                  <Copy k="limits" />
                </p>
              </div>
            </div>
          )}
        </PayState>
        {reputation.resource.status === 'ready' && (
          <Button variant="secondary" onClick={reputation.reload}>
            <Copy k="refresh" />
          </Button>
        )}
        <div className="p2p-cp-actions" data-testid="counterparty-actions">
          <a className="button button--secondary" href={`/p2p?makerId=${encodeURIComponent(userId)}`}>
            {p2pDepth.t('cpTheirOffers')}
          </a>
        </div>
        <ContactActions pay={pay} peerId={userId} />
      </PaySection>
    </div>
  );
}
