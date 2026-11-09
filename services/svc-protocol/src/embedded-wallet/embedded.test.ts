import { afterEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { Principal } from '@intafaced/auth';
import { SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV } from '@intafaced/config';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { embeddedWalletKey, type EmbeddedWalletPasskey } from '@intafaced/contracts/protocol-embedded-wallet';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { EmbeddedWalletRefusedError, MemoryEmbeddedWalletStore, createEmbeddedWallet, type EmbeddedWalletDeps } from './embedded.js';
import {
  ProviderUnavailableError,
  TEST_PROVIDER_DISPLAY_NAME,
  embeddedWalletFromSetting,
  testProviderAdapter,
  type EmbeddedWalletProviderAdapter,
  type EmbeddedWalletSetting,
  type ProviderWallet,
} from './provider.js';

/** J-wallet-22 #1 #2 #3 #7: the provider named, a blank or unwired setting refused, one wallet per person, provider down. */
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '33333333-3333-4333-8333-333333333333';
const ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const PASSKEY: EmbeddedWalletPasskey = { credentialId: 'Y3JlZC1h', publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE', algorithm: -7 };
const T0 = new Date('2026-11-09T09:00:00.000Z');
const URL = 'http://127.0.0.1:14561';

/** A provider that records each call and answers one wallet per person, as the TEST provider does. */
function fakeProvider(over: Partial<EmbeddedWalletProviderAdapter> = {}) {
  const calls: Array<{ ownerRef: string; idempotencyKey: string }> = [];
  const byOwner = new Map<string, ProviderWallet>();
  const adapter: EmbeddedWalletProviderAdapter = {
    info: { id: 'test', displayName: TEST_PROVIDER_DISPLAY_NAME, test: true, capabilities: { export: true, recovery: true } },
    async createWallet(input) {
      calls.push({ ownerRef: input.ownerRef, idempotencyKey: input.idempotencyKey });
      const wallet = byOwner.get(input.ownerRef) ?? { walletId: `w-${byOwner.size + 1}`, address: ADDRESS, ownerRef: input.ownerRef };
      byOwner.set(input.ownerRef, wallet);
      return wallet;
    },
    getWallet: async () => null,
    ...over,
  };
  return { adapter, calls };
}

function deps(
  setting: EmbeddedWalletSetting,
  store = new MemoryEmbeddedWalletStore(),
): EmbeddedWalletDeps & { store: MemoryEmbeddedWalletStore } {
  return { store, setting: () => setting };
}

async function refusal(work: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await work();
  } catch (err) {
    if (err instanceof EmbeddedWalletRefusedError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('the owner’s provider setting', () => {
  it('blank is unset; privy and turnkey are known but unwired; TEST:test is the TEST provider on the test stack only', () => {
    expect(embeddedWalletFromSetting(undefined, undefined, 'production')).toEqual({ kind: 'unset' });
    expect(embeddedWalletFromSetting('  ', undefined, 'production')).toEqual({ kind: 'unset' });
    expect(embeddedWalletFromSetting('privy', undefined, 'production')).toEqual({ kind: 'unwired', id: 'privy' });
    expect(embeddedWalletFromSetting('turnkey', undefined, 'production')).toEqual({ kind: 'unwired', id: 'turnkey' });
    const test = embeddedWalletFromSetting('TEST:test', URL, 'test');
    expect(test.kind === 'ready' && test.adapter.info).toEqual({
      id: 'test',
      displayName: 'TEST wallet provider',
      test: true,
      capabilities: { export: true, recovery: true },
    });
    expect(embeddedWalletFromSetting('TEST:test', URL, 'dev').kind).toBe('ready');
  });

  it('refuses to boot on a TEST provider outside dev or test, a missing or non-loopback URL, or an unknown provider', () => {
    for (const env of ['production', 'staging', undefined, 'DEV'])
      expect(() => embeddedWalletFromSetting('TEST:test', URL, env)).toThrow(/TEST value .* Refusing to boot/);
    expect(() => embeddedWalletFromSetting('TEST:test', undefined, 'test')).toThrow(/TEST_URL .* Refusing to boot/);
    expect(() => embeddedWalletFromSetting('TEST:test', 'https://provider.example', 'test')).toThrow(/loopback/);
    expect(() => embeddedWalletFromSetting('TEST:other', URL, 'test')).toThrow(/names no TEST provider/);
    expect(() => embeddedWalletFromSetting('test', URL, 'test')).toThrow(/must be written TEST:test/);
    expect(() => embeddedWalletFromSetting('privvy', undefined, 'production')).toThrow(/not a provider this build knows/);
  });
});

describe('create (J-wallet-22 #1, #2, #3, #7)', () => {
  it('#1 a blank setting refuses wallet.embedded_provider_unset and nothing is made; an unwired one refuses by its own name', async () => {
    const d = deps({ kind: 'unset' });
    expect((await refusal(() => createEmbeddedWallet(d, { userId: ALICE, passkey: PASSKEY }, T0))).code).toBe(
      'wallet.embedded_provider_unset',
    );
    expect(d.store.rows.size).toBe(0);
    const u = deps({ kind: 'unwired', id: 'privy' });
    expect((await refusal(() => createEmbeddedWallet(u, { userId: ALICE, passkey: PASSKEY }, T0))).code).toBe(
      'wallet.embedded_provider_unwired',
    );
    expect(u.store.rows.size).toBe(0);
  });

  it('#2 records the address and the provider’s wallet id under wallet:embedded:<personId>, and nothing else', async () => {
    const { adapter, calls } = fakeProvider();
    const d = deps({ kind: 'ready', adapter });
    const { row, created } = await createEmbeddedWallet(d, { userId: ALICE, passkey: PASSKEY }, T0);
    expect(created).toBe(true);
    expect(row).toEqual({
      userId: ALICE,
      idempotencyKey: `wallet:embedded:${ALICE}`,
      provider: 'test',
      providerWalletId: 'w-1',
      address: ADDRESS,
      test: true,
      createdAt: T0,
    });
    expect(calls).toEqual([{ ownerRef: ALICE, idempotencyKey: embeddedWalletKey(ALICE) }]);
    // The passkey went to the provider and was not kept: nothing of it is in the record.
    expect(JSON.stringify([...d.store.rows.values()])).not.toContain(PASSKEY.publicKey);
    expect(JSON.stringify([...d.store.rows.values()])).not.toContain(PASSKEY.credentialId);
  });

  it('#3 a second press or a replay gives the same wallet, never a second, and does not ask the provider again', async () => {
    const { adapter, calls } = fakeProvider();
    const d = deps({ kind: 'ready', adapter });
    const first = await createEmbeddedWallet(d, { userId: ALICE, passkey: PASSKEY }, T0);
    const again = await createEmbeddedWallet(d, { userId: ALICE, passkey: PASSKEY }, T0);
    expect(again).toEqual({ row: first.row, created: false });
    expect(calls).toHaveLength(1);
    // Two presses at once: one row, the same wallet for both.
    const race = deps({ kind: 'ready', adapter: fakeProvider().adapter });
    const [a, b] = await Promise.all([
      createEmbeddedWallet(race, { userId: BOB, passkey: PASSKEY }, T0),
      createEmbeddedWallet(race, { userId: BOB, passkey: PASSKEY }, T0),
    ]);
    expect(a.row).toEqual(b.row);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(race.store.rows.size).toBe(1);
  });

  it('#7 the provider down refuses wallet.embedded_provider_down naming the provider, and records nothing', async () => {
    const { adapter } = fakeProvider({
      createWallet: async () => {
        throw new ProviderUnavailableError(TEST_PROVIDER_DISPLAY_NAME, 'did not answer');
      },
    });
    const d = deps({ kind: 'ready', adapter });
    const r = await refusal(() => createEmbeddedWallet(d, { userId: ALICE, passkey: PASSKEY }, T0));
    expect(r.code).toBe('wallet.embedded_provider_down');
    expect(r.message).toContain('TEST wallet provider');
    expect(d.store.rows.size).toBe(0);
  });

  it('a wallet the provider bound to someone else is never recorded', async () => {
    const { adapter } = fakeProvider({ createWallet: async () => ({ walletId: 'w-x', address: ADDRESS, ownerRef: BOB }) });
    const d = deps({ kind: 'ready', adapter });
    expect((await refusal(() => createEmbeddedWallet(d, { userId: ALICE, passkey: PASSKEY }, T0))).code).toBe(
      'wallet.embedded_wallet_mismatch',
    );
    expect(d.store.rows.size).toBe(0);
  });
});

describe('the TEST provider adapter over HTTP', () => {
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

  it('keeps only the wallet id, the address and the person from the provider’s answer', async () => {
    const adapter = testProviderAdapter(
      URL,
      answer(200, { walletId: 'testw_1', address: ADDRESS.toLowerCase(), ownerRef: ALICE, privateKey: '0xdead' }),
    );
    const wallet = await adapter.createWallet({ ownerRef: ALICE, idempotencyKey: embeddedWalletKey(ALICE), passkey: PASSKEY });
    expect(wallet).toEqual({ walletId: 'testw_1', address: ADDRESS, ownerRef: ALICE });
  });

  it('a provider that does not answer, answers 5xx, answers non-JSON or a malformed wallet, is down by name', async () => {
    const down: Array<typeof fetch> = [
      async () => {
        throw new TypeError('fetch failed');
      },
      answer(503, {}),
      async () => new Response('<html>', { status: 200 }),
      answer(200, { walletId: 'x', address: 'not-an-address', ownerRef: ALICE }),
      answer(400, { error: 'passkey_invalid' }),
    ];
    for (const fetcher of down) {
      const adapter = testProviderAdapter(URL, fetcher);
      await expect(
        adapter.createWallet({ ownerRef: ALICE, idempotencyKey: embeddedWalletKey(ALICE), passkey: PASSKEY }),
      ).rejects.toMatchObject({
        name: 'ProviderUnavailableError',
        providerName: 'TEST wallet provider',
      });
    }
    expect(await testProviderAdapter(URL, answer(404, { error: 'not_found' })).getWallet('nope')).toBeNull();
  });
});

// ── Mounted: the procedures as the edge calls them ──────────────────────────────────────────────────────────────

const EDGE_SECRET = 'a-protocol-embedded-wallet-test-edge-secret';
const edge = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-protocol' });
function signedIn(userId: string, region = 'DE') {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['protocol:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, region),
      'x-intafaced-region': region,
    },
    id: 'req-signed',
  });
}
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
function caller(embeddedWallet: EmbeddedWalletDeps | undefined, ctx = signedIn(ALICE)) {
  const routerDeps = {
    chain: { config: { chainId: 84532, factory: ZERO, implementation: ZERO }, isDeployed: async () => false },
    registry: { accountsOf: async () => [] },
    relay: {},
    relayEnabled: () => true,
    ammFactoryAddress: () => ZERO,
    swapSlippageBps: () => null,
    ...(embeddedWallet ? { embeddedWallet } : {}),
  } as unknown as ProtocolRouterDeps;
  return createProtocolRouter(routerDeps).createCaller(ctx);
}

describe('embeddedWallet.* mounted', () => {
  const saved = { regions: process.env[SANCTIONS_REGIONS_ENV], source: process.env[SANCTIONS_SOURCE_ENV] };
  afterEach(() => {
    if (saved.regions === undefined) delete process.env[SANCTIONS_REGIONS_ENV];
    else process.env[SANCTIONS_REGIONS_ENV] = saved.regions;
    if (saved.source === undefined) delete process.env[SANCTIONS_SOURCE_ENV];
    else process.env[SANCTIONS_SOURCE_ENV] = saved.source;
  });

  it('status names the provider; create answers the record with holdsKey false and no key field; status reads it back', async () => {
    const d = deps({ kind: 'ready', adapter: fakeProvider().adapter });
    const alice = caller(d);
    expect(await alice.embeddedWallet.status()).toEqual({
      provider: { id: 'test', displayName: 'TEST wallet provider', test: true, capabilities: { export: true, recovery: true } },
      wallet: null,
    });
    const made = await alice.embeddedWallet.create({ passkey: PASSKEY });
    expect(made).toEqual({
      created: true,
      wallet: {
        address: ADDRESS,
        providerWalletId: 'w-1',
        provider: 'test',
        idempotencyKey: `wallet:embedded:${ALICE}`,
        createdAt: expect.any(String),
        test: true,
        holdsKey: false,
      },
    });
    expect((await alice.embeddedWallet.status()).wallet).toEqual(made.wallet);
    expect(await alice.embeddedWallet.create({ passkey: PASSKEY })).toEqual({ created: false, wallet: made.wallet });
    // Another person sees none of it.
    expect((await caller(d, signedIn(BOB)).embeddedWallet.status()).wallet).toBeNull();
  });

  it('refuses with the code leading the message; nothing wired reads as a blank setting', async () => {
    await expect(caller(undefined).embeddedWallet.create({ passkey: PASSKEY })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/^wallet\.embedded_provider_unset:/),
    });
    expect(await caller(undefined).embeddedWallet.status()).toEqual({ provider: null, wallet: null });
    const down = deps({
      kind: 'ready',
      adapter: fakeProvider({
        createWallet: async () => {
          throw new ProviderUnavailableError('TEST wallet provider', 'did not answer');
        },
      }).adapter,
    });
    await expect(caller(down).embeddedWallet.create({ passkey: PASSKEY })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringMatching(/^wallet\.embedded_provider_down: Your wallet provider \(TEST wallet provider\)/),
    });
  });

  it('refuses a passkey that is not ES256 or not base64url before the provider is asked', async () => {
    const { adapter, calls } = fakeProvider();
    const alice = caller(deps({ kind: 'ready', adapter }));
    await expect(alice.embeddedWallet.create({ passkey: { ...PASSKEY, algorithm: -257 as -7 } })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(alice.embeddedWallet.create({ passkey: { ...PASSKEY, publicKey: 'not base64url!' } })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(calls).toEqual([]);
  });

  it('#1 refuses a visitor from a region on the per-country switch, with its reason, before the provider is asked (OWNER 237)', async () => {
    process.env[SANCTIONS_REGIONS_ENV] = 'US:TEST blocked at launch';
    process.env[SANCTIONS_SOURCE_ENV] = 'TEST fixture for J-wallet-22';
    const { adapter, calls } = fakeProvider();
    const d = deps({ kind: 'ready', adapter });
    await expect(caller(d, signedIn(ALICE, 'US')).embeddedWallet.create({ passkey: PASSKEY })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'TEST blocked at launch',
      cause: { code: 'denied.region_blocked' },
    });
    expect(calls).toEqual([]);
    expect(d.store.rows.size).toBe(0);
  });

  it('a signed-out visitor cannot read or make a wallet', async () => {
    const signedOut = edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
    const d = deps({ kind: 'ready', adapter: fakeProvider().adapter });
    await expect(caller(d, signedOut).embeddedWallet.status()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller(d, signedOut).embeddedWallet.create({ passkey: PASSKEY })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
