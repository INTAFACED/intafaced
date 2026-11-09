import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  LINKED_WALLETS_PATH,
  linkedWalletsSchema,
  retainRawBody,
  serviceAuthHeadersForBody,
  type LinkedWallets,
} from '@intafaced/contracts';
import { LINKED_WALLET_READERS, registerLinkedWalletsRoute } from './linked-wallets.js';

/** The linked-wallet door for svc-agents' payment method (J-agents-02 #4): who may ask, and what a bad request gets. */

const SECRET = 'l'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const ANSWER: LinkedWallets = { state: 'usable', wallets: [{ address: `0x${'ab'.repeat(20)}`, linkedAt: '2026-11-08T20:00:00.000Z' }] };

async function app(read: (userId: string) => Promise<LinkedWallets>) {
  const server = Fastify({ logger: false });
  retainRawBody(server);
  registerLinkedWalletsRoute(server, { read, internalSecret: SECRET });
  await server.ready();
  return server;
}

function post(payload: unknown, service = 'svc-agents') {
  const raw = JSON.stringify(payload);
  return {
    method: 'POST' as const,
    url: LINKED_WALLETS_PATH,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, raw) },
    payload: raw,
  };
}

describe('POST /internal/linked-wallets', () => {
  it('lists only svc-agents as a reader', () => {
    expect([...LINKED_WALLET_READERS]).toEqual(['svc-agents']);
  });

  it('needs service credentials, and only svc-agents may ask', async () => {
    const asked: string[] = [];
    const server = await app(async (userId) => {
      asked.push(userId);
      return ANSWER;
    });
    const anonymous = await server.inject({ method: 'POST', url: LINKED_WALLETS_PATH, payload: { userId: USER } });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe('identity.unauthenticated');
    for (const other of ['svc-token', 'svc-bank', 'svc-edge']) {
      const res = await server.inject(post({ userId: USER }, other));
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('identity.linked_wallet_reader_refused');
    }
    expect(asked).toHaveLength(0);

    const ok = await server.inject(post({ userId: USER }));
    expect(ok.statusCode).toBe(200);
    expect(linkedWalletsSchema.parse(ok.json())).toEqual(ANSWER);
    expect(asked).toEqual([USER]);
  });

  it('refuses a malformed request before any wallet is read', async () => {
    let calls = 0;
    const server = await app(async () => {
      calls += 1;
      return ANSWER;
    });
    for (const bad of [{}, { userId: 'not-a-guid' }, { userId: USER, extra: true }]) {
      const res = await server.inject(post(bad));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('identity.linked_wallets_request_invalid');
    }
    expect(calls).toBe(0);
  });
});
