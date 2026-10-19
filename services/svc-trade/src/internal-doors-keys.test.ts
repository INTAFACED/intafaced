import { generateKeyPairSync } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  createServiceSigner,
  createServiceVerifier,
  serviceAuthHeadersForBody,
  type Keyring,
  type ServiceAuthMode,
  type ServiceName,
} from '@intafaced/contracts';
import { registerMarketLifecycleRoutes } from './market-lifecycle-routes.js';

/**
 * svc-trade's internal doors name the caller from its own service key once S2S is on.
 * Keys are generated here; the verifier is the contracts verifier svc-trade boots with.
 */
const SECRET = 'trade-internal-doors-test-secret-0123456789abcdef';
const MARKET = '11111111-1111-4111-8111-111111111111';
const URL_PATH = `/internal/market-lifecycle/${MARKET}`;

function keyFor(service: ServiceName) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  return { pkcs8, entry: { kid: `${service}.a`, svc: service, use: 's2s' as const, x } };
}

function fleet() {
  const caller = keyFor('svc-ops');
  const keyring: Keyring = [caller.entry];
  return {
    signer: createServiceSigner({ service: 'svc-ops', kid: caller.entry.kid, privateKey: caller.pkcs8, keyring }),
    verifier: () => createServiceVerifier({ self: 'svc-trade', keyring }),
  };
}

async function door(mode?: ServiceAuthMode) {
  const f = fleet();
  const app = Fastify({ logger: false });
  const readLatest = vi.fn(async () => null);
  registerMarketLifecycleRoutes(app, {
    internalSecret: SECRET,
    store: { publish: vi.fn(), readLatest, appendCorrection: vi.fn() } as never,
    ...(mode ? { s2s: { verifier: f.verifier(), mode } } : {}),
  });
  await app.ready();
  return { app, f, readLatest };
}

const keyed = (f: ReturnType<typeof fleet>, audience: ServiceName = 'svc-trade') =>
  f.signer.headers({ audience, method: 'GET', url: new URL(`http://trade.test${URL_PATH}`), body: undefined });
const shared = () => serviceAuthHeadersForBody('svc-ops', SECRET, '');
const get = (app: Awaited<ReturnType<typeof door>>['app'], headers: Record<string, string>) =>
  app.inject({ method: 'GET', url: URL_PATH, headers });

describe('svc-trade market lifecycle door with service keys', () => {
  it('without S2S configured a key-signed call is not a service call, and the shared secret works as before', async () => {
    const { app, f } = await door();
    expect((await get(app, keyed(f))).statusCode).toBe(401);
    expect((await get(app, shared())).statusCode).toBe(404);
    await app.close();
  });

  it('dual: accepts the key and the shared secret', async () => {
    const { app, f } = await door('dual');
    expect((await get(app, keyed(f))).statusCode).toBe(404);
    expect((await get(app, shared())).statusCode).toBe(404);
    await app.close();
  });

  it('keypair: accepts the key, refuses the shared secret, a wrong audience and a replay', async () => {
    const { app, f, readLatest } = await door('keypair');
    expect((await get(app, shared())).statusCode).toBe(401);
    expect((await get(app, keyed(f, 'svc-ledger'))).statusCode).toBe(401);
    expect(readLatest).not.toHaveBeenCalled();
    const once = keyed(f);
    expect((await get(app, once)).statusCode).toBe(404);
    expect((await get(app, once)).statusCode).toBe(401);
    await app.close();
  });
});
