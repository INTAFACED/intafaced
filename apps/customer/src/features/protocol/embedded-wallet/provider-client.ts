import type { EmbeddedWalletPasskey, ProtocolEmbeddedWalletProvider } from '@intafaced/contracts/protocol-embedded-wallet';
import {
  getAddress,
  hashMessage,
  hashTypedData,
  isAddress,
  recoverMessageAddress,
  recoverTypedDataAddress,
  type TypedDataDefinition,
} from 'viem';
import { base64url } from '../../session';

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
  | 'unsupported'
  /** The provider gives the key out once and already did (J-dex-protocol-08 #9): this request got no key. */
  | 'spent'
  /** The chain refused the transaction before it was sent (no gas, a failing call): nothing was sent (J-wallet-24 #4). */
  | 'chain';

/** The chain reads a room makes through the provider's own connection. None of them signs or sends. */
export type ChainReadMethod =
  | 'eth_chainId'
  | 'eth_blockNumber'
  | 'eth_getBlockByNumber'
  | 'eth_getBalance'
  | 'eth_call'
  | 'eth_getTransactionReceipt'
  | 'eth_getTransactionCount'
  | 'eth_estimateGas'
  | 'eth_gasPrice'
  | 'eth_maxPriorityFeePerGas';

/** A transaction from the wallet, as the person reviewed it: the provider prices it from the chain, signs and sends it once. */
export interface WalletTransaction {
  chainId: number;
  to: string;
  data: string;
  /** Wei, as a 0x hex string. */
  value: string;
  /** The wallet's nonce read before signing: the provider sends one transaction per nonce, never a second. */
  nonce: number;
}

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
  /**
   * The provider's own export, after the person's passkey: the key goes to the person on this screen, never to INTAFACED.
   * The provider answers it once; a later request, from any device, fails `spent` with no key (J-dex-protocol-08 #9).
   */
  exportKey(walletId: string): Promise<ClientResult<{ privateKey: string }>>;
  /** Adds a second passkey as a recovery method, approved with a passkey already bound to the wallet. */
  addRecoveryPasskey(walletId: string): Promise<ClientResult<{ passkeys: number }>>;
  /**
   * A transaction from the wallet, after the person's passkey (J-wallet-24 #4): the provider signs it with the wallet's
   * key and sends it on the chain, once per nonce. Answers the chain's transaction hash.
   */
  sendTransaction(walletId: string, transaction: WalletTransaction): Promise<ClientResult<{ hash: string }>>;
  /** A read-only chain call through the provider's own connection; null when it cannot answer. */
  read(method: ChainReadMethod, params: unknown[]): Promise<unknown>;
}

const WEBAUTHN_TIMEOUT_MS = 60_000;

function bytes(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
type Transport = NonNullable<EmbeddedWalletPasskey['registration']>['transports'][number];
const TRANSPORTS: readonly string[] = ['ble', 'internal', 'nfc', 'usb', 'hybrid', 'smart-card'] satisfies readonly Transport[];
const isTransport = (t: string): t is Transport => TRANSPORTS.includes(t);
const supported = () => typeof window !== 'undefined' && window.isSecureContext && !!window.PublicKeyCredential && !!navigator.credentials;

/** A new ES256 passkey on this device, for the wallet. The relying party is this page's own host. */
export async function createWalletPasskey(): Promise<ClientResult<EmbeddedWalletPasskey>> {
  if (!supported()) return { ok: false, failure: 'unsupported' };
  try {
    const challenge = random(32);
    const credential = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'INTAFACED wallet' },
        user: { id: random(16), name: 'wallet', displayName: 'Your wallet' },
        challenge,
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
    // The registration travels too: a provider that binds a passkey only from its registration checks it there.
    const transports = (credential.response.getTransports?.() ?? []).filter(isTransport);
    return {
      ok: true,
      data: {
        credentialId: base64url(credential.rawId),
        publicKey: base64url(publicKey),
        algorithm: -7,
        registration: {
          challenge: base64url(challenge.buffer),
          clientDataJson: base64url(credential.response.clientDataJSON),
          attestationObject: base64url(credential.response.attestationObject),
          transports,
        },
      },
    };
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

/** The provider's answer to an export after the first: 410 `export_spent`, never a key. */
const isSpent = (r: { status: number; body: unknown }) =>
  r.status === 410 && (r.body as { error?: unknown } | null)?.error === 'export_spent';

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
    action: 'sign' | 'signtyped' | 'sendtx' | 'export' | 'recovery',
    payload: unknown,
  ): Promise<ClientResult<T>> {
    const issued = await call('challenge', { walletId, action, payload });
    if (!issued || issued.status >= 500) return { ok: false, failure: 'down' };
    if (isSpent(issued)) return { ok: false, failure: 'spent' };
    const ch = issued.body as { challenge?: unknown; allowCredentials?: unknown };
    if (issued.status !== 200 || typeof ch.challenge !== 'string' || !Array.isArray(ch.allowCredentials))
      return { ok: false, failure: 'refused' };
    const assertion = await assert(ch.challenge, ch.allowCredentials as string[]);
    if (!assertion.ok) return assertion;
    const done = await call(action, { walletId, payload, challenge: ch.challenge, assertion: assertion.data });
    if (!done || done.status >= 500) return { ok: false, failure: 'down' };
    if (isSpent(done)) return { ok: false, failure: 'spent' };
    if (done.status === 422) return { ok: false, failure: 'chain' };
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
    sendTransaction: (walletId, transaction) => act(walletId, 'sendtx', { transaction }),
    async read(method, params) {
      const answer = await call('rpc', { method, params });
      if (!answer || answer.status !== 200) return null;
      const body = answer.body as { result?: unknown } | null;
      return body && 'result' in body ? (body.result ?? null) : null;
    },
  };
}

/** The owner's provider's API, which the page reaches directly: the Customer app's CSP names it in connect-src. */
export const OWNER_PROVIDER_API = 'https://api.turnkey.com';
const SIGN_RAW_PAYLOAD = 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2';

/** The wallet the owner's provider signs for: its address and the provider's `<sub-organisation>/<wallet>` id. */
export interface OwnerProviderWallet {
  address: string;
  providerWalletId: string;
}

type Fetcher = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<Response>;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The WebAuthn challenge the provider checks a passkey stamp against: the UTF-8 bytes of the hex SHA-256 of the exact
 * request body (as the provider's Apache-2.0 `webauthn-stamper` makes it), base64url for `assertWalletPasskey`.
 */
export async function stampChallenge(body: string): Promise<string> {
  const digest = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  return base64url(new TextEncoder().encode(digest).buffer);
}

/** `r`, `s` and the provider's `v` (`00` or `01`, the y parity) as one 65-byte signature. Null when malformed. */
export function joinSignature(result: unknown): `0x${string}` | null {
  if (!result || typeof result !== 'object') return null;
  const { r, s, v } = result as Record<string, unknown>;
  if (typeof r !== 'string' || typeof s !== 'string' || typeof v !== 'string') return null;
  if (!/^[0-9a-fA-F]{1,64}$/.test(r) || !/^[0-9a-fA-F]{1,64}$/.test(s) || !/^0*[01]$/.test(v)) return null;
  return `0x${r.padStart(64, '0')}${s.padStart(64, '0')}${v.endsWith('1') ? '1c' : '1b'}`.toLowerCase() as `0x${string}`;
}

/**
 * The owner's provider's client (turnkey). The page signs at the provider with the person's own passkey: the provider's
 * sign-raw-payload activity on the person's sub-organisation, `signWith` the wallet's address, carrying the EIP-191 or
 * EIP-712 hash, stamped with a WebAuthn assertion whose challenge commits to that exact body (`X-Stamp-WebAuthn`). No
 * INTAFACED service sees the request or the signature before the person's own page sends it on. The signature is checked
 * to recover to the wallet's address before it is used.
 *
 * Sending a transaction, export and a second passkey run in the provider's own browser flow, which this page does not
 * carry yet: each answers `unsupported`, so the room says so in words. The provider reports export and recovery as not
 * offered, so the room shows no button for them.
 */
export function ownerProviderClient(
  deps: {
    wallet?: OwnerProviderWallet | null;
    create?: typeof createWalletPasskey;
    assert?: typeof assertWalletPasskey;
    fetch?: Fetcher;
  } = {},
): EmbeddedWalletClient {
  const unsupported = async () => ({ ok: false as const, failure: 'unsupported' as const });
  const assert = deps.assert ?? assertWalletPasskey;
  const send: Fetcher = deps.fetch ?? ((url, init) => fetch(url, { ...init, credentials: 'omit' }));

  /** The wallet's signature over one 32-byte hash, after the person's passkey; checked to come from the wallet. */
  async function signHash(
    walletId: string,
    hash: `0x${string}`,
    recover: (signature: `0x${string}`) => Promise<string>,
  ): Promise<ClientResult<{ signature: string; address: string }>> {
    const wallet = deps.wallet;
    const subOrganizationId = walletId.split('/')[0];
    if (!wallet || wallet.providerWalletId !== walletId || !subOrganizationId || !isAddress(wallet.address))
      return { ok: false, failure: 'refused' };
    const body = JSON.stringify({
      type: SIGN_RAW_PAYLOAD,
      timestampMs: String(Date.now()),
      organizationId: subOrganizationId,
      parameters: {
        signWith: getAddress(wallet.address),
        payload: hash,
        encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
        hashFunction: 'HASH_FUNCTION_NO_OP',
      },
    });
    const assertion = await assert(await stampChallenge(body), []);
    if (!assertion.ok) return assertion;
    const stamp = JSON.stringify({
      authenticatorData: assertion.data.authenticatorData,
      clientDataJson: assertion.data.clientDataJSON,
      credentialId: assertion.data.credentialId,
      signature: assertion.data.signature,
    });
    let res: Response;
    try {
      res = await send(`${OWNER_PROVIDER_API}/public/v1/submit/sign_raw_payload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Stamp-WebAuthn': stamp },
        body,
      });
    } catch {
      return { ok: false, failure: 'down' };
    }
    if (res.status >= 500) return { ok: false, failure: 'down' };
    if (res.status !== 200) return { ok: false, failure: 'refused' };
    let answer: unknown;
    try {
      answer = await res.json();
    } catch {
      return { ok: false, failure: 'down' };
    }
    const activity = (answer as { activity?: { status?: unknown; result?: { signRawPayloadResult?: unknown } } } | null)?.activity;
    if (activity?.status !== 'ACTIVITY_STATUS_COMPLETED') return { ok: false, failure: 'refused' };
    const signature = joinSignature(activity.result?.signRawPayloadResult);
    if (!signature) return { ok: false, failure: 'down' };
    let signer: string;
    try {
      signer = await recover(signature);
    } catch {
      return { ok: false, failure: 'refused' };
    }
    if (signer.toLowerCase() !== wallet.address.toLowerCase()) return { ok: false, failure: 'refused' };
    return { ok: true, data: { signature, address: getAddress(wallet.address) } };
  }

  return {
    createPasskey: deps.create ?? createWalletPasskey,
    signMessage: (walletId, message) =>
      signHash(walletId, hashMessage(message), (signature) => recoverMessageAddress({ message, signature })),
    async signTypedData(walletId, typedData) {
      const t = typedData as TypedDataDefinition;
      let hash: `0x${string}`;
      try {
        hash = hashTypedData(t);
      } catch {
        return { ok: false, failure: 'refused' };
      }
      return signHash(walletId, hash, (signature) => recoverTypedDataAddress({ ...t, signature }));
    },
    exportKey: unsupported,
    addRecoveryPasskey: unsupported,
    sendTransaction: unsupported,
    read: async () => null,
  };
}

/** The client for the provider svc-protocol names; null for a provider this build has no client for. */
export function embeddedWalletClient(
  provider: ProtocolEmbeddedWalletProvider | null,
  wallet: OwnerProviderWallet | null = null,
): EmbeddedWalletClient | null {
  if (provider?.id === 'test' && provider.test) return testProviderClient();
  if (provider?.id === 'turnkey' && !provider.test) return ownerProviderClient({ wallet });
  return null;
}
