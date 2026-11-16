import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
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
