import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  restoreWatermarkReadSchema,
  createServiceSigner,
  createServiceVerifier,
  type Keyring,
  type ServiceName,
} from '@intafaced/contracts';
import { LedgerError } from '@intafaced/ledger-client';
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

async function mount(asked: { read: number; other: number; bodies?: unknown[] }) {
  const callers: ServiceName[] = ['svc-ops', 'svc-bank'];
  const keys = callers.map((svc) => ({ svc, ...pair() }));
  const keyring: Keyring = keys.map((k) => ({ kid: `${k.svc}.a`, svc: k.svc, use: 's2s' as const, x: k.x }));
  const signer = (svc: ServiceName) =>
    createServiceSigner({ service: svc, kid: `${svc}.a`, privateKey: keys.find((k) => k.svc === svc)!.privateKey, keyring });
  const ledger = new Proxy(
    {
      restoreWatermark: async (body?: unknown) => {
        asked.read += 1;
        asked.bodies?.push(body);
        const asOf = (body as { asOf?: string } | undefined)?.asOf;
        if (asOf === 'bad')
          throw new LedgerError('restore watermark: asOf must be one instant with an offset', 'ledger.restore_asof_invalid');
        if (asOf === '2999-01-01T00:00:00.000Z')
          throw new LedgerError('the cut-off has not passed yet', 'ledger.restore_asof_unanswerable');
        return {
          service: 'ledger',
          kind: 'chain_tip.seq',
          position: '42',
          integrity: 'abc',
          lastWriteAt: '2026-10-20T11:00:00.000Z',
          readAt: '2026-10-20T12:00:00.000Z',
          ...(asOf ? { asOf } : {}),
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

describe('restoreWatermark door', () => {
  it('names svc-ops alone', () => {
    expect(LEDGER_DOOR_CALLERS.restoreWatermark).toEqual(['svc-ops']);
  });

  it('answers svc-ops with the chain tip as a decimal-string position', async () => {
    const asked = { read: 0, other: 0 };
    const m = await mount(asked);
    const res = await m.send('svc-ops', '/trpc/restoreWatermark', {});
    expect(res.statusCode).toBe(200);
    expect(restoreWatermarkReadSchema.parse(res.json())).toMatchObject({ service: 'ledger', position: '42', integrity: 'abc' });
    expect(asked.read).toBe(1);
    await m.app.close();
  });

  it('passes { asOf } through and answers the read as of it; a bad instant is 400 and an unpassed cut-off 409, by name', async () => {
    const asked = { read: 0, other: 0, bodies: [] as unknown[] };
    const m = await mount(asked);
    const res = await m.send('svc-ops', '/trpc/restoreWatermark', { asOf: '2026-10-20T11:30:00.000Z' });
    expect(res.statusCode).toBe(200);
    expect(restoreWatermarkReadSchema.parse(res.json())).toMatchObject({ asOf: '2026-10-20T11:30:00.000Z' });
    expect(asked.bodies[0]).toEqual({ asOf: '2026-10-20T11:30:00.000Z' });
    const bad = await m.send('svc-ops', '/trpc/restoreWatermark', { asOf: 'bad' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'ledger.restore_asof_invalid' });
    const early = await m.send('svc-ops', '/trpc/restoreWatermark', { asOf: '2999-01-01T00:00:00.000Z' });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: 'ledger.restore_asof_unanswerable' });
    await m.app.close();
  });

  it('refuses a key-verified caller the door does not list, and reads nothing', async () => {
    const asked = { read: 0, other: 0 };
    const m = await mount(asked);
    const res = await m.send('svc-bank', '/trpc/restoreWatermark', {});
    expect(res.statusCode).toBe(403);
    expect(asked.read).toBe(0);
    await m.app.close();
  });

  it('refuses an unsigned request', async () => {
    const asked = { read: 0, other: 0 };
    const m = await mount(asked);
    const res = await m.app.inject({
      method: 'POST',
      url: '/trpc/restoreWatermark',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
    expect(asked.read).toBe(0);
    await m.app.close();
  });
});
