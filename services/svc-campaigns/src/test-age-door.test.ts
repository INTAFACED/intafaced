import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { rawBodyOf, serviceAuthHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { TEST_AGE_PATH, registerTestAgeDoor, type TestAgeSubject } from '@intafaced/service-kit';
import { describe, expect, it } from 'vitest';

const SECRET = 'test-age-door-campaigns-secret-32c';
const here = dirname(fileURLToPath(import.meta.url));
const AGE = { subject: 'reward', id: 'task:c1:a1:once', ms: 61_000 };

/** svc-campaigns' app as index.ts builds it: the door in its own scope, and a JSON route beside it. */
async function app(open: boolean) {
  const calls: Array<[string, number]> = [];
  const reward: TestAgeSubject = async (id, ms) => {
    calls.push([id, ms]);
    return id === AGE.id ? { state: 'held', holdUntil: '2026-11-17T00:00:00.000Z' } : null;
  };
  const instance = Fastify({ logger: false });
  await instance.register(async (scope) => {
    registerTestAgeDoor(scope, { open, internalSecret: SECRET, subjects: { reward } });
  });
  instance.post('/beside', async (req) => ({ body: req.body, raw: rawBodyOf(req).retained }));
  await instance.ready();
  const call = (url: string, body: unknown, headers?: Record<string, string>) => {
    const payload = JSON.stringify(body);
    return instance.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', ...(headers ?? serviceAuthHeadersForBody('local-test-stack', SECRET, payload)) },
      payload,
    });
  };
  return { call, calls, close: () => instance.close() };
}

describe("svc-campaigns' TEST age door", () => {
  it('closed (not a TEST stack): a signed call is refused by name and ages nothing', async () => {
    const { call, calls, close } = await app(false);
    const answer = await call(TEST_AGE_PATH, AGE);
    expect(answer.statusCode).toBe(403);
    expect(answer.json()).toMatchObject({ error: 'test_age.door_closed' });
    expect(calls).toEqual([]);
    await close();
  });

  it('open: ages the named reward once; unsigned, edited after signing, or signed as svc-edge, ages nothing', async () => {
    const { call, calls, close } = await app(true);
    expect((await call(TEST_AGE_PATH, AGE, {})).statusCode).toBe(401);
    const edited = serviceAuthHeadersForBody('local-test-stack', SECRET, JSON.stringify({ ...AGE, ms: 1 }));
    expect((await call(TEST_AGE_PATH, AGE, edited)).statusCode).toBe(401);
    // A v1 signature binds no body, so it could carry any body: the door requires the body-bound form.
    expect((await call(TEST_AGE_PATH, AGE, serviceAuthHeaders('local-test-stack', SECRET))).statusCode).toBe(401);
    const edge = serviceAuthHeadersForBody('svc-edge', SECRET, JSON.stringify(AGE));
    expect((await call(TEST_AGE_PATH, AGE, edge)).json()).toMatchObject({ error: 'test_age.unauthenticated' });
    expect(calls).toEqual([]);
    const answer = await call(TEST_AGE_PATH, AGE);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({
      ok: true,
      subject: 'reward',
      id: AGE.id,
      agedMs: 61_000,
      state: 'held',
      holdUntil: '2026-11-17T00:00:00.000Z',
    });
    expect(calls).toEqual([[AGE.id, 61_000]]);
    expect((await call(TEST_AGE_PATH, { ...AGE, id: 'task:none' })).json()).toMatchObject({ error: 'test_age.not_found' });
    await close();
  });

  it("keeps the raw body for the door's route only: a route beside it reads JSON as before", async () => {
    const { call, close } = await app(true);
    const beside = await call('/beside', { a: 1 }, {});
    expect(beside.statusCode).toBe(200);
    expect(beside.json()).toEqual({ body: { a: 1 }, raw: false });
    await close();
  });
});

describe('index.ts wiring', () => {
  const source = readFileSync(join(here, 'index.ts'), 'utf8');

  it('reads the flag before opening the database, mounts the door once in its own scope, and opens it only from that read', () => {
    const check = source.indexOf('const testAgeDoor = testAgeDoorOpen(process.env);');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(source.indexOf('postgres(env.DATABASE_URL'));
    expect(source.match(/registerTestAgeDoor\(/g)).toHaveLength(1);
    expect(source).toMatch(/await app\.register\(async \(scope\) => \{\n\s+registerTestAgeDoor\(scope, \{\n\s+open: testAgeDoor,/);
    expect(source).toMatch(/subjects: \{ reward: ageReward\(sql\), distribution: ageDistributionRun\(sql\) \}/);
    // The TEST pay-fault door opens only from the same read, behind a signed call.
    expect(source).toMatch(/if \(!testAgeDoor\) \{\n\s+return reply\n\s+\.code\(403\)/);
    expect(source).not.toMatch(/retainRawBody\(app\)/);
  });
});
