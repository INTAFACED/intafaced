import { generateKeyPairSync } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  createServiceSigner,
  createServiceVerifier,
  serviceAuthHeadersForBody,
  type Keyring,
  type ServiceAuthMode,
  type ServiceName,
} from '@intafaced/contracts';
import { registerOmsOcoDoor } from './oms-oco-http.js';
import { installOmsWriteRawBody } from './oms-write-hmac.js';

/**
 * The OMS write doors name the caller from its own service key once S2S is on. Keys here are generated per run.
 */
const SECRET = 'a'.repeat(32);
const edgeContext = createEdgeContext({ secret: 'an-execution-oms-keys-test-edge-secret', serviceName: 'svc-execution' });
const PATH = '/execution/oms/oco';
const BODY = '{"oco":true}';

function keyFor(service: ServiceName) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  return { pkcs8, entry: { kid: `${service}.a`, svc: service, use: 's2s' as const, x } };
}

function fleet() {
  const execution = keyFor('svc-execution');
  const trade = keyFor('svc-trade');
  const keyring: Keyring = [execution.entry, trade.entry];
  const signer = (service: ServiceName, k: ReturnType<typeof keyFor>) =>
    createServiceSigner({ service, kid: k.entry.kid, privateKey: k.pkcs8, keyring });
  return {
    execution: signer('svc-execution', execution),
    trade: signer('svc-trade', trade),
    verifier: () => createServiceVerifier({ self: 'svc-execution', keyring }),
  };
}

async function door(mode?: ServiceAuthMode, verifier?: ReturnType<ReturnType<typeof fleet>['verifier']>) {
  const app = Fastify();
  installOmsWriteRawBody(app);
  registerOmsOcoDoor(app, { edgeContext, internalSecret: SECRET, ...(verifier && mode ? { s2s: { verifier, mode } } : {}) });
  await app.ready();
  return app;
}

const keyed = (signer: ReturnType<typeof fleet>['execution'], audience: 'svc-execution' | 'svc-ledger' = 'svc-execution') => ({
  'content-type': 'application/json',
  ...signer.headers({
    audience,
    method: 'POST',
    url: new URL(`http://execution.test${PATH}`),
    body: BODY,
    context: { contentType: 'application/json' },
  }),
});
const shared = () => ({
  'content-type': 'application/json',
  ...serviceAuthHeadersForBody('svc-execution', SECRET, BODY),
});
const post = (app: Awaited<ReturnType<typeof door>>, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: PATH, headers, payload: BODY });

describe('svc-execution OMS write doors with service keys', () => {
  it('without S2S configured, a key-signed call is not a service call and the shared secret works as before', async () => {
    const f = fleet();
    const app = await door();
    expect((await post(app, keyed(f.execution))).statusCode).toBe(401);
    expect((await post(app, shared())).statusCode).toBe(200);
    await app.close();
  });

  it('dual: accepts the key and the shared secret', async () => {
    const f = fleet();
    const app = await door('dual', f.verifier());
    expect((await post(app, keyed(f.execution))).statusCode).toBe(200);
    expect((await post(app, shared())).statusCode).toBe(200);
    await app.close();
  });

  it('keypair: accepts the key and refuses the shared secret', async () => {
    const f = fleet();
    const app = await door('keypair', f.verifier());
    expect((await post(app, keyed(f.execution))).statusCode).toBe(200);
    expect((await post(app, shared())).statusCode).toBe(401);
    await app.close();
  });

  it('only a call named svc-execution by its key writes; another service key is 403', async () => {
    const f = fleet();
    const app = await door('keypair', f.verifier());
    expect((await post(app, keyed(f.trade))).statusCode).toBe(403);
    await app.close();
  });

  it('refuses a key-signed call meant for another service, and a replayed one', async () => {
    const f = fleet();
    const app = await door('keypair', f.verifier());
    expect((await post(app, keyed(f.execution, 'svc-ledger'))).statusCode).toBe(401);
    const once = keyed(f.execution);
    expect((await post(app, once)).statusCode).toBe(200);
    expect((await post(app, once)).statusCode).toBe(401);
    await app.close();
  });
});
