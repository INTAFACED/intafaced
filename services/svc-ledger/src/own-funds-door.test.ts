import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createServiceSigner, createServiceVerifier, type Keyring, type ServiceName } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { LEDGER_DOOR_CALLERS } from './door-callers.js';
import { registerS2sHttp } from './s2s-http.js';
import type { LedgerService } from './service.js';

const SHARED = 'ledger-shared-internal-secret-32chars!';

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  };
}

async function mount(asked: { feeRevenue: unknown[]; other: number }) {
  const callers: ServiceName[] = ['svc-ops', 'svc-bank'];
  const keys = callers.map((svc) => ({ svc, ...pair() }));
  const keyring: Keyring = keys.map((k) => ({ kid: `${k.svc}.a`, svc: k.svc, use: 's2s' as const, x: k.x }));
  const signer = (svc: ServiceName) =>
    createServiceSigner({ service: svc, kid: `${svc}.a`, privateKey: keys.find((k) => k.svc === svc)!.privateKey, keyring });
  const ledger = new Proxy(
    {
      ownFunds: async () => {
        asked.feeRevenue.push('ownFunds');
        return {
          asOf: new Date('2026-11-09T01:00:00.000Z'),
          rows: [{ ownerType: 'house', ownerId: 'market-maker', assetId: 'BTC', kind: 'available', purpose: '', balance: amt('0.25') }],
        };
      },
    },
    {
      get(target, prop) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
        return async () => {
          asked.other += 1;
          return [];
        };
      },
    },
  ) as unknown as LedgerService;
  const app = Fastify({ logger: false });
  registerS2sHttp(app, ledger, SHARED, {
    bodyBind: 'require',
    s2s: { verifier: createServiceVerifier({ self: 'svc-ledger', keyring, bootSecond: 0 }), mode: 'keypair' },
  });
  await app.ready();
  const send = (service: ServiceName, path: string, body: unknown) => {
    const payload = JSON.stringify(body);
    const headers = signer(service).headers({
      audience: 'svc-ledger',
      method: 'POST',
      url: new URL(`http://svc-ledger.internal${path}`),
      body: payload,
      context: { contentType: 'application/json' },
    });
    return app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', ...headers }, payload });
  };
  return { app, send };
}

describe('ownFunds door (J-ops-console-24 #1)', () => {
  it('names svc-ops alone', () => {
    expect(LEDGER_DOOR_CALLERS.ownFunds).toEqual(['svc-ops']);
  });

  it('answers svc-ops the own-funds accounts as decimal strings with the read time', async () => {
    const asked = { feeRevenue: [] as unknown[], other: 0 };
    const m = await mount(asked);
    const res = await m.send('svc-ops', '/trpc/ownFunds', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      asOf: '2026-11-09T01:00:00.000Z',
      accounts: [{ ownerType: 'house', ownerId: 'market-maker', assetId: 'BTC', kind: 'available', purpose: '', balance: '0.25' }],
    });
    expect(asked.other).toBe(0);
    await m.app.close();
  });

  it('refuses a key-verified caller the door does not list, and reads nothing', async () => {
    const asked = { feeRevenue: [] as unknown[], other: 0 };
    const m = await mount(asked);
    const res = await m.send('svc-bank', '/trpc/ownFunds', {});
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ledger.caller_forbidden');
    expect(asked.feeRevenue).toEqual([]);
    await m.app.close();
  });
});
