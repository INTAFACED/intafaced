import { useMemo } from 'react';
import type { ApiClient } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { businessListSchema } from '../money/business-schema';
import { businessProfiles, resolveProfile, type BusinessProfile, type ProfileNotice } from './profiles';

/** Rows asked of the bank for the person's business accounts. */
const BUSINESS_PAGE = 50;

export interface Profiles {
  /** `ready`: the list was read. `unread`: it could not be, so only Personal is offered. */
  status: 'loading' | 'ready' | 'unread';
  businesses: BusinessProfile[];
  /** `personal`, or `business:<id>` of a business the person belongs to. */
  active: string;
  business: BusinessProfile | null;
  notice: ProfileNotice | null;
  reload: () => void;
}

/**
 * The person's profiles and the one in view. Signed out there are none and the answer is Personal. The mode the rest of the
 * app reads is derived from this, never set on its own.
 */
export function useProfiles(api: ApiClient, userId: string | null): Profiles {
  const { activeProfile } = usePreferences();
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('bank', 'business.list', { limit: BUSINESS_PAGE }, businessListSchema, { signal })
        : Promise.resolve({ ok: true as const, data: [] }),
    `profiles:${userId ?? 'anon'}`,
  );
  return useMemo(() => {
    const businesses = resource.status === 'ready' ? businessProfiles(resource.data) : [];
    const read = resource.status === 'ready' ? businesses : null;
    const resolved = resolveProfile(activeProfile, read);
    return {
      status: resource.status === 'ready' ? 'ready' : resource.status === 'loading' ? 'loading' : 'unread',
      businesses,
      ...resolved,
      reload,
    };
  }, [resource, activeProfile, reload]);
}
