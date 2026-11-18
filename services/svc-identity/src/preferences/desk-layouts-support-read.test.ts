import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Sql } from 'postgres';
import {
  retainRawBody,
  serviceAuthHeadersForBody,
  supportDeskLayoutsPath,
  supportDeskLayoutsReadSchema,
  type SupportDeskLayoutsRead,
} from '@intafaced/contracts';
import { deskLayoutsFor, registerSupportDeskLayoutsRoute } from './desk-layouts-support-read.js';

/** svc-support's read of one account's saved desk layouts (J-charts-desk-19 #1): who may ask, and what "none" reads as. */

const SECRET = 'd'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const LAYOUT = {
  id: 'scalp',
  name: 'TEST scalp',
  symbol: 'BTC/USDT',
  interval: '1m',
  desk: { v: 1, preset: 'classic', order: ['markets', 'chart', 'book', 'trades'], widths: {} },
  savedAt: '2026-11-18T10:00:00.000Z',
} as const;

/** A tagged-template stand-in that answers every query with `rows`. */
const sqlAnswering = (rows: unknown[]) => (async () => rows) as unknown as Sql;

async function app(read: (userId: string) => Promise<SupportDeskLayoutsRead>) {
  const server = Fastify({ logger: false });
  retainRawBody(server);
  registerSupportDeskLayoutsRoute(server, { read, internalSecret: SECRET });
  await server.ready();
  return server;
}

const get = (userId: string, service = 'svc-support') => ({
  method: 'GET' as const,
  url: supportDeskLayoutsPath(userId),
  headers: serviceAuthHeadersForBody(service, SECRET, ''),
});

describe('GET /internal/desk-layouts/:userId', () => {
  it('answers svc-support with the account’s layouts and the one in use', async () => {
    const asked: string[] = [];
    const server = await app(async (userId) => {
      asked.push(userId);
      return { userId, layouts: [LAYOUT], active: 'scalp' };
    });
    const res = await server.inject(get(USER));
    expect(res.statusCode).toBe(200);
    expect(supportDeskLayoutsReadSchema.parse(res.json())).toEqual({ userId: USER, layouts: [LAYOUT], active: 'scalp' });
    expect(asked).toEqual([USER]);
  });

  it('needs service credentials, refuses every service but svc-support, and refuses a malformed id', async () => {
    const asked: string[] = [];
    const server = await app(async (userId) => {
      asked.push(userId);
      return { userId, layouts: [], active: null };
    });
    expect((await server.inject({ method: 'GET', url: supportDeskLayoutsPath(USER) })).statusCode).toBe(401);
    for (const other of ['svc-trade', 'svc-notify', 'svc-edge']) {
      const res = await server.inject(get(USER, other));
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('identity.desk_layouts_reader_refused');
    }
    expect((await server.inject(get('not-a-user'))).statusCode).toBe(400);
    expect(asked).toEqual([]);
  });
});

describe('deskLayoutsFor', () => {
  it('an account with no layout row has no saved layouts, not an error', async () => {
    expect(await deskLayoutsFor(sqlAnswering([]), USER)).toEqual({ userId: USER, layouts: [], active: null });
  });

  it('reads the stored value, and refuses one that is no longer the shape', async () => {
    const value = { layouts: [LAYOUT], active: 'scalp', deleted: [] };
    expect(await deskLayoutsFor(sqlAnswering([{ value }]), USER)).toEqual({ userId: USER, layouts: [LAYOUT], active: 'scalp' });
    await expect(deskLayoutsFor(sqlAnswering([{ value: { layouts: 'x' } }]), USER)).rejects.toThrow();
  });
});
