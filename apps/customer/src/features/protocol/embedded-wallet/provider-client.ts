import type { EmbeddedWalletPasskey, ProtocolEmbeddedWalletProvider } from '@intafaced/contracts/protocol-embedded-wallet';
import { base64url } from '../../session/webauthn';

/**
 * The page's side of the embedded-wallet provider (J-wallet-22, OWNER 237). Signing, export and recovery run here,
 * between the person's browser and their provider, after the person's own passkey; nothing of it passes through an
 * INTAFACED service, and no key is ever sent to one. svc-protocol only records the wallet's address and the provider's id.
 *
 * One client per provider adapter. `test` is the labelled TEST provider, reached on the TEST stack's own origin; the
 * provider the agents pick after the testnet trial plugs in as one more client here and one adapter in svc-protocol.
 */

export type ClientFailure =
  /** The provider did not answer, or answered with a server error: nothing was signed or sent. */
  | 'down'
  /** The passkey check did not pass on this device: cancelled, timed out, or no passkey for this wallet here. */
  | 'passkey'
  /** The provider refused the passkey check. */
  | 'refused'
  /** This browser cannot make or use a passkey here. */
  | 'unsupported';

export type ClientResult<T> = { ok: true; data: T } | { ok: false; failure: ClientFailure };

export interface EmbeddedWalletClient {
  /** Makes the person's passkey on this device; answers its id and PUBLIC key only. */
  createPasskey(): Promise<ClientResult<EmbeddedWalletPasskey>>;
  /** EIP-191 message signature from the wallet, after the person's passkey. */
  signMessage(walletId: string, message: string): Promise<ClientResult<{ signature: string; address: string }>>;
  /**
   * EIP-712 typed-data signature from the wallet, after the person's passkey: a venue action the venue prepared (the
   * trading session's one approval, its revoke, the builder-fee approval; J-wallet-22 #8). The passkey's challenge
   * commits to this exact payload, so an assertion for one action never signs another.
   */
  signTypedData(walletId: string, typedData: unknown): Promise<ClientResult<{ signature: string; address: string }>>;
  /** The provider's own export, after the person's passkey: the key goes to the person on this screen, never to INTAFACED. */
  exportKey(walletId: string): Promise<ClientResult<{ privateKey: string }>>;
  /** Adds a second passkey as a recovery method, approved with a passkey already bound to the wallet. */
  addRecoveryPasskey(walletId: string): Promise<ClientResult<{ passkeys: number }>>;
}

const WEBAUTHN_TIMEOUT_MS = 60_000;

function bytes(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const supported = () => typeof window !== 'undefined' && window.isSecureContext && !!window.PublicKeyCredential && !!navigator.credentials;

/** A new ES256 passkey on this device, for the wallet. The relying party is this page's own host. */
export async function createWalletPasskey(): Promise<ClientResult<EmbeddedWalletPasskey>> {
  if (!supported()) return { ok: false, failure: 'unsupported' };
  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'INTAFACED wallet' },
        user: { id: random(16), name: 'wallet', displayName: 'Your wallet' },
        challenge: random(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        attestation: 'none',
        timeout: WEBAUTHN_TIMEOUT_MS,
      },
    });
    if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse))
      return { ok: false, failure: 'passkey' };
    const publicKey = credential.response.getPublicKey();
    if (!publicKey || credential.response.getPublicKeyAlgorithm() !== -7) return { ok: false, failure: 'unsupported' };
    return { ok: true, data: { credentialId: base64url(credential.rawId), publicKey: base64url(publicKey), algorithm: -7 } };
  } catch {
    return { ok: false, failure: 'passkey' };
  }
}

export interface WalletAssertion {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/** The person's passkey answering one provider challenge. Only passkeys bound to the wallet are offered. */
export async function assertWalletPasskey(challenge: string, allowCredentials: readonly string[]): Promise<ClientResult<WalletAssertion>> {
  if (!supported()) return { ok: false, failure: 'unsupported' };
  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: bytes(challenge),
        allowCredentials: allowCredentials.map((id) => ({ type: 'public-key' as const, id: bytes(id) })),
        userVerification: 'required',
        timeout: WEBAUTHN_TIMEOUT_MS,
      },
    });
    if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse))
      return { ok: false, failure: 'passkey' };
    const r = credential.response;
    return {
      ok: true,
      data: {
        credentialId: base64url(credential.rawId),
        clientDataJSON: base64url(r.clientDataJSON),
        authenticatorData: base64url(r.authenticatorData),
        signature: base64url(r.signature),
      },
    };
  } catch {
    return { ok: false, failure: 'passkey' };
  }
}

/** Where the TEST stack passes the TEST provider's client routes, on this page's own origin. */
export const TEST_PROVIDER_CLIENT_PATH = '/__test-wallet-provider/client';

type Post = (path: string, body: unknown) => Promise<{ status: number; body: unknown } | null>;

const post: Post = async (path, body) => {
  try {
    const res = await fetch(`${TEST_PROVIDER_CLIENT_PATH}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      return null;
    }
    return { status: res.status, body: json };
  } catch {
    return null;
  }
};

/**
 * The labelled TEST provider's client: a one-time challenge for one action and its exact payload, the person's passkey
 * answering it, then the action. `deps` is for tests.
 */
export function testProviderClient(
  deps: { post?: Post; assert?: typeof assertWalletPasskey; create?: typeof createWalletPasskey } = {},
): EmbeddedWalletClient {
  const call = deps.post ?? post;
  const assert = deps.assert ?? assertWalletPasskey;
  const create = deps.create ?? createWalletPasskey;
  async function act<T>(
    walletId: string,
    action: 'sign' | 'signtyped' | 'export' | 'recovery',
    payload: unknown,
  ): Promise<ClientResult<T>> {
    const issued = await call('challenge', { walletId, action, payload });
    if (!issued || issued.status >= 500) return { ok: false, failure: 'down' };
    const ch = issued.body as { challenge?: unknown; allowCredentials?: unknown };
    if (issued.status !== 200 || typeof ch.challenge !== 'string' || !Array.isArray(ch.allowCredentials))
      return { ok: false, failure: 'refused' };
    const assertion = await assert(ch.challenge, ch.allowCredentials as string[]);
    if (!assertion.ok) return assertion;
    const done = await call(action, { walletId, payload, challenge: ch.challenge, assertion: assertion.data });
    if (!done || done.status >= 500) return { ok: false, failure: 'down' };
    if (done.status !== 200) return { ok: false, failure: 'refused' };
    return { ok: true, data: done.body as T };
  }
  return {
    createPasskey: create,
    signMessage: (walletId, message) => act(walletId, 'sign', { message }),
    signTypedData: (walletId, typedData) => act(walletId, 'signtyped', { typedData }),
    exportKey: (walletId) => act(walletId, 'export', undefined),
    async addRecoveryPasskey(walletId) {
      const passkey = await create();
      if (!passkey.ok) return passkey;
      return act(walletId, 'recovery', { passkey: passkey.data });
    },
  };
}

/** The client for the provider svc-protocol names; null for a provider this build has no client for. */
export function embeddedWalletClient(provider: ProtocolEmbeddedWalletProvider | null): EmbeddedWalletClient | null {
  if (provider?.id === 'test' && provider.test) return testProviderClient();
  return null;
}
