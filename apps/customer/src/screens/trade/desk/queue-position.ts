/**
 * My place in the queue and the estimated fill chance of my resting orders (J-charts-desk-14 #8), read from svc-trade's
 * `GET /api/v1/orders/:id/queue`: the place from matching's native queue, the chance only while the owner has set its
 * window. The desk shows what the service answers and never computes either itself.
 *
 * hand-declared-ok: svc-trade's queue answer has no browser-safe schema in packages/contracts.
 */
import { useMemo } from 'react';
import { z } from 'zod';
import { useDataEnv, useSource } from '../../../data/hooks';
import { constantSource } from '../../../data/source';
import type { Loadable } from '../../../data/types';
import { scaled } from './order-math';

const decimal = z.string().regex(/^\d+(\.\d+)?$/);

export const queuePositionSchema = z.object({
  orderId: z.string(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  price: decimal,
  remaining: decimal,
  ordersAhead: z.number().int().nonnegative(),
  sizeAhead: decimal,
  source: z.literal('native_l3'),
  asOf: z.string(),
  fillProbability: decimal.nullable(),
  fillProbabilityRefusal: z.literal('trade.queue_probability_unset').nullable(),
  windowSeconds: z.number().int().positive().nullable(),
  tradedInWindow: decimal.nullable(),
});
export type QueuePosition = z.infer<typeof queuePositionSchema>;

export type QueueRead = { orderId: string; ok: true; view: QueuePosition } | { orderId: string; ok: false; code: string | null };

export const QUEUE_POLL_MS = 5_000;

/** Each of `orderIds`, read together; one order's refusal never hides another's place. */
export function useQueuePositions(orderIds: readonly string[], enabled: boolean): Loadable<QueueRead[]> {
  const env = useDataEnv();
  const key = orderIds.join(',');
  return useSource(
    useMemo(() => {
      if (!enabled || !env.userId || orderIds.length === 0) return constantSource<QueueRead[]>({ status: 'empty' });
      return env.poller.source<QueueRead[]>(
        `desk-queue:${env.userId}:${key}`,
        async (signal) => {
          const reads = await Promise.all(
            orderIds.map(async (orderId): Promise<QueueRead> => {
              const answer = (await env.api.rest(`/orders/${encodeURIComponent(orderId)}/queue`, queuePositionSchema, { signal })) as
                { ok: true; data: QueuePosition } | { ok: false; code?: string };
              return answer.ok ? { orderId, ok: true, view: answer.data } : { orderId, ok: false, code: answer.code ?? null };
            }),
          );
          return { ok: true as const, data: reads };
        },
        { intervalMs: QUEUE_POLL_MS },
      );
    }, [env, key, enabled]), // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/** A probability from 0 to 1 as a percent with one decimal, floored ("0.4286" is "42.8%"); null for anything else. */
export function percentOf(probability: string): string | null {
  const units = scaled(probability);
  const one = scaled('1')!;
  if (units === null || units < 0n || units > one) return null;
  const permille = (units * 1000n) / one;
  return `${permille / 10n}.${permille % 10n}%`;
}

/** The window in words: whole minutes when it is a whole number of minutes, else seconds. */
export function windowWords(seconds: number): { n: number; unit: 'minutes' | 'seconds' } {
  return seconds % 60 === 0 ? { n: seconds / 60, unit: 'minutes' } : { n: seconds, unit: 'seconds' };
}
