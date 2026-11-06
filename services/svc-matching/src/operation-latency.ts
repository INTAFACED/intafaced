import { DURATION_BUCKETS } from '@intafaced/telemetry';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The engine's own latency and throughput per order operation, for the founder console's venue health (J-cex-spot-20 #1).
 *
 * The scrape at `/metrics` keeps every reply under one `_local` module label, so it cannot say how long a submit took apart
 * from a depth read. This keeps a small histogram per operation, on the same bucket bounds as the scrape, since the engine
 * started. `GET /health` carries it. An operation with no reply timed yet has no latency: its count is 0 and both
 * percentiles are null, which the console shows as `matching_metrics_unread`, never as 0 ms.
 */

export const OPERATIONS = ['submit', 'cancel', 'depth'] as const;
export type Operation = (typeof OPERATIONS)[number];

/** The route each operation is served on (Fastify's route pattern, not the URL, so a market id is never a label). */
const ROUTES: Readonly<Record<string, Operation>> = {
  'POST /markets/:marketId/orders': 'submit',
  'DELETE /markets/:marketId/orders/:orderId': 'cancel',
  'GET /markets/:marketId/depth': 'depth',
};

export function operationOf(method: string, routePattern: string | undefined): Operation | null {
  if (!routePattern) return null;
  return ROUTES[`${method.toUpperCase()} ${routePattern}`] ?? null;
}

export interface OperationReading {
  /** Replies timed since the engine started. */
  readonly count: number;
  /** Of those, how many answered 5xx. */
  readonly errors: number;
  /** The upper bound, in ms, of the bucket that holds the 50th and 99th percentile; null with no reply timed. */
  readonly p50Ms: number | null;
  readonly p99Ms: number | null;
  /** Replies per minute, averaged over the whole time since timing began (not a current rate), to two decimals; "0" with none. */
  readonly perMinute: string;
}

export interface LatencyBody {
  readonly startedAt: string;
  readonly operations: Readonly<Record<Operation, OperationReading>>;
  /**
   * Submit latency per engine market, one entry for every market the engine has; a market with no submit timed since the
   * engine started has count 0 and no percentile (the console's `matching_metrics_unread`).
   */
  readonly submitByMarket: Readonly<Record<string, OperationReading>>;
}

/** The bucket bounds in ms, with the last bucket open-ended (Infinity). */
const BOUNDS_MS: readonly number[] = [...DURATION_BUCKETS.map((s) => Math.round(s * 1000)), Number.POSITIVE_INFINITY];

export class OperationLatency {
  private readonly counts = new Map<Operation, number[]>();
  private readonly errors = new Map<Operation, number>();
  private readonly submitMarkets = new Map<string, { buckets: number[]; errors: number }>();

  constructor(private readonly startedAt: Date) {
    for (const op of OPERATIONS) {
      this.counts.set(
        op,
        BOUNDS_MS.map(() => 0),
      );
      this.errors.set(op, 0);
    }
  }

  /** `marketId` counts a submit for that market too; the caller passes only an id the engine has (never a raw URL value). */
  observe(op: Operation, ms: number, status: number, marketId?: string): void {
    const i = BOUNDS_MS.findIndex((b) => ms <= b);
    const at = i === -1 ? BOUNDS_MS.length - 1 : i;
    const buckets = this.counts.get(op)!;
    buckets[at] = (buckets[at] ?? 0) + 1;
    if (status >= 500) this.errors.set(op, this.errors.get(op)! + 1);
    if (op === 'submit' && marketId !== undefined) {
      const m = this.submitMarkets.get(marketId) ?? { buckets: BOUNDS_MS.map(() => 0), errors: 0 };
      m.buckets[at] = (m.buckets[at] ?? 0) + 1;
      if (status >= 500) m.errors += 1;
      this.submitMarkets.set(marketId, m);
    }
  }

  read(now: Date, markets: readonly string[] = []): LatencyBody {
    const minutes = Math.max(now.getTime() - this.startedAt.getTime(), 1) / 60_000;
    const reading = (buckets: readonly number[], errors: number): OperationReading => {
      const count = buckets.reduce((n, c) => n + c, 0);
      return {
        count,
        errors,
        p50Ms: percentileBound(buckets, count, 50),
        p99Ms: percentileBound(buckets, count, 99),
        perMinute: count === 0 ? '0' : (count / minutes).toFixed(2),
      };
    };
    const operations = {} as Record<Operation, OperationReading>;
    for (const op of OPERATIONS) operations[op] = reading(this.counts.get(op)!, this.errors.get(op)!);
    const empty = BOUNDS_MS.map(() => 0);
    const submitByMarket: Record<string, OperationReading> = {};
    for (const marketId of [...markets].sort()) {
      const m = this.submitMarkets.get(marketId);
      submitByMarket[marketId] = reading(m?.buckets ?? empty, m?.errors ?? 0);
    }
    return { startedAt: this.startedAt.toISOString(), operations, submitByMarket };
  }
}

/**
 * The upper bound of the bucket holding the p-th percentile reply. A reply slower than the last finite bound is reported as
 * that bound's successor, Infinity, which is not JSON: it is written as null with the count still showing, so the console
 * says "over 10000 ms" rather than a number nobody measured. Null with no reply timed.
 */
function percentileBound(buckets: readonly number[], count: number, p: number): number | null {
  if (count === 0) return null;
  const rank = Math.ceil((count * p) / 100);
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i]!;
    if (seen >= rank) return Number.isFinite(BOUNDS_MS[i]!) ? BOUNDS_MS[i]! : null;
  }
  return null;
}

/**
 * Times every reply of the three operations from the request's arrival (Fastify's `elapsedTime`), so body parsing and the
 * service-auth checks are in the figure, as they are in the `/metrics` scrape.
 */
export function registerOperationLatency(
  app: FastifyInstance,
  latency: OperationLatency,
  /** Whether an id from the route is a market the engine has; only those get a per-market reading. */
  isMarket: (marketId: string) => boolean = () => false,
): void {
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const op = operationOf(req.method, req.routeOptions?.url);
    if (!op) return;
    const raw = (req.params as { marketId?: unknown } | undefined)?.marketId;
    const marketId = typeof raw === 'string' && isMarket(raw) ? raw : undefined;
    latency.observe(op, reply.elapsedTime, reply.statusCode, marketId);
  });
}
