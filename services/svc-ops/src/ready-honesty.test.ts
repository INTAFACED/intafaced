/**
 * GET /ready must not sell IDENTITY_URL / SUPPORT_URL as live peers
 * or as a constructed client. A set URL is config. This process does
 * not fetch; identity/support sources stay hardcoded-absent.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { OPS_IDENTITY_UNWIRED, OPS_SUPPORT_UNWIRED } from './codes.js';
import {
  OPS_IDENTITY_UNPROBED,
  OPS_SOURCE_HARDCODED_ABSENT,
  OPS_SUPPORT_UNPROBED,
  identityUrlHonesty,
  opsReadyUrlHonesty,
  supportUrlHonesty,
} from './ready-honesty.js';

const HARDCODED = {
  identitySource: OPS_SOURCE_HARDCODED_ABSENT,
  supportSource: OPS_SOURCE_HARDCODED_ABSENT,
} as const;

describe('ops ready honesty — URL-set is not live', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  it('blank URLs are absent + unwired, never ok or live', () => {
    expect(opsReadyUrlHonesty({})).toEqual({
      identityUrlConfigured: false,
      supportUrlConfigured: false,
      identity: { status: 'absent', code: OPS_IDENTITY_UNWIRED },
      support: { status: 'absent', code: OPS_SUPPORT_UNWIRED },
      ...HARDCODED,
    });
    expect(identityUrlHonesty('  ').status).not.toBe('ok');
    expect(supportUrlHonesty(undefined).status).not.toBe('ok');
  });

  it('set URLs are configured + unprobed, never live', () => {
    const body = opsReadyUrlHonesty({
      IDENTITY_URL: 'http://identity.test',
      SUPPORT_URL: 'http://support.test',
    });
    expect(body).toEqual({
      identityUrlConfigured: true,
      supportUrlConfigured: true,
      identity: { status: 'configured', code: OPS_IDENTITY_UNPROBED },
      support: { status: 'configured', code: OPS_SUPPORT_UNPROBED },
      ...HARDCODED,
    });
    expect(JSON.stringify(body)).not.toMatch(/"ok"/);
    expect(JSON.stringify(body)).not.toMatch(/live/i);
  });

  it('URL-set still names identitySource/supportSource hardcoded-absent', () => {
    const body = opsReadyUrlHonesty({
      IDENTITY_URL: 'http://identity.test',
      SUPPORT_URL: 'http://support.test',
    });
    expect(body.identitySource).toBe('hardcoded-absent');
    expect(body.supportSource).toBe('hardcoded-absent');
    expect(body.identity.status).toBe('configured');
    expect(body.support.status).toBe('configured');
  });

  it('GET /ready as index.ts mounts does not emit identityUrl/supportUrl booleans', async () => {
    const app = Fastify({ logger: false });
    app.get('/ready', async () => ({
      ready: true as const,
      ...opsReadyUrlHonesty({ IDENTITY_URL: 'http://identity.test' }),
    }));
    await app.ready();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.ready).toBe(true);
    expect(body).not.toHaveProperty('custodial');
    expect(body).not.toHaveProperty('identityUrl');
    expect(body).not.toHaveProperty('supportUrl');
    expect(body.identityUrlConfigured).toBe(true);
    expect(body.supportUrlConfigured).toBe(false);
    expect(body.identity).toEqual({ status: 'configured', code: OPS_IDENTITY_UNPROBED });
    expect(body.support).toEqual({ status: 'absent', code: OPS_SUPPORT_UNWIRED });
    expect(body.identitySource).toBe('hardcoded-absent');
    expect(body.supportSource).toBe('hardcoded-absent');
    expect(JSON.stringify(body)).not.toMatch(/identity\.test/);
  });
  // What the booted index.ts serves on /ready, and that it fetches no peer: index-boot.test.ts.
});
