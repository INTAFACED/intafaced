import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createServiceSigner, createServiceVerifier, type Keyring, type ServiceName } from '@intafaced/contracts';
import { formatAmount, parseAmount as amt, recipes, type PostRequest } from '@intafaced/ledger-client';
import { LEDGER_POST_ALLOWLIST, grantFor, modulesFor } from './caller-allowlist.js';
import { LEDGER_DOOR_CALLERS } from './door-callers.js';
import { registerS2sHttp } from './s2s-http.js';
import type { LedgerService } from './service.js';

/**
 * svc-ops' staff hold grant (ADR 2026-10-22 service-access-calls 3.7 and rule 5): exactly the three staff hold
 * recipes in module `ops`, plus `txByKey` to settle its own unknown outcomes, and no balance or history read.
 */

const SHARED = 'ledger-shared-internal-secret-32chars!';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DESK = 'services/svc-ops/src/staff-holds/desk.ts';

function toWire(req: PostRequest) {
  return {
    idempotencyKey: req.idempotencyKey,
    module: req.module,
    reason: req.reason,
    ...(req.meta ? { meta: req.meta } : {}),
    entries: req.entries.map((e) => ({ account: e.account, direction: e.direction, amount: formatAmount(e.amount) })),
  };
}

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  };
}

async function mount() {
  const asked = { posts: 0, keys: [] as string[], other: 0 };
  const callers: ServiceName[] = ['svc-ops'];
  const keys = callers.map((svc) => ({ svc, ...pair() }));
  const keyring: Keyring = keys.map((k) => ({ kid: `${k.svc}.a`, svc: k.svc, use: 's2s' as const, x: k.x }));
  const signer = createServiceSigner({ service: 'svc-ops', kid: 'svc-ops.a', privateKey: keys[0]!.privateKey, keyring });
  const ledger = new Proxy(
    {
      post: async (req: { idempotencyKey: string; module: string; reason: string }) => {
        asked.posts += 1;
        return {
          id: 'tx-1',
          idempotencyKey: req.idempotencyKey,
          module: req.module,
          reason: req.reason,
          entries: [],
          postedAt: new Date(),
        };
      },
      getTxByKey: async (key: string) => {
        asked.keys.push(key);
        return null;
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
  const send = (path: string, body: unknown) => {
    const payload = JSON.stringify(body);
    const headers = signer.headers({
      audience: 'svc-ledger',
      method: 'POST',
      url: new URL(`http://svc-ledger.internal${path}`),
      body: payload,
      context: { contentType: 'application/json' },
    });
    return app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', ...headers }, payload });
  };
  return { app, send, asked };
}

const place = recipes.staffHoldPlace({ holdNo: '7', userId: USER, assetId: 'USD', amount: amt('40') });

describe('svc-ops staff hold ledger grant', () => {
  it('may post the three staff hold recipes in module ops, cited to the hold desk, and nothing else', () => {
    expect(LEDGER_POST_ALLOWLIST['svc-ops']).toEqual({
      staffHoldConfirm: { module: 'ops', cite: DESK },
      staffHoldPlace: { module: 'ops', cite: DESK },
      staffHoldRelease: { module: 'ops', cite: DESK },
    });
    expect([...modulesFor('svc-ops')]).toEqual(['ops']);
    expect(grantFor('svc-ops', 'deposit')).toBeUndefined();
    expect(grantFor('svc-ops', 'withdrawSettle')).toBeUndefined();
  });

  it('is a poster that reads only its own keys: post and txByKey, never balance or history', () => {
    const on = (door: keyof typeof LEDGER_DOOR_CALLERS) => (LEDGER_DOOR_CALLERS[door] as readonly string[]).includes('svc-ops');
    expect(on('post')).toBe(true);
    expect(on('txByKey')).toBe(true);
    for (const door of ['balance', 'balances', 'history', 'historyPage', 'txById', 'holdingsHistory', 'assetsList', 'assetsGet'] as const)
      expect(on(door), door).toBe(false);
    // The other posters keep their reads.
    expect(LEDGER_DOOR_CALLERS.balance as readonly string[]).toContain('svc-bank');
    expect(LEDGER_DOOR_CALLERS.txByKey as readonly string[]).toContain('svc-bank');
  });

  it('on its own key: a staff hold posts, its key reads back, a deposit is refused, and balance and history refuse it', async () => {
    const m = await mount();
    const posted = await m.send('/trpc/post', toWire(place));
    expect(posted.statusCode, posted.body).toBe(200);
    expect(m.asked.posts).toBe(1);

    const read = await m.send('/trpc/txByKey', { idempotencyKey: place.idempotencyKey });
    expect(read.statusCode, read.body).toBe(200);
    expect(m.asked.keys).toEqual(['ops:hold:7']);

    const deposit = recipes.deposit({ userId: USER, assetId: 'USD', amount: amt('1'), rail: 'bank-sandbox', railRef: 'ops-1' });
    const refused = await m.send('/trpc/post', toWire(deposit));
    expect(refused.statusCode).toBe(403);
    expect(m.asked.posts).toBe(1);

    for (const door of ['balance', 'balances', 'history', 'historyPage']) {
      const res = await m.send(`/trpc/${door}`, { ownerType: 'user', ownerId: USER, assetId: 'USD' });
      expect(res.statusCode, door).toBe(403);
      expect(res.json().code, door).toBe('ledger.caller_forbidden');
    }
    expect(m.asked.other).toBe(0);
    await m.app.close();
  });
});
