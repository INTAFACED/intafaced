import { HOME_CONFIG_PROCEDURE, homeConfigOutputSchema } from '@intafaced/contracts/home-work-items';
import { useSession } from '../../features/session/session';
import { useResource } from '../../shared/resource';

/**
 * How many of the newest movements Home's Recent activity lists: the owner's value from svc-ops' `home.config`
 * (`recentActivityLimit`, HM-dashboard-04). Blank is `unset` and the list says "not set" with
 * `home.recent_activity_limit_unset`; Home never falls back to a count of its own.
 */
export type ActivityLimit =
  { state: 'loading' } | { state: 'ready'; count: number } | { state: 'unset' } | { state: 'failed'; retry: () => void };

export function useRecentActivityLimit(): ActivityLimit {
  const { api } = useSession();
  const config = useResource(
    (signal) => api.query('ops', HOME_CONFIG_PROCEDURE, undefined, homeConfigOutputSchema, { signal }),
    'home-config',
  );
  const resource = config.resource;
  if (resource.status === 'loading') return { state: 'loading' };
  if (resource.status === 'failed') return { state: 'failed', retry: config.reload };
  const count = resource.data.recentActivityLimit;
  return count === null ? { state: 'unset' } : { state: 'ready', count };
}
