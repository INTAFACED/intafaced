import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createServiceSigner, createServiceVerifier, type Keyring, type ServiceName } from '@intafaced/contracts';
import { ledgerTransactionsExistInputSchema } from '@intafaced/contracts/ledger-reconciliation';
import { LEDGER_DOOR_CALLERS } from './door-callers.js';
import { registerS2sHttp } from './s2s-http.js';
import type { LedgerService } from './service.js';

/** Which corrective transaction ids exist, asked by svc-ops resolving an alert as fixed (OPS-reconciliation-04). */
const SHARED = 'ledger-shared-internal-secret-32chars!';
const BOOKED = '00000000-0000-4000-8000-000000000001';
const UNKNOWN = '00000000-0000-4000-8000-000000000002';
const ANSWER = { found: [BOOKED] };

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  };
}

async function mount(asked: unknown[], fault?: Error) {
  const callers: ServiceName[] = ['svc-ops', 'svc-bank'];
  const keys = callers.map((svc) => ({ svc, ...pair() }));
  const keyring: Keyring = keys.map((k) => ({ kid: `${k.svc}.a`, svc: k.svc, use: 's2s' as const, x: k.x }));
  const signer = (svc: ServiceName) =>
    createServiceSigner({ service: svc, kid: `${svc}.a`, privateKey: keys.find((k) => k.svc === svc)!.privateKey, keyring });
  const ledger = {
    transactionsExist: async (input: unknown) => {
      // The service method parses its own input, as LedgerService.transactionsExist does.
      asked.push(ledgerTransactionsExistInputSchema.parse(input));
      if (fault) throw fault;
      return ANSWER;
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
    const path = '/trpc/transactionsExist';
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

describe('transactionsExist door', () => {
  it('names svc-ops alone', () => {
    expect(LEDGER_DOOR_CALLERS.transactionsExist).toEqual(['svc-ops']);
  });

  it('answers svc-ops with the booked ids for the ids it sent', async () => {
    const asked: unknown[] = [];
    const m = await mount(asked);
    const res = await m.send('svc-ops', { txIds: [BOOKED, UNKNOWN] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ANSWER);
    expect(asked).toEqual([{ txIds: [BOOKED, UNKNOWN] }]);
    await m.app.close();
  });

  it('refuses a key-verified caller the door does not list, and asks nothing', async () => {
    const asked: unknown[] = [];
    const m = await mount(asked);
    const res = await m.send('svc-bank', { txIds: [BOOKED] });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ledger.caller_forbidden');
    expect(asked).toEqual([]);
    await m.app.close();
  });

  it('refuses an unsigned request', async () => {
    const asked: unknown[] = [];
    const m = await mount(asked);
    const res = await m.app.inject({
      method: 'POST',
      url: '/trpc/transactionsExist',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ txIds: [BOOKED] }),
    });
    expect(res.statusCode).toBe(401);
    expect(asked).toEqual([]);
    await m.app.close();
  });

  it('answers 400 for no ids, more than twenty, a non-uuid id and an extra key', async () => {
    const asked: unknown[] = [];
    const m = await mount(asked);
    expect((await m.send('svc-ops', { txIds: [] })).statusCode).toBe(400);
    expect((await m.send('svc-ops', { txIds: Array.from({ length: 21 }, () => BOOKED) })).statusCode).toBe(400);
    expect((await m.send('svc-ops', { txIds: ['tx-1'] })).statusCode).toBe(400);
    expect((await m.send('svc-ops', { txIds: [BOOKED], accountId: BOOKED })).statusCode).toBe(400);
    expect(asked).toEqual([]);
    await m.app.close();
  });

  it('answers 500 with a plain message on a ledger fault', async () => {
    const asked: unknown[] = [];
    const m = await mount(asked, new Error('connection lost'));
    const res = await m.send('svc-ops', { txIds: [BOOKED] });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ message: 'Ledger request failed' });
    await m.app.close();
  });
});
