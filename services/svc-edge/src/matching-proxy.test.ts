import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { SERVICE_HEADER } from '@intafaced/contracts';
import { createAdminApi } from './admin-api.js';
import { KillSwitchState } from './kill-switch.js';
import {
  httpMatchingControl,
  registerMatchingOperatorRoutes,
  type MatchingApprovalRead,
  type MatchingApprovalRow,
  type MatchingControlCall,
  type MatchingControlRequest,
  type MatchingControlResult,
  type MatchingDoorBlock,
} from './matching-proxy.js';

const tokens: TokenConfig = {
  secret: 'test-only-signing-secret-at-least-32-characters-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const SESSION = '22222222-2222-4222-8222-222222222222';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length) {
    const app = apps.pop();
    if (app) await app.close();
  }
});

async function bearer(scopes: Array<'admin:read' | 'admin:write' | 'trade:read'>, mfa = true): Promise<string> {
  const { token } = await issueAccessToken({ userId: OPERATOR, sessionId: SESSION, scopes, tier: 'institutional', mfa }, tokens);
  return `Bearer ${token}`;
}

function row(over: Partial<MatchingApprovalRow> = {}): MatchingApprovalRow {
  return {
    status: 'APPROVED',
    actionType: 'matching.halt',
    targetService: 'svc-matching',
    targetId: 'halt:BTC-USDT',
    requesterId: OPERATOR,
    approverId: APPROVER,
    operationId: 'op-halt-1',
    ...over,
  };
}

function mount(opts: {
  readonly matching: MatchingControlCall | null;
  readonly blocked?: MatchingDoorBlock | null;
  readonly read?: MatchingApprovalRead;
  readonly calls?: MatchingControlRequest[];
}) {
  const app = Fastify({ logger: false });
  const admin = createAdminApi(new KillSwitchState(), { tokens, ledger: null });
  registerMatchingOperatorRoutes(app, {
    tokens,
    authenticateWrite: (header) => admin.authenticate(header),
    matching: opts.matching,
    blocked: opts.blocked === undefined ? null : opts.blocked,
    readApproval:
      opts.read ??
      (async () => {
        return row();
      }),
  });
  apps.push(app);
  return app;
}

function recording(result: (req: MatchingControlRequest) => MatchingControlResult | Promise<MatchingControlResult>): {
  readonly calls: MatchingControlRequest[];
  readonly matching: MatchingControlCall;
} {
  const calls: MatchingControlRequest[] = [];
  const matching: MatchingControlCall = async (req) => {
    calls.push(req);
    return result(req);
  };
  return { calls, matching };
}

const haltBody = {
  idempotencyKey: 'halt-key-01',
  approvalId: 'appr-1',
  operationId: 'op-halt-1',
};

describe('operator matching controls', () => {
  it('refuses a halt with no approval and does not call matching', async () => {
    const { calls, matching } = recording(async () => ({ kind: 'answered', status: 200, body: { accepted: true, halted: true } }));
    const app = mount({ matching });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/matching/markets/BTC-USDT/halt',
      headers: { authorization: await bearer(['admin:write']) },
      payload: { idempotencyKey: 'halt-key-01', operatorId: OPERATOR, confirmOperatorId: APPROVER },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'action_approval.missing', key: 'approvalId' });
    expect(calls).toEqual([]);
  });

  it('halts once when the approval is valid and the audit names both operators', async () => {
    const { calls, matching } = recording(async () => ({
      kind: 'answered',
      status: 200,
      body: { accepted: true, halted: true, marketId: 'BTC-USDT' },
    }));
    const app = mount({ matching });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/matching/markets/BTC-USDT/halt',
      headers: { authorization: await bearer(['admin:write']) },
      payload: haltBody,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().audit).toMatchObject({ requesterId: OPERATOR, approverId: APPROVER, action: 'matching.halt', outcome: 'accepted' });
    expect(JSON.stringify(res.json().audit)).not.toContain('svc-edge');
    expect(JSON.stringify(res.json().audit)).not.toContain('svc-trade');
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/markets/BTC-USDT/halt',
        body: { operatorId: OPERATOR, confirmOperatorId: APPROVER, approvalId: 'appr-1', operationId: 'op-halt-1' },
      },
    ]);
  });

  it('refuses a reused approval and does not call matching again', async () => {
    const { calls, matching } = recording(async () => ({ kind: 'answered', status: 200, body: { accepted: true, halted: true } }));
    const app = mount({ matching });
    const headers = { authorization: await bearer(['admin:write']) };
    const first = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/matching/markets/BTC-USDT/halt',
      headers,
      payload: haltBody,
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/matching/markets/BTC-USDT/halt',
      headers,
      payload: { ...haltBody, idempotencyKey: 'halt-key-02' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'action_approval.reused' });
    expect(calls).toHaveLength(1);
  });

  it('returns an unknown outcome on upstream timeout and does not claim the market halted', async () => {
    const { calls, matching } = recording(async () => ({ kind: 'unknown', error: 'svc-matching did not answer before 15000ms' }));
    const app = mount({ matching });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/matching/markets/BTC-USDT/halt',
      headers: { authorization: await bearer(['admin:write']) },
      payload: haltBody,
    });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ outcome: 'unknown', code: 'matching_upstream_unknown' });
    expect(res.json()).not.toHaveProperty('halted');
    expect(JSON.stringify(res.json())).not.toContain('"halted":true');
    expect(calls).toHaveLength(1);
    const replay = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/matching/markets/BTC-USDT/halt',
      headers: { authorization: await bearer(['admin:write']) },
      payload: haltBody,
    });
    expect(replay.statusCode).toBe(504);
    expect(replay.json()).toMatchObject({ outcome: 'unknown' });
    expect(calls).toHaveLength(1);
  });

  it('refuses a session without the operator permission', async () => {
    const { calls, matching } = recording(async () => ({ kind: 'answered', status: 200, body: { accepted: true } }));
    const app = mount({ matching });
    const customer = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/matching/markets/BTC-USDT/halt',
      headers: { authorization: await bearer(['trade:read']) },
      payload: haltBody,
    });
    expect(customer.statusCode).toBe(403);
    expect(customer.json()).toMatchObject({ code: 'scope.denied' });
    const readOnly = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/matching/markets/BTC-USDT/halt',
      headers: { authorization: await bearer(['admin:read']) },
      payload: haltBody,
    });
    expect(readOnly.statusCode).toBe(403);
    const noMfa = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/matching/markets/BTC-USDT/halt',
      headers: { authorization: await bearer(['admin:write'], false) },
      payload: haltBody,
    });
    expect(noMfa.statusCode).toBe(401);
    expect(noMfa.json()).toMatchObject({ code: 'mfa.required' });
    expect(calls).toEqual([]);
  });

  it('refuses a blank signing key with matching_credential_unconfigured and names MATCHING_EDGE_SIGNING_SECRET', async () => {
    let continued = false;
    const app = mount({
      matching: null,
      blocked: { code: 'matching_credential_unconfigured', key: 'MATCHING_EDGE_SIGNING_SECRET' },
      read: async () => {
        continued = true;
        return row();
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/matching/markets/BTC-USDT/halt',
      headers: { authorization: await bearer(['admin:write']) },
      payload: haltBody,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      code: 'matching_credential_unconfigured',
      key: 'MATCHING_EDGE_SIGNING_SECRET',
    });
    expect(continued).toBe(false);
    expect(JSON.stringify(res.json())).not.toContain('halted');
  });

  it('refuses a blank matching URL with matching_unconfigured and names MATCHING_URL', async () => {
    const app = mount({ matching: null, blocked: { code: 'matching_unconfigured', key: 'MATCHING_URL' } });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/matching/markets/BTC-USDT/halt',
      headers: { authorization: await bearer(['admin:write']) },
      payload: haltBody,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'matching_unconfigured', key: 'MATCHING_URL' });
    expect(JSON.stringify(res.json())).not.toContain('halted');
  });

  it('forwards each remaining control to the matching path matching already consumes', async () => {
    const { calls, matching } = recording(async () => ({ kind: 'answered', status: 200, body: { accepted: true } }));
    const read: MatchingApprovalRead = async (approvalId) => {
      const known: Record<string, MatchingApprovalRow> = {
        'appr-resume': row({ actionType: 'matching.resume', targetId: 'resume:BTC-USDT', operationId: 'op-resume' }),
        'appr-ro': row({ actionType: 'matching.reduce_only', targetId: 'reduce_only:BTC-USDT', operationId: 'op-ro' }),
        'appr-ro-off': row({
          actionType: 'matching.reduce_only_resume',
          targetId: 'reduce_only_resume:BTC-USDT',
          operationId: 'op-ro-off',
        }),
        'appr-po': row({ actionType: 'matching.post_only', targetId: 'post_only:BTC-USDT', operationId: 'op-po' }),
        'appr-po-off': row({ actionType: 'matching.post_only_resume', targetId: 'post_only_resume:BTC-USDT', operationId: 'op-po-off' }),
        'appr-delist': row({ actionType: 'matching.delist', targetId: 'delist:BTC-USDT', operationId: 'op-delist' }),
        'appr-all': row({ actionType: 'matching.halt_all', targetId: 'halt_all', operationId: 'op-all' }),
        'appr-open': row({ actionType: 'matching.resume_all', targetId: 'resume_all', operationId: 'op-open' }),
      };
      const found = known[approvalId];
      if (!found) throw new Error(`unexpected approval ${approvalId}`);
      return found;
    };
    const app = mount({ matching, read });
    const headers = { authorization: await bearer(['admin:write']) };
    const posts: Array<{ url: string; approvalId: string; operationId: string; path: string }> = [
      {
        url: '/admin/trade-ops/matching/markets/BTC-USDT/resume',
        approvalId: 'appr-resume',
        operationId: 'op-resume',
        path: '/markets/BTC-USDT/resume',
      },
      {
        url: '/admin/trade-ops/matching/markets/BTC-USDT/reduce-only',
        approvalId: 'appr-ro',
        operationId: 'op-ro',
        path: '/markets/BTC-USDT/reduce-only',
      },
      {
        url: '/admin/trade-ops/matching/markets/BTC-USDT/reduce-only/off',
        approvalId: 'appr-ro-off',
        operationId: 'op-ro-off',
        path: '/markets/BTC-USDT/reduce-only/resume',
      },
      {
        url: '/admin/trade-ops/matching/markets/BTC-USDT/post-only',
        approvalId: 'appr-po',
        operationId: 'op-po',
        path: '/markets/BTC-USDT/post-only',
      },
      {
        url: '/admin/trade-ops/matching/markets/BTC-USDT/post-only/off',
        approvalId: 'appr-po-off',
        operationId: 'op-po-off',
        path: '/markets/BTC-USDT/post-only/resume',
      },
      {
        url: '/admin/trade-ops/matching/markets/BTC-USDT/delist',
        approvalId: 'appr-delist',
        operationId: 'op-delist',
        path: '/markets/BTC-USDT/delist',
      },
      { url: '/admin/trade-ops/matching/halt-all', approvalId: 'appr-all', operationId: 'op-all', path: '/halt-all' },
      { url: '/admin/trade-ops/matching/resume-all', approvalId: 'appr-open', operationId: 'op-open', path: '/resume-all' },
    ];
    for (const post of posts) {
      const res = await app.inject({
        method: 'POST',
        url: post.url,
        headers,
        payload: { idempotencyKey: `key-${post.approvalId}`, approvalId: post.approvalId, operationId: post.operationId },
      });
      expect(res.statusCode, post.url).toBe(200);
      expect(res.json().audit.requesterId, post.url).toBe(OPERATOR);
      expect(res.json().audit.approverId, post.url).toBe(APPROVER);
    }
    expect(calls.map((call) => call.path)).toEqual(posts.map((post) => post.path));
  });

  it('replays the first result for the same client request id', async () => {
    const { calls, matching } = recording(async () => ({ kind: 'answered', status: 200, body: { accepted: true, halted: true } }));
    const app = mount({ matching });
    const headers = { authorization: await bearer(['admin:write']) };
    const first = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/matching/markets/BTC-USDT/halt',
      headers,
      payload: haltBody,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/matching/markets/BTC-USDT/halt',
      headers,
      payload: haltBody,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(calls).toHaveLength(1);
  });
});

describe('matching health read', () => {
  it('returns the three health fields and the age of the answer', async () => {
    const { calls, matching } = recording(async () => ({
      kind: 'answered',
      status: 200,
      body: { ok: true, venueHalted: true, restingOrders: 4, journalRecords: 9, markets: 1 },
    }));
    const app = mount({ matching });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/trade-ops/matching/health',
      headers: { authorization: await bearer(['admin:read'], false) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ venueHalted: true, restingOrders: 4, journalRecords: 9 });
    expect(typeof res.json().ageMs).toBe('number');
    expect(res.json().ageMs).toBeGreaterThanOrEqual(0);
    expect(typeof res.json().asOf).toBe('string');
    expect(calls).toEqual([{ method: 'GET', path: '/health' }]);
  });

  it('returns a typed error when matching is down and does not invent zeros', async () => {
    const { matching } = recording(async () => ({ kind: 'unavailable', error: 'connect ECONNREFUSED' }));
    const app = mount({ matching });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/trade-ops/matching/health',
      headers: { authorization: await bearer(['admin:read'], false) },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'matching_upstream_unavailable', error: 'connect ECONNREFUSED' });
    expect(res.json()).not.toHaveProperty('venueHalted');
    expect(res.json()).not.toHaveProperty('restingOrders');
    expect(res.json()).not.toHaveProperty('journalRecords');
  });

  it('refuses a customer session', async () => {
    const { calls, matching } = recording(async () => ({
      kind: 'answered',
      status: 200,
      body: { venueHalted: false, restingOrders: 4, journalRecords: 9 },
    }));
    const app = mount({ matching });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/trade-ops/matching/health',
      headers: { authorization: await bearer(['trade:read'], false) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'scope.denied' });
    expect(calls).toEqual([]);
  });
});

describe('surveillance cases read', () => {
  it('returns cases to an operator', async () => {
    const cases = [{ accountId: 'acct-1', marketId: 'BTC-USDT', reason: 'self_trade', status: 'open' }];
    const { calls, matching } = recording(async () => ({ kind: 'answered', status: 200, body: { cases } }));
    const app = mount({ matching });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/trade-ops/surveillance/cases?limit=2',
      headers: { authorization: await bearer(['admin:read'], false) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cases).toEqual(cases);
    expect(calls).toEqual([{ method: 'GET', path: '/surveillance/cases?limit=2' }]);
  });

  it('refuses a customer session', async () => {
    const { calls, matching } = recording(async () => ({ kind: 'answered', status: 200, body: { cases: [] } }));
    const app = mount({ matching });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/trade-ops/surveillance/cases?limit=2',
      headers: { authorization: await bearer(['trade:read'], false) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'scope.denied' });
    expect(calls).toEqual([]);
  });

  it('does not route adjudicate or fine', async () => {
    const { calls, matching } = recording(async () => ({ kind: 'answered', status: 200, body: { ok: true } }));
    const app = mount({ matching });
    const headers = { authorization: await bearer(['admin:write']) };
    const adjudicate = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/surveillance/adjudicate',
      headers,
      payload: { reason: 'not a sanction' },
    });
    const fine = await app.inject({
      method: 'POST',
      url: '/admin/trade-ops/surveillance/fine',
      headers,
      payload: {},
    });
    const upstreamShaped = await app.inject({ method: 'POST', url: '/surveillance/adjudicate', headers, payload: {} });
    expect(adjudicate.statusCode).toBe(404);
    expect(fine.statusCode).toBe(404);
    expect(upstreamShaped.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe('matching control client', () => {
  it('signs the call as svc-edge and a timeout is unknown with no halt claim', async () => {
    const secret = 'm'.repeat(32);
    let seen: { url: string; service: string | null; body: string | undefined } | undefined;
    const fetchFn: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      seen = {
        url: String(input),
        service: headers.get(SERVICE_HEADER),
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      return new Response(JSON.stringify({ accepted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const answered = await httpMatchingControl(
      'http://matching.test/',
      secret,
      1000,
      fetchFn,
    )({
      method: 'POST',
      path: '/markets/BTC-USDT/halt',
      body: { operatorId: OPERATOR, confirmOperatorId: APPROVER },
    });
    expect(answered.kind).toBe('answered');
    expect(seen).toEqual({
      url: 'http://matching.test/markets/BTC-USDT/halt',
      service: 'svc-edge',
      body: JSON.stringify({ operatorId: OPERATOR, confirmOperatorId: APPROVER }),
    });

    const timingOut: typeof fetch = async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };
    const timed = await httpMatchingControl('http://matching.test', secret, 1000, timingOut)({ method: 'GET', path: '/health' });
    expect(timed.kind).toBe('unknown');
    expect(JSON.stringify(timed)).not.toContain('halted');
    expect(JSON.stringify(timed)).not.toContain('restingOrders');
  });
});
