import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { createAdminApi, type LedgerOperatorCall } from './admin-api.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { registerAdminRoutes } from './control-plane.js';
import { KillSwitchState } from './kill-switch.js';

// The suites read the live process env for the sanctions-screening posture; an unset APP_ENV refuses by design.
vi.stubEnv('APP_ENV', 'test');

/**
 * The ledger object lookup on the edge (OPS-rules-monitoring-12): treasury scope, the operator's own token forwarded to
 * one named svc-ledger route, the path built from a checked id or an encoded key, and svc-ledger's answer passed through.
 */

const tokens: TokenConfig = {
  secret: 'test-only-signing-secret-at-least-32-characters-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const TX = '33333333-3333-4333-8333-333333333333';

async function bearer(scopes: string[], mfa = true): Promise<string> {
  const { token } = await issueAccessToken(
    { userId: OPERATOR, sessionId: '22222222-2222-4222-8222-222222222222', scopes, tier: 'institutional', mfa },
    tokens,
  );
  return `Bearer ${token}`;
}

async function harness(answer: { status: number; body: unknown } = { status: 200, body: { ok: true } }, wired = true) {
  const calls: { path: string; method: string; bearer: string }[] = [];
  const ledger: LedgerOperatorCall = async (path, method, header) => {
    calls.push({ path, method, bearer: header });
    return answer;
  };
  const app = Fastify({ logger: false });
  registerAdminRoutes(
    app,
    createAdminApi(new KillSwitchState(), { tokens, ledger: wired ? ledger : null, approvals: stubApprovalConsumer(APPROVER) }),
  );
  await app.ready();
  return { app, calls };
}

describe('GET /admin/ledger/transactions/:txId', () => {
  it("forwards the operator's own token to the one transaction route and passes the answer through", async () => {
    const body = { txId: TX, businessKey: 'deposit:local-test:1', postings: [] };
    const { app, calls } = await harness({ status: 200, body });
    const auth = await bearer(['admin:treasury']);
    const res = await app.inject({ method: 'GET', url: `/admin/ledger/transactions/${TX}`, headers: { authorization: auth } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
    expect(calls).toEqual([{ path: `/operator/transactions/${TX}`, method: 'GET', bearer: auth }]);
    await app.close();
  });

  it("passes svc-ledger's refusals through unchanged (404 not found, 503 unrecorded)", async () => {
    for (const answer of [
      { status: 404, body: { message: 'No transaction has that id.', code: 'ledger.tx_not_found' } },
      { status: 503, body: { message: 'The lookup could not be recorded, so it was not read.', code: 'ledger.lookup_unrecorded' } },
    ]) {
      const { app } = await harness(answer);
      const res = await app.inject({
        method: 'GET',
        url: `/admin/ledger/transactions/${TX}`,
        headers: { authorization: await bearer(['admin:treasury']) },
      });
      expect(res.statusCode).toBe(answer.status);
      expect(res.json()).toEqual(answer.body);
      await app.close();
    }
  });

  it('refuses an id that is not a UUID without calling svc-ledger', async () => {
    const { app, calls } = await harness();
    for (const id of ['nope', '..%2Ffreeze', `${TX}%3FbusinessKey%3Dx`]) {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/ledger/transactions/${id}`,
        headers: { authorization: await bearer(['admin:treasury']) },
      });
      expect(res.statusCode, id).toBe(400);
      expect(res.json()).toMatchObject({ code: 'edge.invalid_ledger_lookup' });
    }
    expect(calls).toHaveLength(0);
    await app.close();
  });
});

describe('GET /admin/ledger/trace', () => {
  it('encodes the business key into the one trace route', async () => {
    const { app, calls } = await harness({ status: 200, body: { found: false, businessKey: 'a&b=c d' } });
    const auth = await bearer(['admin:treasury']);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/ledger/trace?businessKey=${encodeURIComponent('a&b=c d')}`,
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ path: '/operator/trace?businessKey=a%26b%3Dc%20d', method: 'GET', bearer: auth }]);
    await app.close();
  });

  it('refuses a missing, blank or over-long key without calling svc-ledger', async () => {
    const { app, calls } = await harness();
    const auth = { authorization: await bearer(['admin:treasury']) };
    for (const url of [
      '/admin/ledger/trace',
      '/admin/ledger/trace?businessKey=%20',
      `/admin/ledger/trace?businessKey=${'k'.repeat(513)}`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth });
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toMatchObject({ code: 'edge.invalid_ledger_lookup' });
    }
    expect(calls).toHaveLength(0);
    await app.close();
  });
});

describe('who may look up through the edge', () => {
  it('refuses no credential, treasury without a second factor and a non-treasury scope, calling nothing', async () => {
    const { app, calls } = await harness();
    for (const url of [`/admin/ledger/transactions/${TX}`, '/admin/ledger/trace?businessKey=k']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url, headers: { authorization: await bearer(['admin:treasury'], false) } })).statusCode,
      ).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url, headers: { authorization: await bearer(['admin:read', 'admin:write']) } })).statusCode,
      ).toBe(403);
    }
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it('refuses with edge.ledger_unreachable when this edge has no ledger URL', async () => {
    const { app } = await harness(undefined, false);
    const res = await app.inject({
      method: 'GET',
      url: `/admin/ledger/transactions/${TX}`,
      headers: { authorization: await bearer(['admin:treasury']) },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'edge.ledger_unreachable' });
    await app.close();
  });
});
