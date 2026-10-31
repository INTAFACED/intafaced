import Fastify from 'fastify';
import { serviceAuthHeadersForBody, SUPPORT_RECORD_OWNERSHIP_PATH } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { registerRecordOwnershipRoute } from './record-ownership.js';

const SECRET = 'internal-secret-for-record-ownership-test';
const USER = '22222222-2222-4222-8222-222222222222';
const RECORD = '11111111-1111-4111-8111-111111111111';
const ask = { kind: 'withdrawal', recordId: RECORD, userId: USER };

async function appFor(owned: boolean, seen: unknown[] = []) {
  const app = Fastify();
  registerRecordOwnershipRoute(app, {
    internalSecret: SECRET,
    owns: async (input) => {
      seen.push(input);
      return owned;
    },
  });
  await app.ready();
  return app;
}

function post(body: unknown, service = 'svc-support') {
  const payload = JSON.stringify(body);
  return {
    method: 'POST' as const,
    url: SUPPORT_RECORD_OWNERSHIP_PATH,
    payload,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) },
  };
}

describe(`POST ${SUPPORT_RECORD_OWNERSHIP_PATH}`, () => {
  it('answers one boolean for the record and user asked, and nothing else', async () => {
    for (const owned of [true, false]) {
      const seen: unknown[] = [];
      const app = await appFor(owned, seen);
      const res = await app.inject(post(ask));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ owned });
      expect(seen).toEqual([ask]);
      await app.close();
    }
  });

  it('refuses an unsigned caller and any service but svc-support, without reading', async () => {
    const seen: unknown[] = [];
    const app = await appFor(true, seen);
    const open = await app.inject({ method: 'POST', url: SUPPORT_RECORD_OWNERSHIP_PATH, payload: ask });
    expect(open.statusCode).toBe(401);
    expect(open.json().error).toBe('pay.unauthenticated');
    for (const caller of ['svc-ledger', 'svc-edge', 'svc-identity']) {
      const other = await app.inject(post(ask, caller));
      expect(other.statusCode).toBe(403);
      expect(other.json().error).toBe('pay.record_ownership_service_forbidden');
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('refuses a malformed question by shape, never by whether the record exists, and reads nothing', async () => {
    const seen: unknown[] = [];
    const app = await appFor(true, seen);
    for (const body of [{}, { ...ask, kind: 'order' }, { ...ask, recordId: 'w-1' }, { ...ask, userId: '' }, { ...ask, amount: '1' }]) {
      const res = await app.inject(post(body));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('pay.record_ownership_invalid');
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('a body changed after signing is refused', async () => {
    const app = await appFor(true);
    const signed = post(ask);
    const res = await app.inject({ ...signed, payload: JSON.stringify({ ...ask, userId: '33333333-3333-4333-8333-333333333333' }) });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
