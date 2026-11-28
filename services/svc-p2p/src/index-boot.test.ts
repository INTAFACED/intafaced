import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as affiliateAccrue from './affiliate-accrue.js';
import * as affiliatePayout from './affiliate-payout.js';
import { InstrumentService } from './instrument-service.js';
import { P2P_MODERATION_UNPROBED } from './moderation-honesty.js';
import { P2pService } from './p2p-service.js';

/**
 * svc-p2p's entrypoint, booted in this process: `index.ts` is imported for real, so its own composition runs (its
 * env parse, its sweep at boot, its routes, its HTTP listener). Only the two things a unit run has no server for are
 * stood in: the Postgres client answers every query with no rows, and the JetStream bus is the in-memory one. The
 * sweeps and the affiliate clients are watched, not replaced in what they are handed.
 */

const IDENTITY_URL = 'http://identity.test:4002';
const INTERNAL_SECRET = 'p2p-boot-test-internal-secret-at-least-32';
const MODERATOR = '11111111-1111-4111-8111-111111111111';

vi.mock('postgres', () => {
  const tag = () => Promise.resolve([]);
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    begin: async (fn: (tx: unknown) => unknown) => fn(sql),
    end: async () => undefined,
  });
  return { default: () => sql };
});

vi.mock('@intafaced/events', async (original) => {
  const events = await original<typeof import('@intafaced/events')>();
  return {
    ...events,
    JetStreamEventBus: { connect: async () => new events.MemoryEventBus('svc-p2p') },
  };
});

vi.mock('./affiliate-accrue.js', async (original) => {
  const real = await original<typeof import('./affiliate-accrue.js')>();
  return { ...real, createAffiliateAccrueClient: vi.fn(real.createAffiliateAccrueClient) };
});
vi.mock('./affiliate-payout.js', async (original) => {
  const real = await original<typeof import('./affiliate-payout.js')>();
  return { ...real, createAffiliatePayoutClient: vi.fn(real.createAffiliatePayoutClient) };
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const sweepSettlements = vi.spyOn(P2pService.prototype, 'sweepSettlements');
const sweepDeadlines = vi.spyOn(P2pService.prototype, 'sweepDeadlines');
const purgeExpiredSnapshots = vi.spyOn(InstrumentService.prototype, 'purgeExpiredSnapshots');
let base = '';

beforeAll(async () => {
  sweepSettlements.mockResolvedValue({ settled: 0, failed: 0, failures: [] });
  sweepDeadlines.mockResolvedValue({ expired: 0, escalated: 0, failures: [] } as never);
  purgeExpiredSnapshots.mockResolvedValue({ purged: 0 });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {
    NODE_ENV: 'test',
    APP_ENV: 'test',
    LOG_LEVEL: 'fatal',
    OTEL_ENABLED: 'false',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: String(port),
    DATABASE_URL: 'postgres://p2p:p2p@127.0.0.1:5432/p2p_test',
    DATABASE_POOL_MAX: '2',
    NATS_URL: 'nats://127.0.0.1:4222',
    REDIS_URL: 'redis://127.0.0.1:6379',
    EDGE_PRINCIPAL_SECRET: 'p2p-boot-test-edge-principal-secret-32-chars',
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    LEDGER_URL: 'http://ledger.test:4001',
    IDENTITY_URL,
    P2P_MODERATOR_USER_IDS: MODERATOR,
    P2P_ESCROW_DEADLINE_SECONDS: '120',
    P2P_PAYMENT_DEADLINE_SECONDS: '900',
    P2P_RELEASE_DEADLINE_SECONDS: '1800',
    P2P_DISPUTE_SLA_SECONDS: '604800',
    P2P_DISPUTE_ESCALATION_RECHECK_SECONDS: '3600',
    P2P_SWEEP_INTERVAL_SECONDS: '3600',
    P2P_INSTRUMENT_RETENTION_DAYS: '90',
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  await import('./index.js');
}, 60_000);

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('svc-p2p entrypoint', () => {
  it('sweeps at boot with published batch sizes: 100 settlements, 100 deadlines, 500 purged snapshots', () => {
    expect(sweepSettlements).toHaveBeenCalledWith(100);
    expect(sweepDeadlines).toHaveBeenCalledWith(undefined, 100);
    expect(purgeExpiredSnapshots).toHaveBeenCalledWith(500);
  });

  it('hands the service the HTTP affiliate accrue and payout clients for IDENTITY_URL, on the internal secret', () => {
    const accrue = vi.mocked(affiliateAccrue.createAffiliateAccrueClient);
    const payout = vi.mocked(affiliatePayout.createAffiliatePayoutClient);
    expect(accrue).toHaveBeenCalledTimes(1);
    expect(accrue.mock.calls[0]!.slice(0, 2)).toEqual([IDENTITY_URL, INTERNAL_SECRET]);
    expect(payout).toHaveBeenCalledTimes(1);
    expect(payout.mock.calls[0]!.slice(0, 2)).toEqual([IDENTITY_URL, INTERNAL_SECRET]);
    // The service the entrypoint built is the one its boot sweep ran on; it holds the clients made for IDENTITY_URL.
    const booted: unknown = sweepSettlements.mock.contexts[0];
    expect(booted).toBeInstanceOf(P2pService);
    expect(Reflect.get(booted as object, 'affiliateAccrue')).toBe(accrue.mock.results[0]!.value);
    expect(Reflect.get(booted as object, 'affiliatePayout')).toBe(payout.mock.results[0]!.value);
    expect(Reflect.get(booted as object, 'affiliateAccrue')).not.toBeInstanceOf(affiliateAccrue.NoopAffiliateAccrue);
    expect(Reflect.get(booted as object, 'affiliatePayout')).not.toBeInstanceOf(affiliatePayout.NoopAffiliatePayout);
  });

  it('serves the moderation posture on /health and /ready as configured and unprobed, never reachable', async () => {
    for (const path of ['/health', '/ready']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body, path).not.toHaveProperty('moderationReachable');
      expect(body.moderationConfigured, path).toBe(true);
      expect(body.moderation, path).toEqual({ status: 'configured', code: P2P_MODERATION_UNPROBED });
    }
  });

  it('mounts the signed closure check: refused without the internal secret, answered with it', async () => {
    const raw = JSON.stringify({ userId: MODERATOR, subAccountIds: [] });
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/internal/closure-check`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', ...headers } });
    expect((await post({})).status).toBe(401);
    expect((await post(serviceAuthHeadersForBody('svc-identity', 'some-other-secret-that-is-long-enough', raw))).status).toBe(401);
    const signed = await post(serviceAuthHeadersForBody('svc-identity', INTERNAL_SECRET, raw));
    expect(signed.status).toBe(200);
    expect(await signed.json()).toMatchObject({ blockers: [] });
  });
});
