import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { AGENT_KEY_READ_PATH, agentKeyReadSchema, retainRawBody, serviceAuthHeadersForBody, type AgentKeyRead } from '@intafaced/contracts';
import { AGENT_KEY_READERS, registerAgentKeyReadRoute } from './agent-key-read.js';

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

function post(payload: unknown, service = 'svc-trade') {
  const raw = JSON.stringify(payload);
  return {
    method: 'POST' as const,
    url: AGENT_KEY_READ_PATH,
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
