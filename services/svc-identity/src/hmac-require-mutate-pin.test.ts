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
 *    already require in-module — do not recook. The tRPC door (rank.awardXp
 *    and the other serviceProcedures) is `require` too, hardcoded rather than
 *    read from env. Fastify tRPC replaces retainRawBody's JSON parser, but
 *    createEdgeContext binds the wire string it leaves on req.body, so bound
 *    callers pass and an empty-body signature replayed over a body does not
 *    (see controls/trpc-s2s-body-binding.test.ts).
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
import { AFFILIATE_PRODUCER_PATH } from './affiliates/producer-accrue.js';
import { AFFILIATE_PRODUCER_PAYOUT_PATH } from './affiliates/producer-payout.js';
import { API_KEY_OWNERSHIP_PATH } from './auth/api-key-ownership-route.js';
import { BOOT_TIMEOUT_MS, BOOT_INTERNAL_SECRET, bootIdentity, type IdentityBoot } from './boot.testkit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE = join(HERE, '../../../docker-compose.apps.yml');
const SECRET = 'a'.repeat(32);
const ID = '11111111-1111-4111-8111-111111111111';

/** The unbound v1 signature: names the service, binds no body. */
const v1 = () => serviceAuthHeaders('svc-trade', BOOT_INTERNAL_SECRET);
/** The body-bound signature over `body`. */
const bound = (body: string, service = 'svc-trade') => serviceAuthHeadersForBody(service, BOOT_INTERNAL_SECRET, body);

const bootUnder = (mode: 'accept-both' | 'require') => bootIdentity({ INTERNAL_SERVICE_BODY_BIND: mode });

/** The GET snapshots whose bind follows INTERNAL_SERVICE_BODY_BIND. */
const GET_SNAPSHOTS = [
  `/internal/rank/${ID}/perks`,
  `/internal/sub-accounts/${ID}`,
  `${API_KEY_OWNERSHIP_PATH}/${ID}`,
  `/internal/sessions/${ID}`,
  `/internal/account/${ID}`,
  `/internal/email-proof/${ID}`,
  `/internal/campaign-participant/${ID}`,
  `/internal/security-lock/${ID}`,
  `/internal/self-freeze/${ID}`,
];

const AWARD = JSON.stringify({
  userId: ID,
  sourceModule: 'svc-p2p',
  action: 'trade.completed.seller',
  xpDelta: 5,
  idempotencyKey: 'idem-award-hmac-pin',
});

async function award(boot: IdentityBoot, headers: Record<string, string>) {
  return boot.app.inject({
    method: 'POST',
    url: '/trpc/rank.awardXp',
    headers: { 'content-type': 'application/json', ...headers },
    payload: AWARD,
  });
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
  it(
    'the booted navigator mutate POSTs refuse unbound v1 HMAC under accept-both',
    async () => {
      const boot = await bootUnder('accept-both');
      const publishBody = JSON.stringify({ sessionId: 'sess-1', userId: ID, status: 'open' });
      const publish = await boot.app.inject({
        method: 'POST',
        url: NAVIGATOR_SESSION_PUBLISH_PATH,
        headers: { 'content-type': 'application/json', ...v1() },
        payload: publishBody,
      });
      expect(publish.statusCode).toBe(401);
      const refresh = await boot.app.inject({ method: 'POST', url: NAVIGATOR_SESSION_REFRESH_PATH, headers: v1() });
      expect(refresh.statusCode).toBe(401);

      // The same caller, body-bound, gets past the door to the session store.
      const signed = await boot.app.inject({
        method: 'POST',
        url: NAVIGATOR_SESSION_PUBLISH_PATH,
        headers: { 'content-type': 'application/json', ...bound(publishBody, 'svc-agents') },
        payload: publishBody,
      });
      expect(signed.statusCode).not.toBe(401);
    },
    BOOT_TIMEOUT_MS,
  );

  // Was: "preserves the default tRPC service mode" and asserted `bodyBindMode:
  // 'require'` was ABSENT, on the belief that require would 401 bound callers
  // because the tRPC adapter bypasses retainRawBody. That belief was the bug:
  // the context read the empty marker, so it 401'd honest callers and admitted a
  // replayed empty-body signature. The context now binds req.body.
  it(
    'the booted tRPC service door requires a body-bound caller under accept-both',
    async () => {
      const boot = await bootUnder('accept-both');
      const unbound = await award(boot, v1());
      expect(unbound.statusCode).toBe(401);
      expect(boot.queries.some((q) => /rank_state|xp_events/i.test(q.text) && q.values.includes(ID))).toBe(false);
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    'the booted tRPC service door takes a body-bound caller and refuses a replayed empty-body signature',
    async () => {
      const boot = await bootUnder('accept-both');
      const replayed = await award(boot, bound(''));
      expect(replayed.statusCode).toBe(401);
      const before = boot.queries.length;
      const honest = await award(boot, bound(AWARD));
      expect(honest.statusCode).not.toBe(401);
      // It reached rank.awardXp: the award read or wrote the person's rank.
      expect(boot.queries.slice(before).some((q) => q.values.includes(ID))).toBe(true);
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    'GET ownership/session/rank/account may still follow compose env',
    async () => {
      const loose = await bootUnder('accept-both');
      for (const url of GET_SNAPSHOTS) {
        const res = await loose.app.inject({ method: 'GET', url, headers: v1() });
        expect(res.statusCode, `${url} under accept-both`).not.toBe(401);
      }
      const strict = await bootUnder('require');
      for (const url of GET_SNAPSHOTS) {
        const res = await strict.app.inject({ method: 'GET', url, headers: v1() });
        expect(res.statusCode, `${url} under require`).toBe(401);
        const signed = await strict.app.inject({ method: 'GET', url, headers: bound('') });
        expect(signed.statusCode, `${url} body-bound under require`).not.toBe(401);
      }
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    'affiliate accrue/payout require body-bound HMAC whatever the env says',
    async () => {
      const boot = await bootUnder('accept-both');
      const body = JSON.stringify({ feeEventId: 'fee-evt-hmac-pin' });
      for (const url of [AFFILIATE_PRODUCER_PATH, AFFILIATE_PRODUCER_PAYOUT_PATH]) {
        const res = await boot.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...v1() }, payload: body });
        expect(res.statusCode, url).toBe(401);
        expect(res.json(), url).toMatchObject({ code: 'identity.unauthenticated' });
      }
    },
    BOOT_TIMEOUT_MS,
  );

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
