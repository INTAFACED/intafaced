import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import {
  BUSINESS_DIRECTORY_HANDLES_PATH,
  BUSINESS_DIRECTORY_RECIPIENT_PATH,
  registerBusinessDirectoryRoutes,
  type BusinessDirectoryStore,
} from './business-directory.js';

const SECRET = 'b'.repeat(32);

function store(): BusinessDirectoryStore {
  const people = [
    { userId: '11111111-1111-4111-8111-111111111111', handle: 'Ada_Admin', email: 'ada@example.com', status: 'active' as const },
    { userId: '55555555-5555-4555-8555-555555555555', handle: 'Fro_Zen', email: 'fro@example.com', status: 'frozen' as const },
  ];
  return {
    async handlesOf(userIds) {
      return people.filter((person) => userIds.includes(person.userId)).map((person) => ({ userId: person.userId, handle: person.handle }));
    },
    async findActiveByHandle(handle) {
      const hit = people.find((person) => person.status === 'active' && person.handle.toLowerCase() === handle.toLowerCase());
      return hit ? { userId: hit.userId, handle: hit.handle } : null;
    },
    async findActiveByEmail(email) {
      const hit = people.find((person) => person.status === 'active' && person.email.toLowerCase() === email.toLowerCase());
      return hit ? { userId: hit.userId, handle: hit.handle } : null;
    },
  };
}

async function app() {
  const server = Fastify({ logger: false });
  registerBusinessDirectoryRoutes(server, { internalSecret: SECRET, store: store() });
  await server.ready();
  return server;
}

function post(path: string, body: unknown, service = 'svc-bank') {
  const raw = JSON.stringify(body);
  return {
    method: 'POST' as const,
    url: path,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, raw) },
    payload: raw,
  };
}

describe('POST /internal/business-directory', () => {
  it('requires svc-bank and never returns an email', async () => {
    const server = await app();
    expect((await server.inject({ method: 'POST', url: BUSINESS_DIRECTORY_RECIPIENT_PATH, payload: {} })).statusCode).toBe(401);
    expect((await server.inject(post(BUSINESS_DIRECTORY_RECIPIENT_PATH, { handle: 'Ada_Admin' }, 'svc-trade'))).statusCode).toBe(403);

    const hit = await server.inject(post(BUSINESS_DIRECTORY_RECIPIENT_PATH, { email: 'ada@example.com' }));
    expect(hit.json()).toEqual({ found: true, userId: '11111111-1111-4111-8111-111111111111', handle: 'Ada_Admin' });
    expect(JSON.stringify(hit.json())).not.toContain('ada@example.com');

    const frozen = await server.inject(post(BUSINESS_DIRECTORY_RECIPIENT_PATH, { handle: 'Fro_Zen' }));
    expect(frozen.json()).toEqual({ found: false });
    const missing = await server.inject(post(BUSINESS_DIRECTORY_RECIPIENT_PATH, { handle: 'nobody' }));
    expect(missing.json()).toEqual({ found: false });

    const handles = await server.inject(
      post(BUSINESS_DIRECTORY_HANDLES_PATH, {
        userIds: ['11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555'],
      }),
    );
    expect(handles.json()).toEqual({
      handles: [
        { userId: '11111111-1111-4111-8111-111111111111', handle: 'Ada_Admin' },
        { userId: '55555555-5555-4555-8555-555555555555', handle: 'Fro_Zen' },
      ],
    });

    expect(
      (await server.inject(post(BUSINESS_DIRECTORY_RECIPIENT_PATH, { handle: 'Ada_Admin', email: 'ada@example.com' }))).statusCode,
    ).toBe(400);
    await server.close();
  });
});
