import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { REGION_FAIL_CLOSED_ENV, SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV, SCREENING_REVIEWED_EMPTY } from '@intafaced/config';
import { createAdminApi } from './admin-api.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { registerAdminRoutes, registerGeoBlockGuard } from './control-plane.js';
import {
  GEO_BLOCK_EMPTY_CODE,
  GEO_BLOCK_HIT_CODE,
  GEO_BLOCK_REGION_UNKNOWN_CODE,
  GEO_BLOCK_SCREENED_CODE,
  GEO_BLOCK_UNRESOLVED_CODE,
  GEO_BLOCK_UNSET_CODE,
  looksLikeGeoClearance,
} from './geo-block.js';
import { KillSwitchState } from './kill-switch.js';

// These suites read the live process env for the sanctions-screening posture. An
// unset APP_ENV is production-like and refuses by design, so they declare the test env.
vi.stubEnv('APP_ENV', 'test');

const tokens: TokenConfig = {
  secret: 'test-only-signing-secret-at-least-32-characters-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';

async function asOperator(): Promise<string> {
  const { token } = await issueAccessToken(
    {
      userId: OPERATOR,
      sessionId: SESSION,
      scopes: ['admin:write'],
      tier: 'institutional',
      mfa: true,
    },
    tokens,
  );
  return `Bearer ${token}`;
}

const apps: FastifyInstance[] = [];

function clearScreeningEnv(): void {
  delete process.env[SANCTIONS_REGIONS_ENV];
  delete process.env[SANCTIONS_SOURCE_ENV];
  delete process.env.DEFAULT_REGION;
  delete process.env[REGION_FAIL_CLOSED_ENV];
}

beforeEach(() => {
  clearScreeningEnv();
});

afterEach(async () => {
  while (apps.length) {
    const a = apps.pop();
    if (a) await a.close();
  }
  clearScreeningEnv();
});

async function buildEdge() {
  const app = Fastify({ logger: false });
  const state = new KillSwitchState();
  registerGeoBlockGuard(app);
  const admin = createAdminApi(state, { tokens, ledger: null, approvals: stubApprovalConsumer('44444444-4444-4444-8444-444444444444') });
  registerAdminRoutes(app, admin);
  app.all('/api/*', async () => ({ ok: true }));
  await app.ready();
  apps.push(app);
  return { app };
}

describe('public geo-block door — empty screening is unknown', () => {
  it('refuses /api with typed unset code when screening is empty', async () => {
    const { app } = await buildEdge();
    const res = await app.inject({ method: 'GET', url: '/api/trade/health' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body.code).toBe(GEO_BLOCK_UNSET_CODE);
    expect(body.error).toBe(GEO_BLOCK_UNSET_CODE);
    expect(body.reason).toBe('screening_unset');
    expect(body.screeningConfigured).toBe(false);
    expect(body.inventedBlockedList).toBe(false);
    expect(looksLikeGeoClearance(body)).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/"blocked"\s*:\s*true/);
    expect(body).not.toHaveProperty('blocked');
  });

  it('refuses /api when screening is reviewed-empty — not a geo-clearance', async () => {
    process.env[SANCTIONS_REGIONS_ENV] = SCREENING_REVIEWED_EMPTY;
    process.env[SANCTIONS_SOURCE_ENV] = 'counsel-memo-test-not-a-real-list';
    const { app } = await buildEdge();
    const res = await app.inject({ method: 'POST', url: '/api/trade/orders' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body.code).toBe(GEO_BLOCK_EMPTY_CODE);
    expect(body.reason).toBe('screening_empty');
    expect(looksLikeGeoClearance(body)).toBe(false);
  });

  it('passes /api when a listed fixture does not name the region', async () => {
    process.env[SANCTIONS_REGIONS_ENV] = 'AA:test-fixture-not-a-real-list';
    process.env.DEFAULT_REGION = 'DE';
    const { app } = await buildEdge();
    const res = await app.inject({ method: 'GET', url: '/api/trade/health' });
    expect(res.statusCode).toBe(200);
  });

  it('blocks /api when the listed fixture names the request region', async () => {
    process.env[SANCTIONS_REGIONS_ENV] = 'AA:test-fixture-not-a-real-list';
    process.env.DEFAULT_REGION = 'AA';
    const { app } = await buildEdge();
    const res = await app.inject({ method: 'GET', url: '/api/trade/health' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      code: GEO_BLOCK_HIT_CODE,
      error: 'This is not available in your region.',
      reason: 'region_listed',
      inventedBlockedList: false,
    });
  });

  it('refuses /api as region-unknown when XX is stamped and fail-closed is armed', async () => {
    process.env[SANCTIONS_REGIONS_ENV] = 'AA:test-fixture-not-a-real-list';
    process.env[REGION_FAIL_CLOSED_ENV] = 'true';
    const { app } = await buildEdge();
    const res = await app.inject({ method: 'GET', url: '/api/trade/health' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body.code).toBe(GEO_BLOCK_REGION_UNKNOWN_CODE);
    expect(body.reason).toBe('region_unknown');
    expect(body.regionResolved).toBe(false);
    expect(looksLikeGeoClearance(body)).toBe(false);
  });
});

describe('ops geo-block door — refuse, never 200-cleared on empty', () => {
  it('GET /admin/compliance/geo-block is 409 when screening is unset', async () => {
    const { app } = await buildEdge();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/compliance/geo-block',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe(GEO_BLOCK_UNSET_CODE);
    expect(looksLikeGeoClearance(body)).toBe(false);
  });

  it('/admin/status geoBlock is refuse, not allowed, when screening is empty', async () => {
    const { app } = await buildEdge();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { geoBlock: Record<string, unknown> };
    expect(body.geoBlock.allowed).toBe(false);
    expect(body.geoBlock.code).toBe(GEO_BLOCK_UNSET_CODE);
    expect(body.geoBlock.enforcedOnApiPath).toBe(true);
    expect(looksLikeGeoClearance(body.geoBlock)).toBe(false);
  });

  it('ops geo-block returns screened (not invented blocked:true) against a listed miss', async () => {
    process.env[SANCTIONS_REGIONS_ENV] = 'AA:test-fixture-not-a-real-list';
    process.env.DEFAULT_REGION = 'DE';
    const { app } = await buildEdge();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/compliance/geo-block',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      code: GEO_BLOCK_SCREENED_CODE,
      inventedBlockedList: false,
      regionResolved: true,
    });
    expect(body).not.toHaveProperty('blocked');
  });

  it('ops geo-block does not 200-screen unresolved XX against a listed miss', async () => {
    process.env[SANCTIONS_REGIONS_ENV] = 'AA:test-fixture-not-a-real-list';
    const { app } = await buildEdge();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/compliance/geo-block',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      code: GEO_BLOCK_UNRESOLVED_CODE,
      reason: 'region_unresolved',
      regionResolved: false,
      inventedBlockedList: false,
    });
    expect(body.code).not.toBe(GEO_BLOCK_SCREENED_CODE);
    expect(looksLikeGeoClearance(body)).toBe(false);
  });
});
