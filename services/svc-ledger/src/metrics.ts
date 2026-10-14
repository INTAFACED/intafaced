import { Metrics, MODULE_LOCAL, PROMETHEUS_CONTENT_TYPE, methodLabel, statusClass } from '@intafaced/telemetry';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * THE BOOK'S SCRAPE SURFACE.
 *
 * `@intafaced/telemetry` owns the series names, the label set, the buckets and
 * the exposition format — same contract as svc-edge, so a second adopter appears
 * as another `service=` value on the same panel. What lives HERE is the
 * Fastify-shaped part: when to observe, what to call the module, and the route
 * that serves the text.
 *
 * ── Why ledger, when the SLO is measured at the edge ────────────────────────
 *
 * §20's numbers are promises to a USER, and those are still measured at
 * svc-edge. This endpoint is not a second SLO. It is the process scrape for
 * the book: post / freeze / reconcile latency on THIS hop, so an operator can
 * tell "the book is the slow part" from "the queue in front of it is".
 *
 * Ledger is not a proxy. Every request this process answers is local work, so
 * the module label is always `_local` — never a path, never an upstream name.
 * A label whose value came from a URL is a cardinality bomb; we do not have
 * one to parse.
 */

export interface MetricsOptions {
  /** Value of the `service` label. Pass `env.SERVICE_NAME`. */
  readonly service: string;
  /** Path the endpoint is served on. Must match `metrics_path` in prometheus.yaml. */
  readonly path?: string;
  /** Inject a registry in tests. Defaults to a fresh one. */
  readonly registry?: Metrics;
  /**
   * Extra gauges, read on each scrape and appended to the exposition. A provider that
   * throws is skipped: a scrape must never fail because a database read did.
   */
  readonly gauges?: () => Promise<readonly GaugeSample[]>;
}

/** One gauge. `value` is exposition text so a bigint seq never passes through a JS number. */
export interface GaugeSample {
  readonly name: string;
  readonly help: string;
  readonly value: string;
}

/** The path this service serves the exposition on. The scrape config must agree. */
export const METRICS_PATH = '/metrics';

/**
 * Which module a finished request was for.
 *
 * Always `_local`. Ledger has no `UPSTREAMS` table and no `/api/` prefix to
 * split. The argument is accepted so the hook and the tests share one function
 * rather than a constant in one place and a different string in the other.
 */
export function moduleLabel(_rawUrl: string): string {
  return MODULE_LOCAL;
}

/**
 * Register the observation hook and the scrape route.
 *
 * Returns the registry so a test can read it directly — but every test in
 * `metrics.test.ts` goes through `app.inject()` and reads the RESPONSE BODY
 * instead. A registry that counts correctly while the route is unmounted is
 * the exact failure this repo has shipped seven times.
 */
export function registerMetrics(app: FastifyInstance, options: MetricsOptions): Metrics {
  const registry = options.registry ?? new Metrics();
  const path = options.path ?? METRICS_PATH;

  /**
   * `onResponse` fires for EVERY reply — including 404s and handler throws.
   * An availability number computed only over requests that reached a handler
   * is an availability number that goes green during an outage.
   */
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const seconds = reply.elapsedTime / 1000;

    registry.observe(
      {
        service: options.service,
        module: moduleLabel(req.url),
        method: methodLabel(req.method),
        status: statusClass(reply.statusCode),
        // Ledger is not a proxy and does not run principal exchange. Service
        // credentials live on individual write routes; they are not an auth
        // outcome this hook can see without teaching it the router.
        outcome: 'none',
      },
      seconds,
    );
  });

  app.get(path, async (_req, reply) => {
    // The content type is not decoration. Prometheus negotiates on it, and a
    // payload served as `application/json` is a target that scrapes, parses
    // nothing and reports itself UP with zero series.
    let extra = '';
    if (options.gauges) {
      try {
        extra = renderGauges(await options.gauges(), options.service);
      } catch {
        extra = '';
      }
    }
    return reply.header('content-type', PROMETHEUS_CONTENT_TYPE).send(registry.render() + extra);
  });

  return registry;
}

/** Prometheus text 0.0.4 for plain gauges. Names are the caller's constants, never request input. */
function renderGauges(samples: readonly GaugeSample[], service: string): string {
  let out = '';
  for (const sample of samples) {
    out += `# HELP ${sample.name} ${sample.help}\n`;
    out += `# TYPE ${sample.name} gauge\n`;
    out += `${sample.name}{service="${service.replace(/[\\"\n]/g, '')}"} ${sample.value}\n`;
  }
  return out;
}

/**
 * The reconciliation gauges. 0 means "never proved", which an alert on
 * `time() - ledger_reconcile_last_verified_timestamp_seconds` treats as stale.
 */
export function reconcileGauges(last: { at: Date | null; seq: string | null }): GaugeSample[] {
  return [
    {
      name: 'ledger_reconcile_last_verified_timestamp_seconds',
      help: 'Unix time of the last reconciliation run that proved the book consistent (0 = never).',
      value: last.at ? String(Math.floor(last.at.getTime() / 1000)) : '0',
    },
    {
      name: 'ledger_reconcile_last_verified_seq',
      help: 'chain_tip seq the last ok reconciliation run covered (0 = never).',
      value: last.seq ?? '0',
    },
  ];
}
