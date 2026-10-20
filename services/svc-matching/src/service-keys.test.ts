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
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { registerRoutes } from './router.js';

/**
 * The matching doors name the caller from its own service key once S2S is on. Keys here are generated per run.
 */
const SECRET = 'matching-service-keys-test-secret-32';
const URL_PATH = '/surveillance/cases?limit=2';

function keyFor(service: ServiceName) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  return { pkcs8, entry: { kid: `${service}.a`, svc: service, use: 's2s' as const, x } };
}

function fleet() {
  const trade = keyFor('svc-trade');
  const pay = keyFor('svc-pay');
  const keyring: Keyring = [trade.entry, pay.entry];
  const signer = (service: ServiceName, k: ReturnType<typeof keyFor>) =>
    createServiceSigner({ service, kid: k.entry.kid, privateKey: k.pkcs8, keyring });
  return {
    trade: signer('svc-trade', trade),
    pay: signer('svc-pay', pay),
    verifier: () => createServiceVerifier({ self: 'svc-matching', keyring, bootSecond: 0 }),
  };
}

async function mount(mode?: ServiceAuthMode, verifier?: ReturnType<ReturnType<typeof fleet>['verifier']>) {
  const engine = new MatchingEngine({ journal: new MemoryJournal(), bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
  const app = Fastify({ logger: false });
  registerRoutes(app, engine, SECRET, { bodyBind: 'require', ...(verifier && mode ? { s2s: { verifier, mode } } : {}) });
  await app.ready();
  return app;
}

const keyed = (signer: ReturnType<typeof fleet>['trade'], audience: 'svc-matching' | 'svc-ledger' = 'svc-matching') =>
  signer.headers({ audience, method: 'GET', url: new URL(`http://matching.test${URL_PATH}`), body: undefined });
const shared = () => serviceAuthHeadersForBody('svc-trade', SECRET, '');
const get = (app: Awaited<ReturnType<typeof mount>>, headers: Record<string, string>) =>
  app.inject({ method: 'GET', url: URL_PATH, headers });

describe('svc-matching doors with service keys', () => {
  it('without S2S configured, a key-signed call is not a service call and the shared secret works as before', async () => {
    const f = fleet();
    const app = await mount();
    expect((await get(app, keyed(f.trade))).statusCode).toBe(401);
    expect((await get(app, shared())).statusCode).toBe(200);
    await app.close();
  });

  it('dual: accepts the key and the shared secret', async () => {
    const f = fleet();
    const app = await mount('dual', f.verifier());
    expect((await get(app, keyed(f.trade))).statusCode).toBe(200);
    expect((await get(app, shared())).statusCode).toBe(200);
    await app.close();
  });

  it('keypair: accepts the key and refuses the shared secret', async () => {
    const f = fleet();
    const app = await mount('keypair', f.verifier());
    expect((await get(app, keyed(f.trade))).statusCode).toBe(200);
    expect((await get(app, shared())).statusCode).toBe(401);
    await app.close();
  });

  it('a service key outside the allowed callers is 403', async () => {
    const f = fleet();
    const app = await mount('keypair', f.verifier());
    expect((await get(app, keyed(f.pay))).statusCode).toBe(403);
    await app.close();
  });

  it('refuses a key-signed call meant for another service, and a replayed one', async () => {
    const f = fleet();
    const app = await mount('keypair', f.verifier());
    expect((await get(app, keyed(f.trade, 'svc-ledger'))).statusCode).toBe(401);
    const once = keyed(f.trade);
    expect((await get(app, once)).statusCode).toBe(200);
    expect((await get(app, once)).statusCode).toBe(401);
    await app.close();
  });
});
