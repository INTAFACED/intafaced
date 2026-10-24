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
 * An account's operator metadata on the edge (J-ops-console-03 #6, #7): the read with the lookups' authority and the
 * operator's own token, the set and the delete as treasury writes, each forwarded to one svc-ledger route built from a
 * checked account id with only its named fields, and svc-ledger's answer (`ledger.frozen` included) passed through.
 */

const tokens: TokenConfig = {
  secret: 'test-only-signing-secret-at-least-32-characters-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const REASON = 'LOCAL TEST label for the desk';

async function bearer(scopes: string[], mfa = true): Promise<string> {
  const { token } = await issueAccessToken(
    { userId: OPERATOR, sessionId: '22222222-2222-4222-8222-222222222222', scopes, tier: 'institutional', mfa },
    tokens,
  );
  return `Bearer ${token}`;
}

async function harness(answer: { status: number; body: unknown } = { status: 200, body: { ok: true } }) {
  const calls: { path: string; method: string; bearer: string; body?: unknown }[] = [];
  const ledger: LedgerOperatorCall = async (path, method, header, body) => {
    calls.push({ path, method, bearer: header, ...(body === undefined ? {} : { body }) });
    return answer;
  };
  const app = Fastify({ logger: false });
  registerAdminRoutes(app, createAdminApi(new KillSwitchState(), { tokens, ledger, approvals: stubApprovalConsumer(APPROVER) }));
  await app.ready();
  return { app, calls };
}

const base = `/admin/ledger/accounts/${ACCOUNT}/metadata`;
const setBody = { key: 'desk.label', value: 'TEST', reason: REASON, revision: 0 };
const deleteBody = { key: 'desk.label', reason: REASON, revision: 1, approvalId: 'appr-1', operationId: 'op-1' };

describe('account metadata through the edge', () => {
  it('forwards the read with the founder’s own token, and the writes with their named fields, passing the answer through', async () => {
    const { app, calls } = await harness({ status: 200, body: { accountId: ACCOUNT } });
    const read = await bearer(['admin:read']);
    const treasury = await bearer(['admin:treasury']);
    const got = await app.inject({ method: 'GET', url: base, headers: { authorization: read } });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual({ accountId: ACCOUNT });
    await app.inject({ method: 'POST', url: `${base}/set`, headers: { authorization: treasury }, payload: setBody });
    await app.inject({ method: 'POST', url: `${base}/delete`, headers: { authorization: treasury }, payload: deleteBody });
    expect(calls).toEqual([
      { path: `/operator/accounts/${ACCOUNT}/metadata`, method: 'GET', bearer: read },
      { path: `/operator/accounts/${ACCOUNT}/metadata/set`, method: 'POST', bearer: treasury, body: setBody },
      { path: `/operator/accounts/${ACCOUNT}/metadata/delete`, method: 'POST', bearer: treasury, body: deleteBody },
    ]);
    await app.close();
  });

  it('passes svc-ledger’s refusal under the posting freeze through unchanged', async () => {
    const frozen = { status: 412, body: { message: 'Ledger posting is frozen: LOCAL TEST', code: 'ledger.frozen' } };
    const { app } = await harness(frozen);
    const res = await app.inject({
      method: 'POST',
      url: `${base}/set`,
      headers: { authorization: await bearer(['admin:treasury']) },
      payload: setBody,
    });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toEqual(frozen.body);
    await app.close();
  });

  it('refuses an account id that is not a UUID and a body with a field it does not name, calling nothing', async () => {
    const { app, calls } = await harness();
    const treasury = await bearer(['admin:treasury']);
    const read = await app.inject({
      method: 'GET',
      url: '/admin/ledger/accounts/not-an-id/metadata',
      headers: { authorization: await bearer(['admin:read']) },
    });
    expect(read.statusCode).toBe(400);
    expect(read.json()).toMatchObject({ code: 'edge.invalid_ledger_lookup' });
    for (const [url, payload] of [
      ['/admin/ledger/accounts/not-an-id/metadata/set', setBody],
      [`${base}/set`, { ...setBody, accountId: 'x' }],
      [`${base}/set`, { ...setBody, revision: '1' }],
      [`${base}/delete`, { ...deleteBody, approverId: 'me' }],
      [`${base}/delete`, { key: 'desk.label', reason: REASON, revision: 1 }],
    ] as const) {
      const res = await app.inject({ method: 'POST', url, headers: { authorization: treasury }, payload });
      expect(res.statusCode, `${url} ${JSON.stringify(payload)}`).toBe(400);
      expect(res.json()).toMatchObject({ code: 'edge.invalid_account_metadata' });
    }
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it('refuses a read without a second factor, and a write from a lookup sign-in, calling nothing', async () => {
    const { app, calls } = await harness();
    expect((await app.inject({ method: 'GET', url: base })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: base, headers: { authorization: await bearer(['admin:read'], false) } })).statusCode,
    ).toBe(401);
    const lookup = await bearer(['admin:read']);
    for (const [path, payload] of [
      ['set', setBody],
      ['delete', deleteBody],
    ] as const) {
      const res = await app.inject({ method: 'POST', url: `${base}/${path}`, headers: { authorization: lookup }, payload });
      expect(res.statusCode, path).toBe(403);
    }
    expect(calls).toHaveLength(0);
    await app.close();
  });
});
