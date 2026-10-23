import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { issueAccessToken } from '@intafaced/auth';
import {
  ASSET_NOT_FOUND,
  ASSET_PRECISION_UNSET,
  createServiceSigner,
  createServiceVerifier,
  type Keyring,
  type ServiceName,
} from '@intafaced/contracts';
import { LedgerError } from '@intafaced/ledger-client';
import { LEDGER_DOOR_CALLERS } from './door-callers.js';
import { registerS2sHttp } from './s2s-http.js';
import { registerOperatorHttp } from './operator-http.js';
import { stubApprovalConsumer } from './ledger/action-approval-consume.js';
import { ASSET_EDIT_STALE, ASSET_OPERATION_CONFLICT } from './ledger/supported-assets.js';
import type { LedgerService } from './service.js';

/**
 * The registry's doors (W-balances-05): the S2S reads every balance reader may ask, and the operator read and write
 * behind `admin:treasury` + MFA. The rows and the approval binding are proven against Postgres in
 * `ledger/supported-assets.pg.test.ts`; this file proves who may knock and what each refusal looks like on the wire.
 */

const SHARED = 'ledger-shared-internal-secret-32chars!';

const USDT = {
  id: 'USDT',
  kind: 'crypto',
  precision: 6,
  networks: [{ networkId: 'ethereum', label: 'Ethereum (ERC-20)' }],
  defaultNetworkId: 'ethereum',
  allowedActions: ['deposit', 'withdraw'],
  state: 'active',
  revision: 1,
  updatedAt: '2026-10-23T00:00:00.000Z',
};

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  };
}

function registry(asked: unknown[]): LedgerService {
  return {
    listAssets: async (input: unknown) => {
      asked.push(['list', input]);
      return [USDT];
    },
    getAsset: async (input: { assetId?: string }) => {
      asked.push(['get', input]);
      if (input?.assetId === 'USDT') return USDT;
      if (input?.assetId === 'BLANK') throw new LedgerError('unset', ASSET_PRECISION_UNSET);
      throw new LedgerError('none', ASSET_NOT_FOUND);
    },
    listOperatorAssets: async () => [{ ...USDT, precision: null }],
    applyAssetEdit: async (_approvals: unknown, operatorId: string, body: { operationId?: string }) => {
      asked.push(['apply', operatorId, body]);
      if (body?.operationId === 'stale') throw new LedgerError('moved', ASSET_EDIT_STALE);
      if (body?.operationId === 'reused') throw new LedgerError('reused', ASSET_OPERATION_CONFLICT);
      return USDT;
    },
  } as unknown as LedgerService;
}

async function s2s(asked: unknown[]) {
  const callers: ServiceName[] = ['svc-bank', 'svc-pay', 'svc-ops'];
  const keys = callers.map((svc) => ({ svc, ...pair() }));
  const keyring: Keyring = keys.map((k) => ({ kid: `${k.svc}.a`, svc: k.svc, use: 's2s' as const, x: k.x }));
  const signer = (svc: ServiceName) =>
    createServiceSigner({ service: svc, kid: `${svc}.a`, privateKey: keys.find((k) => k.svc === svc)!.privateKey, keyring });
  const app = Fastify({ logger: false });
  registerS2sHttp(app, registry(asked), SHARED, {
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

const tokens = {
  secret: 'a-ledger-operator-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const OPERATOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function bearer(scopes: string[], mfa = true): Promise<string> {
  const { token } = await issueAccessToken(
    { userId: OPERATOR, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scopes, tier: 'basic', mfa },
    tokens,
  );
  return `Bearer ${token}`;
}

async function operator(asked: unknown[]) {
  const app = Fastify({ logger: false });
  registerOperatorHttp(app, registry(asked), tokens, stubApprovalConsumer('dddddddd-dddd-4ddd-8ddd-dddddddddddd'));
  await app.ready();
  return app;
}

describe('asset registry S2S doors', () => {
  it('are open to the services that read balances, and not to svc-ops', () => {
    expect(LEDGER_DOOR_CALLERS.assetsList).toEqual(LEDGER_DOOR_CALLERS.historyPage);
    expect(LEDGER_DOOR_CALLERS.assetsGet).toEqual(LEDGER_DOOR_CALLERS.historyPage);
    expect(LEDGER_DOOR_CALLERS.assetsList).toContain('svc-bank');
    expect(LEDGER_DOOR_CALLERS.assetsList).not.toContain('svc-ops');
  });

  it('lists and gets for a listed reader', async () => {
    const asked: unknown[] = [];
    const m = await s2s(asked);
    const list = await m.send('svc-bank', '/trpc/assetsList', { action: 'withdraw' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ assets: [USDT] });
    const get = await m.send('svc-pay', '/trpc/assetsGet', { assetId: 'USDT' });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual(USDT);
    expect(asked).toEqual([
      ['list', { action: 'withdraw' }],
      ['get', { assetId: 'USDT' }],
    ]);
    await m.app.close();
  });

  it('answers an unknown or unpublished asset as 400 with its own code, never a 500', async () => {
    const m = await s2s([]);
    const none = await m.send('svc-bank', '/trpc/assetsGet', { assetId: 'NOPE' });
    expect([none.statusCode, none.json().code]).toEqual([400, ASSET_NOT_FOUND]);
    const blank = await m.send('svc-bank', '/trpc/assetsGet', { assetId: 'BLANK' });
    expect([blank.statusCode, blank.json().code]).toEqual([400, ASSET_PRECISION_UNSET]);
    await m.app.close();
  });

  it('refuses a key-verified caller the doors do not list, and asks nothing', async () => {
    const asked: unknown[] = [];
    const m = await s2s(asked);
    expect((await m.send('svc-ops', '/trpc/assetsList', {})).statusCode).toBe(403);
    expect((await m.send('svc-ops', '/trpc/assetsGet', { assetId: 'USDT' })).statusCode).toBe(403);
    expect(asked).toEqual([]);
    await m.app.close();
  });
});

describe('asset registry operator routes', () => {
  it('refuse without admin:treasury and MFA, and apply nothing', async () => {
    const asked: unknown[] = [];
    const app = await operator(asked);
    expect((await app.inject({ method: 'GET', url: '/operator/assets' })).statusCode).toBe(401);
    const noMfa = await app.inject({
      method: 'POST',
      url: '/operator/assets/apply-edit',
      headers: { authorization: await bearer(['admin:treasury'], false) },
      payload: { approvalId: 'ap', operationId: 'op' },
    });
    expect(noMfa.statusCode).toBeGreaterThanOrEqual(401);
    expect(noMfa.statusCode).toBeLessThan(500);
    expect(asked).toEqual([]);
    await app.close();
  });

  it('list every row for an operator, published or not', async () => {
    const app = await operator([]);
    const res = await app.inject({ method: 'GET', url: '/operator/assets', headers: { authorization: await bearer(['admin:treasury']) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().assets[0]).toMatchObject({ id: 'USDT', precision: null });
    await app.close();
  });

  it('apply an edit as the signed-in operator, and answer stale and reused operations with 409', async () => {
    const asked: unknown[] = [];
    const app = await operator(asked);
    const auth = { authorization: await bearer(['admin:treasury']) };
    const ok = await app.inject({ method: 'POST', url: '/operator/assets/apply-edit', headers: auth, payload: { operationId: 'op-1' } });
    expect([ok.statusCode, ok.json().revision]).toEqual([200, 1]);
    expect(asked).toEqual([['apply', OPERATOR, { operationId: 'op-1' }]]);
    for (const [operationId, code] of [
      ['stale', ASSET_EDIT_STALE],
      ['reused', ASSET_OPERATION_CONFLICT],
    ] as const) {
      const res = await app.inject({ method: 'POST', url: '/operator/assets/apply-edit', headers: auth, payload: { operationId } });
      expect([res.statusCode, res.json().code]).toEqual([409, code]);
    }
    await app.close();
  });
});
