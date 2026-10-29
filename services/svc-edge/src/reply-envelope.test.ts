import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerCors, type OriginAllowlist } from './cors.js';
import { quotaRefuseBody, scopeRefuseBody } from './gateway-plane.js';
import { registerRateLimit } from './hardening.js';
import {
  completeEdgeErrorBody,
  docsFor,
  markProxied,
  registerReplyEnvelope,
  REQUEST_ID_OPTIONS,
  stampProxiedErrorBody,
} from './reply-envelope.js';

/**
 * RC-developer-03 and DV-errors-01, against Fastify's own pipeline: every reply carries the request id and the
 * two server times; every `/api/*` error body carries the same request id; an edge refusal also carries a docs
 * link and an `edge.` code; a service's error body is otherwise left exactly as the service sent it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APP = 'https://app.example.com';
const allowlist: OriginAllowlist = { origins: [APP], configured: true, source: 'configured', summary: 'test' };

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

/** The edge's hooks in `index.ts` order, with stand-in routes for an edge refusal and a proxied answer. */
async function edge(options: { clock?: () => number; bodyLimit?: number; rateMax?: number } = {}) {
  const app = Fastify({ logger: false, bodyLimit: options.bodyLimit ?? 1024, ...REQUEST_ID_OPTIONS });
  apps.push(app);
  registerReplyEnvelope(app, options.clock);
  registerCors(app, allowlist);
  await registerRateLimit(app, { enabled: options.rateMax !== undefined, max: options.rateMax ?? 1, windowMs: 60_000, trustProxy: false });
  await app.register(async (api) => {
    api.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    api.get('/api/edge-refusal', async (_req, reply) => reply.code(503).send({ error: 'Switched off', code: 'edge.module_killed' }));
    api.get('/api/v1/orders-scope', async (_req, reply) => reply.code(403).send(scopeRefuseBody('trade', 'trade:write')));
    api.get('/api/pay/scope', async (_req, reply) => reply.code(403).send(scopeRefuseBody('pay', 'pay:write')));
    api.get('/api/quota', async (_req, reply) => reply.code(429).send(quotaRefuseBody(3)));
    api.post('/api/echo', async () => ({ ok: true }));
    api.get('/api/service/:status', async (req, reply) => {
      const { status } = req.params as { status: string };
      const { body, type } = req.query as { body: string; type?: string };
      markProxied(req);
      return reply
        .code(Number(status))
        .header('content-type', type ?? 'application/json')
        .send(body);
    });
  });
  app.get('/admin/refusal', async (_req, reply) => reply.code(403).send({ error: 'no', code: 'edge.admin_denied' }));
  app.get('/health', async () => ({ ok: true }));
  return app;
}

const service = (app: FastifyInstance, status: number, body: string, type?: string) =>
  app.inject({ method: 'GET', url: '/api/service/' + status, query: { body, ...(type ? { type } : {}) } });

describe('the three headers, on every reply', () => {
  it('stamps a fresh UUID request id and received/sent times on answers, refusals, probes, preflights and the operator plane', async () => {
    const app = await edge();
    const answers = [
      await app.inject({ method: 'GET', url: '/health' }),
      await app.inject({ method: 'GET', url: '/api/edge-refusal' }),
      await app.inject({ method: 'GET', url: '/api/not-a-route' }),
      await app.inject({ method: 'OPTIONS', url: '/api/v1/orders', headers: { origin: APP, 'access-control-request-method': 'POST' } }),
      await app.inject({ method: 'GET', url: '/admin/refusal' }),
      await service(app, 200, '{"ok":true}'),
    ];
    const ids = new Set<string>();
    for (const res of answers) {
      const id = String(res.headers['x-request-id']);
      expect(id).toMatch(UUID);
      ids.add(id);
      const received = Number(res.headers['x-server-received']);
      const sent = Number(res.headers['x-server-sent']);
      expect(Number.isSafeInteger(received) && received > 0).toBe(true);
      expect(sent).toBeGreaterThanOrEqual(received);
    }
    expect(ids.size).toBe(answers.length);
  });

  it('never adopts a caller-supplied request id', async () => {
    const app = await edge();
    for (const header of ['x-request-id', 'request-id']) {
      const res = await app.inject({ method: 'GET', url: '/api/edge-refusal', headers: { [header]: 'chosen-by-caller' } });
      expect(res.headers['x-request-id']).not.toBe('chosen-by-caller');
      expect(res.json().requestId).toBe(res.headers['x-request-id']);
    }
  });

  it('reads received in the first hook and sent last, and sent is never before received when the clock steps back', async () => {
    const forward = [1_000, 1_250];
    const ahead = await edge({ clock: () => forward.shift() ?? 0 });
    const timed = await ahead.inject({ method: 'GET', url: '/health' });
    expect(timed.headers['x-server-received']).toBe('1000');
    expect(timed.headers['x-server-sent']).toBe('1250');

    // The second read is behind the first (an NTP step): sent is held at received, never before it.
    const backward = [1_000, 900];
    const stepped = await edge({ clock: () => backward.shift() ?? 0 });
    const res = await stepped.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-server-received']).toBe('1000');
    expect(res.headers['x-server-sent']).toBe('1000');
  });

  it('the rate-limit refusal carries the same id in its header and its body', async () => {
    const app = await edge({ rateMax: 1 });
    await app.inject({ method: 'GET', url: '/api/edge-refusal' });
    const res = await app.inject({ method: 'GET', url: '/api/edge-refusal' });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'edge.rate_limited', requestId: res.headers['x-request-id'] });
    expect(res.json().docs).toBe('/developers/errors#edge.rate_limited');
  });
});

describe('an edge refusal under /api/*: one shape', () => {
  it('gains requestId (the header value), a docs link and a message, and keeps its code and older error field', async () => {
    const app = await edge();
    const res = await app.inject({ method: 'GET', url: '/api/edge-refusal' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: 'Switched off',
      message: 'Switched off',
      code: 'edge.module_killed',
      docs: '/developers/errors#edge.module_killed',
      requestId: res.headers['x-request-id'],
    });
  });

  it('the trade-door scope refusal keeps its CCXT class, scope code and permission-table link (J-developer-03 #7)', async () => {
    const app = await edge();
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders-scope' });
    const body = res.json();
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(body)).toMatch(/scope/);
    expect(body).toMatchObject({
      code: 'PermissionDenied',
      intafacedCode: 'scope.denied',
      docs: '/developers/permissions',
      requestId: res.headers['x-request-id'],
    });
  });

  it('the pay-door scope refusal keeps its tRPC shape, gains no top-level code, and its link is the permission table', async () => {
    const app = await edge();
    const res = await app.inject({ method: 'GET', url: '/api/pay/scope' });
    const body = res.json();
    expect(body.code).toBeUndefined();
    expect(body.error.data).toMatchObject({ code: 'FORBIDDEN', intafacedCode: 'scope.denied', docs: '/developers/permissions' });
    expect(body.docs).toBe('/developers/permissions');
    expect(body.requestId).toBe(res.headers['x-request-id']);
  });

  it('the key quota refusal keeps its edge code and bucket and gains the request id', async () => {
    const app = await edge();
    const res = await app.inject({ method: 'GET', url: '/api/quota' });
    expect(res.json()).toMatchObject({ code: 'edge.rate_limited', bucket: 'edge.api_key', requestId: res.headers['x-request-id'] });
  });

  it('a framework refusal is renamed into the edge vocabulary: an oversize body is edge.body_too_large, never FST_*', async () => {
    const app = await edge({ bodyLimit: 16 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(64) }),
    });
    expect(res.statusCode).toBe(413);
    const body = res.json();
    expect(body.code).toBe('edge.body_too_large');
    expect(body.requestId).toBe(res.headers['x-request-id']);
    expect(body.docs).toBe('/developers/errors#edge.body_too_large');
    expect(body.statusCode).toBeUndefined();
    expect(res.body).not.toMatch(/FST_/);
  });

  it('an unsupported media type is edge.unsupported_media_type', async () => {
    const app = await edge();
    const res = await app.inject({ method: 'POST', url: '/api/echo', headers: { 'content-type': 'text/xml' }, payload: '<a/>' });
    expect(res.statusCode).toBe(415);
    expect(res.json().code).toBe('edge.unsupported_media_type');
  });

  it('Fastify’s own not-found under /api gains an edge code', async () => {
    const app = await edge();
    const res = await app.inject({ method: 'GET', url: '/api/not-a-route' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'edge.request_invalid', requestId: res.headers['x-request-id'] });
  });

  it('leaves the operator plane and success bodies alone', async () => {
    const app = await edge();
    const admin = await app.inject({ method: 'GET', url: '/admin/refusal' });
    expect(admin.json()).toEqual({ error: 'no', code: 'edge.admin_denied' });
    const ok = await app.inject({ method: 'POST', url: '/api/echo', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(ok.json()).toEqual({ ok: true });
  });
});

describe('a proxied service error: requestId, and every other byte as the service sent it', () => {
  it('inserts the request id into a JSON object error without re-serialising the rest', async () => {
    const app = await edge();
    const sent = '{ "code":"InvalidOrder", "amount": 12345678901234567890123, "errors":[{"field":"side"}] }';
    const res = await service(app, 400, sent);
    expect(res.body).toBe(
      `{ "code":"InvalidOrder", "amount": 12345678901234567890123, "errors":[{"field":"side"}] ,"requestId":"${res.headers['x-request-id']}"}`,
    );
    // A service error is not completed with edge fields: no docs, no edge code.
    expect(res.json().docs).toBeUndefined();
    expect(res.json().code).toBe('InvalidOrder');
  });

  it('a tRPC service error gains the top-level request id beside its own data', async () => {
    const app = await edge();
    const res = await service(app, 403, JSON.stringify({ error: { message: 'no', code: -32003, data: { code: 'FORBIDDEN' } } }));
    expect(res.json()).toEqual({
      error: { message: 'no', code: -32003, data: { code: 'FORBIDDEN' } },
      requestId: res.headers['x-request-id'],
    });
  });

  it('leaves a body that already names a request id, a batch array, non-JSON, a non-JSON type and a success untouched', async () => {
    const app = await edge();
    const cases: Array<[number, string, string?]> = [
      [400, '{"code":"X","requestId":"svc-own"}'],
      [400, '[{"error":{"message":"a"}},{"error":{"message":"b"}}]'],
      [502, '<html>bad gateway</html>'],
      [400, '{"code":"X"}', 'text/plain'],
      [200, '{"code":"fine"}'],
      [400, 'null'],
      [400, '"just a string"'],
    ];
    for (const [status, body, type] of cases) {
      const res = await service(app, status, body, type);
      expect(res.body).toBe(body);
    }
  });
});

describe('the pure helpers', () => {
  it('stampProxiedErrorBody handles an empty object and trailing whitespace', () => {
    expect(stampProxiedErrorBody('{}', 'r1')).toBe('{"requestId":"r1"}');
    expect(stampProxiedErrorBody('{"a":1}\n', 'r1')).toBe('{"a":1,"requestId":"r1"}\n');
    expect(JSON.parse(stampProxiedErrorBody('{"a":"}"}', 'r1'))).toEqual({ a: '}', requestId: 'r1' });
    expect(stampProxiedErrorBody('{"a":', 'r1')).toBe('{"a":');
  });

  it('completeEdgeErrorBody overwrites a stale request id with this one and leaves a non-object alone', () => {
    expect(JSON.parse(completeEdgeErrorBody('{"code":"edge.x","requestId":"old"}', { requestId: 'new', status: 400 })).requestId).toBe(
      'new',
    );
    expect(completeEdgeErrorBody('[1]', { requestId: 'new', status: 400 })).toBe('[1]');
    expect(completeEdgeErrorBody('oops', { requestId: 'new', status: 400 })).toBe('oops');
    expect(JSON.parse(completeEdgeErrorBody('{"message":"boom"}', { requestId: 'r', status: 500 })).code).toBe('edge.internal_error');
  });

  it('docsFor links key and freeze codes to the auth catalogue, the rest to the error page, and never links an odd code by name', () => {
    expect(docsFor('edge.api_key_denied')).toBe('/developers/errors/auth#edge.api_key_denied');
    expect(docsFor('edge.api_key_revoked')).toBe('/developers/errors/auth#edge.api_key_revoked');
    expect(docsFor('account_frozen')).toBe('/developers/errors/auth#account_frozen');
    expect(docsFor('edge.authority_unavailable')).toBe('/developers/errors/auth#edge.authority_unavailable');
    expect(docsFor('edge.no_route')).toBe('/developers/errors#edge.no_route');
    expect(docsFor(undefined)).toBe('/developers/errors');
    expect(docsFor('"><script>')).toBe('/developers/errors');
    expect(docsFor('a'.repeat(200))).toBe('/developers/errors');
  });
});

describe('index.ts wires the envelope', () => {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  it('takes the request id options, registers the envelope before CORS, marks proxied answers and sends its id upstream', () => {
    expect(src).toMatch(/Fastify\(\{[\s\S]*\.\.\.REQUEST_ID_OPTIONS[\s\S]*\}\);/);
    const envelope = src.indexOf('registerReplyEnvelope(app);');
    expect(envelope).toBeGreaterThan(0);
    expect(envelope).toBeLessThan(src.indexOf('registerCors(app, cors);'));
    expect(src.indexOf('markProxied(req);')).toBeGreaterThan(src.indexOf('const text = await response.text();'));
    expect(src).toContain('[REQUEST_ID_HEADER]: String(req.id)');
  });
});
