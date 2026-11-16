import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerKillSwitchGuard } from './control-plane.js';
import { KillSwitchState, resolvedPathname } from './kill-switch.js';
import { notNormalReason } from './path-normal-form.js';
import { isS2sPath, resolve } from './routes.js';

vi.stubEnv('APP_ENV', 'test');

/**
 * A service door the edge must never open, reached through a path the edge reads one way and the service another
 * (project-state #2703).
 *
 * The service here is a Fastify app built the way every INTAFACED service builds its own (default router options),
 * with an `/internal/*` door and a public route. The edge is the same `onRequest` guard `index.ts` registers, and a
 * forwarder that does what the proxy handler does with a path: `resolvedPathname`, then `resolve`, then `isS2sPath`,
 * then the upstream path. A request the edge forwards is sent to the service, so "reached" lists what the service
 * actually served.
 */

interface Harness {
  edge: FastifyInstance;
  service: FastifyInstance;
  /** The service-side route that answered each forwarded request. */
  reached: string[];
}

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.edge.close();
  await harness?.service.close();
  harness = null;
});

async function stack(): Promise<Harness> {
  const reached: string[] = [];
  const service = Fastify({ logger: false, maxParamLength: 5_000 });
  service.all('/internal/test/age', async () => {
    reached.push('/internal/test/age');
    return { door: 'internal' };
  });
  service.all('/internal', async () => {
    reached.push('/internal');
    return { door: 'internal' };
  });
  service.all('/trpc/:path', async (req) => {
    reached.push(`/trpc/${(req.params as { path: string }).path}`);
    return { ok: true };
  });
  service.all('/api/v1/orders/:id', async (req) => {
    reached.push(`/api/v1/orders/${(req.params as { id: string }).id}`);
    return { ok: true };
  });
  service.all('/courses/:slug', async (req) => {
    reached.push(`/courses/${(req.params as { slug: string }).slug}`);
    return { ok: true };
  });
  await service.ready();

  const edge = Fastify({ logger: false });
  registerKillSwitchGuard(edge, new KillSwitchState());
  edge.all('/api/*', async (req, reply) => {
    // What the proxy handler in index.ts does with the path, in the same order.
    const pathname = resolvedPathname(req.url);
    if (pathname === null) return reply.code(400).send({ code: 'edge.unresolvable_path' });
    const target = resolve(pathname);
    if (!target) return reply.code(404).send({ code: 'edge.no_route' });
    if (isS2sPath(target.path)) return reply.code(404).send({ code: 'edge.s2s_not_proxied' });
    const res = await service.inject({ method: req.method as 'GET', url: target.path });
    return reply.code(res.statusCode).send(res.body);
  });
  await edge.ready();

  harness = { edge, service, reached };
  return harness;
}

/** Every way tonight's checker and this builder found to spell `/internal` so a router behind the edge serves it. */
const ATTACKS = [
  '/api/trade/%69nternal/test/age',
  '/api/trade/inte%72nal/test/age',
  '/api/trade/%69%6e%74%65%72%6e%61%6c/test/age',
  '/api/trade/%49nternal/test/age',
  '/api/trade/%2Finternal/test/age',
  '/api/trade/%2finternal/test/age',
  '/api/trade//internal/test/age',
  '/api/trade/internal%2Ftest%2Fage',
  '/api/trade/%252Finternal/test/age',
  '/api/trade/%2569nternal/test/age',
  '/api/trade/./internal/test/age',
  '/api/trade/%2e/internal/test/age',
  '/api/trade/x/../internal/test/age',
  '/api/trade/x/%2e%2e/internal/test/age',
  '/api/trade/x/..%2finternal/test/age',
  '/api/trade\\internal/test/age',
  '/api/trade/%5Cinternal/test/age',
  '/api/trade/internal;x/test/age',
  '/api/trade/internal%3Bx/test/age',
  '/api/trade/INTERNAL/test/age',
  '/api/trade/%EF%BD%89nternal/test/age',
  '/api/trade/internal%09/test/age',
  '/api/trade/%09internal/test/age',
  '/api/trade/internal%00/test/age',
  '/api/trade/internal%20/test/age',
  '/api/trade/internal./test/age',
  '/api/trade/%C0%AFinternal/test/age',
  '/api/trade/%E0%80%AEinternal/test/age',
  '/api/trade/%zzinternal/test/age',
  '/api/trade/%internal/test/age',
  '/api/trade/%69nternal',
  '/api/trade/internal',
  '/api/trade/internal/test/age',
  '/api/trade/internal/test/age?x=1',
  '/%61pi/trade/internal/test/age',
  '/api/%74rade/internal/test/age',
];

describe('a service door is not reachable through the edge by any spelling of its path', () => {
  it('no spelling of /internal reaches the service, under GET and POST', async () => {
    const h = await stack();
    for (const url of ATTACKS) {
      for (const method of ['GET', 'POST'] as const) {
        const res = await h.edge.inject({ method, url });
        expect(res.statusCode, `${method} ${url}`).toBeGreaterThanOrEqual(400);
        expect(res.statusCode, `${method} ${url}`).toBeLessThan(500);
      }
    }
    expect(h.reached).toEqual([]);
  });

  it('the encoded path from project-state #2703 is refused before any route decision', async () => {
    const h = await stack();
    const res = await h.edge.inject({ method: 'GET', url: '/api/trade/%69nternal/test/age' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'edge.unresolvable_path' });
    expect(h.reached).toEqual([]);
  });

  it('public paths that worked before still reach the service, unchanged', async () => {
    const h = await stack();
    const ok = [
      ['POST', '/api/trade/trpc/orders.create', '/trpc/orders.create'],
      ['GET', '/api/trade/trpc/orders.list,orders.open?batch=1&input=%7B%220%22%3A%7B%7D%7D', '/trpc/orders.list,orders.open'],
      ['DELETE', '/api/v1/orders/BTC%2FUSDT', '/api/v1/orders/BTC/USDT'],
      ['DELETE', '/api/v1/orders/11111111-1111-4111-8111-111111111111', '/api/v1/orders/11111111-1111-4111-8111-111111111111'],
      ['GET', '/api/academy/courses/%C3%A9t%C3%A9', '/courses/été'],
      ['GET', '/api/academy/courses/internal-controls', '/courses/internal-controls'],
      ['GET', '/api/academy/courses/caf%C3%A9?q=%69', '/courses/café'],
    ] as const;
    for (const [method, url, served] of ok) {
      const res = await h.edge.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(200);
      expect(h.reached.at(-1), url).toBe(served);
    }
  });
});

describe('each layer holds on its own', () => {
  it('the resolver refuses a path not in normal form, whatever it names', () => {
    for (const url of [
      '/api/trade/%69nternal/test/age',
      '/api/pay/%74rpc/settlement.payout',
      '/api/pay/trpc/settlement%2Epayout',
      '/api/trade//internal/x',
      '/api/trade/%2569nternal/x',
      '/api/trade/%5Cinternal/x',
      '/api/trade/internal%00/x',
      '/admin/%6Bill-switches',
    ]) {
      expect(resolvedPathname(url), url).toBeNull();
    }
  });

  it('the /internal check reads the first segment as the service could, even without the resolver', () => {
    for (const path of [
      '/internal',
      '/internal/',
      '/internal/x',
      '/%69nternal/x',
      '/%2Finternal/x',
      '//internal/x',
      '/internal%2Fx',
      '/\\internal/x',
      '/internal;v=1/x',
      '/INTERNAL/x',
      '/%EF%BD%89nternal/x',
      '/internal%20/x',
      '/internal./x',
      '/%zz',
    ]) {
      expect(isS2sPath(path), path).toBe(true);
    }
    for (const path of ['/', '/trpc/orders.create', '/internals', '/internal-controls/x', '/courses/internal', '/api/v1/internal']) {
      expect(isS2sPath(path), path).toBe(false);
    }
  });

  it('names why a path is not in normal form', () => {
    expect(notNormalReason('/api/trade/%69nternal')).toBe('escaped-unreserved');
    expect(notNormalReason('/api/trade/x%7E')).toBe('escaped-unreserved');
    expect(notNormalReason('/api/trade/x%1F')).toBe('escaped-control');
    expect(notNormalReason('/api/trade/x%7f')).toBe('escaped-control');
    expect(notNormalReason('/api/trade/x%5c')).toBe('escaped-backslash');
    expect(notNormalReason('/api/trade/x%2541')).toBe('double-encoded');
    expect(notNormalReason('/api/trade//x')).toBe('empty-segment');
    expect(notNormalReason('/api/trade/x%25')).toBeNull();
    expect(notNormalReason('/api/trade/x%25zz')).toBeNull();
    expect(notNormalReason('/api/v1/orders/BTC%2FUSDT')).toBeNull();
    expect(notNormalReason('/api/trade/trpc/a%2Cb')).toBeNull();
    expect(notNormalReason('/api/academy/caf%C3%A9')).toBeNull();
    expect(notNormalReason('/api/trade/')).toBeNull();
  });
});
