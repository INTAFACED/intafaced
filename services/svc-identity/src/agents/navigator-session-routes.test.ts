import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import {
  NAVIGATOR_SESSION_PATH,
  NAVIGATOR_SESSION_PUBLISH_PATH,
  NAVIGATOR_SESSION_REFRESH_PATH,
  registerNavigatorSessionRoutes,
} from './navigator-session-routes.js';
import { NavigatorSessionPublishError, type NavigatorSessionStore } from './navigator-session-store.js';

const SECRET = 'a-navigator-session-internal-secret-long-enough-for-hmac';

function serviceHeaders(body = ''): Record<string, string> {
  return serviceAuthHeadersForBody('svc-agents', SECRET, body);
}

function memoryStore(authRows: { sessionId: string; userId: string; status: 'open' | 'closed' }[] = []): NavigatorSessionStore {
  const sessions = new Map<string, { sessionId: string; userId: string; status: 'open' | 'closed' }>();
  return {
    async readSession(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async publishSession(session) {
      sessions.set(session.sessionId, session);
    },
    async refreshFromAuthSessions() {
      for (const row of authRows) {
        await this.publishSession(row);
      }
      return authRows.length;
    },
  };
}

describe('navigator session internal route', () => {
  it('reports an explicit durable-session authority refusal instead of publish success', async () => {
    const app = Fastify();
    const store = memoryStore();
    store.publishSession = async () => {
      throw new NavigatorSessionPublishError();
    };
    registerNavigatorSessionRoutes(app, { internalSecret: SECRET, store, bodyBind: 'require' });
    const body = JSON.stringify({ sessionId: 'sess-1', userId: 'user-1', status: 'open' });
    try {
      const response = await app.inject({
        method: 'POST',
        url: NAVIGATOR_SESSION_PUBLISH_PATH,
        headers: { ...serviceHeaders(body), 'content-type': 'application/json' },
        payload: body,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ ok: false, reason: 'session_authority_denied' });
    } finally {
      await app.close();
    }
  });
  it('refuses no_live_session_store with service auth when store absent', async () => {
    const app = Fastify();
    registerNavigatorSessionRoutes(app, { internalSecret: SECRET });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `${NAVIGATOR_SESSION_PATH}/sess-1`,
      headers: serviceHeaders(),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: 'no_live_session_store' });
    await app.close();
  });

  it('refuses no_live_session_store when projection is missing', async () => {
    const app = Fastify();
    registerNavigatorSessionRoutes(app, { internalSecret: SECRET, store: memoryStore() });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `${NAVIGATOR_SESSION_PATH}/sess-1`,
      headers: serviceHeaders(),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, reason: 'no_live_session_store' });
    await app.close();
  });

  it('401s without service credentials', async () => {
    const app = Fastify();
    registerNavigatorSessionRoutes(app, { internalSecret: SECRET });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: `${NAVIGATOR_SESSION_PATH}/sess-1` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('publish then GET returns operator-owned session projection', async () => {
    const app = Fastify();
    const store = memoryStore();
    registerNavigatorSessionRoutes(app, { internalSecret: SECRET, store });
    await app.ready();

    const publishBody = JSON.stringify({ sessionId: 'sess-1', userId: 'user-1', status: 'open' });
    const publish = await app.inject({
      method: 'POST',
      url: NAVIGATOR_SESSION_PUBLISH_PATH,
      headers: { ...serviceHeaders(publishBody), 'content-type': 'application/json' },
      payload: publishBody,
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json()).toEqual({ ok: true });

    const res = await app.inject({
      method: 'GET',
      url: `${NAVIGATOR_SESSION_PATH}/sess-1`,
      headers: serviceHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, session: { sessionId: 'sess-1', userId: 'user-1', status: 'open' } });
    await app.close();
  });

  it('refresh materializes auth sessions then GET succeeds', async () => {
    const authRows = [{ sessionId: 'sess-2', userId: 'user-2', status: 'open' as const }];
    const app = Fastify();
    const store = memoryStore(authRows);
    registerNavigatorSessionRoutes(app, { internalSecret: SECRET, store });
    await app.ready();

    const refresh = await app.inject({
      method: 'POST',
      url: NAVIGATOR_SESSION_REFRESH_PATH,
      headers: serviceHeaders(),
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json()).toEqual({ ok: true, materialized: 1 });

    const res = await app.inject({
      method: 'GET',
      url: `${NAVIGATOR_SESSION_PATH}/sess-2`,
      headers: serviceHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, session: authRows[0] });
    await app.close();
  });
});
