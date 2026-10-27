import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createIdentityLimitOverrideClient } from './identity-override.js';

const SECRET = 'svc-pay-identity-override-test-secret-at-least-32';
const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-24T22:00:00.000Z');
const LATER = '2026-10-24T23:00:00.000Z';

type Reply = { status: number; body?: unknown; delayMs?: number };
type Asked = { userId: string; rail: string | null; assetId: string | null };

/** A founder's override as identity publishes it. TEST figures. */
const answer = (q: Asked, override: unknown = { version: '2', perTx: '25', rolling24h: null, expiresAt: LATER }) => ({
  status: 200,
  body: { userId: q.userId, rail: q.rail, assetId: q.assetId, override },
});

describe('identity limit override read (J-ops-console-04 #12)', () => {
  let server: Server | undefined;
  const seen: Array<{ url: string; verified: boolean }> = [];

  async function identity(reply: (q: Asked) => Reply): Promise<string> {
    server = createServer((req: IncomingMessage, res) => {
      const verified =
        verifyServiceHeaders(req.headers, SECRET, { rawBody: { retained: true, bytes: Buffer.alloc(0) }, mode: 'require' }).service ===
        'svc-pay';
      seen.push({ url: req.url ?? '', verified });
      const url = new URL(req.url ?? '/', 'http://identity');
      const r = reply({
        userId: decodeURIComponent(url.pathname.split('/').pop() ?? ''),
        rail: url.searchParams.get('rail'),
        assetId: url.searchParams.get('assetId'),
      });
      setTimeout(() => {
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(r.body === undefined ? '' : JSON.stringify(r.body));
      }, r.delayMs ?? 0);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  const client = (baseUrl: string, timeoutMs?: number) =>
    createIdentityLimitOverrideClient({ baseUrl, internalSecret: SECRET, timeoutMs, now: () => NOW });

  afterEach(async () => {
    seen.length = 0;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('asks identity for the withdrawal override of one asset, signed as svc-pay, and returns its figures and end time', async () => {
    const overrideOf = client(await identity((q) => answer(q)));
    expect(await overrideOf(USER, 'USDT')).toEqual({ perTx: amt('25'), rolling24h: null, expiresAt: new Date(LATER) });
    expect(seen).toEqual([{ url: `/internal/limit-override/${USER}?rail=withdrawal&assetId=USDT`, verified: true }]);
  });

  it('none in force is null; one whose end time has passed by our clock is null too', async () => {
    expect(await client(await identity((q) => answer(q, null)))(USER, 'USDT')).toBeNull();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const ended = { version: '3', perTx: '25', rolling24h: '30', expiresAt: NOW.toISOString() };
    expect(await client(await identity((q) => answer(q, ended)))(USER, 'USDT')).toBeNull();
  });

  it('an asset id identity keeps no override for is not asked about', async () => {
    const overrideOf = client(await identity((q) => answer(q)));
    expect(await overrideOf(USER, 'usdt.e')).toBeNull();
    expect(seen).toEqual([]);
  });

  it('refuses to answer (throws) when identity cannot be trusted: never a skipped override', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    const cases: Array<[string, (q: Asked) => Reply]> = [
      ['server error', () => ({ status: 500 })],
      ['unknown account', () => ({ status: 404, body: { code: 'identity.account_not_found' } })],
      ['bad query', () => ({ status: 400, body: { code: 'identity.limit_query_invalid' } })],
      ['rejected credentials', () => ({ status: 401 })],
      ['body off the published contract', (q) => answer(q, { version: '1', perTx: '-5', rolling24h: null, expiresAt: LATER })],
      ['body for a different customer', (q) => answer({ ...q, userId: other })],
      ['body for a different asset', (q) => answer({ ...q, assetId: 'USDC' })],
      ['not JSON', () => ({ status: 200 })],
      ['too slow', (q) => ({ ...answer(q), delayMs: 300 })],
    ];
    for (const [label, reply] of cases) {
      const overrideOf = client(await identity(reply), 100);
      await expect(overrideOf(USER, 'USDT'), label).rejects.toThrow(/identity/);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('refuses when the transport is down, and to build without a real secret', async () => {
    await expect(client('http://127.0.0.1:1', 200)(USER, 'USDT')).rejects.toThrow(/identity/);
    expect(() => createIdentityLimitOverrideClient({ baseUrl: 'http://identity', internalSecret: '' })).toThrow(/secret/);
  });
});
