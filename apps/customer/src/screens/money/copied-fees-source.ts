/** `copy.myCopyFees`: the caller's own copied venue fills, their fees as the venue reports them, and the lead's share. */
import { useMemo } from 'react';
import type { z } from 'zod';
import { COPY_MY_COPY_FEES, type myCopyFeesSchema } from '@intafaced/contracts/trade-copy-procedures';
import { useDataEnv, useSource, type Loadable } from '../../data';
import { constantSource } from '../../data/source';

export type MyCopyFees = z.infer<typeof myCopyFeesSchema>;
export type CopiedFillFees = MyCopyFees['rows'][number];

const READ_EVERY_MS = 5_000;
const PAGE = 100;

export function useMyCopyFees(): Loadable<MyCopyFees> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        env.userId
          ? env.poller.source<MyCopyFees>(
              `copy-my-copy-fees:${env.userId}`,
              (signal) => env.api.call(COPY_MY_COPY_FEES, { limit: PAGE }, { signal }),
              { intervalMs: READ_EVERY_MS },
            )
          : constantSource<MyCopyFees>({ status: 'refused', code: 'auth.required' }),
      [env],
    ),
  );
}
