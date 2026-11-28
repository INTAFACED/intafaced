/**
 * Boots svc-token's start-up module (`index.ts`) with its database and bus stubbed, then calls the app it built over
 * HTTP. Replaces pins that read `index.ts` as text: the internal job doors demand body-bound service signatures
 * whatever the fleet's INTERNAL_SERVICE_BODY_BIND says, the stake gate follows that setting, and the doors verify
 * against INTERNAL_SERVICE_SECRET over the request's exact bytes.
 */
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serviceAuthHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';

const booted = vi.hoisted(() => ({
  apps: [] as FastifyInstance[],
  listenedAfter: [] as string[][],
  routes: [] as string[],
}));

vi.mock('fastify', async (importOriginal) => {
  const real = (await importOriginal<typeof import('fastify')>()).default;
  return {
    default: (opts?: FastifyServerOptions) => {
      const app = real(opts);
      const seen: string[] = [];
      app.addHook('onRoute', (route) => {
        seen.push(`${String(route.method)} ${route.url}`);
      });
      (app as { listen: unknown }).listen = async () => {
        // The routes present when the service opens its port; the test calls the app by inject, not a socket.
        booted.listenedAfter.push([...seen]);
        await app.ready();
        return '';
      };
      booted.apps.push(app);
      return app;
    },
  };
});

vi.mock('postgres', () => ({
  default: () => {
    const sql = Object.assign(() => Promise.resolve([]), {
      json: (v: unknown) => v,
      end: async () => undefined,
      begin: async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(sql),
    });
    return sql;
  },
}));

vi.mock('@intafaced/events', async (importOriginal) => {
  const real = await importOriginal<typeof import('@intafaced/events')>();
  return {
    ...real,
    JetStreamEventBus: { connect: async () => new real.MemoryEventBus('svc-token') },
  };
});

vi.mock('@intafaced/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@intafaced/telemetry')>()),
  registerProcessHooks: () => undefined,
}));

const SECRET = 'svc-token-boot-internal-secret-0000000001';

async function boot(overrides: Record<string, string | undefined> = {}): Promise<FastifyInstance> {
  vi.resetModules();
  vi.unstubAllEnvs();
  const base: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    APP_ENV: 'test',
    LOG_LEVEL: 'fatal',
    OTEL_ENABLED: 'false',
    DATABASE_URL: 'postgres://boot:boot@127.0.0.1:9/boot',
    DATABASE_POOL_MAX: '1',
    EDGE_PRINCIPAL_SECRET: 'svc-token-boot-edge-secret-0000000000001',
    INTERNAL_SERVICE_SECRET: SECRET,
    INTERNAL_SERVICE_BODY_BIND: 'accept-both',
    EMISSIONS_ENABLED: 'true',
    YIELD_JOB_ENABLED: 'true',
    BUYBACK_JOB_ENABLED: 'true',
    EMISSIONS_AUTO_TICK: 'false',
    IDENTITY_URL: undefined,
  };
  for (const [key, value] of Object.entries({ ...base, ...overrides })) vi.stubEnv(key, value);
  await import('./index.js');
  const app = booted.apps.at(-1);
  if (!app) throw new Error('index.ts built no app');
  return app;
}

afterEach(async () => {
  for (const app of booted.apps) await app.close();
  booted.apps.length = 0;
  booted.listenedAfter.length = 0;
  vi.unstubAllEnvs();
});

const JOB_DOORS = [
  { url: '/internal/emissions/mint-next', body: '' },
  { url: '/internal/yield/run-window', body: JSON.stringify({ windowId: 'w1' }) },
  {
    url: '/internal/buyback/run-window',
    body: JSON.stringify({
      runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      revenueWindow: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' },
    }),
  },
] as const;

function post(app: FastifyInstance, url: string, body: string, headers: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url,
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    ...(body ? { payload: body } : {}),
  });
}

describe('the deployed svc-token job mutate mounts require body-bound HMAC', () => {
  it('mounts the three job doors and the stake gate before the port opens', async () => {
    await boot();
    const routes = booted.listenedAfter[0] ?? [];
    for (const { url } of JOB_DOORS) expect(routes).toContain(`POST ${url}`);
    expect(routes).toContain('GET /internal/stake/:userId');
  });

  it('refuses unbound v1 HMAC on every mutate job even while the fleet setting is accept-both', async () => {
    const app = await boot({ INTERNAL_SERVICE_BODY_BIND: 'accept-both' });
    for (const { url, body } of JOB_DOORS) {
      const res = await post(app, url, body, serviceAuthHeaders('svc-token', SECRET));
      expect(res.statusCode, url).toBe(401);
      expect(res.json().code, url).toBe('token.unauthenticated');
    }
  });

  it('a body-bound signature over the exact bytes with INTERNAL_SERVICE_SECRET passes the job door', async () => {
    const app = await boot();
    for (const { url, body } of JOB_DOORS) {
      const res = await post(app, url, body, serviceAuthHeadersForBody('svc-token', SECRET, body));
      expect(res.statusCode, url).not.toBe(401);
      const wrongSecret = await post(app, url, body, serviceAuthHeadersForBody('svc-token', 'x'.repeat(40), body));
      expect(wrongSecret.statusCode, url).toBe(401);
      const otherBytes = await post(app, url, body, serviceAuthHeadersForBody('svc-token', SECRET, `${body} `));
      expect(otherBytes.statusCode, url).toBe(401);
    }
  });

  it('GET stake follows the fleet setting: v1 passes under accept-both and is refused under require', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const lenient = await boot({ INTERNAL_SERVICE_BODY_BIND: 'accept-both' });
    const passed = await lenient.inject({
      method: 'GET',
      url: `/internal/stake/${userId}`,
      headers: serviceAuthHeaders('svc-token', SECRET),
    });
    expect(passed.statusCode).not.toBe(401);
    const unsigned = await lenient.inject({ method: 'GET', url: `/internal/stake/${userId}` });
    expect(unsigned.statusCode).toBe(401);

    const strict = await boot({ INTERNAL_SERVICE_BODY_BIND: 'require' });
    const refused = await strict.inject({
      method: 'GET',
      url: `/internal/stake/${userId}`,
      headers: serviceAuthHeaders('svc-token', SECRET),
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.json().code).toBe('token.unauthenticated');
    const bound = await strict.inject({
      method: 'GET',
      url: `/internal/stake/${userId}`,
      headers: serviceAuthHeadersForBody('svc-token', SECRET, ''),
    });
    expect(bound.statusCode).not.toBe(401);
  });
});
