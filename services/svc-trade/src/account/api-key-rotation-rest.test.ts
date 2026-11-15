import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { describe, expect, it } from 'vitest';
import { attachApiKeyRotationRoutes, type ApiKeyRotationClient } from './api-key-rotation-rest.js';

const USER = '11111111-1111-4111-8111-111111111111';
const KID = '22222222-2222-4222-8222-222222222222';
const REQ = '33333333-3333-4333-8333-333333333333';

function mount(who: Partial<Principal> | null, client?: ApiKeyRotationClient) {
  const app = Fastify();
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const recording: ApiKeyRotationClient | undefined = client && {
    post: async (path, body) => {
      calls.push({ path, body });
      return client.post(path, body);
    },
  };
  attachApiKeyRotationRoutes(app, recording, (_req, reply) => {
    if (!who) {
      void reply.code(401).send({ code: 'AuthenticationError' });
      return null;
    }
    return {
      userId: USER,
      sub: USER,
      sid: 's',
      scopes: ['trade:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(),
      ...who,
    } as Principal;
  });
  return { app, calls };
}

const answers = (status: number, body: unknown): ApiKeyRotationClient => ({ post: async () => ({ status, body }) });

describe("a key's own rotation request (J-developer-07 #3)", () => {
  it('names the account and the key the edge authenticated, and passes the request id back', async () => {
    const { app, calls } = mount({ kid: KID }, answers(200, { requestId: REQ, keyId: KID, overlapSeconds: 0, createdAt: 'x' }));
    const res = await app.inject({ method: 'POST', url: '/api/v1/account/api-key/rotation', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().requestId).toBe(REQ);
    expect(calls).toEqual([{ path: '/internal/api-key-rotation/request', body: { userId: USER, keyId: KID } }]);
  });

  it("the requester's approval passes identity's refusal on with its code", async () => {
    const { app, calls } = mount(
      { kid: KID },
      answers(403, { error: 'The key that asked for a rotation cannot approve it', code: 'identity.rotation_self_approval' }),
    );
    const res = await app.inject({ method: 'POST', url: '/api/v1/account/api-key/rotation/approve', payload: { requestId: REQ } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'The key that asked for a rotation cannot approve it', code: 'identity.rotation_self_approval' });
    expect(calls[0]).toEqual({ path: '/internal/api-key-rotation/approve-by-key', body: { userId: USER, keyId: KID, requestId: REQ } });
  });

  it('a person signed in on a device is sent to the key page, and nothing reaches identity', async () => {
    const { app, calls } = mount({}, answers(200, {}));
    const res = await app.inject({ method: 'POST', url: '/api/v1/account/api-key/rotation', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('identity.rotation_key_only');
    expect(calls).toHaveLength(0);
  });

  it('no principal is a 401; identity down, unwired or answering off-contract is a 503', async () => {
    expect((await mount(null, answers(200, {})).app.inject({ method: 'POST', url: '/api/v1/account/api-key/rotation' })).statusCode).toBe(
      401,
    );
    for (const client of [
      undefined,
      answers(500, { code: 'identity.boom' }),
      answers(401, { code: 'identity.unauthenticated' }),
      { post: async () => Promise.reject(new Error('down')) },
    ]) {
      const res = await mount({ kid: KID }, client).app.inject({ method: 'POST', url: '/api/v1/account/api-key/rotation', payload: {} });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('trade.identity_unavailable');
    }
  });
});
