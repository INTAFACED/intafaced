import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { retainRawBody, serviceAuthHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { TEST_AGE_PATH, registerTestAgeDoor, type TestAgeSubject } from '@intafaced/service-kit';
import { describe, expect, it } from 'vitest';

const SECRET = 'test-age-door-bank-route-secret-32c';
const here = dirname(fileURLToPath(import.meta.url));
const ID = '0b6f6a8e-4d1c-4f7a-9a31-5c2e7d9b1a01';
const AGE = { subject: 'shared-pot-invite', id: ID, ms: 125_000 };

/** svc-bank's app as index.ts builds it: the raw body kept for the whole app, then the door with its subjects. */
async function app(open: boolean) {
  const calls: Array<[string, string, number]> = [];
  const subject =
    (name: string): TestAgeSubject =>
    async (id, ms) => {
      calls.push([name, id, ms]);
      return id === ID ? { expiresAt: '2026-11-17T00:00:00.000Z' } : null;
    };
  const instance = Fastify({ logger: false });
  retainRawBody(instance);
  registerTestAgeDoor(instance, {
    open,
    internalSecret: SECRET,
    subjects: { 'shared-pot-invite': subject('shared-pot-invite'), 'business-invite': subject('business-invite') },
    installRawBody: false,
  });
  await instance.ready();
  const call = (body: unknown, headers?: Record<string, string>) => {
    const payload = JSON.stringify(body);
    return instance.inject({
      method: 'POST',
      url: TEST_AGE_PATH,
      headers: { 'content-type': 'application/json', ...(headers ?? serviceAuthHeadersForBody('local-test-stack', SECRET, payload)) },
      payload,
    });
  };
  return { call, calls, close: () => instance.close() };
}

describe("svc-bank's TEST age door", () => {
  it('closed (not a TEST stack): a signed call is refused by name and ages nothing', async () => {
    const { call, calls, close } = await app(false);
    const answer = await call(AGE);
    expect(answer.statusCode).toBe(403);
    expect(answer.json()).toMatchObject({ error: 'test_age.door_closed' });
    expect(calls).toEqual([]);
    await close();
  });

  it('open: ages the named invite once; unsigned, a v1 signature, edited after signing, or svc-edge, ages nothing', async () => {
    const { call, calls, close } = await app(true);
    expect((await call(AGE, {})).statusCode).toBe(401);
    expect((await call(AGE, serviceAuthHeaders('local-test-stack', SECRET))).statusCode).toBe(401);
    expect((await call(AGE, serviceAuthHeadersForBody('local-test-stack', SECRET, JSON.stringify({ ...AGE, ms: 1 })))).statusCode).toBe(
      401,
    );
    expect((await call(AGE, serviceAuthHeadersForBody('svc-edge', SECRET, JSON.stringify(AGE)))).statusCode).toBe(401);
    expect(calls).toEqual([]);
    expect((await call(AGE)).json()).toEqual({
      ok: true,
      subject: 'shared-pot-invite',
      id: ID,
      agedMs: 125_000,
      expiresAt: '2026-11-17T00:00:00.000Z',
    });
    expect((await call({ ...AGE, subject: 'business-invite' })).statusCode).toBe(200);
    expect((await call({ ...AGE, subject: 'loan' })).json()).toMatchObject({ error: 'test_age.invalid' });
    expect(calls).toEqual([
      ['shared-pot-invite', ID, 125_000],
      ['business-invite', ID, 125_000],
    ]);
    await close();
  });
});

describe('index.ts wiring', () => {
  const source = readFileSync(join(here, 'index.ts'), 'utf8');

  it('reads the flag before opening the database, mounts the door once after the raw body is kept, and opens it only from that read', () => {
    const check = source.indexOf('const testAgeDoor = testAgeDoorOpen(process.env);');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(source.indexOf('postgres(env.DATABASE_URL'));
    expect(source.match(/registerTestAgeDoor\(/g)).toHaveLength(1);
    expect(source.indexOf('retainRawBody(app);')).toBeLessThan(source.indexOf('registerTestAgeDoor(app'));
    expect(source).toMatch(/registerTestAgeDoor\(app, \{\n\s+open: testAgeDoor,/);
    expect(source).toMatch(/'shared-pot-invite': ageSharedPotInvite\(sql\), 'business-invite': ageBusinessInvite\(sql\)/);
  });
});
