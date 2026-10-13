import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnconfiguredCardRenderer } from './card/card-renderer.js';
import { HttpNeuralEngineClient } from './engine/http-engine.js';
import { MockNeuralEngine } from './engine/mock-engine.js';
import { isUsable } from './engine/neural-engine.js';
import { PROD_ENGINE_CONFIG_CODE, ProdEngineConfigError, assertProdEngine, isLoopbackEngineUrl } from './prod-engine.js';
import { blueprintReadiness } from './readiness.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: 'an-edge-principal-secret-long-enough-for-the-schema',
};

const PROD_HTTP = {
  APP_ENV: 'prod',
  BLUEPRINT_ENGINE_MODE: 'http' as const,
  BLUEPRINT_ENGINE_URL: 'https://neural-engine.internal/v1',
};

async function loadEnvModule(overrides: Record<string, string | undefined>): Promise<unknown> {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('BLUEPRINT_ENGINE_URL', undefined);
  vi.stubEnv('BLUEPRINT_ENGINE_MODE', undefined);
  vi.stubEnv('APP_ENV', undefined);
  // CI points these at a local chain node for the whole job; with APP_ENV=prod the production-posture guard
  // would refuse them before the engine check this file is about. They have nothing to do with it.
  for (const key of ['PROTOCOL_RPC_URL', 'INDEXER_RPC_URL', 'INDEXER_REORG_RPC_URL']) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  return import('./env.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('assertProdEngine — prod refuses mock and loopback', () => {
  it('throws a typed error when APP_ENV=prod and BLUEPRINT_ENGINE_MODE=mock', () => {
    expect(() =>
      assertProdEngine({
        APP_ENV: 'prod',
        BLUEPRINT_ENGINE_MODE: 'mock',
        BLUEPRINT_ENGINE_URL: 'https://neural-engine.internal/v1',
      }),
    ).toThrow(ProdEngineConfigError);

    try {
      assertProdEngine({
        APP_ENV: 'prod',
        BLUEPRINT_ENGINE_MODE: 'mock',
        BLUEPRINT_ENGINE_URL: 'https://neural-engine.internal/v1',
      });
      expect.unreachable('must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProdEngineConfigError);
      expect((err as ProdEngineConfigError).code).toBe(PROD_ENGINE_CONFIG_CODE);
      expect((err as ProdEngineConfigError).message).toMatch(/APP_ENV=prod/);
      expect((err as ProdEngineConfigError).message).toMatch(/BLUEPRINT_ENGINE_MODE=mock/);
    }
  });

  it('throws when APP_ENV=prod and ENGINE_URL is unset (unpublished)', () => {
    expect(() =>
      assertProdEngine({
        APP_ENV: 'prod',
        BLUEPRINT_ENGINE_MODE: 'http',
        BLUEPRINT_ENGINE_URL: undefined,
      }),
    ).toThrow(ProdEngineConfigError);
  });

  it('throws when APP_ENV=prod and ENGINE_URL is explicit localhost (not a schema default)', () => {
    expect(() =>
      assertProdEngine({
        APP_ENV: 'prod',
        BLUEPRINT_ENGINE_MODE: 'http',
        BLUEPRINT_ENGINE_URL: 'http://localhost:4108',
      }),
    ).toThrow(ProdEngineConfigError);
  });

  it('allows APP_ENV=prod with owner-explicit host.docker.internal', () => {
    expect(() =>
      assertProdEngine({
        APP_ENV: 'prod',
        BLUEPRINT_ENGINE_MODE: 'http',
        BLUEPRINT_ENGINE_URL: 'http://host.docker.internal:4108',
      }),
    ).not.toThrow();
  });

  it('throws when APP_ENV=prod and ENGINE_URL is another loopback spelling', () => {
    expect(() =>
      assertProdEngine({
        APP_ENV: 'prod',
        BLUEPRINT_ENGINE_MODE: 'http',
        BLUEPRINT_ENGINE_URL: 'http://127.0.0.1:4108',
      }),
    ).toThrow(ProdEngineConfigError);
    expect(() =>
      assertProdEngine({
        APP_ENV: 'prod',
        BLUEPRINT_ENGINE_MODE: 'http',
        BLUEPRINT_ENGINE_URL: 'http://[::1]:4108',
      }),
    ).toThrow(ProdEngineConfigError);
    expect(isLoopbackEngineUrl('http://[::1]:4108')).toBe(true);
  });

  it('throws blueprint.prod_engine_config for every loopback engine URL in prod', () => {
    const loopbacks = [
      'http://127.0.0.2',
      'http://127.0.0.0:4108',
      'http://127.255.255.255:4108',
      'http://localhost.',
      'http://localhost.:4108',
      'http://LOCALHOST.',
      'http://[::ffff:127.0.0.1]',
      'http://[::ffff:127.0.0.1]:4108',
      'http://[::ffff:7f00:1]',
      'http://[::ffff:7f00:2]:4108',
      'http://[::ffff:7fff:ffff]',
      'http://localhost:4108',
      'http://127.0.0.1:4108',
      'http://[::1]:4108',
      'http://0.0.0.0:4108',
    ];

    for (const url of loopbacks) {
      expect(isLoopbackEngineUrl(url), url).toBe(true);
      try {
        assertProdEngine({
          APP_ENV: 'prod',
          BLUEPRINT_ENGINE_MODE: 'http',
          BLUEPRINT_ENGINE_URL: url,
        });
        expect.unreachable(`must throw for ${url}`);
      } catch (err) {
        expect(err, url).toBeInstanceOf(ProdEngineConfigError);
        expect((err as ProdEngineConfigError).code, url).toBe(PROD_ENGINE_CONFIG_CODE);
      }
    }
  });

  it('allows APP_ENV=prod with http mode and a non-loopback engine URL', () => {
    expect(() => assertProdEngine(PROD_HTTP)).not.toThrow();
  });

  it('allows mock in local/dev (APP_ENV not prod)', () => {
    for (const appEnv of ['dev', 'test', 'staging'] as const) {
      expect(() =>
        assertProdEngine({
          APP_ENV: appEnv,
          BLUEPRINT_ENGINE_MODE: 'mock',
          BLUEPRINT_ENGINE_URL: 'http://localhost:4108',
        }),
      ).not.toThrow();
    }
  });
});

describe('env load — prod refuses unpublished URL, not only an explicit mock', () => {
  it('refuses APP_ENV=prod + MODE=mock at import', async () => {
    await expect(
      loadEnvModule({
        APP_ENV: 'prod',
        BLUEPRINT_ENGINE_MODE: 'mock',
        BLUEPRINT_ENGINE_URL: 'https://neural-engine.internal/v1',
      }),
    ).rejects.toMatchObject({ name: 'ProdEngineConfigError', code: PROD_ENGINE_CONFIG_CODE });
  });

  it('refuses APP_ENV=prod + http when ENGINE_URL is unset (unpublished, not localhost)', async () => {
    await expect(loadEnvModule({ APP_ENV: 'prod', BLUEPRINT_ENGINE_MODE: 'http' })).rejects.toThrow(/BLUEPRINT_ENGINE_URL/);
  });

  it('still boots APP_ENV=dev + mock with unpublished URL', async () => {
    const mod = (await loadEnvModule({ APP_ENV: 'dev', BLUEPRINT_ENGINE_MODE: 'mock' })) as {
      env: { APP_ENV: string; BLUEPRINT_ENGINE_MODE: string; BLUEPRINT_ENGINE_URL?: string };
    };
    expect(mod.env.APP_ENV).toBe('dev');
    expect(mod.env.BLUEPRINT_ENGINE_MODE).toBe('mock');
    expect(mod.env.BLUEPRINT_ENGINE_URL).toBeUndefined();
  });
});

describe('/ready — process ready is not engine usable (kube-probe)', () => {
  it('stays ready:true when isUsable is false (HTTP engine, no call yet)', () => {
    const engine = new HttpNeuralEngineClient({ baseUrl: 'https://neural-engine.internal/v1' });
    expect(isUsable(engine)).toBe(false);

    const payload = blueprintReadiness({
      engine,
      engineMode: 'http',
      cardRenderer: new UnconfiguredCardRenderer(),
      cardRendererConfigured: false,
    });

    expect(payload.ready).toBe(true);
    expect(payload.engine.usable).toBe(false);
    expect(payload.engine.mode).toBe('http');
    expect(payload.cardRenderer.configured).toBe(false);
  });

  it('stays ready:true when the mock is past the 60s staleness window', () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date(startedAt.getTime() + 61_000);
    const engine = new MockNeuralEngine({}, startedAt);
    expect(isUsable(engine, now)).toBe(false);

    const payload = blueprintReadiness({
      engine,
      engineMode: 'mock',
      cardRenderer: new UnconfiguredCardRenderer(),
      cardRendererConfigured: false,
      now,
    });

    expect(payload.ready).toBe(true);
    expect(payload.engine.usable).toBe(false);
  });

  it('still reports usable:true for a fresh healthy mock, without gating the rasterizer', () => {
    const engine = new MockNeuralEngine({});
    expect(isUsable(engine)).toBe(true);

    const payload = blueprintReadiness({
      engine,
      engineMode: 'mock',
      cardRenderer: new UnconfiguredCardRenderer(),
      cardRendererConfigured: false,
    });

    expect(payload.ready).toBe(true);
    expect(payload.engine.usable).toBe(true);
    expect(payload.cardRenderer.id).toBe('card-renderer-unconfigured');
    expect(payload.cardRenderer.configured).toBe(false);
  });
});
