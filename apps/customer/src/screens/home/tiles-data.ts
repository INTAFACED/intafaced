import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  HOME_TILES_NAMESPACE,
  homeTilesPreferenceSchema,
  homeTilesRequestId,
  homeTilesValueSchema,
  type HomeTilesValue,
} from '@intafaced/contracts/home-tiles-preferences';
import { useSession } from '../../features/session/session';
import type { ApiResult } from '../../shared/api';

const storedSchema = homeTilesPreferenceSchema.extend({ outcome: z.literal('stored') });

/** This device's copy of the account's layout, so the first paint already has it. The account record wins once read. */
const deviceKey = (userId: string) => `intafaced.customer.home.tiles.v1:${userId}`;
function readDevice(userId: string | null): HomeTilesValue | null {
  if (!userId) return null;
  try {
    const parsed = homeTilesValueSchema.safeParse(JSON.parse(localStorage.getItem(deviceKey(userId)) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function writeDevice(userId: string, value: HomeTilesValue | null): void {
  try {
    if (value) localStorage.setItem(deviceKey(userId), JSON.stringify(value));
    else localStorage.removeItem(deviceKey(userId));
  } catch {
    /* a blocked store only costs the first paint */
  }
}

const isConflict = (result: Extract<ApiResult<unknown>, { ok: false }>) =>
  result.status === 409 || result.code === 'CONFLICT' || result.message.includes('preferences.version_conflict');

export type SaveOutcome = 'saved' | 'conflict' | 'not-saved';
export interface HomeLayout {
  /** The account's layout, or null while nothing is stored (Home shows its shipped order). */
  layout: HomeTilesValue | null;
  /** Whether the account's record has been read on this visit. */
  read: boolean;
  /**
   * Store `next` on the account, compare-and-set on the version read. When another device changed the layout first, the
   * newer one is read and kept, and the answer is `conflict`: this device's change is not written over it.
   */
  save: (next: HomeTilesValue | null) => Promise<SaveOutcome>;
}

/** The account's Home layout (`home.tiles` through the identity preferences door). */
export function useHomeLayout(): HomeLayout {
  const { api, userId } = useSession();
  const [layout, setLayout] = useState<HomeTilesValue | null>(() => readDevice(userId));
  const [read, setRead] = useState(false);
  const version = useRef(0);
  const shown = useRef(layout);
  shown.current = layout;

  const adopt = useCallback(
    (nextVersion: number, value: HomeTilesValue | null) => {
      version.current = nextVersion;
      setLayout(value);
      setRead(true);
      if (userId) writeDevice(userId, value);
    },
    [userId],
  );

  const reread = useCallback(
    async (signal?: AbortSignal): Promise<boolean> => {
      if (!userId) return false;
      const result = await api.query('identity', 'preferences.get', { namespace: HOME_TILES_NAMESPACE }, homeTilesPreferenceSchema, {
        signal,
      });
      if (!result.ok) return false;
      adopt(result.data.version, result.data.value);
      return true;
    },
    [api, userId, adopt],
  );

  useEffect(() => {
    setLayout(readDevice(userId));
    setRead(false);
    const controller = new AbortController();
    void reread(controller.signal);
    return () => controller.abort();
  }, [userId, reread]);

  const save = useCallback(
    async (next: HomeTilesValue | null): Promise<SaveOutcome> => {
      if (!userId) return 'not-saved';
      if (!read && !(await reread())) return 'not-saved';
      const ifVersion = version.current;
      const before = shown.current;
      // Show the choice at once; the account's answer then confirms it, replaces it (conflict) or takes it back.
      setLayout(next);
      // Reset stores the empty layout: nothing chosen, so Home shows its shipped order on every device.
      const value = next ?? { order: [], hidden: [] };
      const result = await api.mutate(
        'identity',
        'preferences.set',
        { namespace: HOME_TILES_NAMESPACE, value, ifVersion, clientRequestId: homeTilesRequestId(userId, ifVersion, value) },
        storedSchema,
      );
      if (result.ok) {
        adopt(result.data.version, result.data.value);
        return 'saved';
      }
      if (isConflict(result)) {
        if (!(await reread())) setLayout(before);
        return 'conflict';
      }
      setLayout(before);
      return 'not-saved';
    },
    [api, userId, read, reread, adopt],
  );

  return { layout, read, save };
}
