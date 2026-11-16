import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import {
  createServiceSigner,
  createServiceVerifier,
  serviceAuthHeadersForBody,
  type Keyring,
  type ServiceName,
} from '@intafaced/contracts';
import type { TestAgeSubject } from '@intafaced/service-kit';
import { describe, expect, it } from 'vitest';
import { TEST_AGE_PATH, registerTestAgeDoor } from './test-age-door.js';

const SECRET = 'test-age-door-route-secret-32-chars';
const here = dirname(fileURLToPath(import.meta.url));

function app(open: boolean) {
  const calls: Array<[string, number]> = [];
  const quote: TestAgeSubject = async (id, ms) => {
    calls.push([id, ms]);
    return id === 'q1' ? { expiresAt: '2026-11-17T00:00:00.000Z' } : null;
  };
  const instance = Fastify();
  registerTestAgeDoor(instance, { open, internalSecret: SECRET, subjects: { 'otc-quote': quote } });
  const call = (body: unknown, headers?: Record<string, string>) => {
    const payload = JSON.stringify(body);
    return instance.inject({
      method: 'POST',
      url: TEST_AGE_PATH,
      headers: { 'content-type': 'application/json', ...(headers ?? serviceAuthHeadersForBody('local-test-stack', SECRET, payload)) },
      payload,
    });
  };
  return { call, calls };
}

const AGE = { subject: 'otc-quote', id: 'q1', ms: 60_000 };

describe('the TEST age door route', () => {
  it('closed (not a TEST stack): a signed call is refused by name and ages nothing', async () => {
    const { call, calls } = app(false);
    const answer = await call(AGE);
    expect(answer.statusCode).toBe(403);
    expect(answer.json()).toMatchObject({ error: 'test_age.door_closed' });
    expect(calls).toEqual([]);
  });

  it('open or closed: no service auth, or a body edited after signing, is refused before anything', async () => {
    for (const open of [true, false]) {
      const { call, calls } = app(open);
      expect((await call(AGE, {})).statusCode).toBe(401);
      const signed = serviceAuthHeadersForBody('local-test-stack', SECRET, JSON.stringify({ ...AGE, ms: 1 }));
      expect((await call(AGE, signed)).statusCode).toBe(401);
      expect(calls).toEqual([]);
    }
  });

  it('open: ages the named quote once and answers its new times', async () => {
    const { call, calls } = app(true);
    const answer = await call(AGE);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ ok: true, subject: 'otc-quote', id: 'q1', agedMs: 60_000, expiresAt: '2026-11-17T00:00:00.000Z' });
    expect(calls).toEqual([['q1', 60_000]]);
  });

  it('open: an unknown quote is not found, and a body out of shape is invalid', async () => {
    const { call } = app(true);
    expect((await call({ ...AGE, id: 'q2' })).json()).toMatchObject({ error: 'test_age.not_found' });
    expect((await call({ ...AGE, ms: -1 })).json()).toMatchObject({ error: 'test_age.invalid' });
    expect((await call({ ...AGE, subject: 'fills' })).json()).toMatchObject({ error: 'test_age.invalid' });
  });
});

describe('the TEST age door with service keys', () => {
  /** A fleet where `caller` holds a key, svc-trade verifies, and the door is open. */
  async function keyed(caller: ServiceName) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
    const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
    const keyring: Keyring = [{ kid: `${caller}.a`, svc: caller, use: 's2s', x }];
    const signer = createServiceSigner({ service: caller, kid: `${caller}.a`, privateKey: pkcs8, keyring });
    const calls: string[] = [];
    const instance = Fastify({ logger: false });
    registerTestAgeDoor(instance, {
      open: true,
      internalSecret: SECRET,
      s2s: { verifier: createServiceVerifier({ self: 'svc-trade', keyring, bootSecond: 0 }), mode: 'dual' },
      subjects: {
        'otc-quote': async (id) => {
          calls.push(id);
          return { expiresAt: '2026-11-17T00:00:00.000Z' };
        },
      },
    });
    await instance.ready();
    const payload = JSON.stringify(AGE);
    const headers = signer.headers({
      audience: 'svc-trade',
      method: 'POST',
      url: new URL(`http://trade.test${TEST_AGE_PATH}`),
      body: payload,
      context: { contentType: 'application/json' },
    });
    const answer = await instance.inject({
      method: 'POST',
      url: TEST_AGE_PATH,
      headers: { 'content-type': 'application/json', ...headers },
      payload,
    });
    await instance.close();
    return { status: answer.statusCode, calls };
  }

  it("refuses svc-edge's own key: the edge signs every request it forwards, so its call is a customer's", async () => {
    const edge = await keyed('svc-edge');
    expect(edge.status).toBe(401);
    expect(edge.calls).toEqual([]);
  });

  it('refuses svc-edge naming itself over the shared secret too', async () => {
    const { call, calls } = app(true);
    expect((await call(AGE, serviceAuthHeadersForBody('svc-edge', SECRET, JSON.stringify(AGE)))).statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it("another service's key is a service call, and the open door ages its quote", async () => {
    const ops = await keyed('svc-ops');
    expect(ops.status).toBe(200);
    expect(ops.calls).toEqual(['q1']);
  });
});

describe('index.ts wiring', () => {
  const source = readFileSync(join(here, 'index.ts'), 'utf8');

  it('reads the flag before opening the database, mounts the door once, and opens it only from that read', () => {
    const check = source.indexOf('const testAgeDoor = testAgeDoorOpen(process.env);');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(source.indexOf('postgres(env.DATABASE_URL'));
    expect(source.match(/registerTestAgeDoor\(/g)).toHaveLength(1);
    expect(source).toMatch(/registerTestAgeDoor\(app, \{\n\s+open: testAgeDoor,/);
  });
});
