import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createServiceSigner,
  createServiceVerifier,
  serviceAuthHeaders,
  serviceAuthHeadersForBody,
  type Keyring,
  type ServiceName,
} from '@intafaced/contracts';
import { coachSpineIsComplete, coachSpinePayload } from './coach-spine.js';
import { registerInternalCurriculumRoute } from './internal-curriculum.js';

const SECRET = 'academy-internal-curriculum-test-secret-32ch';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('GET /internal/curriculum', () => {
  it('refuses unsigned callers and serves the spine with body-bound service HMAC', async () => {
    const app = Fastify();
    registerInternalCurriculumRoute(app, SECRET);
    await app.ready();

    const bare = await app.inject({ method: 'GET', url: '/internal/curriculum' });
    expect(bare.statusCode).toBe(401);
    expect(bare.json()).toMatchObject({ code: 'academy.unauthenticated' });

    const ok = await app.inject({
      method: 'GET',
      url: '/internal/curriculum',
      headers: serviceAuthHeadersForBody('svc-agents', SECRET, ''),
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as ReturnType<typeof coachSpinePayload>;
    expect(coachSpineIsComplete(body)).toBe(true);
    expect(body.licensedLibraryImported).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/"body"/);

    const mismatch = await app.inject({
      method: 'GET',
      url: '/internal/curriculum',
      headers: serviceAuthHeadersForBody('svc-agents', SECRET, '{"not":"empty"}'),
    });
    expect(mismatch.statusCode).toBe(401);

    await app.close();
  });

  it('require mode 401s a v1 caller that did not bind the empty body', async () => {
    const app = Fastify();
    registerInternalCurriculumRoute(app, SECRET, 'require');
    await app.ready();
    const v1 = await app.inject({
      method: 'GET',
      url: '/internal/curriculum',
      headers: serviceAuthHeaders('svc-agents', SECRET),
    });
    expect(v1.statusCode).toBe(401);
    await app.close();
  });

  it('index mounts the internal curriculum door', () => {
    const index = readFileSync(join(ROOT, 'services/svc-academy/src/index.ts'), 'utf8');
    expect(index).toMatch(/registerInternalCurriculumRoute/);
    expect(index).toMatch(/INTERNAL_SERVICE_SECRET/);
    expect(index).toMatch(/INTERNAL_SERVICE_BODY_BIND/);
    expect(index).toMatch(/s2sFromEnv\(env, 'svc-academy'\)/);
  });
});

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  };
}

/** Real generated keys for the callers, and the receiver's verifier built from the public keyring only. */
function kit() {
  const callers: ServiceName[] = ['svc-agents', 'svc-trade'];
  const keys = callers.map((svc) => ({ svc, ...pair() }));
  const keyring: Keyring = keys.map((k) => ({ kid: `${k.svc}.a`, svc: k.svc, use: 's2s' as const, x: k.x }));
  const signer = (svc: ServiceName, ring: Keyring = keyring, privateKey = keys.find((k) => k.svc === svc)!.privateKey) =>
    createServiceSigner({ service: svc, kid: `${svc}.a`, privateKey, keyring: ring });
  const verifier = () => createServiceVerifier({ self: 'svc-academy', keyring });
  return { keys, keyring, signer, verifier };
}

const TARGET = 'http://svc-academy.internal/internal/curriculum';

async function mounted(mode: 'dual' | 'keypair' | undefined, k = kit()) {
  const app = Fastify();
  registerInternalCurriculumRoute(app, SECRET, 'require', mode ? { verifier: k.verifier(), mode } : undefined);
  await app.ready();
  const get = (headers: Record<string, string>, url = '/internal/curriculum') => app.inject({ method: 'GET', url, headers });
  return { app, get, k };
}

describe('GET /internal/curriculum with per-service keys', () => {
  for (const mode of ['dual', 'keypair'] as const) {
    it(`${mode}: serves a call signed by svc-agents' own key`, async () => {
      const { app, get, k } = await mounted(mode);
      const res = await get(k.signer('svc-agents').headers({ audience: 'svc-academy', method: 'GET', url: new URL(TARGET), body: '' }));
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  }

  it('refuses a replay of the same signed call', async () => {
    const { app, get, k } = await mounted('keypair');
    const headers = k.signer('svc-agents').headers({ audience: 'svc-academy', method: 'GET', url: new URL(TARGET), body: '' });
    expect((await get(headers)).statusCode).toBe(200);
    expect((await get(headers)).statusCode).toBe(401);
    await app.close();
  });

  it('refuses a call signed for another audience', async () => {
    const { app, get, k } = await mounted('keypair');
    const res = await get(k.signer('svc-agents').headers({ audience: 'svc-bank', method: 'GET', url: new URL(TARGET), body: '' }));
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('refuses a tampered path or query', async () => {
    const { app, get, k } = await mounted('keypair');
    const headers = k.signer('svc-agents').headers({ audience: 'svc-academy', method: 'GET', url: new URL(`${TARGET}?lang=en`), body: '' });
    expect((await get(headers, '/internal/curriculum?lang=fr')).statusCode).toBe(401);
    await app.close();
  });

  it('refuses a key that is not in the keyring (wrong key for a listed kid)', async () => {
    const { app, get, k } = await mounted('keypair');
    const stranger = pair();
    const forged = createServiceSigner({
      service: 'svc-agents',
      kid: 'svc-agents.a',
      privateKey: stranger.privateKey,
      keyring: [{ kid: 'svc-agents.a', svc: 'svc-agents', use: 's2s', x: stranger.x }],
    });
    const res = await get(forged.headers({ audience: 'svc-academy', method: 'GET', url: new URL(TARGET), body: '' }));
    expect(res.statusCode).toBe(401);
    expect(k.keyring).toHaveLength(2);
    await app.close();
  });

  it('refuses a caller that is not on the door list, even with a valid key', async () => {
    const { app, get, k } = await mounted('keypair');
    const res = await get(k.signer('svc-trade').headers({ audience: 'svc-academy', method: 'GET', url: new URL(TARGET), body: '' }));
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('dual: the shared secret still works for svc-agents, but not for a service off the door list', async () => {
    const { app, get } = await mounted('dual');
    expect((await get(serviceAuthHeadersForBody('svc-agents', SECRET, ''))).statusCode).toBe(200);
    expect((await get(serviceAuthHeadersForBody('svc-trade', SECRET, ''))).statusCode).toBe(401);
    await app.close();
  });

  it('keypair: refuses the shared secret', async () => {
    const { app, get } = await mounted('keypair');
    expect((await get(serviceAuthHeadersForBody('svc-agents', SECRET, ''))).statusCode).toBe(401);
    await app.close();
  });

  it('dual: a bad key signature beside a valid shared signature is refused, never falling back', async () => {
    const { app, get, k } = await mounted('dual');
    const stranger = pair();
    const forged = createServiceSigner({
      service: 'svc-agents',
      kid: 'svc-agents.a',
      privateKey: stranger.privateKey,
      keyring: [{ kid: 'svc-agents.a', svc: 'svc-agents', use: 's2s', x: stranger.x }],
    });
    const headers = {
      ...forged.headers({ audience: 'svc-academy', method: 'GET', url: new URL(TARGET), body: '' }),
      ...serviceAuthHeadersForBody('svc-agents', SECRET, ''),
    };
    expect((await get(headers)).statusCode).toBe(401);
    expect(k.keyring).toHaveLength(2);
    await app.close();
  });

  it('without a verifier the door is exactly the shared-secret door, and an off-list name is now refused', async () => {
    const { app, get } = await mounted(undefined);
    expect((await get(serviceAuthHeadersForBody('svc-agents', SECRET, ''))).statusCode).toBe(200);
    expect((await get(serviceAuthHeadersForBody('svc-trade', SECRET, ''))).statusCode).toBe(401);
    await app.close();
  });
});
