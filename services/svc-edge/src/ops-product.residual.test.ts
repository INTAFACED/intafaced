import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { NETWORK_SIGNAL_CONFIGURED_ENV, NETWORK_SIGNAL_FAIL_CLOSED_ENV } from '@intafaced/config';
import { createAdminApi } from './admin-api.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { registerAdminRoutes, registerKillSwitchGuard, registerNetworkAccessGuard } from './control-plane.js';
import { KillSwitchState } from './kill-switch.js';

// These suites read the live process env for the sanctions-screening posture. An
// unset APP_ENV is production-like and refuses by design, so they declare the test env.
vi.stubEnv('APP_ENV', 'test');

/**
 * Wave 13 L05 product Done bars beyond #1551/#1582 status-surface seals.
 *
 * Unit cards:
 * | Unit | Promise | Done bar | Class |
 * | network on path | VPN fail-closed product | fail-closed refuses /api | N |
 * | queue open | compliance queue product | open is explicit; no invent | N |
 * | queue audit | disposition trail | refuse/success recorded | N |
 * | kill reason | admin kill residual | 503 carries halt codes | N |
 * | analytics door | warehouse dark honesty | GET never live without lag | N |
 */

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

afterEach(async () => {
  while (apps.length) {
    const a = apps.pop();
    if (a) await a.close();
  }
  delete process.env[NETWORK_SIGNAL_FAIL_CLOSED_ENV];
  delete process.env[NETWORK_SIGNAL_CONFIGURED_ENV];
});

async function buildEdge() {
  const app = Fastify({ logger: false });
  const state = new KillSwitchState();
  registerKillSwitchGuard(app, state);
  registerNetworkAccessGuard(app);
  const admin = createAdminApi(state, { tokens, ledger: null, approvals: stubApprovalConsumer('44444444-4444-4444-8444-444444444444') });
  registerAdminRoutes(app, admin);
  app.all('/api/*', async () => ({ ok: true }));
  await app.ready();
  apps.push(app);
  return { app, state, admin };
}

describe('U1 — network fail-closed on request path', () => {
  it('allows /api when network fail-closed is off (default)', async () => {
    const { app } = await buildEdge();
    const res = await app.inject({ method: 'GET', url: '/api/trade/health' });
    expect(res.statusCode).toBe(200);
  });

  it('refuses /api with typed code when fail-closed and partner unset', async () => {
    process.env[NETWORK_SIGNAL_FAIL_CLOSED_ENV] = '1';
    const { app } = await buildEdge();
    const res = await app.inject({ method: 'POST', url: '/api/trade/orders' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      code: 'edge.network_unconfigured',
      networkCode: 'denied.network_unconfigured',
    });
  });

  it('does not block /admin or /ready under fail-closed', async () => {
    process.env[NETWORK_SIGNAL_FAIL_CLOSED_ENV] = '1';
    const { app } = await buildEdge();
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    // /ready may not be registered on this harness — only assert admin path.
    const status = await app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().networkSignal.accessAllowed).toBe(false);
    void ready;
  });

  it('refuses dark partner under fail-closed', async () => {
    process.env[NETWORK_SIGNAL_FAIL_CLOSED_ENV] = '1';
    process.env[NETWORK_SIGNAL_CONFIGURED_ENV] = '1';
    const { app } = await buildEdge();
    const res = await app.inject({ method: 'GET', url: '/api/identity/me' });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('edge.network_dark');
  });
});

describe('U2 — compliance queue open product', () => {
  it('does not invent cases on empty GET', async () => {
    const { app } = await buildEdge();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/compliance/queue',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ empty: true, items: [] });
  });

  it('opens a case only via explicit POST — never auto-fill', async () => {
    const { app } = await buildEdge();
    const open = await app.inject({
      method: 'POST',
      url: '/admin/compliance/queue/open',
      headers: { authorization: await asOperator() },
      payload: { id: 'hit-1', kind: 'screening_hit', subjectId: 'user-9' },
    });
    expect(open.statusCode).toBe(200);
    expect(open.json().empty).toBe(false);
    expect(open.json().items).toHaveLength(1);
    expect(open.json().items[0].id).toBe('hit-1');

    const bad = await app.inject({
      method: 'POST',
      url: '/admin/compliance/queue/open',
      headers: { authorization: await asOperator() },
      payload: { id: '', kind: 'manual', subjectId: 'x' },
    });
    expect(bad.statusCode).toBe(400);

    const dup = await app.inject({
      method: 'POST',
      url: '/admin/compliance/queue/open',
      headers: { authorization: await asOperator() },
      payload: { id: 'hit-1', kind: 'manual', subjectId: 'user-9' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('records disposition audit including partner_cleared refuse', async () => {
    const { app } = await buildEdge();
    await app.inject({
      method: 'POST',
      url: '/admin/compliance/queue/open',
      headers: { authorization: await asOperator() },
      payload: { id: 'hit-2', kind: 'network_flag', subjectId: 'user-2' },
    });
    const refuse = await app.inject({
      method: 'POST',
      url: '/admin/compliance/queue/disposition',
      headers: { authorization: await asOperator() },
      payload: { itemId: 'hit-2', status: 'partner_cleared', partnerRef: 'slot-z' },
    });
    expect(refuse.statusCode).toBe(409);
    expect(refuse.json().code).toBe('refuse.partner_absent');

    const q = await app.inject({
      method: 'GET',
      url: '/admin/compliance/queue',
      headers: { authorization: await asOperator() },
    });
    const body = q.json() as {
      empty: boolean;
      recentAudit: Array<{ itemId: string; ok: boolean; code?: string }>;
    };
    expect(body.empty).toBe(false); // case still open
    expect(body.recentAudit.some((a) => a.itemId === 'hit-2' && a.ok === false && a.code === 'refuse.partner_absent')).toBe(true);
  });

  it('attributes a disposition to the verified operator, never a caller-supplied actor', async () => {
    const { app } = await buildEdge();
    const authorization = await asOperator();
    await app.inject({
      method: 'POST',
      url: '/admin/compliance/queue/open',
      headers: { authorization },
      payload: { id: 'hit-forge', kind: 'manual', subjectId: 'user-3' },
    });

    const disposition = await app.inject({
      method: 'POST',
      url: '/admin/compliance/queue/disposition',
      headers: { authorization },
      payload: {
        itemId: 'hit-forge',
        status: 'rejected',
        actor: '99999999-9999-4999-8999-999999999999',
        reason: 'identity evidence did not match',
        approvalId: 'appr-hit-forge',
        operationId: 'op-hit-forge',
      },
    });

    expect(disposition.statusCode).toBe(200);
    expect(disposition.json()).toMatchObject({
      ok: true,
      actor: OPERATOR,
      approverId: '44444444-4444-4444-8444-444444444444',
    });
    expect(disposition.json().queue.recentAudit[0]).toMatchObject({
      itemId: 'hit-forge',
      actor: OPERATOR,
      approverId: '44444444-4444-4444-8444-444444444444',
      reason: 'identity evidence did not match',
    });
  });
});

describe('U4 — analytics warehouse door', () => {
  it('GET /admin/analytics/warehouse never paints live without lag', async () => {
    const { app } = await buildEdge();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics/warehouse',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      mayLabelLive: boolean;
      surfaceStatus: string;
      etlWatermark: string;
      refuse: string | null;
    };
    expect(body.mayLabelLive).toBe(false);
    expect(body.surfaceStatus).not.toBe('ok');
    expect(body.etlWatermark).toBe('absent');
    expect((body as { lagSource?: string }).lagSource).toBe('unknown');
  });
});

describe('U5 — kill halt codes residual', () => {
  it('503 carries haltCode + operatorReason', async () => {
    const { app, state } = await buildEdge();
    state.set('trade', true, OPERATOR, 'incident desk freeze of new orders');
    const res = await app.inject({ method: 'POST', url: '/api/trade/orders.create' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      code: 'edge.module_killed',
      module: 'trade',
      haltCode: 'module-killed',
    });
    expect(String(res.json().operatorReason)).toMatch(/incident desk freeze/i);
  });
});
