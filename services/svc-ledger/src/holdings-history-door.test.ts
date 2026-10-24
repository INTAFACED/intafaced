import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createServiceSigner, createServiceVerifier, type Keyring, type ServiceName } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { LEDGER_DOOR_CALLERS } from './door-callers.js';
import { registerS2sHttp } from './s2s-http.js';
import type { LedgerService } from './service.js';

const SHARED = 'ledger-shared-internal-secret-32chars!';
const USER = '81111111-1111-4111-8111-111111111111';
const ASK = { ownerType: 'user', ownerId: USER, from: '2026-10-01T00:00:00.000Z', bucketSeconds: 3_600 };

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  };
}

async function mount(asked: unknown[]) {
  const callers: ServiceName[] = ['svc-bank', 'svc-tax'];
  const keys = callers.map((svc) => ({ svc, ...pair() }));
  const keyring: Keyring = keys.map((k) => ({ kid: `${k.svc}.a`, svc: k.svc, use: 's2s' as const, x: k.x }));
  const signer = (svc: ServiceName) =>
    createServiceSigner({ service: svc, kid: `${svc}.a`, privateKey: keys.find((k) => k.svc === svc)!.privateKey, keyring });
  const ledger = {
    holdingsHistory: async (input: unknown) => {
      asked.push(input);
      return {
        asOf: new Date('2026-10-24T12:00:00.000Z'),
        holdings: [{ assetId: 'BTC', amount: amt('0.5') }],
        movements: [
          { assetId: 'BTC', module: 'trade', reason: 'trade.fill', bucketStart: 1_759_280_400, net: amt('0.5'), fee: amt('0.001') },
          { assetId: 'USDT', module: 'trade', reason: 'trade.fill', bucketStart: 1_759_280_400, net: amt('-30000'), fee: 0n },
        ],
      };
    },
  } as unknown as LedgerService;
  const app = Fastify({ logger: false });
  registerS2sHttp(app, ledger, SHARED, {
    bodyBind: 'require',
    s2s: { verifier: createServiceVerifier({ self: 'svc-ledger', keyring, bootSecond: 0 }), mode: 'keypair' },
  });
  await app.ready();
  const send = (service: ServiceName, body: unknown) => {
    const payload = JSON.stringify(body);
    const headers = signer(service).headers({
      audience: 'svc-ledger',
      method: 'POST',
      url: new URL('http://svc-ledger.internal/trpc/holdingsHistory'),
      body: payload,
      context: { contentType: 'application/json' },
    });
    return app.inject({
      method: 'POST',
      url: '/trpc/holdingsHistory',
      headers: { 'content-type': 'application/json', ...headers },
      payload,
    });
  };
  return { app, send };
}

describe('holdingsHistory door', () => {
  it('names svc-bank alone', () => {
    expect(LEDGER_DOOR_CALLERS.holdingsHistory).toEqual(['svc-bank']);
  });

  it('answers svc-bank with decimal strings and ISO bucket starts', async () => {
    const asked: unknown[] = [];
    const m = await mount(asked);
    const res = await m.send('svc-bank', ASK);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      asOf: '2026-10-24T12:00:00.000Z',
      from: ASK.from,
      bucketSeconds: 3_600,
      holdings: [{ assetId: 'BTC', amount: '0.5' }],
      movements: [
        { assetId: 'BTC', module: 'trade', reason: 'trade.fill', bucketStart: '2025-10-01T01:00:00.000Z', net: '0.5', fee: '0.001' },
        { assetId: 'USDT', module: 'trade', reason: 'trade.fill', bucketStart: '2025-10-01T01:00:00.000Z', net: '-30000', fee: '0' },
      ],
    });
    expect(asked).toEqual([{ ownerType: 'user', ownerId: USER, from: new Date(ASK.from), bucketSeconds: 3_600 }]);
    await m.app.close();
  });

  it('refuses a key-verified caller the door does not list, and asks nothing', async () => {
    const asked: unknown[] = [];
    const m = await mount(asked);
    const res = await m.send('svc-tax', ASK);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ledger.caller_forbidden');
    expect(asked).toEqual([]);
    await m.app.close();
  });

  it('answers 400 for a start off its bucket, a bucket it does not offer, and a house owner', async () => {
    const asked: unknown[] = [];
    const m = await mount(asked);
    const cut = await m.send('svc-bank', { ...ASK, from: '2026-10-01T00:30:00.000Z' });
    expect(cut.statusCode).toBe(400);
    expect(cut.json().code).toBe('ledger.holdings_history_window_invalid');
    expect((await m.send('svc-bank', { ...ASK, bucketSeconds: 120 })).statusCode).toBe(400);
    expect((await m.send('svc-bank', { ...ASK, ownerType: 'house', ownerId: 'fees:trade' })).statusCode).toBe(400);
    expect(asked).toEqual([]);
    await m.app.close();
  });
});
