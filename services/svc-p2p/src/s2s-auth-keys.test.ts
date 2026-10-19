import { generateKeyPairSync } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  createServiceSigner,
  createServiceVerifier,
  serviceAuthHeadersForBody,
  type Keyring,
  type ServiceAuthMode,
  type ServiceName,
} from '@intafaced/contracts';
import { installP2pS2sRawBody, p2pInternalServiceOf } from './s2s-auth.js';

/**
 * The p2p internal doors name the caller from its own service key once S2S is on. Keys here are generated per run.
 */
const SECRET = 'p2p-s2s-keys-test-secret-32chars!';
const PATH = '/internal/ping';

function keyFor(service: ServiceName) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  return { pkcs8, entry: { kid: `${service}.a`, svc: service, use: 's2s' as const, x } };
}

function fleet() {
  const ops = keyFor('svc-ops');
  const keyring: Keyring = [ops.entry];
  return {
    ops: createServiceSigner({ service: 'svc-ops', kid: ops.entry.kid, privateKey: ops.pkcs8, keyring }),
    verifier: () => createServiceVerifier({ self: 'svc-p2p', keyring }),
  };
}

async function mount(mode?: ServiceAuthMode, verifier?: ReturnType<ReturnType<typeof fleet>['verifier']>) {
  const app = Fastify({ logger: false });
  installP2pS2sRawBody(app);
  app.get(PATH, async (req, reply) => {
    const service = p2pInternalServiceOf(req, SECRET, 'require', verifier && mode ? { verifier, mode } : undefined);
    if (service === null) return reply.code(401).send({ code: 'p2p.unauthenticated' });
    return { ok: true, service };
  });
  await app.ready();
  return app;
}

const keyed = (signer: ReturnType<typeof fleet>['ops'], audience: 'svc-p2p' | 'svc-ledger' = 'svc-p2p') =>
  signer.headers({ audience, method: 'GET', url: new URL(`http://p2p.test${PATH}`), body: undefined });
const shared = () => serviceAuthHeadersForBody('svc-ops', SECRET, '');

describe('p2p internal doors with service keys', () => {
  it('without S2S configured, a key-signed call is not a service call and the shared secret works as before', async () => {
    const f = fleet();
    const app = await mount();
    expect((await app.inject({ method: 'GET', url: PATH, headers: keyed(f.ops) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: PATH, headers: shared() })).statusCode).toBe(200);
    await app.close();
  });

  it('dual: accepts the key and the shared secret, naming the caller from the key', async () => {
    const f = fleet();
    const app = await mount('dual', f.verifier());
    const res = await app.inject({ method: 'GET', url: PATH, headers: keyed(f.ops) });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toBe('svc-ops');
    expect((await app.inject({ method: 'GET', url: PATH, headers: shared() })).statusCode).toBe(200);
    await app.close();
  });

  it('keypair: accepts the key and refuses the shared secret', async () => {
    const f = fleet();
    const app = await mount('keypair', f.verifier());
    expect((await app.inject({ method: 'GET', url: PATH, headers: keyed(f.ops) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: PATH, headers: shared() })).statusCode).toBe(401);
    await app.close();
  });

  it('refuses a key-signed call meant for another service, and a replayed one', async () => {
    const f = fleet();
    const app = await mount('keypair', f.verifier());
    expect((await app.inject({ method: 'GET', url: PATH, headers: keyed(f.ops, 'svc-ledger') })).statusCode).toBe(401);
    const once = keyed(f.ops);
    expect((await app.inject({ method: 'GET', url: PATH, headers: once })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: PATH, headers: once })).statusCode).toBe(401);
    await app.close();
  });
});
