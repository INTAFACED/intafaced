import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { createAdminApi, type LedgerOperatorCall } from './admin-api.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { registerAdminRoutes } from './control-plane.js';
import { EdgeComplianceQueue } from './compliance-honesty.js';
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
const APPROVER = '44444444-4444-4444-8444-444444444444';

async function bearer(scopes: string[], mfa = true): Promise<string> {
  const { token } = await issueAccessToken({ userId: OPERATOR, sessionId: SESSION, scopes, tier: 'institutional', mfa }, tokens);
  return `Bearer ${token}`;
}

describe('admin ops back end on the edge', () => {
  it('refuses reconcile when the ledger URL is unset and does not invent a book', async () => {
    const app = Fastify({ logger: false });
    const admin = createAdminApi(new KillSwitchState(), { tokens, ledger: null, approvals: stubApprovalConsumer(APPROVER) });
    registerAdminRoutes(app, admin);
    await app.ready();
    const headers = { authorization: await bearer(['admin:treasury']) };
    const read = await app.inject({ method: 'GET', url: '/admin/ledger/reconcile', headers });
    expect(read.statusCode).toBe(503);
    expect(read.json()).toMatchObject({ code: 'edge.ledger_unreachable' });
    expect(JSON.stringify(read.json())).not.toMatch(/accountsChecked|chainLength/);
    const post = await app.inject({
      method: 'POST',
      url: '/admin/ledger/reconcile',
      headers,
      payload: { approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(post.statusCode).toBe(503);
    expect(post.json()).toMatchObject({ code: 'edge.ledger_unreachable' });
    await app.close();
  });

  it('proxies reconcile and then reads that result back, including after a new admin', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'edge-reconcile-'));
    const path = join(directory, 'last.json');
    const report = {
      ok: true,
      accountsChecked: 4,
      chainLength: 9,
      unbalancedAssets: [],
      ranAt: '2026-10-17T00:00:00.000Z',
      confirmOperatorId: APPROVER,
    };
    const ledger: LedgerOperatorCall = async (called, method) => {
      expect(called).toBe('/operator/reconcile');
      expect(method).toBe('POST');
      return { status: 200, body: report };
    };
    const app = Fastify({ logger: false });
    const admin = createAdminApi(new KillSwitchState(), {
      tokens,
      ledger,
      approvals: stubApprovalConsumer(APPROVER),
      reconcileLastPath: path,
    });
    registerAdminRoutes(app, admin);
    await app.ready();
    const headers = { authorization: await bearer(['admin:treasury']) };
    const missing = await app.inject({ method: 'GET', url: '/admin/ledger/reconcile', headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'edge.reconcile_never_run' });

    const ran = await app.inject({
      method: 'POST',
      url: '/admin/ledger/reconcile',
      headers,
      payload: { approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(ran.statusCode).toBe(200);
    expect(ran.json()).toMatchObject({ accountsChecked: 4, chainLength: 9, confirmOperatorId: APPROVER });

    const again = createAdminApi(new KillSwitchState(), {
      tokens,
      ledger,
      approvals: stubApprovalConsumer(APPROVER),
      reconcileLastPath: path,
    });
    await expect(again.readReconcile()).resolves.toMatchObject({ status: 200, body: report });
    await app.close();
  });

  it('keeps a compliance case and its reason across a restart file, and refuses population intake', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'edge-compliance-'));
    const path = join(directory, 'queue.json');
    const first = new EdgeComplianceQueue(() => process.env, { statePath: path });
    first.open({ id: 'hit-9', kind: 'manual', subjectId: 'user-9', openedAt: '2026-10-17T00:00:00.000Z' });
    const second = new EdgeComplianceQueue(() => process.env, { statePath: path });
    expect(second.snapshot().items.map((item) => item.id)).toEqual(['hit-9']);
    expect(second.snapshot().store).toBe('file');

    const app = Fastify({ logger: false });
    const admin = createAdminApi(new KillSwitchState(), { tokens, ledger: null, approvals: stubApprovalConsumer(APPROVER) });
    registerAdminRoutes(app, admin);
    await app.ready();
    const headers = { authorization: await bearer(['admin:write']) };
    const intake = await app.inject({ method: 'POST', url: '/admin/compliance/queue/intake', headers, payload: {} });
    expect(intake.statusCode).toBe(409);
    expect(intake.json()).toMatchObject({ code: 'edge.screening_subject_feed_unconfigured' });
    const population = await app.inject({ method: 'GET', url: '/admin/compliance/geo-population', headers });
    expect(population.statusCode).toBe(409);
    expect(population.json()).toMatchObject({ code: 'edge.geo_population_unconfigured', scope: 'request' });
    expect(population.json()).not.toHaveProperty('listHitCount');
    const plain = await app.inject({
      method: 'GET',
      url: '/admin/compliance/geo-population',
      headers: { authorization: await bearer(['identity:read']) },
    });
    expect(plain.statusCode).toBe(403);
    await app.close();
  });

  it('refuses a one-operator disposition before anything is cleared', async () => {
    const app = Fastify({ logger: false });
    const admin = createAdminApi(new KillSwitchState(), { tokens, ledger: null, approvals: stubApprovalConsumer(APPROVER) });
    registerAdminRoutes(app, admin);
    await app.ready();
    const headers = { authorization: await bearer(['admin:write']) };
    await app.inject({
      method: 'POST',
      url: '/admin/compliance/queue/open',
      headers,
      payload: { id: 'hit-1', kind: 'manual', subjectId: 'user-1' },
    });
    const refused = await app.inject({
      method: 'POST',
      url: '/admin/compliance/queue/disposition',
      headers,
      payload: { itemId: 'hit-1', status: 'cleared', reason: 'evidence checked by one person' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'action_approval.missing' });
    const queue = await app.inject({ method: 'GET', url: '/admin/compliance/queue', headers });
    expect(queue.json().items).toHaveLength(1);
    await app.close();
  });

  it('forwards reconciliation control list, define and run, and refuses a run with no approval', async () => {
    const seen: Array<{ path: string; method: string; bearer: string; body?: unknown }> = [];
    const ledger: LedgerOperatorCall = async (path, method, bearerHeader, body) => {
      seen.push({ path, method, bearer: bearerHeader, body });
      return { status: 200, body: { ok: true, path } };
    };
    const app = Fastify({ logger: false });
    const admin = createAdminApi(new KillSwitchState(), { tokens, ledger, approvals: stubApprovalConsumer(APPROVER) });
    registerAdminRoutes(app, admin);
    await app.ready();
    const treasury = { authorization: await bearer(['admin:treasury']) };
    const compliance = { authorization: await bearer(['admin:compliance']) };
    const listed = await app.inject({ method: 'GET', url: '/admin/ledger/reconciliation/controls', headers: compliance });
    expect(listed.statusCode).toBe(200);
    const defined = await app.inject({
      method: 'POST',
      url: '/admin/ledger/reconciliation/controls',
      headers: treasury,
      payload: {
        template: 'threshold',
        accountSet: { mode: 'query', assetId: 'USDT' },
        reason: 'set the reconciliation control',
      },
    });
    expect(defined.statusCode).toBe(200);
    const ran = await app.inject({
      method: 'POST',
      url: '/admin/ledger/reconciliation/controls/run',
      headers: treasury,
      payload: {
        controlId: '11111111-1111-4111-8111-111111111111',
        reason: 'run the reconciliation control',
        approvalId: 'appr-1',
        operationId: 'op-1',
      },
    });
    expect(ran.statusCode).toBe(200);
    expect(seen.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /operator/reconciliation/controls',
      'POST /operator/reconciliation/controls',
      'POST /operator/reconciliation/controls/run',
    ]);
    expect(seen[2]?.bearer).toBe(treasury.authorization);
    expect(seen[2]?.body).toMatchObject({ approvalId: 'appr-1', operationId: 'op-1' });
    const before = seen.length;
    const refused = await app.inject({
      method: 'POST',
      url: '/admin/ledger/reconciliation/controls/run',
      headers: treasury,
      payload: { controlId: '11111111-1111-4111-8111-111111111111', reason: 'run the reconciliation control' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'edge.invalid_reconciliation_control' });
    expect(seen).toHaveLength(before);
    const anonymous = await app.inject({ method: 'POST', url: '/admin/ledger/reconciliation/controls/run', payload: {} });
    expect(anonymous.statusCode).toBe(401);
    await app.close();
  });
  it('forwards a control update, and refuses compliance and a treasury token without a second factor before calling the ledger', async () => {
    const seen: string[] = [];
    const ledger: LedgerOperatorCall = async (path, method) => {
      seen.push(`${method} ${path}`);
      return { status: 200, body: { ok: true } };
    };
    const app = Fastify({ logger: false });
    const admin = createAdminApi(new KillSwitchState(), { tokens, ledger, approvals: stubApprovalConsumer(APPROVER) });
    registerAdminRoutes(app, admin);
    await app.ready();
    const controlId = '11111111-1111-4111-8111-111111111111';
    const update = { controlId, explanation: 'set the explanation', reason: 'update the reconciliation control' };
    const run = { controlId, reason: 'run the reconciliation control', approvalId: 'appr-1', operationId: 'op-1' };
    const define = { template: 'threshold', accountSet: { mode: 'query', assetId: 'USDT' }, reason: 'set the reconciliation control' };
    const treasury = { authorization: await bearer(['admin:treasury']) };
    const updated = await app.inject({
      method: 'POST',
      url: '/admin/ledger/reconciliation/controls/update',
      headers: treasury,
      payload: update,
    });
    expect(updated.statusCode).toBe(200);
    expect(seen).toEqual(['POST /operator/reconciliation/controls/update']);
    const compliance = { authorization: await bearer(['admin:compliance']) };
    const noMfa = { authorization: await bearer(['admin:treasury'], false) };
    for (const [url, payload] of [
      ['/admin/ledger/reconciliation/controls', define],
      ['/admin/ledger/reconciliation/controls/update', update],
      ['/admin/ledger/reconciliation/controls/run', run],
    ] as const) {
      const byCompliance = await app.inject({ method: 'POST', url, headers: compliance, payload });
      expect(byCompliance.statusCode).toBe(403);
      const withoutMfa = await app.inject({ method: 'POST', url, headers: noMfa, payload });
      expect(withoutMfa.statusCode).toBe(401);
      expect(withoutMfa.json()).toMatchObject({ code: 'mfa.required' });
    }
    const listedWithoutMfa = await app.inject({ method: 'GET', url: '/admin/ledger/reconciliation/controls', headers: noMfa });
    expect(listedWithoutMfa.statusCode).toBe(401);
    expect(seen).toHaveLength(1);
    await app.close();
  });
});
