import { useEffect, useMemo } from 'react';
import { z, type ZodType } from 'zod';
import { useSession } from '../../features/session/session';
import { authoredRefusal } from '../../shared/api';
import { useResource, type Resource } from '../../shared/resource';
import type { ActivityFeed, Loadable, PortfolioSummary } from './deps';
import {
  alertStatus,
  buildSteps,
  depositStatus,
  hasMoneyIn,
  hasTrade,
  PAGES_CAP,
  securityStatus,
  tradeStatus,
  verificationStatus,
  type Step,
  type StepStatus,
} from './started';

// Only the fields the checklist reads. The full screens (Verification, Security, Price alerts) hold the strict
// contracts; here an extra field must not make a done step look undone.
const kycAnswer = z.object({ tier: z.string(), records: z.array(z.object({ status: z.string() }).passthrough()) }).passthrough();
const passkeysAnswer = z.array(z.object({ credentialId: z.string() }).passthrough());
const alertsAnswer = z.object({ items: z.array(z.object({ kind: z.string(), status: z.string() }).passthrough()) }).passthrough();

/** The answers Home already holds; the other three steps read their own. */
export interface StartedInputs {
  portfolio: Loadable<PortfolioSummary>;
  activity: Loadable<ActivityFeed>;
}

/** One read of a service answer, only while the list is on screen. */
function useProbe<T>(enabled: boolean, name: string, module: string, procedure: string, input: unknown, schema: ZodType<T>): Resource<T> {
  const { api, userId } = useSession();
  return useResource(
    (signal) =>
      enabled && userId
        ? api.query(module, procedure, input, schema, { signal })
        : Promise.resolve(authoredRefusal('aborted', { key: 'beforeDispatch' })),
    `started-${name}:${userId}:${enabled}`,
  ).resource;
}

const fromProbe = <T>(resource: Resource<T>, read: (data: T) => StepStatus): StepStatus =>
  resource.status === 'loading' ? 'checking' : resource.status === 'failed' ? 'unknown' : read(resource.data);

/**
 * The five Get started steps with their real status. Verification, passkeys and price alerts are read once when the
 * list is first drawn; the balance and the money history are the ones Home already holds. A read that fails is
 * `unknown`, never `done`.
 */
export function useGetStarted({ portfolio, activity }: StartedInputs, enabled: boolean): Step[] {
  const kyc = useProbe(enabled, 'kyc', 'identity', 'kyc.status', { limit: 10 }, kycAnswer);
  const passkeys = useProbe(enabled, 'passkeys', 'identity', 'webauthn.list', { limit: 10 }, passkeysAnswer);
  const alerts = useProbe(enabled, 'alerts', 'notify', 'notify.alerts', { limit: 100 }, alertsAnswer);

  // Looking for a first trade: read one more page of the history at a time (the feed never polls).
  const feed = activity.status === 'ready' ? activity.data : null;
  const read = feed?.items.length ?? 0;
  const tradeFound = feed ? hasTrade(feed.items) : false;
  useEffect(() => {
    if (enabled && feed && !tradeFound && read < PAGES_CAP && feed.hasMore && !feed.loadingMore && !feed.moreFailed) feed.loadMore();
  }, [enabled, feed, tradeFound, read]);

  return useMemo(() => {
    const balance =
      portfolio.status === 'loading'
        ? 'loading'
        : portfolio.status === 'empty' || (portfolio.status === 'ready' && portfolio.data.holdings.length === 0)
          ? 'none'
          : portfolio.status === 'ready'
            ? 'held'
            : 'failed';

    // Older rows may hold the first deposit while the pager above is still reading; until it stops, "none" is a guess.
    const paging = feed !== null && feed.hasMore && !feed.moreFailed && !tradeFound && read < PAGES_CAP;
    const history =
      activity.status === 'loading' || paging
        ? 'loading'
        : activity.status === 'empty'
          ? 'none'
          : feed
            ? hasMoneyIn(feed.items)
              ? 'in'
              : feed.moreFailed
                ? 'failed'
                : 'none'
            : 'failed';
    const trades =
      activity.status === 'loading'
        ? 'loading'
        : activity.status === 'empty'
          ? 'empty'
          : feed
            ? feed.moreFailed && !tradeFound
              ? 'failed'
              : { trade: tradeFound, hasMore: feed.hasMore, read }
            : 'failed';

    return buildSteps({
      verify: fromProbe(kyc, verificationStatus),
      secure: fromProbe(passkeys, (data) => securityStatus(data.length)),
      deposit: depositStatus(balance, history),
      trade: tradeStatus(trades),
      alert: fromProbe(alerts, (data) => alertStatus(data.items)),
    });
  }, [kyc, passkeys, alerts, portfolio, activity, feed, tradeFound, read]);
}
