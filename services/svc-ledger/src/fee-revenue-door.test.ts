import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createServiceSigner, createServiceVerifier, type Keyring, type ServiceName } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { serializeFeeRevenue } from './ledger/fee-revenue.js';
import { LEDGER_DOOR_CALLERS } from './door-callers.js';
import { registerS2sHttp } from './s2s-http.js';
import type { LedgerService } from './service.js';

const SHARED = 'ledger-shared-internal-secret-32chars!';
/**
 * svc-ops' doors: its three reads (fee revenue, the restore watermark and the reconciliation evaluation feed), and its
 * staff hold posts with the read of their own keys (ADR 2026-10-22 3.7).
 */
const OPS_DOORS = ['feeRevenue', 'restoreWatermark', 'reconciliationEvaluations', 'post', 'txByKey'];
const WINDOW = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' };

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
      feeRevenue: async (range: unknown) => {
        asked.feeRevenue.push(range);
        return [
          { assetId: 'USDT', collected: amt('12.5'), returned: amt('0.25') },
          { assetId: 'BTC', collected: amt('0.001'), returned: amt('0') },
        ];
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

describe('feeRevenue door', () => {
  it('names svc-ops alone, and svc-ops is named on no read door but its own (its staff hold posts and their keys aside)', () => {
    expect(LEDGER_DOOR_CALLERS.feeRevenue).toEqual(['svc-ops']);
    for (const [door, services] of Object.entries(LEDGER_DOOR_CALLERS)) {
      if (OPS_DOORS.includes(door)) continue;
      expect((services as readonly string[]).includes('svc-ops'), door).toBe(false);
    }
  });

  it('answers svc-ops per asset as decimal strings, with the signed net', async () => {
    const asked = { feeRevenue: [] as unknown[], other: 0 };
    const m = await mount(asked);
    const res = await m.send('svc-ops', '/trpc/feeRevenue', WINDOW);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      from: WINDOW.from,
      to: WINDOW.to,
      assets: [
        { assetId: 'USDT', collected: '12.5', returned: '0.25', net: '12.25' },
        { assetId: 'BTC', collected: '0.001', returned: '0', net: '0.001' },
      ],
    });
    expect(asked.feeRevenue).toEqual([{ from: new Date(WINDOW.from), to: new Date(WINDOW.to) }]);
    await m.app.close();
  });

  it('carries a negative net when more went out than came in', () => {
    const out = serializeFeeRevenue({ from: new Date(WINDOW.from), to: new Date(WINDOW.to) }, [
      { assetId: 'USDT', collected: amt('1'), returned: amt('3.5') },
    ]);
    expect(out.assets[0]!.net).toBe('-2.5');
  });

  it('refuses a key-verified caller the door does not list, and asks nothing', async () => {
    const asked = { feeRevenue: [] as unknown[], other: 0 };
    const m = await mount(asked);
    const res = await m.send('svc-bank', '/trpc/feeRevenue', WINDOW);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ledger.caller_forbidden');
    expect(asked.feeRevenue).toEqual([]);
    await m.app.close();
  });

  it('gives svc-ops no other read door: every other served door refuses it', async () => {
    const asked = { feeRevenue: [] as unknown[], other: 0 };
    const m = await mount(asked);
    for (const door of Object.keys(LEDGER_DOOR_CALLERS).filter((d) => !OPS_DOORS.includes(d))) {
      const res = await m.send('svc-ops', `/trpc/${door}`, { ownerType: 'treasury', ownerId: 'fees:trade' });
      expect(res.statusCode, door).toBe(403);
    }
    expect(asked.other).toBe(0);
    await m.app.close();
  });

  it('refuses an unsigned request', async () => {
    const asked = { feeRevenue: [] as unknown[], other: 0 };
    const m = await mount(asked);
    const res = await m.app.inject({
      method: 'POST',
      url: '/trpc/feeRevenue',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(WINDOW),
    });
    expect(res.statusCode).toBe(401);
    expect(asked.feeRevenue).toEqual([]);
    await m.app.close();
  });

  it('answers 400 for an inverted window and for a date-only value', async () => {
    const asked = { feeRevenue: [] as unknown[], other: 0 };
    const m = await mount(asked);
    const inverted = await m.send('svc-ops', '/trpc/feeRevenue', { from: WINDOW.to, to: WINDOW.from });
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json().code).toBe('ledger.fee_revenue_window_invalid');
    const empty = await m.send('svc-ops', '/trpc/feeRevenue', { from: WINDOW.from, to: WINDOW.from });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe('ledger.fee_revenue_window_invalid');
    const dateOnly = await m.send('svc-ops', '/trpc/feeRevenue', { from: '2026-10-01', to: '2026-11-01' });
    expect(dateOnly.statusCode).toBe(400);
    expect(asked.feeRevenue).toEqual([]);
    await m.app.close();
  });
});
