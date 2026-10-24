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
 * The ledger object lookup on the edge (OPS-rules-monitoring-12): a founder's admin:read with a second factor, the operator's own token forwarded to
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
  it('refuses no credential, admin:read or treasury without a second factor, and a scope that is neither, calling nothing', async () => {
    const { app, calls } = await harness();
    for (const url of [`/admin/ledger/transactions/${TX}`, '/admin/ledger/trace?businessKey=k']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      for (const scopes of [['admin:treasury'], ['admin:read']]) {
        const res = await app.inject({ method: 'GET', url, headers: { authorization: await bearer(scopes, false) } });
        expect(res.statusCode).toBe(401);
      }
      expect(
        (await app.inject({ method: 'GET', url, headers: { authorization: await bearer(['market:ops', 'admin:write']) } })).statusCode,
      ).toBe(403);
    }
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("forwards a founder's admin:read with a second factor (owner decision 2026-10-23) on both lookups", async () => {
    const { app, calls } = await harness();
    const auth = await bearer(['admin:read']);
    expect(
      (await app.inject({ method: 'GET', url: `/admin/ledger/transactions/${TX}`, headers: { authorization: auth } })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/admin/ledger/trace?businessKey=k', headers: { authorization: auth } })).statusCode,
    ).toBe(200);
    expect(calls.map((call) => call.path)).toEqual([`/operator/transactions/${TX}`, '/operator/trace?businessKey=k']);
    expect(calls.every((call) => call.bearer === auth)).toBe(true);
    await app.close();
  });

  it('keeps the freeze and reconcile on treasury: admin:read with a second factor forwards nothing there', async () => {
    const { app, calls } = await harness();
    const authorization = await bearer(['admin:read']);
    expect((await app.inject({ method: 'GET', url: '/admin/ledger/freeze', headers: { authorization } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/admin/ledger/reconcile', headers: { authorization }, payload: {} })).statusCode).toBe(
      403,
    );
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

describe('the ledger desk reads through the edge (OPS-ledger-desk-01)', () => {
  it("forwards each read's named query keys, re-encoded, with the operator's own token, and passes the answer through", async () => {
    const body = { total: '1', rows: [], nextCursor: null };
    const { app, calls } = await harness({ status: 200, body });
    const auth = await bearer(['admin:read']);
    const list = await app.inject({
      method: 'GET',
      url: '/admin/ledger/transactions?assetId=USDT&from=2026-10-24T00%3A00%3A00Z&before=51',
      headers: { authorization: auth },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual(body);
    await app.inject({ method: 'GET', url: '/admin/ledger/accounts?prefix=house%3Afees%26x%3D1', headers: { authorization: auth } });
    await app.inject({ method: 'GET', url: '/admin/ledger/stats', headers: { authorization: auth } });
    expect(calls).toEqual([
      { path: '/operator/transactions?assetId=USDT&from=2026-10-24T00%3A00%3A00Z&before=51', method: 'GET', bearer: auth },
      { path: '/operator/accounts?prefix=house%3Afees%26x%3D1', method: 'GET', bearer: auth },
      { path: '/operator/stats', method: 'GET', bearer: auth },
    ]);
    await app.close();
  });

  it("passes svc-ledger's refusals through unchanged", async () => {
    const answer = { status: 400, body: { message: 'from must be before to', code: 'ledger.lookup_input_invalid' } };
    const { app } = await harness(answer);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/ledger/transactions?from=2026-10-25T00:00:00Z&to=2026-10-24T00:00:00Z',
      headers: { authorization: await bearer(['admin:read']) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(answer.body);
    await app.close();
  });

  it('refuses a key the read does not take, a repeated key and an over-long value, calling nothing', async () => {
    const { app, calls } = await harness();
    const authorization = await bearer(['admin:read']);
    for (const url of [
      '/admin/ledger/transactions?txId=x',
      '/admin/ledger/transactions?assetId=USDT&assetId=BTC',
      `/admin/ledger/accounts?prefix=${'a'.repeat(257)}`,
      '/admin/ledger/stats?all=1',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization } });
      expect(res.statusCode, url).toBe(400);
      expect(res.json()).toMatchObject({ code: 'edge.invalid_ledger_lookup' });
    }
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it('refuses no credential, no second factor and a scope that is not a read of the book, calling nothing', async () => {
    const { app, calls } = await harness();
    for (const url of ['/admin/ledger/transactions', '/admin/ledger/accounts?prefix=house%3Af', '/admin/ledger/stats']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url, headers: { authorization: await bearer(['admin:read'], false) } })).statusCode,
        url,
      ).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url, headers: { authorization: await bearer(['market:ops', 'admin:write']) } })).statusCode,
        url,
      ).toBe(403);
    }
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it('refuses with edge.ledger_unreachable when this edge has no ledger URL', async () => {
    const { app } = await harness(undefined, false);
    const res = await app.inject({ method: 'GET', url: '/admin/ledger/stats', headers: { authorization: await bearer(['admin:read']) } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'edge.ledger_unreachable' });
    await app.close();
  });
});
