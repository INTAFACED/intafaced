import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createIdentityKycTierClient } from './identity-tier.js';

const SECRET = 'svc-pay-identity-tier-test-secret-at-least-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';

type Reply = { status: number; body?: unknown; delayMs?: number };

describe('identity KYC tier read for D-148', () => {
  let server: Server | undefined;
  const seen: Array<{ url: string; verified: boolean }> = [];

  async function identity(reply: (userId: string) => Reply): Promise<string> {
    server = createServer((req: IncomingMessage, res) => {
      const verified =
        verifyServiceHeaders(req.headers, SECRET, { rawBody: { retained: true, bytes: Buffer.alloc(0) }, mode: 'require' }).service ===
        'svc-pay';
      seen.push({ url: req.url ?? '', verified });
      const userId = decodeURIComponent((req.url ?? '').split('/').pop() ?? '');
      const r = reply(userId);
      setTimeout(() => {
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(r.body === undefined ? '' : JSON.stringify(r.body));
      }, r.delayMs ?? 0);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    seen.length = 0;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('asks identity for the account, signed as svc-pay, and returns the published tier', async () => {
    const url = await identity((userId) => ({ status: 200, body: { userId, status: 'active', kycTier: 'full' } }));
    const tierOf = createIdentityKycTierClient({ baseUrl: url, internalSecret: SECRET });
    expect(await tierOf(USER)).toBe('full');
    expect(seen).toEqual([{ url: `/internal/account/${USER}`, verified: true }]);
  });

  it('refuses to answer (throws) when identity cannot be trusted: never a guessed tier', async () => {
    const cases: Array<[string, (userId: string) => Reply]> = [
      ['server error', () => ({ status: 500 })],
      ['unknown account', () => ({ status: 404, body: { code: 'identity.account_not_found' } })],
      ['rejected credentials', () => ({ status: 401 })],
      ['body off the published contract', (userId) => ({ status: 200, body: { userId, status: 'active', kycTier: 'platinum' } })],
      [
        'body for a different user',
        () => ({ status: 200, body: { userId: '22222222-2222-4222-8222-222222222222', status: 'active', kycTier: 'full' } }),
      ],
      ['not JSON', () => ({ status: 200 })],
      ['too slow', (userId) => ({ status: 200, body: { userId, status: 'active', kycTier: 'full' }, delayMs: 300 })],
    ];
    for (const [label, reply] of cases) {
      const url = await identity(reply);
      const tierOf = createIdentityKycTierClient({ baseUrl: url, internalSecret: SECRET, timeoutMs: 100 });
      await expect(tierOf(USER), label).rejects.toThrow(/identity/);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('refuses when the transport is down', async () => {
    const tierOf = createIdentityKycTierClient({ baseUrl: 'http://127.0.0.1:1', internalSecret: SECRET, timeoutMs: 200 });
    await expect(tierOf(USER)).rejects.toThrow(/identity/);
  });

  it('refuses to build without a real secret rather than send unsigned calls', () => {
    expect(() => createIdentityKycTierClient({ baseUrl: 'http://identity', internalSecret: '' })).toThrow(/secret/);
  });
});
