import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { IDENTITY_HOLDER_NAME_CHECK_PATH, holderNameCheckSchema, retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { FounderControlError } from './controls/founder-controls.js';
import { registerHolderNameCheck, type HolderNameChecker } from './holder-name-check.js';

const SECRET = 'h'.repeat(32);
const ADA = '11111111-1111-4111-8111-111111111111';

function checker(seen: string[]): HolderNameChecker {
  return {
    async holderNameCheck({ userId, name }) {
      seen.push(name);
      if (name === 'unreadable') throw new FounderControlError('identity.details_unreadable', 'identity.details_unreadable');
      if (name === 'db down') throw new Error('connection refused');
      if (userId !== ADA) return null;
      return { userId, outcome: name === 'Ada Lovelace' ? 'match' : 'mismatch' };
    },
  };
}

async function app(seen: string[] = []) {
  const server = Fastify({ logger: false });
  retainRawBody(server);
  registerHolderNameCheck(server, { internalSecret: SECRET, details: checker(seen) });
  await server.ready();
  return server;
}

function post(body: unknown, service = 'svc-p2p') {
  const raw = JSON.stringify(body);
  return {
    method: 'POST' as const,
    url: IDENTITY_HOLDER_NAME_CHECK_PATH,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, raw) },
    payload: raw,
  };
}

describe('POST /internal/holder-name-check (P-ads-merchant-18)', () => {
  it('answers svc-p2p with the outcome alone, and nobody else at all', async () => {
    const seen: string[] = [];
    const server = await app(seen);
    expect(
      (await server.inject({ method: 'POST', url: IDENTITY_HOLDER_NAME_CHECK_PATH, payload: { userId: ADA, name: 'x' } })).statusCode,
    ).toBe(401);
    expect((await server.inject(post({ userId: ADA, name: 'Ada Lovelace' }, 'svc-bank'))).statusCode).toBe(403);
    expect(seen).toEqual([]);

    const match = await server.inject(post({ userId: ADA, name: 'Ada Lovelace' }));
    expect(match.statusCode).toBe(200);
    expect(holderNameCheckSchema.parse(match.json())).toEqual({ userId: ADA, outcome: 'match' });
    const mismatch = await server.inject(post({ userId: ADA, name: 'Ada King' }));
    expect(mismatch.json()).toEqual({ userId: ADA, outcome: 'mismatch' });
    // The answer never echoes the name it was sent.
    expect(mismatch.body).not.toContain('Ada King');

    expect((await server.inject(post({ userId: '22222222-2222-4222-8222-222222222222', name: 'Ada' }))).statusCode).toBe(404);
    // A record identity cannot read is typed, never an answer about the name.
    const unreadable = await server.inject(post({ userId: ADA, name: 'unreadable' }));
    expect([unreadable.statusCode, unreadable.json().code]).toEqual([503, 'identity.details_unreadable']);
    const down = await server.inject(post({ userId: ADA, name: 'db down' }));
    expect([down.statusCode, down.json().code]).toEqual([503, 'identity.holder_name_unavailable']);
    expect((await server.inject(post({ userId: ADA }))).statusCode).toBe(400);
    expect((await server.inject(post({ userId: ADA, name: '' }))).statusCode).toBe(400);
    expect((await server.inject(post({ userId: 'not-a-uuid', name: 'Ada' }))).statusCode).toBe(400);
    await server.close();
  });
});
