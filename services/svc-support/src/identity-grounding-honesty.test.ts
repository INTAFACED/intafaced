/**
 * GET /health and /ready must not sell INTERNAL_SERVICE_SECRET as identity wired.
 * A set secret is config. This process does not fetch identity. Store is unprobed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IDENTITY_GROUNDING_UNPROBED,
  IDENTITY_GROUNDING_UNWIRED,
  SUPPORT_STORE_UNPROBED,
  composePretendsGroundingLoopServing,
  identityGroundingHonesty,
  identitySecretSet,
  supportHealthHonesty,
  supportStoreHonesty,
} from './identity-grounding-honesty.js';
import { mountedSupportApp } from './testing/mounted-app.js';
import { composeServiceBlock } from '@intafaced/config/compose';

const here = dirname(fileURLToPath(import.meta.url));
const COMPOSE = join(here, '../../../docker-compose.apps.yml');

function serviceBlock(source: string, name: string): string {
  return composeServiceBlock(source, name);
}

describe('identity grounding honesty — secret-set is not wired', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  it('names support.identity_grounding_unwired when the S2S secret is blank', () => {
    expect(identitySecretSet('')).toBe(false);
    expect(identitySecretSet('   ')).toBe(false);
    expect(identitySecretSet(undefined)).toBe(false);
    expect(identitySecretSet(null)).toBe(false);
    expect(identityGroundingHonesty('')).toEqual({ status: 'absent', code: IDENTITY_GROUNDING_UNWIRED });
    expect(identityGroundingHonesty('   ')).toEqual({ status: 'absent', code: IDENTITY_GROUNDING_UNWIRED });
    expect(identityGroundingHonesty(undefined)).toEqual({ status: 'absent', code: IDENTITY_GROUNDING_UNWIRED });
    expect(identityGroundingHonesty(null)).toEqual({ status: 'absent', code: IDENTITY_GROUNDING_UNWIRED });
  });

  it('nonempty secret is configured + unprobed, never wired', () => {
    expect(identitySecretSet('an-internal-service-secret-long-enough')).toBe(true);
    expect(identityGroundingHonesty('an-internal-service-secret-long-enough')).toEqual({
      status: 'configured',
      code: IDENTITY_GROUNDING_UNPROBED,
    });
    const body = supportHealthHonesty({
      serviceName: 'svc-support',
      identitySecret: 'an-internal-service-secret-long-enough',
    });
    expect(body.ok).toBe(true);
    expect(body.identityGroundingWired).toBe(false);
    expect(body.identitySecretSet).toBe(true);
    expect(body.identityGroundingRefuse).toBeNull();
    expect(body.identity).toEqual({ status: 'configured', code: IDENTITY_GROUNDING_UNPROBED });
  });

  it('/health.ok is process liveness, not secret-set', () => {
    const blank = supportHealthHonesty({ serviceName: 'svc-support', identitySecret: '' });
    const set = supportHealthHonesty({
      serviceName: 'svc-support',
      identitySecret: 'an-internal-service-secret-long-enough',
    });
    expect(blank.ok).toBe(true);
    expect(set.ok).toBe(true);
    expect(blank.ok).toBe(set.ok);
    expect(blank.identitySecretSet).not.toBe(set.identitySecretSet);
    expect(blank.identityGroundingWired).toBe(false);
    expect(set.identityGroundingWired).toBe(false);
  });

  it('/ready store is configured + unprobed, not a live postgres string', () => {
    expect(supportStoreHonesty()).toEqual({ status: 'configured', code: SUPPORT_STORE_UNPROBED });
    expect(JSON.stringify(supportStoreHonesty())).not.toMatch(/postgres/i);
  });

  it('GET /health as http-app mounts does not sell secret-set as wired', async () => {
    const app = Fastify({ logger: false });
    app.get('/health', async () =>
      supportHealthHonesty({
        serviceName: 'svc-support',
        identitySecret: 'an-internal-service-secret-long-enough',
      }),
    );
    await app.ready();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.identityGroundingWired).toBe(false);
    expect(body.identitySecretSet).toBe(true);
    expect(body.identity).toEqual({ status: 'configured', code: IDENTITY_GROUNDING_UNPROBED });
  });

  it('the mounted app serves the honesty helpers: a set secret is not wired, and the store is unprobed', async () => {
    for (const identitySecret of ['an-internal-service-secret-long-enough', '', undefined]) {
      const { app, get } = await mountedSupportApp(identitySecret);
      const health = await get('/health');
      expect(health.status).toBe(200);
      expect(health.body).toEqual(supportHealthHonesty({ serviceName: 'svc-support', identitySecret }));
      expect(health.body.ok).toBe(true);
      expect(health.body.identityGroundingWired).toBe(false);
      const ready = await get('/ready');
      expect(ready.body.ready).toBe(true);
      expect(ready.body.identityGroundingWired).toBe(false);
      expect(ready.body.store).toEqual({ status: 'configured', code: SUPPORT_STORE_UNPROBED });
      expect(JSON.stringify(ready.body.store)).not.toMatch(/postgres/i);
      await app.close();
    }
  });

  it('detects compose that claims IDENTITY_URL without the internal secret', () => {
    const dishonest = [
      '  svc-support:',
      '    environment:',
      '      SERVICE_NAME: svc-support',
      '      IDENTITY_URL: http://svc-identity:4002',
      '',
    ].join('\n');
    expect(composePretendsGroundingLoopServing(dishonest)).toBe(true);
  });

  it('fails if shipped compose pretends the grounding loop is serving without the secret', () => {
    const block = serviceBlock(readFileSync(COMPOSE, 'utf8'), 'svc-support');
    expect(composePretendsGroundingLoopServing(block)).toBe(false);
    expect(block).toMatch(/\*internal-secret/);
    expect(block).toMatch(/IDENTITY_URL:\s*http:\/\/svc-identity:4002/);
  });
});
