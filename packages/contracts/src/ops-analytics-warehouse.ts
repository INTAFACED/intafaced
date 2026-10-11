/**
 * OPS ANALYTICS — Stage-1 warehouse read replica + honest empty surface
 * (TRK-ops.analytics).
 *
 * Slice A law in code:
 *   · which source DBs may feed a read replica
 *   · analytics connections are read-only (never writer credentials on primary)
 *   · lag fail-closed for "live" labels
 *   · empty / unconfigured warehouse → empty|unavailable — never invent volume
 *
 * No warehouse process, no OLTP write, no fabricated trading KPIs.
 */

import { z } from 'zod';
import {
  ANALYTICS_SOURCE_DBS,
  assertMetricPoint,
  lagFreshness,
  mayLabelLive,
  type AnalyticsSourceDb,
  type LagFreshness,
} from './ops-analytics.js';
import type { CubeFactRow, CubePoint } from './ops-analytics-cube.js';
import { evaluateCubeFixtures } from './ops-analytics-cube.js';

/** Replica sources documented for Stage-1 (OLTP remains SoT). */
export const WAREHOUSE_REPLICA_SOURCES = ANALYTICS_SOURCE_DBS;

/** Only read-only roles may attach to analytics replica URLs. */
export const ANALYTICS_REPLICA_ROLES = ['readonly'] as const;
export type AnalyticsReplicaRole = (typeof ANALYTICS_REPLICA_ROLES)[number];

/**
 * Writer / primary role name fragments that MUST NOT appear in analytics
 * connection strings. Fail-closed: if the URL looks like a service writer, refuse.
 */
export const FORBIDDEN_ANALYTICS_WRITER_USER_FRAGMENTS = [
  'svc_ledger',
  'svc_trade',
  'svc_identity',
  'intafaced_ops',
  'postgres',
  'migrator',
  'owner',
  'admin',
  'writer',
  'rw_',
] as const;

/**
 * Writer words no read-only marker may rescue.
 *
 * `admin_ro` is still admin. These are refused before the marker is consulted —
 * which is the half the original ordering got wrong.
 */
const NEVER_READONLY_USER_FRAGMENTS = ['postgres', 'migrator', 'owner', 'admin', 'writer', 'rw_'] as const;

/**
 * Service-owned names a genuine read-only marker DOES rescue.
 *
 * This is the documented intent — "`svc_ledger_ro` is allowed; bare
 * `svc_ledger` is not" — and it is the only class where a marker wins.
 */
const SERVICE_OWNED_USER_FRAGMENTS = ['svc_ledger', 'svc_trade', 'svc_identity', 'intafaced_ops'] as const;

/**
 * Read-only username markers, matched as a SUFFIX or the whole username.
 *
 * Anchored on purpose. Matched with `includes`, `_ro` is a substring of `_role`
 * and `_root`, and `analytics_ro` is a substring of `analytics_root` — so
 * `postgres_root`, `writer_role`, `admin_role` and `svc_ledger_rw_rotator` all
 * presented as read-only. A suffix is what a read-only role actually looks
 * like, and anything that misses now fails closed rather than open.
 */
export const ALLOWED_ANALYTICS_READONLY_USER_MARKERS = ['_ro', 'readonly', 'analytics_ro', 'replica_ro'] as const;

export const analyticsReplicaEndpointSchema = z.object({
  source: z.enum(ANALYTICS_SOURCE_DBS),
  /** Connection URL — must use a read-only role; never primary writer. */
  url: z
    .string()
    .url()
    .or(z.string().regex(/^postgres(ql)?:\/\//)),
  role: z.literal('readonly'),
  /** Observed replication lag in seconds; null/undefined → unknown freshness. */
  lagSeconds: z.number().finite().nonnegative().nullable().optional(),
});

export type AnalyticsReplicaEndpoint = z.infer<typeof analyticsReplicaEndpointSchema>;

export type ReplicaRoleCheck = { readonly ok: true; readonly username: string } | { readonly ok: false; readonly reason: string };

/**
 * Extract the username postgres.js will connect as. Invalid URL → empty string.
 *
 * `parseUrl` decodes the host, then `url.replace(decodedHost, decodedHost.split(',')[0])`
 * before `decodeURIComponent` of the username. The first match can sit in the
 * userinfo, so `postgres://post,XXgres_ro:pw@post,XX/db` connects as `postgres_ro`.
 * WHATWG `URL.username` stays percent-encoded; postgres.js runs
 * `decodeURIComponent` on it before auth. Query keys that are not driver
 * defaults are copied into `options.connection`, and `StartupMessage`
 * Object.assigns them over the URL user (SCRAM sends `n=*`). Last `user`
 * wins, matching that reduce.
 */
export function analyticsReplicaUsername(url: string): string {
  try {
    let host = url;
    host = host.slice(host.indexOf('://') + 3).split(/[?/]/)[0] ?? '';
    host = decodeURIComponent(host.slice(host.indexOf('@') + 1));
    const rewritten = url.replace(host, host.split(',')[0] ?? '');
    const normalized = rewritten.replace(/^postgres(ql)?:\/\//i, 'http://');
    const parsed = new URL(normalized);
    let username = decodeURIComponent(parsed.username || '');
    let queryUser: string | undefined;
    for (const [key, value] of parsed.searchParams) {
      if (key === 'user') queryUser = value;
    }
    if (queryUser !== undefined) username = queryUser;
    return username;
  } catch {
    return '';
  }
}

/**
 * Fail-closed: analytics may only use read-only replica credentials.
 * Writer-looking usernames are refused even if role claims "readonly".
 */
export function assertAnalyticsReplicaRole(url: string, role: string): ReplicaRoleCheck {
  if (role !== 'readonly') {
    return { ok: false, reason: `analytics replica role must be "readonly", got "${role}"` };
  }
  const username = analyticsReplicaUsername(url);
  if (!username) {
    return { ok: false, reason: 'analytics replica URL missing username' };
  }
  const lower = username.toLowerCase();

  // A writer word is never rescued by a marker. `admin_ro` is still admin, and
  // this class has to be refused BEFORE the marker is consulted — the previous
  // order returned early on the marker and never reached this loop at all.
  for (const frag of NEVER_READONLY_USER_FRAGMENTS) {
    if (lower.includes(frag)) {
      return {
        ok: false,
        reason: `refuse writer-looking username "${username}" — analytics must not use primary credentials`,
      };
    }
  }

  // The marker rescues a SERVICE name and nothing else, which is the documented
  // intent: `svc_ledger_ro` is allowed, bare `svc_ledger` is not.
  //
  // Anchored, because `includes` was the second half of the bug: `_ro` is a
  // substring of `_role` and `_root`, and `analytics_ro` is a substring of
  // `analytics_root`. A suffix (or the whole username) is what a read-only role
  // actually looks like.
  if (ALLOWED_ANALYTICS_READONLY_USER_MARKERS.some((m) => lower === m || lower.endsWith(m))) {
    return { ok: true, username };
  }

  for (const frag of SERVICE_OWNED_USER_FRAGMENTS) {
    if (lower.includes(frag)) {
      return {
        ok: false,
        reason: `refuse writer-looking username "${username}" — analytics must not use primary credentials`,
      };
    }
  }
  return {
    ok: false,
    reason: `username "${username}" lacks a read-only marker (${ALLOWED_ANALYTICS_READONLY_USER_MARKERS.join(', ')})`,
  };
}

/**
 * Validate a replica endpoint (schema + role law).
 */
export function validateAnalyticsReplicaEndpoint(
  endpoint: AnalyticsReplicaEndpoint,
): ReplicaRoleCheck | { readonly ok: true; readonly endpoint: AnalyticsReplicaEndpoint } {
  const parsed = analyticsReplicaEndpointSchema.safeParse(endpoint);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? 'invalid replica endpoint' };
  }
  const roleCheck = assertAnalyticsReplicaRole(parsed.data.url, parsed.data.role);
  if (!roleCheck.ok) return roleCheck;
  return { ok: true, endpoint: parsed.data };
}

/** Stage-1 registry: which sources replicate (documented; wiring is env-side). */
export type WarehouseReplicaPlan = {
  readonly sources: readonly AnalyticsSourceDb[];
  readonly liveMaxLagSeconds: number;
  readonly forbidWriterOnPrimary: true;
};

export const WAREHOUSE_REPLICA_PLAN_V0: WarehouseReplicaPlan = {
  sources: WAREHOUSE_REPLICA_SOURCES,
  liveMaxLagSeconds: 60,
  forbidWriterOnPrimary: true,
};

export function listWarehouseReplicaSources(): readonly AnalyticsSourceDb[] {
  return WAREHOUSE_REPLICA_PLAN_V0.sources;
}

/**
 * How lag was obtained.
 *   · probed     — measured against a replica (carries lagMeasuredAt)
 *   · configured — operator-typed env number (never "live" without measurement age)
 *   · unknown    — no lag signal
 */
export type LagSource = 'probed' | 'configured' | 'unknown';

/**
 * Max age of a lag *measurement* (seconds) before the reading itself is unknown.
 * A "5s lag" stamped an hour ago is a lie, not live.
 */
export const LAG_MEASUREMENT_MAX_AGE_SECONDS = 60;

/** Env keys for Stage-1 replica URLs (one per source DB). */
export const ANALYTICS_REPLICA_URL_ENV = {
  ledger: 'ANALYTICS_REPLICA_LEDGER_URL',
  trade: 'ANALYTICS_REPLICA_TRADE_URL',
  identity: 'ANALYTICS_REPLICA_IDENTITY_URL',
} as const;

/**
 * ETL watermark honesty (ops.analytics / D26-P1-O4 residual).
 *
 * Operator-stamped ISO-8601 instant of the last successful warehouse ETL run.
 * Unset / blank / unparseable → `absent` — never invent "ran and found nothing"
 * vs "never ran". Presence of a watermark does NOT paint live cubes; lag probe
 * rules still gate `mayLabelLive`.
 */
export const ANALYTICS_ETL_WATERMARK_AT_ENV = 'ANALYTICS_ETL_WATERMARK_AT' as const;

export type EtlWatermarkState = 'absent' | 'present';

export type EtlWatermarkResolution = {
  readonly state: EtlWatermarkState;
  /** ISO-8601 when `state === 'present'`; otherwise null. */
  readonly at: string | null;
  readonly note: string;
  /** Env key name only — never a secret. */
  readonly envKey: typeof ANALYTICS_ETL_WATERMARK_AT_ENV;
};

const ETL_ABSENT_NOTE = 'ETL watermark: ABSENT — cannot claim "ran and found nothing" vs "never ran". No fake cubes.';
const ETL_PRESENT_NOTE = 'ETL watermark: PRESENT (operator-stamped). Does not imply live cubes — lag probe still required.';

/**
 * Live cubes require all four: replica configured, fresh probed lag in the live
 * band, an ETL watermark, and real facts. Any missing piece → never mayLabelLive.
 * Watermark alone never paints live; lag probe alone never paints live.
 */
export function mayPaintLiveCubes(input: {
  readonly replicaConfigured: boolean;
  readonly lagMayLabelLive: boolean;
  readonly etlWatermark: EtlWatermarkState;
  readonly hasFacts: boolean;
}): boolean {
  return input.replicaConfigured === true && input.lagMayLabelLive === true && input.etlWatermark === 'present' && input.hasFacts === true;
}

/**
 * Resolve ETL watermark from env. Fail-closed: junk timestamps are absent.
 */
export function resolveEtlWatermark(env: Record<string, string | undefined> = process.env): EtlWatermarkResolution {
  const raw = env[ANALYTICS_ETL_WATERMARK_AT_ENV];
  if (raw === undefined || raw.trim() === '') {
    return { state: 'absent', at: null, note: ETL_ABSENT_NOTE, envKey: ANALYTICS_ETL_WATERMARK_AT_ENV };
  }
  const trimmed = raw.trim();
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    return {
      state: 'absent',
      at: null,
      note: `ETL watermark: ABSENT — ${ANALYTICS_ETL_WATERMARK_AT_ENV} is not a parseable ISO-8601 instant. No fake cubes.`,
      envKey: ANALYTICS_ETL_WATERMARK_AT_ENV,
    };
  }
  return {
    state: 'present',
    at: new Date(ms).toISOString(),
    note: ETL_PRESENT_NOTE,
    envKey: ANALYTICS_ETL_WATERMARK_AT_ENV,
  };
}

/**
 * SQL for lag on a hot-standby: seconds since last replayed WAL.
 * NULL when the connection is not in recovery (not a standby) — treat as unknown.
 * Callers inject a query runner; contracts never open a DB pool.
 */
export const ANALYTICS_REPLICA_LAG_SQL =
  'SELECT CASE WHEN pg_last_xact_replay_timestamp() IS NULL THEN NULL ' +
  'ELSE EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) END AS lag_seconds';

export type WarehouseSurfaceStatus = 'ok' | 'empty' | 'unavailable' | 'refuse';

export type WarehouseLagMeta = {
  readonly lagSource: LagSource;
  readonly lagMeasuredAt: number | null;
};

export type WarehouseEtlHonesty = {
  readonly etlWatermark: EtlWatermarkState;
  readonly etlWatermarkAt: string | null;
};

export type WarehouseSurfaceResult =
  | ({
      readonly status: 'ok';
      readonly points: readonly CubePoint[];
      readonly freshness: LagFreshness;
      readonly mayLabelLive: boolean;
      readonly lagSource: LagSource;
      readonly lagMeasuredAt: number | null;
    } & WarehouseEtlHonesty)
  | ({
      readonly status: 'empty';
      readonly reason: 'no_facts';
      readonly freshness: LagFreshness;
      readonly mayLabelLive: false;
      readonly lagSource: LagSource;
      readonly lagMeasuredAt: number | null;
    } & WarehouseEtlHonesty)
  | ({
      readonly status: 'unavailable';
      readonly reason: 'replica_unconfigured' | 'lag_unknown' | 'lag_stale';
      readonly freshness: LagFreshness;
      readonly mayLabelLive: false;
      readonly lagSource: LagSource;
      readonly lagMeasuredAt: number | null;
    } & WarehouseEtlHonesty)
  | ({
      readonly status: 'refuse';
      readonly reason: string;
      readonly mayLabelLive: false;
      readonly lagSource: LagSource;
      readonly lagMeasuredAt: number | null;
    } & WarehouseEtlHonesty);

export type WarehouseSurfaceInput = {
  /** False until ANALYTICS_REPLICA_* URLs (or dry-run flag) are configured. */
  readonly replicaConfigured: boolean;
  /** Observed lag; null/undefined → unknown (never "live"). */
  readonly lagSeconds: number | null | undefined;
  /**
   * Epoch ms when lag was measured. Required for a "live" badge.
   * Stale measurements (older than LAG_MEASUREMENT_MAX_AGE_SECONDS) → unknown.
   */
  readonly lagMeasuredAt?: number | null;
  /**
   * How lag was obtained. Omitted + lagSeconds set → treated as `configured`
   * (operator-typed; cannot claim live without measurement age).
   */
  readonly lagSource?: LagSource;
  /** Clock injection for measurement-age tests. */
  readonly nowMs?: number;
  /**
   * Fixture / replica fact rows. Empty or omitted → empty surface
   * (never invent trading volume).
   */
  readonly facts?: readonly CubeFactRow[] | null;
  /**
   * ETL watermark honesty. Omitted → `absent` (fail-closed). Presence never
   * paints live cubes by itself; absence forbids `mayLabelLive`.
   */
  readonly etlWatermark?: EtlWatermarkState;
  readonly etlWatermarkAt?: string | null;
};

export type EffectiveWarehouseLag = {
  readonly lagSeconds: number | null;
  readonly lagMeasuredAt: number | null;
  readonly lagSource: LagSource;
  readonly freshness: LagFreshness;
  /** True only with a fresh measurement and lag inside the live band. */
  readonly mayLabelLive: boolean;
  readonly measurementAgeSeconds: number | null;
};

/**
 * Fail-closed lag resolution.
 *
 * Rules:
 *   1. Measurement older than LAG_MEASUREMENT_MAX_AGE_SECONDS → unknown.
 *   2. `configured` (env-typed) without lagMeasuredAt → never mayLabelLive;
 *      freshness caps at `delayed` (never paints "live" from a typed number).
 *   3. `probed` without lagMeasuredAt → unknown (probe must stamp time).
 *   4. Fresh measurement + live band → mayLabelLive.
 */
export function resolveEffectiveWarehouseLag(input: {
  readonly lagSeconds: number | null | undefined;
  readonly lagMeasuredAt?: number | null;
  readonly lagSource?: LagSource;
  readonly nowMs?: number;
}): EffectiveWarehouseLag {
  const now = input.nowMs ?? Date.now();
  const hasLagNumber = input.lagSeconds !== null && input.lagSeconds !== undefined;
  const lagSource: LagSource = input.lagSource ?? (hasLagNumber ? 'configured' : 'unknown');
  const measuredAt = input.lagMeasuredAt ?? null;

  const ageSeconds = measuredAt !== null && Number.isFinite(measuredAt) ? (now - measuredAt) / 1000 : null;

  // Stale or inverted measurement timestamp → the reading itself is unknown.
  if (measuredAt !== null) {
    if (ageSeconds === null || ageSeconds < 0 || ageSeconds > LAG_MEASUREMENT_MAX_AGE_SECONDS) {
      return {
        lagSeconds: null,
        lagMeasuredAt: measuredAt,
        lagSource,
        freshness: 'unknown',
        mayLabelLive: false,
        measurementAgeSeconds: ageSeconds,
      };
    }
  }

  // Probe without a timestamp is not a probe — fail closed.
  if (lagSource === 'probed' && measuredAt === null) {
    return {
      lagSeconds: null,
      lagMeasuredAt: null,
      lagSource: 'probed',
      freshness: 'unknown',
      mayLabelLive: false,
      measurementAgeSeconds: null,
    };
  }

  // Operator-typed lag with no measurement age: usable for delayed/stale bands,
  // but never "live" and never mayLabelLive.
  if (lagSource === 'configured' && measuredAt === null) {
    const raw = lagFreshness(input.lagSeconds);
    const freshness: LagFreshness = raw === 'live' ? 'delayed' : raw;
    return {
      lagSeconds: hasLagNumber ? (input.lagSeconds as number) : null,
      lagMeasuredAt: null,
      lagSource: 'configured',
      freshness,
      mayLabelLive: false,
      measurementAgeSeconds: null,
    };
  }

  if (!hasLagNumber || lagSource === 'unknown') {
    return {
      lagSeconds: null,
      lagMeasuredAt: measuredAt,
      lagSource: lagSource === 'unknown' ? 'unknown' : lagSource,
      freshness: 'unknown',
      mayLabelLive: false,
      measurementAgeSeconds: ageSeconds,
    };
  }

  const freshness = lagFreshness(input.lagSeconds);
  // Live badge requires a fresh measurement stamp — never a bare number.
  const live = freshness === 'live' && measuredAt !== null && mayLabelLive(input.lagSeconds);
  return {
    lagSeconds: input.lagSeconds as number,
    lagMeasuredAt: measuredAt,
    lagSource,
    freshness,
    mayLabelLive: live,
    measurementAgeSeconds: ageSeconds,
  };
}

/**
 * Read-only analytics surface.
 *
 * Honest empty warehouse: no facts → `empty`. Unconfigured replica or lag that
 * fails the live SLO → `unavailable`. Never fabricates volume series.
 * Env-only lag without measurement age never claims live.
 * Missing ETL watermark never claims live (fail-closed if omitted).
 */
export function queryWarehouseSurface(input: WarehouseSurfaceInput): WarehouseSurfaceResult {
  const etlWatermark: EtlWatermarkState = input.etlWatermark ?? 'absent';
  const etlWatermarkAt = etlWatermark === 'present' ? (input.etlWatermarkAt ?? null) : null;
  const etl: WarehouseEtlHonesty = { etlWatermark, etlWatermarkAt };

  if (!input.replicaConfigured) {
    return {
      status: 'unavailable',
      reason: 'replica_unconfigured',
      freshness: 'unknown',
      mayLabelLive: false,
      lagSource: 'unknown',
      lagMeasuredAt: null,
      ...etl,
    };
  }

  const effective = resolveEffectiveWarehouseLag({
    lagSeconds: input.lagSeconds,
    lagMeasuredAt: input.lagMeasuredAt,
    lagSource: input.lagSource,
    nowMs: input.nowMs,
  });

  if (effective.freshness === 'unknown') {
    return {
      status: 'unavailable',
      reason: 'lag_unknown',
      freshness: 'unknown',
      mayLabelLive: false,
      lagSource: effective.lagSource,
      lagMeasuredAt: effective.lagMeasuredAt,
      ...etl,
    };
  }
  if (effective.freshness === 'stale') {
    return {
      status: 'unavailable',
      reason: 'lag_stale',
      freshness: 'stale',
      mayLabelLive: false,
      lagSource: effective.lagSource,
      lagMeasuredAt: effective.lagMeasuredAt,
      ...etl,
    };
  }

  const facts = input.facts ?? [];
  if (facts.length === 0) {
    return {
      status: 'empty',
      reason: 'no_facts',
      freshness: effective.freshness,
      mayLabelLive: false,
      lagSource: effective.lagSource,
      lagMeasuredAt: effective.lagMeasuredAt,
      ...etl,
    };
  }

  const evaluated = evaluateCubeFixtures(facts);
  if (evaluated.status === 'refuse') {
    return {
      status: 'refuse',
      reason: evaluated.reason,
      mayLabelLive: false,
      lagSource: effective.lagSource,
      lagMeasuredAt: effective.lagMeasuredAt,
      ...etl,
    };
  }

  for (const p of evaluated.points) {
    const check = assertMetricPoint(p.metricId, p.value);
    if (!check.ok) {
      return {
        status: 'refuse',
        reason: `${p.metricId}: ${check.reason}`,
        mayLabelLive: false,
        lagSource: effective.lagSource,
        lagMeasuredAt: effective.lagMeasuredAt,
        ...etl,
      };
    }
  }

  return {
    status: 'ok',
    points: evaluated.points,
    freshness: effective.freshness,
    mayLabelLive: mayPaintLiveCubes({
      replicaConfigured: true,
      lagMayLabelLive: effective.mayLabelLive,
      etlWatermark,
      hasFacts: evaluated.points.length > 0,
    }),
    lagSource: effective.lagSource,
    lagMeasuredAt: effective.lagMeasuredAt,
    ...etl,
  };
}

/**
 * Operator-facing one-liner. Never implies live volume when surface is empty.
 */
export function warehouseSurfaceStatusLine(result: WarehouseSurfaceResult): string {
  const wm = `wm=${result.etlWatermark}`;
  if (result.status === 'ok') {
    return `status=ok points=${result.points.length} freshness=${result.freshness} live=${result.mayLabelLive ? '1' : '0'} lagSource=${result.lagSource} ${wm}`;
  }
  if (result.status === 'empty') {
    return `status=empty reason=${result.reason} freshness=${result.freshness} live=0 lagSource=${result.lagSource} ${wm}`;
  }
  if (result.status === 'unavailable') {
    return `status=unavailable reason=${result.reason} freshness=${result.freshness} live=0 lagSource=${result.lagSource} ${wm}`;
  }
  return `status=refuse reason=${result.reason} live=0 lagSource=${result.lagSource} ${wm}`;
}

// ── Replica env resolution + optional lag probe ─────────────────────────────

export type AnalyticsReplicaUrlEnv = Readonly<Record<string, string | undefined>>;

export type ConfiguredReplicaEndpoint = {
  readonly source: AnalyticsSourceDb;
  readonly url: string;
  readonly username: string;
};

/**
 * Collect ANALYTICS_REPLICA_{LEDGER,TRADE,IDENTITY}_URL from an env map.
 * Empty / whitespace values are ignored.
 */
export function listConfiguredAnalyticsReplicaUrls(
  env: AnalyticsReplicaUrlEnv,
): readonly { readonly source: AnalyticsSourceDb; readonly url: string }[] {
  const out: { source: AnalyticsSourceDb; url: string }[] = [];
  for (const source of WAREHOUSE_REPLICA_SOURCES) {
    const key = ANALYTICS_REPLICA_URL_ENV[source];
    const raw = env[key];
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (url.length > 0) out.push({ source, url });
  }
  return out;
}

/**
 * Injected lag probe. Contracts never open sockets — unit tests mock this;
 * production may run ANALYTICS_REPLICA_LAG_SQL via a read-only pool.
 */
export type WarehouseLagProbe = (args: {
  readonly endpoints: readonly ConfiguredReplicaEndpoint[];
  readonly nowMs: number;
}) =>
  | Promise<{ readonly lagSeconds: number | null; readonly measuredAt: number } | null>
  | { readonly lagSeconds: number | null; readonly measuredAt: number }
  | null;

/** Stamp a probe reading (pure helper for SQL result adapters). */
export function lagFromProbeReading(
  lagSeconds: number | null | undefined,
  nowMs: number,
): { readonly lagSeconds: number | null; readonly measuredAt: number; readonly lagSource: 'probed' } {
  const lag = lagSeconds === null || lagSeconds === undefined || !Number.isFinite(lagSeconds) || lagSeconds < 0 ? null : lagSeconds;
  return { lagSeconds: lag, measuredAt: nowMs, lagSource: 'probed' };
}

/**
 * Parse a `ANALYTICS_REPLICA_LAG_SQL` result (postgres.js row, array, or object).
 * NULL / missing / negative / non-finite → null (not a standby, or unreadable).
 */
export function parseWarehouseLagSqlResult(result: unknown): number | null {
  const row = Array.isArray(result) ? result[0] : result;
  if (row == null || typeof row !== 'object') return null;
  const rec = row as { readonly lag_seconds?: unknown; readonly lagSeconds?: unknown };
  const raw = rec.lag_seconds ?? rec.lagSeconds;
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : typeof raw === 'bigint' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Injected one-shot query. Contracts still do not open a pool. */
export type WarehouseLagSqlQuery = (args: {
  readonly url: string;
  readonly sql: string;
  readonly source: AnalyticsSourceDb;
}) => Promise<unknown> | unknown;

/**
 * Production SQL probe: run ANALYTICS_REPLICA_LAG_SQL on every configured replica.
 *
 * · Any source that fails / returns NULL → overall unknown (never live from a subset).
 * · All connections fail → null (not a measurement).
 * · All succeed → worst lag (max seconds).
 * · Writer-looking URL → null (role law; resolveWarehouseReplicaConfig already refuses).
 */
export function createSqlWarehouseLagProbe(query: WarehouseLagSqlQuery): WarehouseLagProbe {
  return async ({ endpoints, nowMs }) => {
    if (endpoints.length === 0) return null;
    const lags: number[] = [];
    let sawQuery = false;
    let sawUnknown = false;
    for (const ep of endpoints) {
      const role = assertAnalyticsReplicaRole(ep.url, 'readonly');
      if (!role.ok) return null;
      try {
        const raw = await query({ url: ep.url, sql: ANALYTICS_REPLICA_LAG_SQL, source: ep.source });
        sawQuery = true;
        const lag = parseWarehouseLagSqlResult(raw);
        if (lag === null) sawUnknown = true;
        else lags.push(lag);
      } catch {
        sawUnknown = true;
      }
    }
    if (!sawQuery) return null;
    if (sawUnknown || lags.length === 0) {
      return { lagSeconds: null, measuredAt: nowMs };
    }
    return { lagSeconds: Math.max(...lags), measuredAt: nowMs };
  };
}

export function parseConfiguredLagSeconds(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export type ResolvedWarehouseReplica =
  | {
      readonly status: 'ok';
      readonly replicaConfigured: boolean;
      readonly endpoints: readonly ConfiguredReplicaEndpoint[];
      readonly lagSeconds: number | null;
      readonly lagMeasuredAt: number | null;
      readonly lagSource: LagSource;
    }
  | {
      readonly status: 'refuse';
      readonly reason: string;
      readonly replicaConfigured: false;
      readonly endpoints: readonly [];
      readonly lagSeconds: null;
      readonly lagMeasuredAt: null;
      readonly lagSource: 'unknown';
    };

/**
 * Production path: read replica URLs, assert readonly roles, optional lag probe.
 *
 * · URL present + writer-looking username → refuse (assertAnalyticsReplicaRole caller).
 * · Probe present + endpoints → lagSource `probed` with measurement stamp.
 * · Probe absent + ANALYTICS_REPLICA_LAG_SECONDS → lagSource `configured` (never live alone).
 * · Neither → lag unknown; replicaConfigured true only if URL or dry-run flag set.
 */
export async function resolveWarehouseReplicaConfig(
  opts: {
    readonly env?: AnalyticsReplicaUrlEnv;
    readonly probe?: WarehouseLagProbe | null;
    readonly nowMs?: number;
    /** Override static lag (tests). Default: parse env ANALYTICS_REPLICA_LAG_SECONDS. */
    readonly configuredLagSeconds?: number | null;
    /** Override dry-run flag (tests). Default: env ANALYTICS_REPLICA_CONFIGURED === 'true'. */
    readonly configuredFlag?: boolean;
  } = {},
): Promise<ResolvedWarehouseReplica> {
  const env = opts.env ?? (typeof process !== 'undefined' ? process.env : {});
  const nowMs = opts.nowMs ?? Date.now();
  const rawUrls = listConfiguredAnalyticsReplicaUrls(env);
  const endpoints: ConfiguredReplicaEndpoint[] = [];

  for (const { source, url } of rawUrls) {
    const check = assertAnalyticsReplicaRole(url, 'readonly');
    if (!check.ok) {
      return {
        status: 'refuse',
        reason: check.reason,
        replicaConfigured: false,
        endpoints: [],
        lagSeconds: null,
        lagMeasuredAt: null,
        lagSource: 'unknown',
      };
    }
    endpoints.push({ source, url, username: check.username });
  }

  const flag = opts.configuredFlag ?? env.ANALYTICS_REPLICA_CONFIGURED === 'true';
  const replicaConfigured = endpoints.length > 0 || flag;

  if (opts.probe && endpoints.length > 0) {
    const measured = await opts.probe({ endpoints, nowMs });
    if (measured) {
      return {
        status: 'ok',
        replicaConfigured: true,
        endpoints,
        lagSeconds: measured.lagSeconds,
        lagMeasuredAt: measured.measuredAt,
        lagSource: 'probed',
      };
    }
    // Probe ran but could not measure (e.g. not a standby) → unknown, still configured.
    return {
      status: 'ok',
      replicaConfigured: true,
      endpoints,
      lagSeconds: null,
      lagMeasuredAt: null,
      lagSource: 'unknown',
    };
  }

  const configuredLag =
    opts.configuredLagSeconds !== undefined ? opts.configuredLagSeconds : parseConfiguredLagSeconds(env.ANALYTICS_REPLICA_LAG_SECONDS);

  if (configuredLag !== null) {
    return {
      status: 'ok',
      replicaConfigured,
      endpoints,
      lagSeconds: configuredLag,
      lagMeasuredAt: null,
      lagSource: 'configured',
    };
  }

  return {
    status: 'ok',
    replicaConfigured,
    endpoints,
    lagSeconds: null,
    lagMeasuredAt: null,
    lagSource: 'unknown',
  };
}
