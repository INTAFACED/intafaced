import { generateKeyPairSync } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  createServiceSigner,
  createServiceVerifier,
  serviceAuthHeadersForBody,
  type Keyring,
  type ServiceAuthMode,
} from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { registerInternalStake } from './internal-stake.js';
import { registerInternalEmissions } from './internal-emissions.js';
import { accessTierFor, feeDiscountBps, DEFAULT_FEE_DISCOUNT_SCHEDULE } from './economics/staking.js';

/**
 * The internal doors name the caller from its own service key once S2S is on. The signer here is a generated key;
 * the verifier is the contracts verifier svc-token boots with.
 */
const SECRET = 'test-internal-secret-for-token-stake-gate';
const USER = '11111111-1111-4111-8111-111111111111';

function keyFor(service: string, kid = `${service}.a`) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const x = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  return { pkcs8, entry: { kid, svc: service, use: 's2s' as const, x } };
}

function fleet() {
  const trade = keyFor('svc-trade');
  const token = keyFor('svc-token');
  const keyring: Keyring = [trade.entry, token.entry];
  return {
    trade: createServiceSigner({ service: 'svc-trade', kid: trade.entry.kid, privateKey: trade.pkcs8, keyring }),
    token: createServiceSigner({ service: 'svc-token', kid: token.entry.kid, privateKey: token.pkcs8, keyring }),
    verifier: () => createServiceVerifier({ self: 'svc-token', keyring }),
  };
}

const access = (staked = parseAmount('10000')) => ({
  staked,
  tier: accessTierFor(staked),
  feeDiscountBps: feeDiscountBps(staked, DEFAULT_FEE_DISCOUNT_SCHEDULE),
});

async function stakeDoor(mode?: ServiceAuthMode, verifier?: ReturnType<ReturnType<typeof fleet>['verifier']>) {
  const app = Fastify();
  registerInternalStake(app, {
    internalSecret: SECRET,
    accessOf: vi.fn(async () => access()),
    ...(verifier && mode ? { s2s: { verifier, mode } } : {}),
  });
  await app.ready();
  return app;
}

const url = `/internal/stake/${USER}`;
const keyed = (signer: ReturnType<typeof fleet>['trade']) =>
  signer.headers({ audience: 'svc-token', method: 'GET', url: new URL(`http://token.test${url}`), body: undefined });

describe('svc-token stake door with service keys', () => {
  it('without S2S configured, a key-signed call is not a service call', async () => {
    const f = fleet();
    const app = await stakeDoor();
    expect((await app.inject({ method: 'GET', url, headers: keyed(f.trade) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url, headers: serviceAuthHeadersForBody('svc-trade', SECRET, '') })).statusCode).toBe(200);
    await app.close();
  });

  it('dual: accepts the key and still accepts the shared secret', async () => {
    const f = fleet();
    const app = await stakeDoor('dual', f.verifier());
    expect((await app.inject({ method: 'GET', url, headers: keyed(f.trade) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url, headers: serviceAuthHeadersForBody('svc-trade', SECRET, '') })).statusCode).toBe(200);
    await app.close();
  });

  it('keypair: accepts the key and refuses the shared secret', async () => {
    const f = fleet();
    const app = await stakeDoor('keypair', f.verifier());
    expect((await app.inject({ method: 'GET', url, headers: keyed(f.trade) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url, headers: serviceAuthHeadersForBody('svc-trade', SECRET, '') })).statusCode).toBe(401);
    await app.close();
  });

  it('refuses a key-signed call meant for another service, and a replayed one', async () => {
    const f = fleet();
    const app = await stakeDoor('keypair', f.verifier());
    const wrongAudience = f.trade.headers({
      audience: 'svc-ledger',
      method: 'GET',
      url: new URL(`http://token.test${url}`),
      body: undefined,
    });
    expect((await app.inject({ method: 'GET', url, headers: wrongAudience })).statusCode).toBe(401);
    const once = keyed(f.trade);
    expect((await app.inject({ method: 'GET', url, headers: once })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url, headers: once })).statusCode).toBe(401);
    await app.close();
  });
});

describe('svc-token job door with service keys', () => {
  it('only a call named svc-token by its key runs the job; another service key is 403', async () => {
    const f = fleet();
    const app = Fastify();
    const mintNextEpoch = vi.fn(async () => ({ epoch: 1, minted: parseAmount('1') }));
    registerInternalEmissions(app, {
      internalSecret: SECRET,
      emissionsEnabled: true,
      mintNextEpoch,
      bodyBind: 'require',
      s2s: { verifier: f.verifier(), mode: 'keypair' },
    });
    await app.ready();
    const post = (signer: typeof f.trade) =>
      app.inject({
        method: 'POST',
        url: '/internal/emissions/mint-next',
        headers: {
          'content-type': 'application/json',
          ...signer.headers({
            audience: 'svc-token',
            method: 'POST',
            url: new URL('http://token.test/internal/emissions/mint-next'),
            body: '{}',
            context: { contentType: 'application/json' },
          }),
        },
        payload: '{}',
      });
    expect((await post(f.trade)).statusCode).toBe(403);
    expect(mintNextEpoch).not.toHaveBeenCalled();
    expect((await post(f.token)).statusCode).toBe(200);
    expect(mintNextEpoch).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
