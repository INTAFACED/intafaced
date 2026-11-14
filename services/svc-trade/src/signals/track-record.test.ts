import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Sql } from 'postgres';
import { retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { registerTrackRecord } from './track-record.js';

const SECRET = 'trade-track-record-secret-at-least-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-12T00:00:00.000Z');

function fakeSql(answer: () => Array<{ n: number; first: Date | null }>): { sql: Sql; seen: unknown[][] } {
  const seen: unknown[][] = [];
  const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    seen.push(values);
    return Promise.resolve(answer());
  }) as unknown as Sql;
  return { sql, seen };
}

async function get(sql: Sql, { service = 'svc-market', secret = SECRET, userId = USER } = {}) {
  const app = Fastify();
  retainRawBody(app);
  registerTrackRecord(app, { sql, secret: SECRET, now: () => NOW });
  const res = await app.inject({
    method: 'GET',
    url: `/internal/track-record/${userId}`,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, secret, '') },
  });
  await app.close();
  return res;
}

describe('GET /internal/track-record/:userId', () => {
  it('answers the fill count and first fill time of that user', async () => {
    const first = new Date('2026-11-01T10:00:00.000Z');
    const { sql, seen } = fakeSql(() => [{ n: 3, first }]);
    const res = await get(sql);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: USER, fills: 3, firstFillAt: first.toISOString(), asOf: NOW.toISOString() });
    expect(seen).toEqual([[USER]]);
  });

  it('answers zero fills and no first fill for a user with none', async () => {
    const { sql } = fakeSql(() => [{ n: 0, first: null }]);
    expect((await get(sql)).json()).toMatchObject({ fills: 0, firstFillAt: null });
  });

  it('refuses a caller other than svc-market, and one without credentials', async () => {
    const { sql, seen } = fakeSql(() => [{ n: 1, first: NOW }]);
    const other = await get(sql, { service: 'svc-identity' });
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('trade.track_record_forbidden');
    const unsigned = await get(sql, { secret: 'another-secret-that-is-at-least-32-chars' });
    expect(unsigned.statusCode).toBe(401);
    expect(seen).toEqual([]);
  });

  it('refuses a malformed user id before reading', async () => {
    const { sql, seen } = fakeSql(() => [{ n: 1, first: NOW }]);
    const res = await get(sql, { userId: 'not-a-user' });
    expect(res.statusCode).toBe(400);
    expect(seen).toEqual([]);
  });

  it('answers 503 when the count cannot be read, never zero', async () => {
    const sql = (() => Promise.reject(new Error('db down'))) as unknown as Sql;
    const res = await get(sql);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('trade.track_record_unavailable');
  });
});
