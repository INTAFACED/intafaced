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
  identityProvisionAdapter,
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
  it('blank is unset; privy is known but unwired; turnkey needs svc-identity’s URL; TEST:test is the TEST provider on the test stack only', () => {
    expect(embeddedWalletFromSetting(undefined, undefined, 'production')).toEqual({ kind: 'unset' });
    expect(embeddedWalletFromSetting('  ', undefined, 'production')).toEqual({ kind: 'unset' });
    expect(embeddedWalletFromSetting('privy', undefined, 'production')).toEqual({ kind: 'unwired', id: 'privy' });
    expect(() => embeddedWalletFromSetting('turnkey', undefined, 'production')).toThrow(/turnkey needs IDENTITY_URL.*Refusing to boot/);
    expect(() => embeddedWalletFromSetting('turnkey', undefined, 'production', fetch, undefined, 'not a url')).toThrow(
      /needs IDENTITY_URL/,
    );
    const owner = embeddedWalletFromSetting('turnkey', undefined, 'production', fetch, undefined, 'http://svc-identity:4002');
    // Named without the vendor (user-facing copy names no partner), and offering no export or recovery in this build yet.
    expect(owner.kind === 'ready' && owner.adapter.info).toEqual({
      id: 'turnkey',
      displayName: 'your wallet provider',
      test: false,
      capabilities: { export: false, recovery: false },
    });
    const test = embeddedWalletFromSetting('TEST:test', URL, 'test');
    expect(test.kind === 'ready' && test.adapter.info).toEqual({
      id: 'test',
      displayName: 'TEST wallet provider',
      test: true,
      capabilities: { export: true, recovery: true },
    });
    expect(embeddedWalletFromSetting('TEST:test', URL, 'dev').kind).toBe('ready');
    // The same TEST provider standing in for one whose plan offers no key export (J-wallet-22 #5).
    const noExport = embeddedWalletFromSetting('TEST:test-no-export', URL, 'test');
    expect(noExport.kind === 'ready' && noExport.adapter.info.capabilities).toEqual({ export: false, recovery: true });
    expect(() => embeddedWalletFromSetting('TEST:test-no-export', URL, 'production')).toThrow(/TEST value .* Refusing to boot/);
  });

  it('boots the TEST provider in the beta posture (staging, INTAFACED_BETA_POSTURE test-networks), loopback URL still required', () => {
    expect(embeddedWalletFromSetting('TEST:test', URL, 'staging', fetch, 'test-networks').kind).toBe('ready');
    expect(() => embeddedWalletFromSetting('TEST:test', 'https://provider.example', 'staging', fetch, 'test-networks')).toThrow(/loopback/);
    for (const [env, beta] of [
      ['prod', 'test-networks'],
      ['staging', 'mainnet'],
      ['staging', undefined],
    ] as const)
      expect(() => embeddedWalletFromSetting('TEST:test', URL, env, fetch, beta)).toThrow(/TEST value .* Refusing to boot/);
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

  it('a provider that refuses the passkey (4xx) is a refusal by name, not the provider down', async () => {
    const adapter = testProviderAdapter(URL, async () => new Response(JSON.stringify({ error: 'passkey_invalid' }), { status: 400 }));
    const d = deps({ kind: 'ready', adapter });
    const r = await refusal(() => createEmbeddedWallet(d, { userId: ALICE, passkey: PASSKEY }, T0));
    expect(r.code).toBe('wallet.embedded_wallet_mismatch');
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
  });
});

describe('the owner’s provider, made through svc-identity', () => {
  const IDENTITY = 'http://svc-identity:4002';
  const FORWARDED = { 'x-intafaced-principal': 'p', 'x-intafaced-principal-sig': 's', 'x-intafaced-region': 'DE' };
  const WALLET_ID = 'sub-1/wallet-1';
  type Sent = { url: string; method: string; headers: Headers; body: string };
  function identity(status: number, body: unknown) {
    const sent: Sent[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      sent.push({ url: String(input), method: String(init?.method), headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    };
    return { fetcher, sent };
  }
  const make = (fetcher: typeof fetch, forwarded: Record<string, string> | undefined = FORWARDED) =>
    identityProvisionAdapter(IDENTITY, fetcher).createWallet({
      ownerRef: ALICE,
      idempotencyKey: embeddedWalletKey(ALICE),
      passkey: PASSKEY,
      ...(forwarded ? { forwarded } : {}),
    });

  it('asks svc-identity’s record with the person’s own signed principal and the passkey only, and keeps its answer', async () => {
    const { fetcher, sent } = identity(200, { result: { data: { walletId: WALLET_ID, address: ADDRESS.toLowerCase(), ownerRef: ALICE } } });
    expect(await make(fetcher)).toEqual({ walletId: WALLET_ID, address: ADDRESS, ownerRef: ALICE });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${IDENTITY}/trpc/embeddedWallet.provision`);
    expect(sent[0]!.method).toBe('POST');
    expect(JSON.parse(sent[0]!.body)).toEqual({ passkey: PASSKEY });
    for (const [name, value] of Object.entries(FORWARDED)) expect(sent[0]!.headers.get(name)).toBe(value);
  });

  it('with no signed-in person on the request nothing is asked, and it is down', async () => {
    const { fetcher, sent } = identity(200, {});
    await expect(make(fetcher, {})).rejects.toMatchObject({ name: 'ProviderUnavailableError', providerName: 'your wallet provider' });
    expect(sent).toHaveLength(0);
  });

  it('a 409 is the provider refusing the passkey; no answer, any other error, non-JSON or no wallet is down; nothing recorded', async () => {
    const refused = deps({ kind: 'ready', adapter: identityProvisionAdapter(IDENTITY, identity(409, {}).fetcher) });
    const err = await createEmbeddedWallet(refused, { userId: ALICE, passkey: PASSKEY, forwarded: FORWARDED }).catch((e: unknown) => e);
    expect((err as EmbeddedWalletRefusedError).code).toBe('wallet.embedded_wallet_mismatch');
    expect(refused.store.rows.size).toBe(0);
    const downs: Array<typeof fetch> = [
      async () => {
        throw new TypeError('fetch failed');
      },
      identity(503, {}).fetcher,
      identity(412, {}).fetcher,
      identity(401, {}).fetcher,
      identity(200, '<html>').fetcher,
      identity(200, { result: { data: { walletId: WALLET_ID, address: 'not-an-address', ownerRef: ALICE } } }).fetcher,
    ];
    for (const fetcher of downs) {
      const d = deps({ kind: 'ready', adapter: identityProvisionAdapter(IDENTITY, fetcher) });
      const down = await createEmbeddedWallet(d, { userId: ALICE, passkey: PASSKEY, forwarded: FORWARDED }).catch((e: unknown) => e);
      expect((down as EmbeddedWalletRefusedError).code).toBe('wallet.embedded_provider_down');
      expect(d.store.rows.size).toBe(0);
    }
  });

  it('a wallet svc-identity says is someone else’s is never recorded', async () => {
    const d = deps({
      kind: 'ready',
      adapter: identityProvisionAdapter(
        IDENTITY,
        identity(200, { result: { data: { walletId: WALLET_ID, address: ADDRESS, ownerRef: BOB } } }).fetcher,
      ),
    });
    const err = await createEmbeddedWallet(d, { userId: ALICE, passkey: PASSKEY, forwarded: FORWARDED }).catch((e: unknown) => e);
    expect((err as EmbeddedWalletRefusedError).code).toBe('wallet.embedded_wallet_mismatch');
    expect(d.store.rows.size).toBe(0);
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
      // The owner's gas-sponsor setting is blank (J-wallet-24 #2): no sponsored deposit is offered.
      gasSponsor: { set: false, code: 'wallet.gas_sponsor_unset' },
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

  it('create with the owner’s provider passes the person’s own edge-signed principal on to svc-identity, byte for byte', async () => {
    const seen: Headers[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ result: { data: { walletId: 'sub-1/wallet-1', address: ADDRESS, ownerRef: ALICE } } }));
    };
    const ctx = signedIn(ALICE);
    const d = deps({ kind: 'ready', adapter: identityProvisionAdapter('http://svc-identity:4002', fetcher) });
    const made = await caller(d, ctx).embeddedWallet.create({ passkey: PASSKEY });
    expect(made.wallet).toMatchObject({
      provider: 'turnkey',
      providerWalletId: 'sub-1/wallet-1',
      address: ADDRESS,
      test: false,
      holdsKey: false,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.get('x-intafaced-principal')).toBe(ctx.forwardedPrincipal!.raw);
    expect(seen[0]!.get('x-intafaced-principal-sig')).toBe(ctx.forwardedPrincipal!.signature);
  });

  it('refuses with the code leading the message; nothing wired reads as a blank setting', async () => {
    await expect(caller(undefined).embeddedWallet.create({ passkey: PASSKEY })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/^wallet\.embedded_provider_unset:/),
    });
    expect(await caller(undefined).embeddedWallet.status()).toEqual({
      provider: null,
      wallet: null,
      gasSponsor: { set: false, code: 'wallet.gas_sponsor_unset' },
    });
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
