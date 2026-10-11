/**
 * S2S navigator session read for svc-agents identity.session.read live plane.
 *
 * Missing projection = honest `no_live_session_store`. Operator publishes rows
 * via POST publish — never seeded with invented open sessions.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { rawBodyOf, retainRawBody, verifyServiceHeaders, type ServiceBodyBindMode } from '@intafaced/contracts';
import { NavigatorSessionPublishError, type NavigatorSessionStore } from './navigator-session-store.js';

export const NAVIGATOR_SESSION_PATH = '/internal/agents/navigator-session' as const;
export const NAVIGATOR_SESSION_PUBLISH_PATH = '/internal/agents/navigator-session/publish' as const;
export const NAVIGATOR_SESSION_REFRESH_PATH = '/internal/agents/navigator-session/refresh' as const;

export type NavigatorSessionRefuse = {
  readonly ok: false;
  readonly reason: 'no_live_session_store';
};

export type NavigatorSessionPublishRefuse = {
  readonly ok: false;
  readonly reason: 'no_session_store' | 'invalid_publish_body' | 'session_authority_denied';
};

export type NavigatorSessionPublishOk = {
  readonly ok: true;
};

export type NavigatorSessionRefreshRefuse = {
  readonly ok: false;
  readonly reason: 'no_session_store' | 'no_live_session_store';
};

export type NavigatorSessionRefreshOk = {
  readonly ok: true;
  readonly materialized: number;
};

export type NavigatorSessionOk = {
  readonly ok: true;
  readonly session: {
    readonly sessionId: string;
    readonly userId: string;
    readonly status: 'open' | 'closed';
  };
};

export type NavigatorSessionBody = NavigatorSessionRefuse | NavigatorSessionOk;

export type NavigatorSessionRouteDeps = {
  readonly internalSecret: string;
  readonly store?: NavigatorSessionStore;
  readonly bodyBind?: ServiceBodyBindMode;
  /** Isolated tests need this. Production `index.ts` already installed via accrue. */
  readonly installRawBody?: boolean;
};

function parsePublishBody(raw: unknown): NavigatorSessionOk['session'] | null {
  if (raw === null || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) return null;
  if (typeof body.userId !== 'string' || !body.userId.trim()) return null;
  if (body.status !== 'open' && body.status !== 'closed') return null;
  return {
    sessionId: body.sessionId.trim(),
    userId: body.userId.trim(),
    status: body.status,
  };
}

export function registerNavigatorSessionRoutes(app: FastifyInstance, deps: NavigatorSessionRouteDeps): void {
  if (deps.installRawBody !== false) {
    retainRawBody(app);
  }
  const authorised = (req: FastifyRequest): boolean =>
    verifyServiceHeaders(req.headers, deps.internalSecret, {
      rawBody: rawBodyOf(req),
      mode: deps.bodyBind,
    }).service !== null;

  app.get<{ Params: { sessionId: string } }>(`${NAVIGATOR_SESSION_PATH}/:sessionId`, async (req, reply) => {
    if (!authorised(req)) {
      return reply.code(401).send({ error: 'identity.unauthenticated', message: 'service credentials required' });
    }
    if (!deps.store) {
      const body: NavigatorSessionRefuse = { ok: false, reason: 'no_live_session_store' };
      return reply.code(503).send(body);
    }
    const session = await deps.store.readSession(req.params.sessionId);
    if (!session) {
      const body: NavigatorSessionRefuse = { ok: false, reason: 'no_live_session_store' };
      return reply.code(503).send(body);
    }
    const body: NavigatorSessionOk = { ok: true, session };
    return reply.send(body);
  });

  app.post(NAVIGATOR_SESSION_PUBLISH_PATH, async (req, reply) => {
    if (!authorised(req)) {
      return reply.code(401).send({ error: 'identity.unauthenticated', message: 'service credentials required' });
    }
    if (!deps.store) {
      const body: NavigatorSessionPublishRefuse = { ok: false, reason: 'no_session_store' };
      return reply.code(503).send(body);
    }
    const session = parsePublishBody(req.body);
    if (!session) {
      const body: NavigatorSessionPublishRefuse = { ok: false, reason: 'invalid_publish_body' };
      return reply.code(400).send(body);
    }
    try {
      await deps.store.publishSession(session);
    } catch (error) {
      if (!(error instanceof NavigatorSessionPublishError)) throw error;
      const body: NavigatorSessionPublishRefuse = { ok: false, reason: error.code };
      return reply.code(409).send(body);
    }
    const body: NavigatorSessionPublishOk = { ok: true };
    return reply.send(body);
  });

  app.post(NAVIGATOR_SESSION_REFRESH_PATH, async (req, reply) => {
    if (!authorised(req)) {
      return reply.code(401).send({ error: 'identity.unauthenticated', message: 'service credentials required' });
    }
    if (!deps.store) {
      const body: NavigatorSessionRefreshRefuse = { ok: false, reason: 'no_session_store' };
      return reply.code(503).send(body);
    }
    const materialized = await deps.store.refreshFromAuthSessions();
    if (materialized === 0) {
      const body: NavigatorSessionRefreshRefuse = { ok: false, reason: 'no_live_session_store' };
      return reply.code(503).send(body);
    }
    const body: NavigatorSessionRefreshOk = { ok: true, materialized };
    return reply.send(body);
  });
}
