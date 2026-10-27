import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ZodTypeAny } from 'zod';
import { currentReturnLocation } from '../../app/location';
import { authoredRefusal, type ApiClient } from '../../shared/api';
import { readContract, type ContractData, type ContractProcedure } from '../../shared/contract-call';
import type { Resource } from '../../shared/resource';
import { Button, Loading } from '../../shared/ui';
import { uiCopy, uiMessage } from '../../shared/ui-copy';
import { useSession, type Session } from '../session/session';
import { stamp } from '../../screens/money/time';
import { usePreferences } from '../../shared/preferences';
import { formatXp, rankGetFor, rankPerksGet } from './rank-perks-api';
import { rankPerksCopy as copy } from './rank-perks-copy';
import './rank-perks.css';

type ReadContext = { api: ApiClient; owner: string | null; session: Session | null; href: string; departure: number };

function useAccountRead<P extends ContractProcedure<ZodTypeAny, undefined>>(
  context: ReadContext,
  procedure: P,
  isCurrent: (context: ReadContext) => boolean,
) {
  type T = ContractData<P>;
  const [revision, setRevision] = useState(0);
  const [answer, setAnswer] = useState<{ context: ReadContext; revision: number; resource: Resource<T> } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (isCurrent(context)) {
      void readContract(context.api, procedure as ContractProcedure<P['output'], undefined>, undefined, { signal: controller.signal }).then(
        (result) => {
          if (!controller.signal.aborted && isCurrent(context))
            setAnswer({
              context,
              revision,
              resource: result.ok ? { status: 'ready', data: result.data } : { status: 'failed', failure: result },
            });
        },
        () => {
          if (!controller.signal.aborted && isCurrent(context))
            setAnswer({ context, revision, resource: { status: 'failed', failure: authoredRefusal('error', { key: 'loadFailed' }) } });
        },
      );
    }
    return () => controller.abort();
  }, [context, revision, procedure, isCurrent]);
  const resource: Resource<T> =
    answer?.context === context && answer.revision === revision && isCurrent(context) ? answer.resource : { status: 'loading' };
  return {
    resource,
    reload: () => {
      if (isCurrent(context)) setRevision((value) => value + 1);
    },
  };
}

export function RankPerks() {
  const { api, userId: owner, session } = useSession();
  const { t, Copy, requestedLocale } = copy.useCopy();
  const { timeZone } = usePreferences();
  const id = useId();
  const [location, setLocation] = useState(() => ({ href: currentReturnLocation(), departure: 0 }));
  const observed = useRef(location);
  const current = useRef({ api, owner, session });
  current.current = { api, owner, session };
  // Observed departures invalidate even an A→B→A sequence batched into one render.
  useEffect(() => {
    function observe() {
      const href = currentReturnLocation();
      if (href !== observed.current.href) {
        observed.current = { href, departure: observed.current.departure + 1 };
        setLocation(observed.current);
      }
    }
    window.addEventListener('popstate', observe);
    window.addEventListener('hashchange', observe);
    observe();
    return () => {
      window.removeEventListener('popstate', observe);
      window.removeEventListener('hashchange', observe);
    };
  }, []);
  const context = useMemo(() => ({ api, owner, session, ...location }), [api, owner, session, location]);
  const isCurrent = useCallback(
    (original: ReadContext) =>
      original.owner !== null &&
      original.session !== null &&
      current.current.api === original.api &&
      current.current.owner === original.owner &&
      current.current.session === original.session &&
      original.api.canWrite() &&
      observed.current.departure === original.departure &&
      observed.current.href === original.href &&
      currentReturnLocation() === original.href,
    [],
  );
  const rankProcedure = useMemo(() => rankGetFor(owner ?? ''), [owner]);
  const rank = useAccountRead(context, rankProcedure, isCurrent);
  const perks = useAccountRead(context, rankPerksGet, isCurrent);
  if (!owner || !session) return null;

  function failed<T>(resource: Resource<T>, half: 'rank' | 'perks', retry: () => void) {
    if (resource.status !== 'failed') return null;
    const failure = resource.failure;
    return (
      <div data-testid="rank-perks__failure" className="rank-perks__failure" role="status">
        <h3>
          <Copy k={half === 'rank' ? 'failedRank' : 'failedPerks'} />
        </h3>
        <p lang={failure.messageCopy ? uiCopy.forLocale(requestedLocale).languageFor(failure.messageCopy.key) : 'und'}>
          {failure.messageCopy ? uiMessage(failure.messageCopy, requestedLocale) : failure.message}
        </p>
        {failure.reason === 'unauthorized' ? (
          <a
            className="text-link"
            href={`/login?redirect=${encodeURIComponent(currentReturnLocation())}`}
            onClick={(event) => {
              event.currentTarget.href = `/login?redirect=${encodeURIComponent(currentReturnLocation())}`;
            }}
          >
            <Copy k="signIn" />
          </a>
        ) : (
          <Button variant="secondary" onClick={retry}>
            <Copy k={half === 'rank' ? 'retryRank' : 'retryPerks'} />
          </Button>
        )}
      </div>
    );
  }
  const value = rank.resource.status === 'ready' ? rank.resource.data : null;
  const benefit = perks.resource.status === 'ready' ? perks.resource.data : null;
  return (
    <section data-testid="rank-perks" className="rank-perks" aria-label={t('title')}>
      <section data-testid="rank-perks__rank" className="rank-perks__rank" aria-labelledby={`${id}-rank`}>
        <header className="rank-perks__heading">
          <h2 id={`${id}-rank`}>
            <Copy k="rank" />
          </h2>
          <Button variant="secondary" disabled={rank.resource.status === 'loading'} onClick={rank.reload}>
            <Copy k="refreshRank" />
          </Button>
        </header>
        {rank.resource.status === 'loading' && <Loading label={<Copy k="loadingRank" />} />}
        {failed(rank.resource, 'rank', rank.reload)}
        {value && (
          <>
            <p className="rank-perks__number">
              <Copy k="rankValue" params={{ count: value.rank }} />
            </p>
            <dl className="rank-perks__counts">
              {(['xp', 'seasonXp', 'nextRankAt'] as const).map((field) => (
                <div key={field}>
                  <dt>
                    <Copy k={field === 'xp' ? 'xp' : field === 'seasonXp' ? 'season' : 'remaining'} />
                  </dt>
                  <dd lang={requestedLocale}>{value[field] === null ? <Copy k="highest" /> : formatXp(value[field], requestedLocale)}</dd>
                </div>
              ))}
            </dl>
            <p className="rank-perks__updated">
              <Copy k="updated" />{' '}
              <time dateTime={value.updatedAt} lang={requestedLocale}>
                {stamp(value.updatedAt, timeZone)}
              </time>
            </p>
          </>
        )}
      </section>
      <section data-testid="rank-perks__perks" className="rank-perks__perks" aria-labelledby={`${id}-perks`}>
        <header className="rank-perks__heading">
          <h2 id={`${id}-perks`}>
            <Copy k="perks" />
          </h2>
          <Button variant="secondary" disabled={perks.resource.status === 'loading'} onClick={perks.reload}>
            <Copy k="refreshPerks" />
          </Button>
        </header>
        <p className="rank-perks__boundary">
          <Copy k="separate" />
        </p>
        {perks.resource.status === 'loading' && <Loading label={<Copy k="loadingPerks" />} />}
        {failed(perks.resource, 'perks', perks.reload)}
        {benefit && (
          <dl className="rank-perks__rows">
            <div>
              <dt>
                <Copy k="fee" />
              </dt>
              <dd>
                <Copy k="bps" params={{ count: benefit.feeDiscountBps / 100 }} />
              </dd>
            </div>
          </dl>
        )}
        <p className="rank-perks__boundary">
          <Copy k="boundary" />
        </p>
      </section>
    </section>
  );
}
