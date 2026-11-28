/** svc-notify's `telegram.*` records, as the preferences page reads and changes them (J-charts-desk-21 #1, #6). */
import { useMemo } from 'react';
import {
  NOTIFY_TELEGRAM_LINK_CODE,
  NOTIFY_TELEGRAM_STATUS,
  NOTIFY_TELEGRAM_UNLINK,
  type NotifyTelegramStatus,
} from '@intafaced/contracts/notify-telegram-procedures';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import { useDataEnv, useSource, type Loadable } from '../../data';
import type { ApiResult } from '../../shared/api';
import { constantSource } from '../../data/source';

/** While a code waits to be sent, the link state is read this often, so the page shows the link within a few seconds. */
const STATUS_INTERVAL = 3_000;

const statusKey = (userId: string) => `notify-telegram-status:${userId}`;

export function useTelegram(): {
  status: Loadable<NotifyTelegramStatus>;
  linkCode: () => Promise<ApiResult<ProcedureOutput<typeof NOTIFY_TELEGRAM_LINK_CODE>>>;
  unlink: () => Promise<ApiResult<ProcedureOutput<typeof NOTIFY_TELEGRAM_UNLINK>>>;
  refresh: () => void;
} {
  const env = useDataEnv();
  const status = useSource(
    useMemo(
      () =>
        env.userId
          ? env.poller.source<NotifyTelegramStatus>(
              statusKey(env.userId),
              (signal) => env.api.call(NOTIFY_TELEGRAM_STATUS, undefined, { signal }),
              { intervalMs: STATUS_INTERVAL },
            )
          : constantSource<NotifyTelegramStatus>({ status: 'refused', code: 'auth.required' }),
      [env],
    ),
  );
  return useMemo(
    () => ({
      status,
      linkCode: () => env.api.call(NOTIFY_TELEGRAM_LINK_CODE, undefined),
      unlink: () => env.api.call(NOTIFY_TELEGRAM_UNLINK, undefined),
      refresh: () => {
        if (env.userId) env.poller.refresh(statusKey(env.userId));
      },
    }),
    [env, status],
  );
}
