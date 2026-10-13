/**
 * Unit card — production identity mutate mounts hardcode HMAC bodyBind require
 *
 * 1. Promise: live POST /internal/agents/navigator-session/{publish,refresh}
 *    401 unbound v1 HMAC even while fleet compose stays
 *    INTERNAL_SERVICE_BODY_BIND:-accept-both.
 * 2. Break: index.ts passed bodyBind: env.INTERNAL_SERVICE_BODY_BIND into
 *    registerNavigatorSessionRoutes, so POST publish/refresh (same authorised
 *    helper as GET) stayed accept-both under the compose default.
 * 3. Done bar: navigator register is bodyBind: 'require' — not the env.
 *    GET ownership/session/rank/account stay env. Affiliate accrue/payout
 *    already require in-module — do not recook. tRPC rank.awardXp stays
 *    createEdgeContext default: Fastify tRPC replaces retainRawBody's JSON
 *    parser, so require would 401 bound callers.
 * 4. Class N
 * 5. Paths: services/svc-identity/src/index.ts (production mounts only)
 * 6. RED: origin/main passing env bind into the navigator mutate register
 * 7. Collision: none — does not touch docker-compose.apps.yml or config pins.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { serviceAuthHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';
import {
  NAVIGATOR_SESSION_PUBLISH_PATH,
  NAVIGATOR_SESSION_REFRESH_PATH,
  registerNavigatorSessionRoutes,
} from './agents/navigator-session-routes.js';
import type { NavigatorSessionStore } from './agents/navigator-session-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, 'index.ts');
const COMPOSE = join(HERE, '../../../docker-compose.apps.yml');
const SECRET = 'a'.repeat(32);

function indexSource(): string {
  return readFileSync(INDEX, 'utf8');
}

/** Executable lines — not `//` or block-comment `*` prefixes. */
function liveLines(src: string): string {
  return src
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

function objectCall(src: string, name: string): string {
  const needle = `${name}(app,`;
  const start = src.indexOf(needle);
  expect(start, `${name} missing`).toBeGreaterThan(-1);
  const end = src.indexOf('});', start);
  expect(end, `${name} unclosed`).toBeGreaterThan(start);
  return src.slice(start, end + 3);
}

function getRouteBlock(src: string, path: string): string {
  const needle = `app.get<{ Params:`;
  const pathAt = src.indexOf(path);
  expect(pathAt, path).toBeGreaterThan(-1);
  const start = src.lastIndexOf(needle, pathAt);
  expect(start, `get ${path}`).toBeGreaterThan(-1);
  const end = src.indexOf('});', pathAt);
  expect(end, `unclosed ${path}`).toBeGreaterThan(pathAt);
  return src.slice(start, end + 3);
}

function memoryStore(): NavigatorSessionStore {
  const sessions = new Map<string, { sessionId: string; userId: string; status: 'open' | 'closed' }>();
  return {
    async readSession(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async publishSession(session) {
      sessions.set(session.sessionId, session);
    },
    async refreshFromAuthSessions() {
      return 1;
    },
  };
}

describe('the deployed svc-identity mutate mounts require body-bound HMAC', () => {
  it('pins navigator mutate register to bodyBind require on live lines before listen', () => {
    const live = liveLines(indexSource());
    const listen = live.indexOf('app.listen(');
    expect(listen).toBeGreaterThan(-1);
    const block = objectCall(live, 'registerNavigatorSessionRoutes');
    expect(live.indexOf('registerNavigatorSessionRoutes(app,')).toBeLessThan(listen);
    expect(block).toMatch(/bodyBind:\s*'require'/);
    expect(block).not.toMatch(/INTERNAL_SERVICE_BODY_BIND/);
  });

  it('preserves the default tRPC service mode while retaining the full request for delegated reads', () => {
    const live = liveLines(indexSource());
    const start = live.indexOf('createIdentityRequestContext(');
    expect(start).toBeGreaterThan(-1);
    const edge = live.slice(start, live.indexOf('});', start) + 3);
    expect(edge).not.toMatch(/bodyBindMode:\s*'require'/);
    expect(live).toMatch(/identityRequestContext\(req\)/);
    const factory = liveLines(readFileSync(join(HERE, 'controls/founder-context.ts'), 'utf8'));
    expect(factory).toMatch(/const regular = createEdgeContext\(options\)/);
    expect(factory).toMatch(/if \(!requiresBody\) return context/);
  });

  it('GET ownership/session/rank/account may still follow compose env', () => {
    const live = liveLines(indexSource());
    const ownership = objectCall(live, 'registerApiKeyOwnershipRoute');
    expect(ownership).toMatch(/bodyBind:\s*env\.INTERNAL_SERVICE_BODY_BIND/);
    expect(ownership).not.toMatch(/bodyBind:\s*'require'/);

    for (const path of [
      '/internal/rank/:userId/perks',
      '/internal/sub-accounts/:subAccountId',
      '/internal/sessions/:sessionId',
      '/internal/account/:userId',
    ]) {
      const block = getRouteBlock(live, path);
      expect(block, path).toMatch(/mode:\s*env\.INTERNAL_SERVICE_BODY_BIND/);
      expect(block, path).not.toMatch(/mode:\s*'require'/);
    }
  });

  it('does not recook affiliate accrue/payout mounts (already require in-module)', () => {
    const live = liveLines(indexSource());
    expect(objectCall(live, 'registerAffiliateProducerAccrue')).not.toMatch(/bodyBind/);
    expect(objectCall(live, 'registerAffiliateProducerPayout')).not.toMatch(/bodyBind/);
  });

  it('does not flip the compose INTERNAL_SERVICE_BODY_BIND default', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    expect(compose).toMatch(/INTERNAL_SERVICE_BODY_BIND:\s*\$\{INTERNAL_SERVICE_BODY_BIND:-accept-both\}/);
    expect(compose).not.toMatch(/INTERNAL_SERVICE_BODY_BIND:.*:-require/);
  });

  it('v1 HMAC is 401 on navigator mutate POSTs when production mode require is mounted', async () => {
    const app = Fastify({ logger: false });
    registerNavigatorSessionRoutes(app, {
      internalSecret: SECRET,
      store: memoryStore(),
      bodyBind: 'require',
    });
    await app.ready();

    const publishBody = JSON.stringify({ sessionId: 'sess-1', userId: 'user-1', status: 'open' });
    const v1 = serviceAuthHeaders('svc-agents', SECRET);
    const publish = await app.inject({
      method: 'POST',
      url: NAVIGATOR_SESSION_PUBLISH_PATH,
      headers: { 'content-type': 'application/json', ...v1 },
      payload: publishBody,
    });
    expect(publish.statusCode).toBe(401);

    const refresh = await app.inject({
      method: 'POST',
      url: NAVIGATOR_SESSION_REFRESH_PATH,
      headers: v1,
    });
    expect(refresh.statusCode).toBe(401);

    const bound = await app.inject({
      method: 'POST',
      url: NAVIGATOR_SESSION_PUBLISH_PATH,
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-agents', SECRET, publishBody) },
      payload: publishBody,
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json()).toEqual({ ok: true });
    await app.close();
  });
});
