import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../features/session/session';
import type { ApiResult } from '../../shared/api';
import { settleFailure } from './alerts-model';
import { listAlertTriggers, type AlertTriggerPage } from './notify-api';

export type TriggersState = { status: 'loading' } | { status: 'off' } | { status: 'failed' } | { status: 'ready'; page: AlertTriggerPage };

const LIMIT = 50;
type Failure = Extract<ApiResult<unknown>, { ok: false }>;
const isOff = (failure: Failure) => {
  const settled = settleFailure(failure);
  return settled.kind === 'refused' && (settled.refusal === 'logOff' || settled.refusal === 'notOn');
};

/** The signed-in person's trigger history. A platform that has not set how long it is kept answers `off`, which is not an empty list. */
export function useTriggers() {
  const { api, userId } = useSession();
  const [state, setState] = useState<TriggersState>({ status: 'loading' });
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void listAlertTriggers(api, { limit: LIMIT }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) return setState(isOff(result) ? { status: 'off' } : { status: 'failed' });
      setState({ status: 'ready', page: result.data });
    });
    return () => controller.abort();
  }, [api, userId, cycle]);
  const reload = useCallback(() => setCycle((value) => value + 1), []);
  return { state, reload };
}
