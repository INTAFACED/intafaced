import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createServiceSigner, createServiceVerifier, type Keyring, type ServiceName } from '@intafaced/contracts';
import { reconciliationEvaluationFeedInputSchema } from '@intafaced/contracts/ledger-reconciliation';
import { LEDGER_DOOR_CALLERS } from './door-callers.js';
import { registerS2sHttp } from './s2s-http.js';
import type { LedgerService } from './service.js';

/** The reconciliation evaluation feed svc-ops pulls to raise and count its alerts (OPS-reconciliation-03). */
const SHARED = 'ledger-shared-internal-secret-32chars!';
const CURSOR = { finishedAt: '2026-10-29T12:00:00.000001Z', id: '00000000-0000-4000-8000-000000000001' };
const FEED = { evaluations: [], next: CURSOR };

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  };
}

async function mount(asked: unknown[]) {
  const callers: ServiceName[] = ['svc-ops', 'svc-bank'];
  const keys = callers.map((svc) => ({ svc, ...pair() }));
  const keyring: Keyring = keys.map((k) => ({ kid: `${k.svc}.a`, svc: k.svc, use: 's2s' as const, x: k.x }));
  const signer = (svc: ServiceName) =>
    createServiceSigner({ service: svc, kid: `${svc}.a`, privateKey: keys.find((k) => k.svc === svc)!.privateKey, keyring });
  const ledger = {
    reconciliationEvaluations: async (input: unknown) => {
      // The service method parses its own input, as LedgerService.reconciliationEvaluations does.
      asked.push(reconciliationEvaluationFeedInputSchema.parse(input));
      return FEED;
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
    const path = '/trpc/reconciliationEvaluations';
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

describe('reconciliationEvaluations door', () => {
  it('names svc-ops alone', () => {
    expect(LEDGER_DOOR_CALLERS.reconciliationEvaluations).toEqual(['svc-ops']);
  });

  it('answers svc-ops with the feed for the cursor it sent', async () => {
    const asked: unknown[] = [];
    const m = await mount(asked);
    const res = await m.send('svc-ops', { after: CURSOR, limit: 50 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(FEED);
    expect(asked).toEqual([{ after: CURSOR, limit: 50 }]);
    await m.app.close();
  });

  it('refuses a key-verified caller the door does not list, and asks nothing', async () => {
    const asked: unknown[] = [];
    const m = await mount(asked);
    const res = await m.send('svc-bank', { after: null, limit: 50 });
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
      url: '/trpc/reconciliationEvaluations',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ after: null, limit: 50 }),
    });
    expect(res.statusCode).toBe(401);
    expect(asked).toEqual([]);
    await m.app.close();
  });

  it('answers 400 for a limit past the cap and for a date-only cursor', async () => {
    const asked: unknown[] = [];
    const m = await mount(asked);
    expect((await m.send('svc-ops', { after: null, limit: 501 })).statusCode).toBe(400);
    expect((await m.send('svc-ops', { after: { ...CURSOR, finishedAt: '2026-10-29' }, limit: 5 })).statusCode).toBe(400);
    expect(asked).toEqual([]);
    await m.app.close();
  });
});
