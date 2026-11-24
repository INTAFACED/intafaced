import { createECDH, createPublicKey, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isRecord } from '@intafaced/contracts/guards';
import { embeddedWalletKey, type EmbeddedWalletPasskey } from '@intafaced/contracts/protocol-embedded-wallet';
import { EmbeddedWalletRefusedError, MemoryEmbeddedWalletStore, createEmbeddedWallet } from './embedded.js';
import { embeddedWalletFromSetting } from './provider.js';
import { TURNKEY_API_BASE_URL, turnkeyAdapter, turnkeyApiKey, turnkeyStamp, turnkeySubOrgName, type TurnkeySettings } from './turnkey.js';

/** The owner's wallet provider. Every request is checked against the provider's published API shape. */
const ALICE = '11111111-1111-4111-8111-111111111111';
const ORG = '6b2c1c5e-0000-4000-8000-000000000001';
const SUB = '6b2c1c5e-0000-4000-8000-0000000000aa';
const WALLET = '6b2c1c5e-0000-4000-8000-0000000000bb';
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';

// A throwaway P-256 key pair made here, never a real key.
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const PRIVATE = ecdh.getPrivateKey('hex').padStart(64, '0');
const PUBLIC = ecdh.getPublicKey('hex', 'compressed');
const SETTINGS: TurnkeySettings = { organizationId: ORG, apiPublicKey: PUBLIC, apiPrivateKey: PRIVATE };

const PASSKEY: EmbeddedWalletPasskey = {
  credentialId: 'Y3JlZC1h',
  publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE',
  algorithm: -7,
  registration: {
    challenge: 'Y2hhbGxlbmdl',
    clientDataJson: 'e30',
    attestationObject: 'o2NmbXRkbm9uZQ',
    transports: ['internal', 'hybrid'],
  },
};

type Call = { url: string; body: Record<string, unknown>; stamp: string };
/** A provider answering by path, recording each signed call. */
function provider(answers: Record<string, (body: Record<string, unknown>) => { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body: unknown = JSON.parse(String(init?.body));
    if (!isRecord(body)) throw new Error('the adapter sent a body that is not an object');
    calls.push({ url, body, stamp: new Headers(init?.headers).get('X-Stamp') ?? '' });
    const path = url.slice(TURNKEY_API_BASE_URL.length);
    const answer = answers[path]?.(body) ?? { status: 404, body: {} };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  return { fetcher, calls };
}
const ok = (body: unknown) => () => ({ status: 200, body });
const NONE = { '/public/v1/query/list_suborgs': ok({ organizationIds: [] }) };
const COMPLETED = {
  activity: {
    status: 'ACTIVITY_STATUS_COMPLETED',
    result: {
      createSubOrganizationResultV8: {
        subOrganizationId: SUB,
        wallet: { walletId: WALLET, addresses: [ADDRESS.toLowerCase()] },
        rootUserIds: ['u'],
      },
    },
  },
};
const create = (adapter: ReturnType<typeof turnkeyAdapter>, passkey = PASSKEY) =>
  adapter.createWallet({ ownerRef: ALICE, idempotencyKey: embeddedWalletKey(ALICE), passkey });

describe('the owner’s wallet provider: settings', () => {
  it('blank stays unset; turnkey with its key settings is ready, named without the vendor, and offers no export or recovery yet', () => {
    expect(embeddedWalletFromSetting('', undefined, 'staging', fetch, undefined, SETTINGS)).toEqual({ kind: 'unset' });
    const ready = embeddedWalletFromSetting('turnkey', undefined, 'staging', fetch, undefined, SETTINGS);
    expect(ready.kind === 'ready' && ready.adapter.info).toEqual({
      id: 'turnkey',
      displayName: 'your wallet provider',
      test: false,
      capabilities: { export: false, recovery: false },
    });
  });

  it('refuses to boot on a missing or malformed key setting, naming the setting and never its value', () => {
    const cases: Array<[Partial<TurnkeySettings>, RegExp]> = [
      [{ organizationId: ' ' }, /needs TURNKEY_ORGANIZATION_ID, which is blank/],
      [{ apiPrivateKey: undefined }, /needs TURNKEY_API_PRIVATE_KEY, which is blank/],
      [{ organizationId: 'org id; drop' }, /TURNKEY_ORGANIZATION_ID is not an organisation id/],
      [{ apiPublicKey: `04${PUBLIC.slice(2)}` }, /TURNKEY_API_PUBLIC_KEY is not a compressed P-256 public key/],
      [{ apiPrivateKey: `${PRIVATE}00` }, /TURNKEY_API_PRIVATE_KEY is not a P-256 private key/],
      [{ apiPublicKey: `${PUBLIC.startsWith('02') ? '03' : '02'}${PUBLIC.slice(2)}` }, /not the public half of TURNKEY_API_PRIVATE_KEY/],
    ];
    for (const [over, message] of cases) {
      let thrown: unknown;
      try {
        turnkeyApiKey({ ...SETTINGS, ...over });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as Error).message).toMatch(message);
      expect((thrown as Error).message).not.toContain(PRIVATE);
      expect((thrown as Error).message).not.toContain(PRIVATE.slice(0, 16));
    }
  });
});

describe('the owner’s wallet provider: the request stamp', () => {
  it('is the API key’s ECDSA-SHA256 signature over the exact body, with its compressed public key and scheme', () => {
    const { key } = turnkeyApiKey(SETTINGS);
    const body = JSON.stringify({ organizationId: ORG });
    const stamp = JSON.parse(Buffer.from(turnkeyStamp(body, PUBLIC, key), 'base64url').toString()) as Record<string, string>;
    expect(stamp.publicKey).toBe(PUBLIC);
    expect(stamp.scheme).toBe('SIGNATURE_SCHEME_TK_API_P256');
    const uncompressed = ecdh.getPublicKey();
    const verifyKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: uncompressed.subarray(1, 33).toString('base64url'),
        y: uncompressed.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    const verify = (content: string) => createVerify('SHA256').update(content).verify(verifyKey, Buffer.from(stamp.signature!, 'hex'));
    expect(verify(body)).toBe(true);
    expect(verify(`${body} `)).toBe(false);
    expect(JSON.stringify(stamp)).not.toContain(PRIVATE);
  });
});

describe('the owner’s wallet provider: making the wallet', () => {
  it('makes one sub-organisation for the person, the passkey its only root user, one Ethereum account, no seed phrase back', async () => {
    const { fetcher, calls } = provider({ ...NONE, '/public/v1/submit/create_sub_organization': ok(COMPLETED) });
    const wallet = await create(turnkeyAdapter(SETTINGS, fetcher));
    expect(wallet).toEqual({ walletId: `${SUB}/${WALLET}`, address: ADDRESS, ownerRef: ALICE });

    expect(calls.map((c) => c.url)).toEqual([
      `${TURNKEY_API_BASE_URL}/public/v1/query/list_suborgs`,
      `${TURNKEY_API_BASE_URL}/public/v1/submit/create_sub_organization`,
    ]);
    expect(calls[0]!.body).toEqual({ organizationId: ORG, filterType: 'NAME', filterValue: turnkeySubOrgName(ALICE) });
    const made = calls[1]!.body;
    expect(made.type).toBe('ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8');
    expect(made.organizationId).toBe(ORG);
    expect(typeof made.timestampMs).toBe('string');
    expect(made.parameters).toEqual({
      subOrganizationName: `intafaced:${ALICE}`,
      rootQuorumThreshold: 1,
      rootUsers: [
        {
          userName: 'wallet owner',
          apiKeys: [],
          oauthProviders: [],
          authenticators: [
            {
              authenticatorName: 'passkey',
              challenge: 'Y2hhbGxlbmdl',
              attestation: {
                credentialId: 'Y3JlZC1h',
                clientDataJson: 'e30',
                attestationObject: 'o2NmbXRkbm9uZQ',
                transports: ['AUTHENTICATOR_TRANSPORT_INTERNAL', 'AUTHENTICATOR_TRANSPORT_HYBRID'],
              },
            },
          ],
        },
      ],
      wallet: {
        walletName: 'INTAFACED wallet',
        accounts: [
          { curve: 'CURVE_SECP256K1', pathFormat: 'PATH_FORMAT_BIP32', path: "m/44'/60'/0'/0/0", addressFormat: 'ADDRESS_FORMAT_ETHEREUM' },
        ],
      },
    });
    // INTAFACED's own API key is never a member of the person's sub-organisation, so it can never sign for the wallet.
    expect(JSON.stringify(made.parameters)).not.toContain(PUBLIC);
    for (const call of calls) expect(call.stamp).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('a retry after a crash gets the wallet the provider already made for the person, never a second', async () => {
    const { fetcher, calls } = provider({
      '/public/v1/query/list_suborgs': ok({ organizationIds: [SUB] }),
      '/public/v1/query/list_wallets': ok({ wallets: [{ walletId: WALLET, walletName: 'INTAFACED wallet' }] }),
      '/public/v1/query/list_wallet_accounts': ok({
        accounts: [{ address: ADDRESS.toLowerCase(), path: "m/44'/60'/0'/0/0", addressFormat: 'ADDRESS_FORMAT_ETHEREUM' }],
      }),
    });
    expect(await create(turnkeyAdapter(SETTINGS, fetcher))).toEqual({ walletId: `${SUB}/${WALLET}`, address: ADDRESS, ownerRef: ALICE });
    expect(calls.some((c) => c.url.endsWith('create_sub_organization'))).toBe(false);
    expect(calls[1]!.body).toEqual({ organizationId: SUB });
    expect(calls[2]!.body).toEqual({ organizationId: SUB, walletId: WALLET });
  });

  it('a passkey without its registration, a 4xx or a failed activity is refused: nothing is made or recorded', async () => {
    const { registration: _dropped, ...bare } = PASSKEY;
    const none = provider(NONE);
    await expect(create(turnkeyAdapter(SETTINGS, none.fetcher), bare)).rejects.toMatchObject({ name: 'ProviderRefusedError' });
    expect(none.calls).toHaveLength(0);
    for (const answer of [
      () => ({ status: 400, body: { code: 3, message: 'invalid attestation' } }),
      ok({ activity: { status: 'ACTIVITY_STATUS_FAILED', failure: { message: 'x' } } }),
    ]) {
      const { fetcher } = provider({ ...NONE, '/public/v1/submit/create_sub_organization': answer });
      const store = new MemoryEmbeddedWalletStore();
      const deps = { store, setting: () => ({ kind: 'ready' as const, adapter: turnkeyAdapter(SETTINGS, fetcher) }) };
      const err = await createEmbeddedWallet(deps, { userId: ALICE, passkey: PASSKEY }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmbeddedWalletRefusedError);
      expect((err as EmbeddedWalletRefusedError).code).toBe('wallet.embedded_wallet_mismatch');
      expect(store.rows.size).toBe(0);
    }
  });

  it('no answer, a 5xx, our own key refused, non-JSON, an unfinished activity or no wallet is down: nothing recorded', async () => {
    const downs: Array<Parameters<typeof provider>[0]> = [
      { '/public/v1/query/list_suborgs': () => ({ status: 503, body: {} }) },
      { '/public/v1/query/list_suborgs': () => ({ status: 401, body: { message: 'unauthorized' } }) },
      { ...NONE, '/public/v1/submit/create_sub_organization': ok({ activity: { status: 'ACTIVITY_STATUS_PENDING' } }) },
      {
        ...NONE,
        '/public/v1/submit/create_sub_organization': ok({
          activity: { status: 'ACTIVITY_STATUS_COMPLETED', result: { createSubOrganizationResultV8: { subOrganizationId: SUB } } },
        }),
      },
      { '/public/v1/query/list_suborgs': ok({ organizationIds: [SUB, 'other-sub'] }) },
    ];
    const thrown: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const notJson: typeof fetch = async () => new Response('<html>', { status: 200 });
    const fetchers = [...downs.map((d) => provider(d).fetcher), thrown, notJson];
    for (const fetcher of fetchers) {
      const store = new MemoryEmbeddedWalletStore();
      const deps = { store, setting: () => ({ kind: 'ready' as const, adapter: turnkeyAdapter(SETTINGS, fetcher) }) };
      const err = await createEmbeddedWallet(deps, { userId: ALICE, passkey: PASSKEY }).catch((e: unknown) => e);
      expect((err as EmbeddedWalletRefusedError).code).toBe('wallet.embedded_provider_down');
      expect((err as Error).message).toContain('your wallet provider');
      expect((err as Error).message).not.toContain(PRIVATE);
      expect(store.rows.size).toBe(0);
    }
  });

  it('records the wallet under the person’s business key, holding no key material', async () => {
    const { fetcher } = provider({ ...NONE, '/public/v1/submit/create_sub_organization': ok(COMPLETED) });
    const store = new MemoryEmbeddedWalletStore();
    const deps = { store, setting: () => ({ kind: 'ready' as const, adapter: turnkeyAdapter(SETTINGS, fetcher) }) };
    const { row, created } = await createEmbeddedWallet(deps, { userId: ALICE, passkey: PASSKEY });
    expect(created).toBe(true);
    expect(row).toMatchObject({ provider: 'turnkey', providerWalletId: `${SUB}/${WALLET}`, address: ADDRESS, test: false });
    expect(row.idempotencyKey).toBe(embeddedWalletKey(ALICE));
  });
});
