import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST, setWarehouseLagProbeForTests } from './route.js';

vi.mock('@/lib/admin-bff-gate', () => ({ adminBffGate: vi.fn(async () => null) }));

/**
 * Admin warehouse surface — honest empty/lag, no invent volume.
 * Wave-3: env-only lag never live; URL role assert; probe stamps measurement.
 */

const originalEnv = { ...process.env };
const AUTH_HEADERS = {};

afterEach(() => {
  process.env = { ...originalEnv };
  delete process.env.ANALYTICS_REPLICA_CONFIGURED;
  delete process.env.ANALYTICS_REPLICA_LAG_SECONDS;
  delete process.env.ANALYTICS_REPLICA_LEDGER_URL;
  delete process.env.ANALYTICS_REPLICA_TRADE_URL;
  delete process.env.ANALYTICS_REPLICA_IDENTITY_URL;
  delete process.env.ANALYTICS_ETL_WATERMARK_AT;
  setWarehouseLagProbeForTests(null);
});

describe('GET /api/analytics/warehouse', () => {
  it('returns unavailable when replica is not configured — never invents volume', async () => {
    process.env.ANALYTICS_REPLICA_CONFIGURED = 'false';
    const res = await GET(new Request('http://admin.local/api/analytics/warehouse', { headers: AUTH_HEADERS }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('unavailable');
    expect(body.reason).toBe('replica_unconfigured');
    expect(body.mayLabelLive).toBe(false);
  });

  it('returns empty when dry-run flag + env lag — never mayLabelLive from typed lag', async () => {
    process.env.ANALYTICS_REPLICA_CONFIGURED = 'true';
    process.env.ANALYTICS_REPLICA_LAG_SECONDS = '5';
    const res = await GET(new Request('http://admin.local/api/analytics/warehouse', { headers: AUTH_HEADERS }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('empty');
    expect(body.mayLabelLive).toBe(false);
    expect(body.lagSource).toBe('configured');
    // Env lag of 5 would have been "live" before; now capped at delayed.
    expect(body.freshness).toBe('delayed');
  });

  it('URL present with writer username → refuse (assertAnalyticsReplicaRole production caller)', async () => {
    process.env.ANALYTICS_REPLICA_LEDGER_URL = 'postgres://svc_ledger:x@primary:5432/ledger';
    const res = await GET(new Request('http://admin.local/api/analytics/warehouse', { headers: AUTH_HEADERS }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe('refuse');
    expect(body.mayLabelLive).toBe(false);
    expect(String(body.reason)).toMatch(/writer-looking|primary credentials|readonly/i);
  });

  it('readonly URL without lag → unavailable lag_unknown (configured path, no invent)', async () => {
    process.env.ANALYTICS_REPLICA_LEDGER_URL = 'postgres://analytics_ro:x@replica:5432/ledger';
    const res = await GET(new Request('http://admin.local/api/analytics/warehouse', { headers: AUTH_HEADERS }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('unavailable');
    expect(body.reason).toBe('lag_unknown');
    expect(body.mayLabelLive).toBe(false);
  });
});

describe('POST /api/analytics/warehouse', () => {
  it('env lag + fixtures → ok points but mayLabelLive false', async () => {
    process.env.ANALYTICS_REPLICA_CONFIGURED = 'true';
    process.env.ANALYTICS_REPLICA_LAG_SECONDS = '5';
    const res = await POST(
      new Request('http://admin.local/api/analytics/warehouse', {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          facts: [{ metricId: 'trade.fills.count', value: '3' }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.points.some((p: { metricId: string; value: string }) => p.metricId === 'trade.fills.count' && p.value === '3')).toBe(true);
    // Break residual: typed env lag must not claim live forever.
    expect(body.mayLabelLive).toBe(false);
    expect(body.lagSource).toBe('configured');
  });

  it('probe + readonly URL + watermark + fixtures → mayLabelLive true with lagMeasuredAt', async () => {
    process.env.ANALYTICS_REPLICA_LEDGER_URL = 'postgres://analytics_ro:x@replica:5432/ledger';
    process.env.ANALYTICS_ETL_WATERMARK_AT = '2026-08-12T10:00:00.000Z';
    setWarehouseLagProbeForTests(({ nowMs }) => ({
      lagSeconds: 6,
      measuredAt: nowMs,
    }));

    const res = await POST(
      new Request('http://admin.local/api/analytics/warehouse', {
        method: 'POST',
        headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          facts: [{ metricId: 'trade.fills.count', value: '3' }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.mayLabelLive).toBe(true);
    expect(body.lagSource).toBe('probed');
    expect(typeof body.lagMeasuredAt).toBe('number');
    expect(body.freshness).toBe('live');
  });
});
