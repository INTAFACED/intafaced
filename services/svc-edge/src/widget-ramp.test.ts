import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { WIDGET_IFRAME_RETIRED, WIDGET_RAMP_PATH, fetchDest, refererOrigin, registerWidgetRampRoute } from './widget-ramp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');
const SRC = readFileSync(join(HERE, 'widget-ramp.ts'), 'utf8');
const INDEX = readFileSync(join(HERE, 'index.ts'), 'utf8');

const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length) {
    const a = apps.pop();
    if (a) await a.close();
  }
});

async function build(lines: string[] = [], withHelmet = true) {
  const app = Fastify({
    logger: { level: 'info', stream: { write: (chunk: string) => void lines.push(chunk) } },
  });
  if (withHelmet) {
    await app.register(helmet, { contentSecurityPolicy: false, frameguard: { action: 'sameorigin' } });
  }
  registerWidgetRampRoute(app);
  await app.ready();
  apps.push(app);
  return app;
}

function widgetLog(lines: string[]): Record<string, unknown> {
  const hit = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'edge: retired ramp widget requested');
  if (!hit) throw new Error('no retired-widget log line');
  return hit;
}

describe('ops.infra-b2b retired ramp iframe widget', () => {
  it('answers 410 JSON with the named code and denies framing, with no env needed', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: WIDGET_RAMP_PATH });
    expect(res.statusCode).toBe(410);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json<{ code: string; message: string }>();
    expect(body.code).toBe('ops.widget_iframe_retired');
    expect(body.code).toBe(WIDGET_IFRAME_RETIRED);
    expect(body.message.length).toBeGreaterThan(10);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toMatch(/<iframe|<html/i);
  });

  it('sends the same headers when no helmet is registered', async () => {
    const app = await build([], false);
    const res = await app.inject({ method: 'GET', url: WIDGET_RAMP_PATH });
    expect(res.statusCode).toBe(410);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
  });

  it('logs Sec-Fetch-Dest and the Referer origin only, never path or query', async () => {
    const lines: string[] = [];
    const app = await build(lines);
    await app.inject({
      method: 'GET',
      url: WIDGET_RAMP_PATH,
      headers: { 'sec-fetch-dest': 'iframe', referer: 'https://partner.example/checkout/42?token=secret#frag' },
    });
    const log = widgetLog(lines);
    expect(log.secFetchDest).toBe('iframe');
    expect(log.refererOrigin).toBe('https://partner.example');
    const raw = lines.join('');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('/checkout/42');
  });

  it('logs none when the headers are missing or hostile', async () => {
    const lines: string[] = [];
    const app = await build(lines);
    await app.inject({ method: 'GET', url: WIDGET_RAMP_PATH, headers: { 'sec-fetch-dest': 'x"y\n', referer: 'not a url' } });
    const log = widgetLog(lines);
    expect(log.secFetchDest).toBe('none');
    expect(log.refererOrigin).toBe('none');
  });

  it('refererOrigin and fetchDest normalise', () => {
    expect(refererOrigin('https://a.example:8443/p?q=1')).toBe('https://a.example:8443');
    expect(refererOrigin(undefined)).toBe('none');
    expect(refererOrigin('')).toBe('none');
    expect(refererOrigin('data:text/html,hi')).toBe('none');
    expect(fetchDest('iframe')).toBe('iframe');
    expect(fetchDest(undefined)).toBe('none');
    expect(fetchDest('IFRAME')).toBe('none');
  });

  it('no longer serves any framable page, licence or white-label env', () => {
    expect(SRC).not.toMatch(/frame-ancestors \*/);
    expect(SRC).not.toMatch(/removeHeader/);
    expect(SRC).not.toMatch(/INFRA_LICENCE|INFRA_WIDGET|<iframe|text\/html/);
    expect(INDEX).toMatch(/registerWidgetRampRoute\(app\)/);
    const env = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(env).not.toMatch(/INFRA_LICENCE|INFRA_WIDGET/);
    const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
    expect(compose).not.toMatch(/INFRA_LICENCE|INFRA_WIDGET/);
  });

  it('exact GET wins over /api/* catch-all', async () => {
    const app = Fastify({ logger: false });
    registerWidgetRampRoute(app);
    app.all('/api/*', async (_req, reply) => reply.code(404).send({ code: 'edge.no_route' }));
    await app.ready();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: WIDGET_RAMP_PATH });
    expect(res.statusCode).toBe(410);
    expect(res.json<{ code: string }>().code).toBe(WIDGET_IFRAME_RETIRED);
  });

  it('customer nginx keeps denying all framing (this retirement relies on it)', () => {
    const tpl = readFileSync(join(ROOT, 'apps/customer/security-headers.conf.template'), 'utf8');
    expect(tpl).toMatch(/X-Frame-Options "DENY"/);
    expect(tpl).toMatch(/frame-ancestors 'none'/);
  });
});
