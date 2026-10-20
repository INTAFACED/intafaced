import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../features/session/session';
import { readAlertQuota, type AlertQuota } from './notify-api';

export type QuotaState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; quota: AlertQuota };

/** The signed-in person's alert quota. A failed read blocks nothing: the service still refuses a create past the cap. */
export function useAlertQuota() {
  const { api, userId } = useSession();
  const [state, setState] = useState<QuotaState>({ status: 'loading' });
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void readAlertQuota(api, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setState(result.ok ? { status: 'ready', quota: result.data } : { status: 'failed' });
    });
    return () => controller.abort();
  }, [api, userId, cycle]);
  const reload = useCallback(() => setCycle((value) => value + 1), []);
  return { state, reload };
}
