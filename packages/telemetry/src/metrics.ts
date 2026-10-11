/**
 * PROMETHEUS METRICS — the numbers an SLO panel is drawn from (§14.5).
 *
 * ── What was actually missing ───────────────────────────────────────────────
 *
 * `./start.ts` fixed the TRACE half: it registers a real `NodeTracerProvider`,
 * so the spans every service was already writing now reach Tempo. The METRIC
 * half had no equivalent, and its absence was total rather than partial —
 * verified on this branch before a line was written:
 *
 *   · `prom-client`, `text/plain; version=0.0.4` and `http_request_duration`
 *     appear NOWHERE under `services/` or `packages/`.
 *   · `tooling/infra/prometheus.yaml` scraped `localhost:9090` (itself) and
 *     `nats:8222`. Not one application target.
 *   · `tooling/infra/grafana/` held a datasource provisioning file and nothing
 *     else — no dashboard, and no provider that could have loaded one.
 *
 * So Grafana pointed at a Prometheus that held no application series, and §14's
 * "at least one SLO dashboard panel" had nothing it could have plotted.
 *
 * ── Why this lives in the shared package, not in one service ────────────────
 *
 * §14 says "per module". Nineteen services cannot each invent a metric name and
 * still be one dashboard: `svc-trade` emitting `trade_requests_total` and
 * `svc-pay` emitting `pay_http_total` is nineteen dashboards and no fleet view.
 * The series names, the label set and the bucket boundaries are decided HERE,
 * once, so the panel that works for the edge works for the next adopter with no
 * dashboard change — the new service simply appears as another `service=` value.
 *
 * ── Why no `prom-client` ────────────────────────────────────────────────────
 *
 * It was considered and rejected, not overlooked. `prom-client` is a reasonable
 * library, but the exposition format below is roughly eighty lines, it is
 * frozen (0.0.4), and this repo's supply-chain ratchet (`pnpm scan:deps`) makes
 * every new runtime dependency a standing cost. The deciding argument is that a
 * dependency would not have removed the hard part: the risk here was never
 * "can we format a histogram", it was "does anything scrape it, and does the
 * dashboard name the series we actually emit". A library answers neither, and
 * both are answered by tests in this change. What the format costs us in
 * hand-written code is repaid by `promtool check metrics` — the real Prometheus
 * parser — being run against this module's output; see `metrics.test.ts` and
 * the PR body.
 *
 * ── Not a public surface ────────────────────────────────────────────────────
 *
 * The labels below are route names, status classes and auth outcomes. No user
 * id, no amount, no path an attacker chose. It is still an INTERNAL endpoint:
 * whatever ingress sits in front of a service must not route `/metrics`, the
 * same way it must not route `/admin/*`. That is a deployment property this
 * module cannot enforce and does not pretend to.
 */

/** Exposition format version this module emits. Send it as the `content-type`. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** The counter family name. Exported so tests and tooling never retype it. */
export const REQUESTS_TOTAL = 'intafaced_http_requests_total';

/** The histogram family name. Exported for the same reason. */
export const REQUEST_DURATION_SECONDS = 'intafaced_http_request_duration_seconds';

/**
 * Histogram buckets, in seconds.
 *
 * Chosen around the numbers §20 actually names — "< 2s incl. on-chain JIT
 * conversion" for a card auth decision, sub-second perp finality — rather than
 * a library default, so the quantiles anyone cares about land BETWEEN buckets
 * that exist. A p99 reportable only as "somewhere between 0.5s and 5s" is not
 * an SLO, it is a shrug with a chart.
 */
export const DURATION_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** HTTP methods that may appear as a label value. Anything else becomes `_other`. */
const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/**
 * The label set, and every field is bounded on purpose.
 *
 * CARDINALITY IS THE FAILURE MODE OF A METRICS ENDPOINT ON A PUBLIC DOOR. A
 * label whose values come from a URL turns a thousand requests to
 * `/api/trade/aaa…` into a thousand permanent series in Prometheus — a
 * write-amplification attack that survives the attacker leaving. Every field
 * here draws from a finite set known at build time, and `Metrics.observe`
 * enforces a hard cap on top of that as a second line.
 */
export interface HttpRequestLabels {
  /**
   * Which service emitted the sample — `svc-edge`, `svc-pay`, …
   *
   * Deliberately IN THE EXPOSITION rather than attached by the scrape config.
   * A `labels:` block in `prometheus.yaml` that sets a label the payload also
   * sets does not overwrite it — Prometheus renames the scraped one to
   * `exported_service` and the dashboard silently matches nothing. Emitting it
   * here and NOT setting it in the scrape config is one owner for one label;
   * `observability-wiring.test.ts` in svc-edge asserts the two never collide.
   */
  readonly service: string;
  /**
   * The module the request was for — `trade`, `identity`, … — or one of the
   * reserved values below. Comes from a route table, so the set is finite.
   */
  readonly module: string;
  /** HTTP method, upper-case, from `KNOWN_METHODS`. */
  readonly method: string;
  /** `2xx` | `3xx` | `4xx` | `5xx` — the class, never the code. */
  readonly status: string;
  /** How the caller presented: `authenticated` | `anonymous` | `refused` | `none`. */
  readonly outcome: string;
}

/** A request the service answered itself (`/health`, `/ready`, `/metrics`). */
export const MODULE_LOCAL = '_local';
/** A path that matched no upstream — a 404 from the front door. */
export const MODULE_UNROUTED = '_unrouted';
/** Module label on the one overflow series. Past the cap, see `observe`. */
export const MODULE_OVERFLOW = '_overflow';

/**
 * The only series a full map may insert or update for a new key.
 * Every field is constant. Keeping the caller's service, method, status, or
 * outcome would open another series per combination.
 */
const OVERFLOW_LABELS: HttpRequestLabels = {
  service: MODULE_OVERFLOW,
  module: MODULE_OVERFLOW,
  method: MODULE_OVERFLOW,
  status: MODULE_OVERFLOW,
  outcome: MODULE_OVERFLOW,
};

interface Series {
  readonly labels: HttpRequestLabels;
  count: number;
  sum: number;
  readonly buckets: number[];
}

/** `2xx`/`3xx`/`4xx`/`5xx` from a status code. Anything unrecognised is `5xx`. */
export function statusClass(status: number): string {
  if (!Number.isFinite(status) || status < 100 || status >= 600) return '5xx';
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return '2xx';
}

/** Clamp a method to the known set so the label cannot be caller-chosen. */
export function methodLabel(method: string | undefined): string {
  const upper = (method ?? '').toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : '_other';
}

function labelKey(l: HttpRequestLabels): string {
  return [l.service, l.module, l.method, l.status, l.outcome].join('\u0000');
}

/**
 * Per the exposition spec, a label value escapes exactly three things: the
 * backslash, the double quote and the line feed. Nothing else — over-escaping
 * produces a value that parses but does not equal what the dashboard matches.
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/** A HELP docstring escapes the backslash and the line feed, but NOT the quote. */
function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function renderLabels(l: HttpRequestLabels, extra?: Record<string, string>): string {
  const pairs = [
    `service="${escapeLabelValue(l.service)}"`,
    `module="${escapeLabelValue(l.module)}"`,
    `method="${escapeLabelValue(l.method)}"`,
    `status="${escapeLabelValue(l.status)}"`,
    `outcome="${escapeLabelValue(l.outcome)}"`,
    ...Object.entries(extra ?? {}).map(([k, v]) => `${k}="${escapeLabelValue(v)}"`),
  ];
  return `{${pairs.join(',')}}`;
}

/**
 * Sample values go out as plain `String(n)`.
 *
 * Checked rather than assumed, because this is the kind of detail that makes a
 * target go DOWN with a parse error: `String(1)` is `1`, `String(0.1+0.2)` is
 * `0.30000000000000004`, and `String(1e-7)` is `1e-7`. The exposition grammar
 * accepts all three — its sample value is a Go `ParseFloat`, which takes
 * exponent notation — so no custom formatter is warranted. `promtool check
 * metrics` is run over real output in `metrics.test.ts` to keep that honest.
 */
function sample(value: number): string {
  return String(value);
}

/**
 * A single-process metrics registry.
 *
 * PER-PROCESS ON PURPOSE. Prometheus scrapes each replica separately and
 * aggregates with `sum by (...)`, so per-process counters are the correct
 * shape. A shared store behind several replicas produces one series whose
 * resets no `rate()` can interpret, which is worse than no metric because it
 * looks like a metric.
 */
export class Metrics {
  private readonly series = new Map<string, Series>();

  /**
   * @param maxSeries Hard cap on distinct caller label combinations. One constant
   *   overflow series may sit past it. 2000 is far above
   *   what the bounded label set can legitimately produce (19 services × ~20
   *   modules × 7 methods × 4 classes is the theoretical ceiling for the whole
   *   fleet, and one process sees one service's slice of it), so hitting it
   *   means something is generating labels it should not be.
   */
  constructor(private readonly maxSeries = 2_000) {}

  /** Record one finished request. `durationSeconds`, not milliseconds. */
  observe(labels: HttpRequestLabels, durationSeconds: number): void {
    let key = labelKey(labels);
    let stored = labels;

    // At the cap, a new key folds into one constant series. Insert that series
    // once if it is missing, then update it. Dropping the sample would
    // understate the request count. Size stays at most maxSeries + 1. A key
    // that is already stored still updates, under the cap or not.
    if (!this.series.has(key) && this.series.size >= this.maxSeries) {
      stored = OVERFLOW_LABELS;
      key = labelKey(stored);
    }

    let s = this.series.get(key);
    if (!s) {
      s = { labels: stored, count: 0, sum: 0, buckets: new Array<number>(DURATION_BUCKETS.length).fill(0) };
      this.series.set(key, s);
    }

    // A negative duration is a broken clock, not a fast request. Clamp rather
    // than drop: losing the request from `_count` would understate the
    // denominator of every availability ratio drawn from it.
    const seconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;

    s.count += 1;
    s.sum += seconds;
    for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
      if (seconds <= (DURATION_BUCKETS[i] as number)) s.buckets[i] = (s.buckets[i] as number) + 1;
    }
  }

  /** How many distinct series are held. For the cap's own test. */
  size(): number {
    return this.series.size;
  }

  /**
   * The full exposition, in Prometheus text format 0.0.4.
   *
   * Both families are emitted even when empty. A `# TYPE` line with no samples
   * is valid, and it is the difference between "this service has served no
   * requests yet" and "this service does not have this metric" — which are the
   * same blank panel unless the endpoint says which one it is.
   */
  render(): string {
    const lines: string[] = [
      `# HELP ${REQUESTS_TOTAL} ${escapeHelp('Requests answered, by service, module, method, status class and auth outcome.')}`,
      `# TYPE ${REQUESTS_TOTAL} counter`,
    ];

    for (const s of this.series.values()) {
      lines.push(`${REQUESTS_TOTAL}${renderLabels(s.labels)} ${sample(s.count)}`);
    }

    lines.push(
      `# HELP ${REQUEST_DURATION_SECONDS} ${escapeHelp('Request latency in seconds, measured where the promise to the caller was made.')}`,
      `# TYPE ${REQUEST_DURATION_SECONDS} histogram`,
    );

    for (const s of this.series.values()) {
      for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
        lines.push(
          `${REQUEST_DURATION_SECONDS}_bucket${renderLabels(s.labels, { le: String(DURATION_BUCKETS[i]) })} ${sample(s.buckets[i] as number)}`,
        );
      }
      // `+Inf` must equal `_count` or the histogram is malformed and
      // `histogram_quantile` returns nonsense rather than an error.
      lines.push(`${REQUEST_DURATION_SECONDS}_bucket${renderLabels(s.labels, { le: '+Inf' })} ${sample(s.count)}`);
      lines.push(`${REQUEST_DURATION_SECONDS}_sum${renderLabels(s.labels)} ${sample(s.sum)}`);
      lines.push(`${REQUEST_DURATION_SECONDS}_count${renderLabels(s.labels)} ${sample(s.count)}`);
    }

    // The trailing newline is REQUIRED. A payload whose last line has no `\n`
    // is rejected by the Prometheus parser, and the target goes DOWN with a
    // parse error that never reaches the service's own logs.
    return `${lines.join('\n')}\n`;
  }
}

/**
 * Every metric family name this module can emit.
 *
 * Exists so a dashboard can be checked against the CODE rather than against
 * somebody's memory of the code. `observability-wiring.test.ts` reads the
 * committed panel JSON, pulls the metric names out of its PromQL, and asserts
 * each one is in this list — which is the check that would have caught a panel
 * querying `http_request_duration_seconds` while the service emitted
 * `intafaced_http_request_duration_seconds`. That mistake is a green diff and a
 * blank chart, and nothing else in a normal test suite sees it.
 */
export const METRIC_FAMILIES: readonly string[] = [
  REQUESTS_TOTAL,
  `${REQUEST_DURATION_SECONDS}_bucket`,
  `${REQUEST_DURATION_SECONDS}_sum`,
  `${REQUEST_DURATION_SECONDS}_count`,
];

/** Label names the exposition emits. Used to prove the scrape config adds none of them. */
export const EMITTED_LABEL_NAMES: readonly string[] = ['service', 'module', 'method', 'status', 'outcome'];
