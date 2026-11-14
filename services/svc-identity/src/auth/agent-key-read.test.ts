import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  AGENT_KEY_CALLS_PATH,
  AGENT_KEY_READ_PATH,
  agentKeyCallsSchema,
  agentKeyReadSchema,
  retainRawBody,
  serviceAuthHeadersForBody,
  type AgentKeyCalls,
  type AgentKeyRead,
} from '@intafaced/contracts';
import { AGENT_KEY_READERS, registerAgentKeyCallsRoute, registerAgentKeyReadRoute } from './agent-key-read.js';

/** svc-trade's read of a person's own key before it binds it to an agent account (J-agents-21 #6): who may ask, and what a bad request gets. */

const SECRET = 'k'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const FOUND: AgentKeyRead = { state: 'found', keyId: KEY, kind: 'agent', scopes: ['trade:read', 'trade:write'], revoked: false };

async function app(read: (userId: string, keyId: string) => Promise<AgentKeyRead>) {
  const server = Fastify({ logger: false });
  retainRawBody(server);
  registerAgentKeyReadRoute(server, { read, internalSecret: SECRET });
  await server.ready();
  return server;
}

function post(payload: unknown, service = 'svc-trade', url: string = AGENT_KEY_READ_PATH) {
  const raw = JSON.stringify(payload);
  return {
    method: 'POST' as const,
    url,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, raw) },
    payload: raw,
  };
}

describe('POST /internal/agent-keys/read', () => {
  it('lists only svc-trade as a reader', () => {
    expect([...AGENT_KEY_READERS]).toEqual(['svc-trade']);
  });

  it('needs service credentials, and only svc-trade may ask', async () => {
    const asked: string[] = [];
    const server = await app(async (userId, keyId) => {
      asked.push(`${userId}/${keyId}`);
      return FOUND;
    });
    const anonymous = await server.inject({ method: 'POST', url: AGENT_KEY_READ_PATH, payload: { userId: USER, keyId: KEY } });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe('identity.unauthenticated');
    for (const other of ['svc-agents', 'svc-edge', 'svc-pay']) {
      const res = await server.inject(post({ userId: USER, keyId: KEY }, other));
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('identity.agent_key_reader_refused');
    }
    expect(asked).toHaveLength(0);
    const ok = await server.inject(post({ userId: USER, keyId: KEY }));
    expect(ok.statusCode).toBe(200);
    expect(agentKeyReadSchema.parse(ok.json())).toEqual(FOUND);
    expect(asked).toEqual([`${USER}/${KEY}`]);
  });

  it('refuses a malformed request before any key is read', async () => {
    let calls = 0;
    const server = await app(async () => {
      calls += 1;
      return FOUND;
    });
    for (const bad of [{}, { userId: USER }, { userId: USER, keyId: 'nope' }, { userId: USER, keyId: KEY, extra: 1 }]) {
      const res = await server.inject(post(bad));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('identity.agent_key_read_invalid');
    }
    expect(calls).toBe(0);
  });
});

/** The key's call log for the assistant connection's Activity (J-agents-21 #11): the same readers, the same refusals. */
describe('POST /internal/agent-keys/calls', () => {
  const LOG: AgentKeyCalls = {
    state: 'found',
    keyId: KEY,
    asOf: '2026-11-13T00:00:00.000Z',
    calls: [
      {
        requestId: 'r1',
        method: 'POST',
        path: '/api/v1/venue/agent/orders',
        status: 200,
        outsideIpList: false,
        at: '2026-11-13T00:00:00.000Z',
      },
    ],
  };
  async function callsApp(read: (userId: string, keyId: string, limit: number) => Promise<AgentKeyCalls>) {
    const server = Fastify({ logger: false });
    retainRawBody(server);
    registerAgentKeyCallsRoute(server, { read, internalSecret: SECRET });
    await server.ready();
    return server;
  }

  it('needs service credentials, only svc-trade may ask, and a bad request reads nothing', async () => {
    const asked: string[] = [];
    const server = await callsApp(async (userId, keyId, limit) => {
      asked.push(`${userId}/${keyId}/${limit}`);
      return LOG;
    });
    const anonymous = await server.inject({ method: 'POST', url: AGENT_KEY_CALLS_PATH, payload: { userId: USER, keyId: KEY, limit: 5 } });
    expect(anonymous.statusCode).toBe(401);
    for (const other of ['svc-agents', 'svc-edge']) {
      const res = await server.inject(post({ userId: USER, keyId: KEY, limit: 5 }, other, AGENT_KEY_CALLS_PATH));
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('identity.agent_key_reader_refused');
    }
    for (const bad of [
      { userId: USER, keyId: KEY },
      { userId: USER, keyId: KEY, limit: 0 },
      { userId: USER, keyId: KEY, limit: 201 },
    ]) {
      const res = await server.inject(post(bad, 'svc-trade', AGENT_KEY_CALLS_PATH));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('identity.agent_key_read_invalid');
    }
    expect(asked).toHaveLength(0);
    const ok = await server.inject(post({ userId: USER, keyId: KEY, limit: 5 }, 'svc-trade', AGENT_KEY_CALLS_PATH));
    expect(ok.statusCode).toBe(200);
    expect(agentKeyCallsSchema.parse(ok.json())).toEqual(LOG);
    expect(asked).toEqual([`${USER}/${KEY}/5`]);
  });
});
