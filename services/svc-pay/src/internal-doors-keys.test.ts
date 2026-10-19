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
import { registerCaptureReconcileRoutes } from './capture-reconcile-routes.js';
import { registerSubscriptionCycleRoutes } from './subscriptions/internal-cycle-routes.js';

/**
 * svc-pay's internal doors name the caller from its own service key once S2S is on.
 * Keys are generated here; the verifier is the contracts verifier svc-pay boots with.
 */
const SECRET = 'pay-internal-doors-test-secret-0123456789abcdef';
const CAPTURE = '/internal/jobs/reconcile-authorized-captures';
const BODY = '{"limit":10}';

function keyFor(service: ServiceName) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  return { pkcs8, entry: { kid: `${service}.a`, svc: service, use: 's2s' as const, x } };
}

function fleet() {
  const scheduler = keyFor('svc-ops');
  const keyring: Keyring = [scheduler.entry];
  return {
    signer: createServiceSigner({ service: 'svc-ops', kid: scheduler.entry.kid, privateKey: scheduler.pkcs8, keyring }),
    verifier: () => createServiceVerifier({ self: 'svc-pay', keyring }),
  };
}

async function captureDoor(mode?: ServiceAuthMode, f = fleet()) {
  const app = Fastify({ logger: false });
  const reconcile = vi.fn(async () => ({ scanned: 0 }));
  registerCaptureReconcileRoutes(app, {
    internalSecret: SECRET,
    pay: { reconcileAuthorizedCaptures: reconcile } as never,
    mode: 'required',
    ...(mode ? { s2s: { verifier: f.verifier(), mode } } : {}),
  });
  await app.ready();
  return { app, f, reconcile };
}

const keyed = (f: ReturnType<typeof fleet>, audience: ServiceName = 'svc-pay') =>
  ({
    'content-type': 'application/json',
    ...f.signer.headers({
      audience,
      method: 'POST',
      url: new URL(`http://pay.test${CAPTURE}`),
      body: BODY,
      context: { contentType: 'application/json' },
    }),
  }) as Record<string, string>;
const shared = () => ({ 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-ops', SECRET, BODY) });
const post = (app: Awaited<ReturnType<typeof captureDoor>>['app'], headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: CAPTURE, headers, payload: BODY });

describe('svc-pay capture reconcile door with service keys', () => {
  it('without S2S configured a key-signed call is not a service call, and the shared secret works as before', async () => {
    const { app, f } = await captureDoor();
    expect((await post(app, keyed(f))).statusCode).toBe(401);
    expect((await post(app, shared())).statusCode).toBe(200);
    await app.close();
  });

  it('dual: accepts the key and the shared secret', async () => {
    const { app, f } = await captureDoor('dual');
    expect((await post(app, keyed(f))).statusCode).toBe(200);
    expect((await post(app, shared())).statusCode).toBe(200);
    await app.close();
  });

  it('keypair: accepts the key, refuses the shared secret, a wrong audience and a replay', async () => {
    const { app, f, reconcile } = await captureDoor('keypair');
    expect((await post(app, shared())).statusCode).toBe(401);
    expect((await post(app, keyed(f, 'svc-ledger'))).statusCode).toBe(401);
    expect(reconcile).not.toHaveBeenCalled();
    const once = keyed(f);
    expect((await post(app, once)).statusCode).toBe(200);
    expect((await post(app, once)).statusCode).toBe(401);
    await app.close();
  });
});

describe('svc-pay subscription cycle doors with service keys', () => {
  it('the journal read accepts the key in keypair mode and refuses the shared secret', async () => {
    const f = fleet();
    const app = Fastify({ logger: false });
    registerSubscriptionCycleRoutes(app, {
      internalSecret: SECRET,
      subscriptions: { runDueSubscriptions: vi.fn(), listCycles: vi.fn(async () => []) } as never,
      s2s: { verifier: f.verifier(), mode: 'keypair' },
    });
    await app.ready();
    const url = '/internal/subscriptions/11111111-1111-4111-8111-111111111111/cycles?limit=10';
    const headers = f.signer.headers({ audience: 'svc-pay', method: 'GET', url: new URL(`http://pay.test${url}`), body: undefined });
    expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url, headers: serviceAuthHeadersForBody('svc-ops', SECRET, '') })).statusCode).toBe(401);
    await app.close();
  });
});
