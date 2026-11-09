import { isExplicitDevOrTest } from '@intafaced/config';
import type {
  EmbeddedWalletPasskey,
  EmbeddedWalletProviderId,
  ProtocolEmbeddedWalletProvider,
} from '@intafaced/contracts/protocol-embedded-wallet';
import { getAddress, isAddress, type Address } from 'viem';

/**
 * THE EMBEDDED-WALLET PROVIDER INTERFACE (J-wallet-22, OWNER 237). The owner's provider makes the person's wallet and
 * keeps its key; the key signs only after the person's own passkey. svc-protocol reaches the provider through one adapter
 * and only ever asks it two things: make (or return) the person's wallet bound to their passkey, and read a wallet back.
 * Neither answer carries key material, and no method here can sign: signing, export and recovery run between the
 * person's browser and the provider, never through INTAFACED.
 *
 * Adapters: `test`, the labelled TEST provider (tooling/scripts/local-test-wallet-provider.mjs), refused outside APP_ENV
 * dev or test. The vendor the agents pick after the testnet trial (Turnkey or Privy) plugs in as one more adapter; until
 * then its id is known but unwired and refuses `wallet.embedded_provider_unwired`. No vendor SDK is in this build.
 */

export interface ProviderWallet {
  readonly walletId: string;
  readonly address: Address;
  /** The INTAFACED person the provider bound the wallet to. */
  readonly ownerRef: string;
}

export interface EmbeddedWalletProviderAdapter {
  readonly info: ProtocolEmbeddedWalletProvider;
  /**
   * Makes the person's one wallet, bound to their passkey, or returns the one the provider already holds for them (the
   * provider is idempotent on `ownerRef` and on `idempotencyKey`). Throws `ProviderUnavailableError` when it cannot be
   * reached or answers with an error.
   */
  createWallet(input: { ownerRef: string; idempotencyKey: string; passkey: EmbeddedWalletPasskey }): Promise<ProviderWallet>;
  /** Reads one wallet back; null when the provider has no such wallet. */
  getWallet(walletId: string): Promise<ProviderWallet | null>;
}

/** The provider did not answer, or answered with an error. The message never carries the provider's body. */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly providerName: string,
    readonly detail: string,
  ) {
    super(`${providerName}: ${detail}`);
    this.name = 'ProviderUnavailableError';
  }
}

/** The owner's provider setting, read once at boot. */
export type EmbeddedWalletSetting =
  | { readonly kind: 'unset' }
  | { readonly kind: 'unwired'; readonly id: EmbeddedWalletProviderId }
  | { readonly kind: 'ready'; readonly adapter: EmbeddedWalletProviderAdapter };

export const TEST_PROVIDER_DISPLAY_NAME = 'TEST wallet provider';
/** How long svc-protocol waits for the provider before it says the provider is down. */
export const PROVIDER_TIMEOUT_MS = 8000;

/**
 * `PROTOCOL_EMBEDDED_WALLET_PROVIDER`, read once at boot. Blank is unset: creating refuses
 * `wallet.embedded_provider_unset`. `TEST:test` is the labelled TEST provider and refuses to boot unless the RAW
 * `APP_ENV` is exactly dev or test (a TEST provider copied to staging never passes for a real one); it needs
 * `PROTOCOL_EMBEDDED_WALLET_TEST_URL`, a loopback URL. `privy` or `turnkey` are known and unwired in this build. Anything
 * else refuses to boot, so a mistyped provider never reads as unset.
 */
export function embeddedWalletFromSetting(
  raw: string | undefined,
  testUrl: string | undefined,
  rawAppEnv: string | undefined,
  fetcher: typeof fetch = fetch,
): EmbeddedWalletSetting {
  const value = raw?.trim() ?? '';
  if (!value) return { kind: 'unset' };
  const test = /^TEST:/i.exec(value);
  if (test) {
    if (!isExplicitDevOrTest(rawAppEnv))
      throw new Error(
        `PROTOCOL_EMBEDDED_WALLET_PROVIDER is a TEST value but APP_ENV=${rawAppEnv ?? '(unset)'} is not the local test stack. Refusing to boot.`,
      );
    const id = value.slice(test[0].length).trim();
    if (id !== 'test')
      throw new Error(`PROTOCOL_EMBEDDED_WALLET_PROVIDER=TEST:${id} names no TEST provider; the only one is TEST:test. Refusing to boot.`);
    return { kind: 'ready', adapter: testProviderAdapter(requireLoopbackUrl(testUrl), fetcher) };
  }
  if (value === 'privy' || value === 'turnkey') return { kind: 'unwired', id: value };
  if (value === 'test')
    throw new Error('PROTOCOL_EMBEDDED_WALLET_PROVIDER=test must be written TEST:test, and only on the local test stack. Refusing to boot.');
  throw new Error(`PROTOCOL_EMBEDDED_WALLET_PROVIDER="${value}" is not a provider this build knows (privy, turnkey). Refusing to boot.`);
}

function requireLoopbackUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PROTOCOL_EMBEDDED_WALLET_TEST_URL must be the TEST provider’s URL when the provider is TEST:test. Refusing to boot.');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('PROTOCOL_EMBEDDED_WALLET_TEST_URL must be a loopback http URL: the TEST provider is never reached over a network. Refusing to boot.');
  return url.origin;
}

function readWallet(body: unknown): ProviderWallet | null {
  if (!body || typeof body !== 'object') return null;
  const { walletId, address, ownerRef } = body as Record<string, unknown>;
  if (typeof walletId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(walletId)) return null;
  if (typeof address !== 'string' || !isAddress(address, { strict: false })) return null;
  if (typeof ownerRef !== 'string' || !ownerRef) return null;
  // Only these three fields leave this function: anything else the provider sent is dropped, never stored or logged.
  return { walletId, address: getAddress(address), ownerRef };
}

/**
 * The labelled TEST provider's server-side adapter. It speaks to the TEST provider process's `/server/*` routes over
 * loopback. The process holds every TEST key in its own memory, never in a svc-* database or log.
 */
export function testProviderAdapter(origin: string, fetcher: typeof fetch = fetch): EmbeddedWalletProviderAdapter {
  const info: ProtocolEmbeddedWalletProvider = {
    id: 'test',
    displayName: TEST_PROVIDER_DISPLAY_NAME,
    test: true,
    capabilities: { export: true, recovery: true },
  };
  const call = async (path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> => {
    let res: Response;
    try {
      res = await fetcher(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    } catch {
      throw new ProviderUnavailableError(info.displayName, 'did not answer');
    }
    if (res.status >= 500) throw new ProviderUnavailableError(info.displayName, `answered ${res.status}`);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      throw new ProviderUnavailableError(info.displayName, 'answered with something that is not JSON');
    }
    return { status: res.status, body };
  };
  return {
    info,
    async createWallet(input) {
      const { status, body } = await call('/server/wallets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const wallet = status === 200 ? readWallet(body) : null;
      if (!wallet) throw new ProviderUnavailableError(info.displayName, `refused to make the wallet (${status})`);
      return wallet;
    },
    async getWallet(walletId) {
      const { status, body } = await call(`/server/wallets/${encodeURIComponent(walletId)}`);
      if (status === 404) return null;
      const wallet = status === 200 ? readWallet(body) : null;
      if (!wallet) throw new ProviderUnavailableError(info.displayName, `answered ${status} for a wallet read`);
      return wallet;
    },
  };
}
