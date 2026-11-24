import { isBetaPosture, isExplicitDevOrTest } from '@intafaced/config';
import type {
  EmbeddedWalletPasskey,
  EmbeddedWalletProviderId,
  ProtocolEmbeddedWalletProvider,
} from '@intafaced/contracts/protocol-embedded-wallet';
import { getAddress, isAddress, type Address } from 'viem';
import { IDENTITY_EMBEDDED_WALLET_PROVISION } from '@intafaced/contracts/identity-embedded-wallet-procedures';
import { trpcRecordReply, trpcRecordRequest } from '@intafaced/contracts/procedure-trpc';

/**
 * THE EMBEDDED-WALLET PROVIDER INTERFACE (J-wallet-22, OWNER 237). The owner's provider makes the person's wallet and
 * keeps its key; the key signs only after the person's own passkey. svc-protocol reaches the provider through one adapter
 * and only ever asks it one thing: make (or return) the person's wallet bound to their passkey.
 * The answer carries key material, and no method here can sign: signing, export and recovery run between the
 * person's browser and the provider, never through INTAFACED.
 *
 * Adapters: `test`, the labelled TEST provider (tooling/scripts/local-test-wallet-provider.mjs), refused outside APP_ENV
 * dev or test; `turnkey`, the owner's provider, reached through svc-identity, which holds its API key
 * (`identityProvisionAdapter`): svc-protocol declares no key of any kind. `privy` is known but unwired and refuses
 * `wallet.embedded_provider_unwired`. No vendor SDK is in this build.
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
  createWallet(input: {
    ownerRef: string;
    idempotencyKey: string;
    passkey: EmbeddedWalletPasskey;
    /** The person's own edge-signed principal from this request (`forwardedPrincipalHeaders`), passed on unchanged. */
    forwarded?: Record<string, string>;
  }): Promise<ProviderWallet>;
}

/** The provider answered, and refused to make the wallet with what it was given (a 4xx): not down, and retrying won't help. */
export class ProviderRefusedError extends Error {
  constructor(
    readonly providerName: string,
    readonly status: number,
  ) {
    super(`${providerName}: refused (${status})`);
    this.name = 'ProviderRefusedError';
  }
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
 * `APP_ENV` is exactly dev or test, or the process is in the beta posture (`rawBetaPosture`: raw
 * `INTAFACED_BETA_POSTURE` `test-networks` beside APP_ENV `staging`), where it stays labelled TEST and never passes for a real
 * one; it needs
 * `PROTOCOL_EMBEDDED_WALLET_TEST_URL`, a loopback URL. `TEST:test-no-export` is the same TEST provider standing in for a
 * provider whose plan offers no key export (J-wallet-22 #5): it reports `export: false`, so the room says so. `turnkey` is the
 * owner's provider, made through svc-identity at `identityUrl`, refusing to boot when that is blank. `privy` is
 * known and unwired in this build. Anything
 * else refuses to boot, so a mistyped provider never reads as unset.
 */
export function embeddedWalletFromSetting(
  raw: string | undefined,
  testUrl: string | undefined,
  rawAppEnv: string | undefined,
  fetcher: typeof fetch = fetch,
  rawBetaPosture?: string,
  identityUrl?: string,
): EmbeddedWalletSetting {
  const value = raw?.trim() ?? '';
  if (!value) return { kind: 'unset' };
  const test = /^TEST:/i.exec(value);
  if (test) {
    if (!isExplicitDevOrTest(rawAppEnv) && !isBetaPosture(rawAppEnv, rawBetaPosture))
      throw new Error(
        `PROTOCOL_EMBEDDED_WALLET_PROVIDER is a TEST value but APP_ENV=${rawAppEnv ?? '(unset)'} is neither the local test stack nor the beta posture. Refusing to boot.`,
      );
    const id = value.slice(test[0].length).trim();
    if (id !== 'test' && id !== 'test-no-export')
      throw new Error(
        `PROTOCOL_EMBEDDED_WALLET_PROVIDER=TEST:${id} names no TEST provider; the only ones are TEST:test and TEST:test-no-export. Refusing to boot.`,
      );
    return { kind: 'ready', adapter: testProviderAdapter(requireLoopbackUrl(testUrl), fetcher, { export: id === 'test' }) };
  }
  if (value === 'turnkey') return { kind: 'ready', adapter: identityProvisionAdapter(requireIdentityUrl(identityUrl), fetcher) };
  if (value === 'privy') return { kind: 'unwired', id: value };
  if (value === 'test')
    throw new Error(
      'PROTOCOL_EMBEDDED_WALLET_PROVIDER=test must be written TEST:test, and only on the local test stack. Refusing to boot.',
    );
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
    throw new Error(
      'PROTOCOL_EMBEDDED_WALLET_TEST_URL must be a loopback http URL: the TEST provider is never reached over a network. Refusing to boot.',
    );
  return url.origin;
}

function requireIdentityUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch {
    // refused below
  }
  throw new Error(
    'PROTOCOL_EMBEDDED_WALLET_PROVIDER=turnkey needs IDENTITY_URL, svc-identity’s URL, which holds the provider’s key. Refusing to boot.',
  );
}

/** The room names where the key is kept without naming the vendor (user-facing copy names no partner). */
const OWNER_PROVIDER_DISPLAY_NAME = 'your wallet provider';

/**
 * The owner's provider (`turnkey`), reached through svc-identity's `embeddedWallet.provision`, which holds the provider's
 * API key. The call carries the person's own edge-signed principal, so svc-identity makes the wallet for that person
 * only; without one nothing is asked. A 409 is the provider refusing the passkey; any other failure is down.
 */
export function identityProvisionAdapter(identityUrl: string, fetcher: typeof fetch = fetch): EmbeddedWalletProviderAdapter {
  const info: ProtocolEmbeddedWalletProvider = {
    id: 'turnkey',
    displayName: OWNER_PROVIDER_DISPLAY_NAME,
    test: false,
    // Export and a second passkey run in the provider's own browser flow, which this build's page does not carry yet:
    // the room says so in words instead of offering a button that fails.
    capabilities: { export: false, recovery: false },
  };
  return {
    info,
    async createWallet(input) {
      if (!input.forwarded || Object.keys(input.forwarded).length === 0)
        throw new ProviderUnavailableError(info.displayName, 'was not asked: no signed-in person on this request');
      const sent = trpcRecordRequest(IDENTITY_EMBEDDED_WALLET_PROVISION, identityUrl, { passkey: input.passkey });
      let res: Response;
      try {
        res = await fetcher(sent.url, {
          method: sent.method,
          headers: { 'content-type': 'application/json', ...input.forwarded },
          body: sent.body,
          // svc-identity waits up to PROVIDER_TIMEOUT_MS for the provider itself.
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS + 2000),
        });
      } catch {
        throw new ProviderUnavailableError(info.displayName, 'did not answer');
      }
      if (res.status === 409) throw new ProviderRefusedError(info.displayName, res.status);
      if (!res.ok) throw new ProviderUnavailableError(info.displayName, `answered ${res.status}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ProviderUnavailableError(info.displayName, 'answered with something that is not JSON');
      }
      const reply = trpcRecordReply(IDENTITY_EMBEDDED_WALLET_PROVISION, body);
      const wallet = reply && readWallet(reply);
      if (!wallet) throw new ProviderUnavailableError(info.displayName, 'answered with no wallet');
      return wallet;
    },
  };
}

function readWallet(body: unknown): ProviderWallet | null {
  if (!body || typeof body !== 'object') return null;
  const { walletId, address, ownerRef } = body as Record<string, unknown>;
  if (typeof walletId !== 'string' || !/^[A-Za-z0-9_/-]{1,160}$/.test(walletId)) return null;
  if (typeof address !== 'string' || !isAddress(address, { strict: false })) return null;
  if (typeof ownerRef !== 'string' || !ownerRef) return null;
  // Only these three fields leave this function: anything else the provider sent is dropped, never stored or logged.
  return { walletId, address: getAddress(address), ownerRef };
}

/**
 * The labelled TEST provider's server-side adapter. It speaks to the TEST provider process's `/server/*` routes over
 * loopback. The process holds every TEST key itself (memory and its own state file), never in a svc-* database or log.
 */
export function testProviderAdapter(
  origin: string,
  fetcher: typeof fetch = fetch,
  offers: { export: boolean } = { export: true },
): EmbeddedWalletProviderAdapter {
  const info: ProtocolEmbeddedWalletProvider = {
    id: 'test',
    displayName: TEST_PROVIDER_DISPLAY_NAME,
    test: true,
    capabilities: { export: offers.export, recovery: true },
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
      if (status >= 400) throw new ProviderRefusedError(info.displayName, status);
      const wallet = status === 200 ? readWallet(body) : null;
      if (!wallet) throw new ProviderUnavailableError(info.displayName, `answered ${status} with no wallet`);
      return wallet;
    },
  };
}
