import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_ETL_WATERMARK_AT_ENV,
  ANALYTICS_REPLICA_LAG_SQL,
  ANALYTICS_REPLICA_URL_ENV,
  LAG_MEASUREMENT_MAX_AGE_SECONDS,
  WAREHOUSE_REPLICA_PLAN_V0,
  assertAnalyticsReplicaRole,
  createSqlWarehouseLagProbe,
  lagFromProbeReading,
  listConfiguredAnalyticsReplicaUrls,
  listWarehouseReplicaSources,
  parseConfiguredLagSeconds,
  parseWarehouseLagSqlResult,
  queryWarehouseSurface,
  resolveEffectiveWarehouseLag,
  mayPaintLiveCubes,
  resolveEtlWatermark,
  resolveWarehouseReplicaConfig,
  validateAnalyticsReplicaEndpoint,
  warehouseSurfaceStatusLine,
} from './ops-analytics-warehouse.js';

describe('analytics Stage-1 — warehouse replica + empty surface', () => {
  it('documents ledger, trade, identity as replica sources', () => {
    expect(listWarehouseReplicaSources()).toEqual(['ledger', 'trade', 'identity']);
    expect(WAREHOUSE_REPLICA_PLAN_V0.forbidWriterOnPrimary).toBe(true);
    expect(WAREHOUSE_REPLICA_PLAN_V0.liveMaxLagSeconds).toBe(60);
  });

  it('accepts read-only replica usernames', () => {
    expect(assertAnalyticsReplicaRole('postgres://analytics_ro:x@localhost:5433/wh', 'readonly')).toEqual({
      ok: true,
      username: 'analytics_ro',
    });
    expect(assertAnalyticsReplicaRole('postgres://svc_ledger_ro:x@localhost:5433/wh', 'readonly').ok).toBe(true);
  });

  it('refuses writer / primary credentials on analytics path', () => {
    expect(assertAnalyticsReplicaRole('postgres://svc_ledger:x@localhost:5433/intafaced', 'readonly').ok).toBe(false);
    expect(assertAnalyticsReplicaRole('postgres://intafaced_ops:x@localhost:5433/intafaced', 'readonly').ok).toBe(false);
    expect(assertAnalyticsReplicaRole('postgres://analytics_ro:x@localhost:5433/wh', 'readwrite').ok).toBe(false);
  });

  it('validateAnalyticsReplicaEndpoint enforces role + url shape', () => {
    const ok = validateAnalyticsReplicaEndpoint({
      source: 'ledger',
      url: 'postgres://replica_ro:secret@replica.internal:5432/ledger',
      role: 'readonly',
      lagSeconds: 12,
    });
    expect(ok.ok).toBe(true);

    const bad = validateAnalyticsReplicaEndpoint({
      source: 'ledger',
      url: 'postgres://svc_trade:secret@primary:5432/trade',
      role: 'readonly',
    });
    expect(bad.ok).toBe(false);
  });

  it('unconfigured replica → unavailable (never invent volume)', () => {
    const r = queryWarehouseSurface({ replicaConfigured: false, lagSeconds: 0, facts: [] });
    expect(r).toEqual({
      status: 'unavailable',
      reason: 'replica_unconfigured',
      freshness: 'unknown',
      mayLabelLive: false,
      lagSource: 'unknown',
      lagMeasuredAt: null,
      etlWatermark: 'absent',
      etlWatermarkAt: null,
    });
    expect(warehouseSurfaceStatusLine(r)).toContain('live=0');
  });

  it('unknown lag → unavailable, never live', () => {
    const r = queryWarehouseSurface({ replicaConfigured: true, lagSeconds: null, facts: [] });
    expect(r.status).toBe('unavailable');
    if (r.status !== 'unavailable') return;
    expect(r.reason).toBe('lag_unknown');
    expect(r.mayLabelLive).toBe(false);
  });

  it('stale lag → unavailable', () => {
    const r = queryWarehouseSurface({ replicaConfigured: true, lagSeconds: 120, facts: [] });
    expect(r).toMatchObject({ status: 'unavailable', reason: 'lag_stale', freshness: 'stale', mayLabelLive: false });
  });

  it('configured + env lag + no facts → honest empty; env lag is never "live"', () => {
    // lagSeconds alone is lagSource=configured — freshness caps at delayed, not live.
    const r = queryWarehouseSurface({ replicaConfigured: true, lagSeconds: 5, facts: [] });
    expect(r).toEqual({
      status: 'empty',
      reason: 'no_facts',
      freshness: 'delayed',
      mayLabelLive: false,
      lagSource: 'configured',
      lagMeasuredAt: null,
      etlWatermark: 'absent',
      etlWatermarkAt: null,
    });
  });

  it('env-only lag with facts → ok but mayLabelLive false (never live from a typed number)', () => {
    const r = queryWarehouseSurface({
      replicaConfigured: true,
      lagSeconds: 10,
      facts: [
        { metricId: 'ledger.postings.count', value: '4' },
        { metricId: 'ledger.volume.notional', value: '250.25' },
      ],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.mayLabelLive).toBe(false);
    expect(r.lagSource).toBe('configured');
    expect(r.freshness).toBe('delayed');
    expect(r.points.find((p) => p.metricId === 'ledger.volume.notional')!.value).toBe('250.25');
    expect(warehouseSurfaceStatusLine(r)).toMatch(/status=ok points=2/);
    expect(warehouseSurfaceStatusLine(r)).toContain('live=0');
  });

  it('probed lag with measurement stamp + facts but no watermark → mayLabelLive false', () => {
    const now = 1_700_000_000_000;
    const r = queryWarehouseSurface({
      replicaConfigured: true,
      lagSeconds: 10,
      lagSource: 'probed',
      lagMeasuredAt: now,
      nowMs: now,
      facts: [
        { metricId: 'ledger.postings.count', value: '4' },
        { metricId: 'ledger.volume.notional', value: '250.25' },
      ],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.mayLabelLive).toBe(false);
    expect(r.etlWatermark).toBe('absent');
    expect(r.freshness).toBe('live');
  });

  it('probed lag + watermark present + facts → mayLabelLive true', () => {
    const now = 1_700_000_000_000;
    const r = queryWarehouseSurface({
      replicaConfigured: true,
      lagSeconds: 10,
      lagSource: 'probed',
      lagMeasuredAt: now,
      nowMs: now,
      etlWatermark: 'present',
      etlWatermarkAt: '2026-08-12T10:00:00.000Z',
      facts: [
        { metricId: 'ledger.postings.count', value: '4' },
        { metricId: 'ledger.volume.notional', value: '250.25' },
      ],
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.mayLabelLive).toBe(true);
    expect(r.lagSource).toBe('probed');
    expect(r.lagMeasuredAt).toBe(now);
    expect(r.freshness).toBe('live');
    expect(r.etlWatermark).toBe('present');
    expect(r.etlWatermarkAt).toBe('2026-08-12T10:00:00.000Z');
  });

  it('stale lag measurement → unknown (never live forever from an old reading)', () => {
    const now = 1_700_000_000_000;
    const measuredAt = now - (LAG_MEASUREMENT_MAX_AGE_SECONDS + 5) * 1000;
    const r = queryWarehouseSurface({
      replicaConfigured: true,
      lagSeconds: 5,
      lagSource: 'probed',
      lagMeasuredAt: measuredAt,
      nowMs: now,
      facts: [{ metricId: 'ledger.postings.count', value: '1' }],
    });
    expect(r).toMatchObject({
      status: 'unavailable',
      reason: 'lag_unknown',
      mayLabelLive: false,
      lagSource: 'probed',
      lagMeasuredAt: measuredAt,
    });
  });

  it('refuses money as JS number — no float warehouse close-enough', () => {
    const r = queryWarehouseSurface({
      replicaConfigured: true,
      lagSeconds: 5,
      lagSource: 'probed',
      lagMeasuredAt: Date.now(),
      facts: [{ metricId: 'ledger.volume.notional', value: 99 as unknown as string }],
    });
    expect(r.status).toBe('refuse');
  });
});

describe('resolveEffectiveWarehouseLag — measurement honesty', () => {
  it('configured without measurement never mayLabelLive even when lag is small', () => {
    const e = resolveEffectiveWarehouseLag({ lagSeconds: 5, lagSource: 'configured' });
    expect(e.mayLabelLive).toBe(false);
    expect(e.freshness).toBe('delayed');
    expect(e.lagSource).toBe('configured');
  });

  it('omitted lagSource with a number defaults to configured (fail-closed)', () => {
    const e = resolveEffectiveWarehouseLag({ lagSeconds: 3 });
    expect(e.lagSource).toBe('configured');
    expect(e.mayLabelLive).toBe(false);
  });

  it('probed without lagMeasuredAt is unknown', () => {
    const e = resolveEffectiveWarehouseLag({ lagSeconds: 5, lagSource: 'probed' });
    expect(e.freshness).toBe('unknown');
    expect(e.mayLabelLive).toBe(false);
  });

  it('fresh probed measurement inside live band mayLabelLive', () => {
    const now = 100_000;
    const e = resolveEffectiveWarehouseLag({
      lagSeconds: 12,
      lagSource: 'probed',
      lagMeasuredAt: now - 5_000,
      nowMs: now,
    });
    expect(e.freshness).toBe('live');
    expect(e.mayLabelLive).toBe(true);
    expect(e.measurementAgeSeconds).toBe(5);
  });
});

describe('resolveWarehouseReplicaConfig — URLs + role + probe', () => {
  it('reads ANALYTICS_REPLICA_*_URL env keys', () => {
    expect(ANALYTICS_REPLICA_URL_ENV).toEqual({
      ledger: 'ANALYTICS_REPLICA_LEDGER_URL',
      trade: 'ANALYTICS_REPLICA_TRADE_URL',
      identity: 'ANALYTICS_REPLICA_IDENTITY_URL',
    });
    const listed = listConfiguredAnalyticsReplicaUrls({
      ANALYTICS_REPLICA_LEDGER_URL: 'postgres://analytics_ro:x@h/db',
      ANALYTICS_REPLICA_TRADE_URL: '  ',
    });
    expect(listed).toEqual([{ source: 'ledger', url: 'postgres://analytics_ro:x@h/db' }]);
  });

  it('calls assertAnalyticsReplicaRole when a URL is present — writer refused', async () => {
    const r = await resolveWarehouseReplicaConfig({
      env: {
        ANALYTICS_REPLICA_LEDGER_URL: 'postgres://svc_ledger:secret@primary:5432/ledger',
      },
    });
    expect(r.status).toBe('refuse');
    if (r.status !== 'refuse') return;
    expect(r.reason).toMatch(/writer-looking|primary credentials/i);
    expect(r.replicaConfigured).toBe(false);
  });

  it('accepts readonly URL and marks replica configured', async () => {
    const r = await resolveWarehouseReplicaConfig({
      env: {
        ANALYTICS_REPLICA_LEDGER_URL: 'postgres://analytics_ro:x@replica:5432/ledger',
      },
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.replicaConfigured).toBe(true);
    expect(r.endpoints).toHaveLength(1);
    expect(r.endpoints[0]!.username).toBe('analytics_ro');
    expect(r.lagSource).toBe('unknown');
  });

  it('env-only ANALYTICS_REPLICA_LAG_SECONDS is configured, never probed', async () => {
    const r = await resolveWarehouseReplicaConfig({
      env: {
        ANALYTICS_REPLICA_CONFIGURED: 'true',
        ANALYTICS_REPLICA_LAG_SECONDS: '5',
      },
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.lagSource).toBe('configured');
    expect(r.lagSeconds).toBe(5);
    expect(r.lagMeasuredAt).toBeNull();
    // Surface must not claim live from this.
    const surface = queryWarehouseSurface({
      replicaConfigured: r.replicaConfigured,
      lagSeconds: r.lagSeconds,
      lagMeasuredAt: r.lagMeasuredAt,
      lagSource: r.lagSource,
      facts: [{ metricId: 'trade.fills.count', value: '1' }],
    });
    expect(surface.status).toBe('ok');
    if (surface.status !== 'ok') return;
    expect(surface.mayLabelLive).toBe(false);
  });

  it('optional probe stamps lagSource=probed with measurement time', async () => {
    const now = 2_000_000_000_000;
    const r = await resolveWarehouseReplicaConfig({
      env: {
        ANALYTICS_REPLICA_LEDGER_URL: 'postgres://replica_ro:x@replica:5432/ledger',
      },
      nowMs: now,
      probe: ({ nowMs }) => ({ lagSeconds: 8, measuredAt: nowMs }),
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.lagSource).toBe('probed');
    expect(r.lagSeconds).toBe(8);
    expect(r.lagMeasuredAt).toBe(now);

    const surface = queryWarehouseSurface({
      replicaConfigured: r.replicaConfigured,
      lagSeconds: r.lagSeconds,
      lagMeasuredAt: r.lagMeasuredAt,
      lagSource: r.lagSource,
      nowMs: now,
      etlWatermark: 'present',
      etlWatermarkAt: '2026-08-12T10:00:00.000Z',
      facts: [{ metricId: 'trade.fills.count', value: '2' }],
    });
    expect(surface.status).toBe('ok');
    if (surface.status !== 'ok') return;
    expect(surface.mayLabelLive).toBe(true);
  });

  it('probe returning null → lag unknown, still configured', async () => {
    const r = await resolveWarehouseReplicaConfig({
      env: {
        ANALYTICS_REPLICA_LEDGER_URL: 'postgres://analytics_ro:x@replica:5432/ledger',
      },
      probe: () => null,
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.replicaConfigured).toBe(true);
    expect(r.lagSource).toBe('unknown');
    expect(r.lagSeconds).toBeNull();
  });

  it('documents lag SQL + lagFromProbeReading pure helper', () => {
    expect(ANALYTICS_REPLICA_LAG_SQL).toContain('pg_last_xact_replay_timestamp');
    expect(lagFromProbeReading(4.5, 99)).toEqual({ lagSeconds: 4.5, measuredAt: 99, lagSource: 'probed' });
    expect(lagFromProbeReading(null, 99).lagSeconds).toBeNull();
    expect(parseConfiguredLagSeconds('12')).toBe(12);
    expect(parseConfiguredLagSeconds('')).toBeNull();
    expect(parseConfiguredLagSeconds('nope')).toBeNull();
  });
});

describe('createSqlWarehouseLagProbe — production SQL adapter', () => {
  const ledger = {
    source: 'ledger' as const,
    url: 'postgres://analytics_ro:x@replica:5432/ledger',
    username: 'analytics_ro',
  };
  const trade = {
    source: 'trade' as const,
    url: 'postgres://analytics_ro:x@replica:5432/trade',
    username: 'analytics_ro',
  };

  it('parses postgres.js rows, numeric strings, and NULL', () => {
    expect(parseWarehouseLagSqlResult([{ lag_seconds: 4.25 }])).toBe(4.25);
    expect(parseWarehouseLagSqlResult([{ lag_seconds: '8.5' }])).toBe(8.5);
    expect(parseWarehouseLagSqlResult({ lagSeconds: 0 })).toBe(0);
    expect(parseWarehouseLagSqlResult([{ lag_seconds: null }])).toBeNull();
    expect(parseWarehouseLagSqlResult([])).toBeNull();
    expect(parseWarehouseLagSqlResult([{ lag_seconds: -1 }])).toBeNull();
    expect(parseWarehouseLagSqlResult('nope')).toBeNull();
  });

  it('sends ANALYTICS_REPLICA_LAG_SQL and stamps worst lag', async () => {
    const seen: string[] = [];
    const probe = createSqlWarehouseLagProbe(async ({ sql, source }) => {
      seen.push(source);
      expect(sql).toBe(ANALYTICS_REPLICA_LAG_SQL);
      return [{ lag_seconds: source === 'ledger' ? 3 : 11 }];
    });
    const reading = await probe({ endpoints: [ledger, trade], nowMs: 1_700 });
    expect(seen).toEqual(['ledger', 'trade']);
    expect(reading).toEqual({ lagSeconds: 11, measuredAt: 1_700 });
  });

  it('not-a-standby (NULL) is a measurement with unknown lag — not invented 0', async () => {
    const probe = createSqlWarehouseLagProbe(async () => [{ lag_seconds: null }]);
    const reading = await probe({ endpoints: [ledger], nowMs: 9 });
    expect(reading).toEqual({ lagSeconds: null, measuredAt: 9 });
  });

  it('one source failing fail-closes the rollup (never live from a subset)', async () => {
    const probe = createSqlWarehouseLagProbe(async ({ source }) => {
      if (source === 'trade') throw new Error('connect timeout');
      return [{ lag_seconds: 2 }];
    });
    const reading = await probe({ endpoints: [ledger, trade], nowMs: 5 });
    expect(reading).toEqual({ lagSeconds: null, measuredAt: 5 });
  });

  it('all connections fail → null (not a measurement)', async () => {
    const probe = createSqlWarehouseLagProbe(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await probe({ endpoints: [ledger], nowMs: 1 })).toBeNull();
  });

  it('writer-looking URL never queries', async () => {
    let queried = 0;
    const probe = createSqlWarehouseLagProbe(async () => {
      queried += 1;
      return [{ lag_seconds: 1 }];
    });
    const reading = await probe({
      endpoints: [{ source: 'ledger', url: 'postgres://svc_ledger:x@primary:5432/ledger', username: 'svc_ledger' }],
      nowMs: 1,
    });
    expect(queried).toBe(0);
    expect(reading).toBeNull();
  });

  it('resolveWarehouseReplicaConfig + SQL probe → lagSource probed', async () => {
    const now = 2_100_000_000_000;
    const r = await resolveWarehouseReplicaConfig({
      env: { ANALYTICS_REPLICA_LEDGER_URL: ledger.url },
      nowMs: now,
      probe: createSqlWarehouseLagProbe(async () => [{ lag_seconds: '6' }]),
    });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.lagSource).toBe('probed');
    expect(r.lagSeconds).toBe(6);
    expect(r.lagMeasuredAt).toBe(now);
    const surface = queryWarehouseSurface({
      replicaConfigured: r.replicaConfigured,
      lagSeconds: r.lagSeconds,
      lagMeasuredAt: r.lagMeasuredAt,
      lagSource: r.lagSource,
      nowMs: now,
      facts: [{ metricId: 'trade.fills.count', value: '1' }],
    });
    expect(surface.status).toBe('ok');
    if (surface.status !== 'ok') return;
    expect(surface.mayLabelLive).toBe(false);
    expect(surface.etlWatermark).toBe('absent');

    const live = queryWarehouseSurface({
      replicaConfigured: r.replicaConfigured,
      lagSeconds: r.lagSeconds,
      lagMeasuredAt: r.lagMeasuredAt,
      lagSource: r.lagSource,
      nowMs: now,
      etlWatermark: 'present',
      etlWatermarkAt: '2026-08-15T00:00:00.000Z',
      facts: [{ metricId: 'trade.fills.count', value: '1' }],
    });
    expect(live.status).toBe('ok');
    if (live.status !== 'ok') return;
    expect(live.mayLabelLive).toBe(true);
  });
});

describe('resolveEtlWatermark — D26-P1-O4 honesty', () => {
  it('unset / blank / junk → absent', () => {
    expect(resolveEtlWatermark({}).state).toBe('absent');
    expect(resolveEtlWatermark({ [ANALYTICS_ETL_WATERMARK_AT_ENV]: '  ' }).state).toBe('absent');
    expect(resolveEtlWatermark({ [ANALYTICS_ETL_WATERMARK_AT_ENV]: 'tomorrow' }).state).toBe('absent');
  });

  it('valid ISO → present with normalised at', () => {
    const r = resolveEtlWatermark({ [ANALYTICS_ETL_WATERMARK_AT_ENV]: '2026-08-12T10:00:00.000Z' });
    expect(r).toMatchObject({ state: 'present', at: '2026-08-12T10:00:00.000Z' });
  });

  it('watermark present + dark replica cannot paint live cubes', () => {
    const r = queryWarehouseSurface({
      replicaConfigured: false,
      lagSeconds: 5,
      etlWatermark: 'present',
      etlWatermarkAt: '2026-08-12T10:00:00.000Z',
      facts: [{ metricId: 'trade.fills.count', value: '9' }],
    });
    expect(r.status).toBe('unavailable');
    expect(r.mayLabelLive).toBe(false);
    expect(r.etlWatermark).toBe('present');
  });
});

describe('mayPaintLiveCubes — D26-P1-O4 live-cube gate', () => {
  const live = {
    replicaConfigured: true,
    lagMayLabelLive: true,
    etlWatermark: 'present' as const,
    hasFacts: true,
  };

  it('true only when replica + probed live lag + watermark + facts', () => {
    expect(mayPaintLiveCubes(live)).toBe(true);
  });

  it('false when replica dark, watermark absent, lag not live, or no facts', () => {
    expect(mayPaintLiveCubes({ ...live, replicaConfigured: false })).toBe(false);
    expect(mayPaintLiveCubes({ ...live, etlWatermark: 'absent' })).toBe(false);
    expect(mayPaintLiveCubes({ ...live, lagMayLabelLive: false })).toBe(false);
    expect(mayPaintLiveCubes({ ...live, hasFacts: false })).toBe(false);
  });
});

/**
 * A read-only MARKER must not rescue a writer WORD, and must not be matched by
 * accident.
 *
 * The guard returned `ok` on the marker check before it ever reached the
 * forbidden-fragment loop, and matched markers with `includes` — so `_ro`, a
 * substring of `_role` and `_root`, presented half the writer names in the
 * denylist as read-only credentials.
 */
describe('assertAnalyticsReplicaRole — a marker is not a bypass', () => {
  const url = (user: string) => `postgres://${user}:x@localhost:5433/wh`;

  it('refuses writer names whose spelling happens to contain a marker', () => {
    // Every one of these was accepted: `_ro` matches inside `_role` and `_root`.
    for (const user of ['postgres_root', 'writer_role', 'admin_role', 'intafaced_ops_root', 'svc_ledger_rw_rotator']) {
      const result = assertAnalyticsReplicaRole(url(user), 'readonly');
      expect(result.ok, user).toBe(false);
    }
  });

  it('refuses a writer word even when the username really does end in a marker', () => {
    // `admin_ro` is still admin. No marker rescues this class.
    for (const user of ['admin_ro', 'postgres_ro', 'writer_readonly', 'migrator_ro']) {
      expect(assertAnalyticsReplicaRole(url(user), 'readonly').ok, user).toBe(false);
    }
  });

  it('still allows what the marker exists for — a service name made read-only', () => {
    for (const user of ['svc_ledger_ro', 'analytics_ro', 'replica_ro', 'readonly', 'warehouse_readonly']) {
      expect(assertAnalyticsReplicaRole(url(user), 'readonly').ok, user).toBe(true);
    }
  });

  it('still refuses a bare service name', () => {
    for (const user of ['svc_ledger', 'svc_trade', 'intafaced_ops']) {
      expect(assertAnalyticsReplicaRole(url(user), 'readonly').ok, user).toBe(false);
    }
  });
});

/**
 * The role check has to see the username postgres.js will connect as.
 *
 * WHATWG URL.username stays percent-encoded, and postgres.js decodeURIComponent's
 * it before auth. Query keys that are not driver defaults are copied onto
 * options.connection and overwrite the URL user in the startup message.
 */
describe('assertAnalyticsReplicaRole — connected user, not the raw URL user', () => {
  it('refuses a percent-encoded writer that decodes to a never-readonly fragment', () => {
    const result = assertAnalyticsReplicaRole('postgres://%61dmin_ro:x@h/db', 'readonly');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('admin_ro');
  });

  it('refuses the query user when it overrides the URL user', () => {
    const result = assertAnalyticsReplicaRole('postgres://analytics_ro:x@host/db?user=postgres', 'readonly');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('postgres');
  });

  it('accepts a query user that is a genuine read-only role', () => {
    expect(assertAnalyticsReplicaRole('postgres://admin:x@host/db?user=analytics_ro', 'readonly')).toEqual({
      ok: true,
      username: 'analytics_ro',
    });
  });

  it('still accepts a genuine analytics_ro URL with no override', () => {
    expect(assertAnalyticsReplicaRole('postgres://analytics_ro:x@host/db', 'readonly')).toEqual({
      ok: true,
      username: 'analytics_ro',
    });
  });

  it('refuses a comma host that postgres.js rewrites into the username', () => {
    // parseUrl does url.replace(decodedHost, decodedHost.split(',')[0]) before
    // decodeURIComponent(username). The first "post,XX" sits in the userinfo,
    // so this URL authenticates as postgres_ro.
    const result = assertAnalyticsReplicaRole('postgres://post,XXgres_ro:pw@post,XX/db', 'readonly');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('postgres_ro');
  });
});
