import {
  embeddedWalletKey,
  type EmbeddedWalletPasskey,
  type EmbeddedWalletProviderId,
  type ProtocolEmbeddedWalletProvider,
  type ProtocolEmbeddedWalletRefusal,
} from '@intafaced/contracts/protocol-embedded-wallet';
import { getAddress, type Address } from 'viem';
import {
  OWNER_PROVIDER_INFO,
  ProviderRefusedError,
  ProviderUnavailableError,
  testProviderInfo,
  type EmbeddedWalletSetting,
} from './provider.js';

/**
 * THE EMBEDDED SELF-CUSTODY WALLET (J-wallet-22, OWNER 237): one wallet per person, made with a passkey and no seed
 * phrase, whose key the owner's provider keeps and signs with only after the person's passkey.
 *
 *   1. `embeddedWalletStatus` names the provider (where the key is kept) and the person's wallet, if any.
 *   2. `createEmbeddedWallet` refuses a blank provider setting (`wallet.embedded_provider_unset`) before anything is made,
 *      returns the person's existing wallet without asking the provider, else asks the provider for the person's wallet
 *      bound to their passkey, checks the provider bound it to this person, and records the address and the provider's
 *      wallet id under the business key `wallet:embedded:<personId>`. A replay or a second press gives the same wallet:
 *      the store keeps one row per person and returns the first, and the provider is idempotent on the person too.
 *
 * Region blocks run before any of this, in the procedure's jurisdiction guard (OWNER 237). The record holds no key
 * material and there is no method here that signs: INTAFACED moves nothing and the ledger posts nothing.
 */

export const EMBEDDED_PROVIDER_UNSET = 'wallet.embedded_provider_unset' as const;
export const EMBEDDED_PROVIDER_UNWIRED = 'wallet.embedded_provider_unwired' as const;
export const EMBEDDED_PROVIDER_DOWN = 'wallet.embedded_provider_down' as const;
export const EMBEDDED_WALLET_MISMATCH = 'wallet.embedded_wallet_mismatch' as const;

export class EmbeddedWalletRefusedError extends Error {
  constructor(
    readonly code: ProtocolEmbeddedWalletRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'EmbeddedWalletRefusedError';
  }
}

export interface EmbeddedWalletRow {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly provider: EmbeddedWalletProviderId;
  readonly providerWalletId: string;
  readonly address: Address;
  readonly test: boolean;
  readonly createdAt: Date;
}

export interface EmbeddedWalletStore {
  /** The person's one wallet; null when they have none. */
  find(userId: string): Promise<EmbeddedWalletRow | null>;
  /**
   * Records the wallet under its business key. When the person already has one, writes nothing and returns that one with
   * `created: false`.
   */
  insert(row: EmbeddedWalletRow): Promise<{ row: EmbeddedWalletRow; created: boolean }>;
}

export class MemoryEmbeddedWalletStore implements EmbeddedWalletStore {
  readonly rows = new Map<string, EmbeddedWalletRow>();
  async find(userId: string) {
    return this.rows.get(embeddedWalletKey(userId)) ?? null;
  }
  async insert(row: EmbeddedWalletRow) {
    const existing = this.rows.get(row.idempotencyKey);
    if (existing) return { row: existing, created: false };
    this.rows.set(row.idempotencyKey, row);
    return { row, created: true };
  }
}

export interface EmbeddedWalletDeps {
  store: EmbeddedWalletStore;
  /** The owner's provider setting, read at boot. */
  setting: () => EmbeddedWalletSetting;
}

/** The provider the room names, or null while the owner's setting is blank. An unwired provider is named too. */
export function providerInfo(setting: EmbeddedWalletSetting): ProtocolEmbeddedWalletProvider | null {
  if (setting.kind === 'unset') return null;
  if (setting.kind === 'unwired')
    return { id: setting.id, displayName: 'your wallet provider', test: false, capabilities: { export: false, recovery: false } };
  return setting.adapter.info;
}

/**
 * Where a recorded wallet's key is kept: its own provider, whatever the setting names today. A wallet made at the TEST
 * provider stays TEST and signs there after the setting moves to the owner's provider, so a stack switched to it keeps
 * its testers' wallets; the room picks its signing client from this, so naming the setting's provider would send every signature to
 * a provider that holds no key for the wallet.
 */
function keptAt(row: EmbeddedWalletRow, setting: EmbeddedWalletSetting): ProtocolEmbeddedWalletProvider | null {
  if (setting.kind === 'ready' && setting.adapter.info.id === row.provider) return setting.adapter.info;
  if (row.provider === 'test') return testProviderInfo();
  if (row.provider === 'turnkey') return OWNER_PROVIDER_INFO;
  return { id: row.provider, displayName: 'your wallet provider', test: row.test, capabilities: { export: false, recovery: false } };
}

/** The provider the room names: the one keeping the person's wallet, else the setting's (null while it is blank). */
export async function embeddedWalletStatus(deps: EmbeddedWalletDeps, userId: string) {
  const setting = deps.setting();
  const wallet = await deps.store.find(userId);
  return { provider: wallet ? keptAt(wallet, setting) : providerInfo(setting), wallet };
}

function readyAdapter(setting: EmbeddedWalletSetting) {
  if (setting.kind === 'unset')
    throw new EmbeddedWalletRefusedError(
      EMBEDDED_PROVIDER_UNSET,
      'No embedded-wallet provider is set, so no wallet can be made. Nothing was made.',
    );
  if (setting.kind === 'unwired')
    throw new EmbeddedWalletRefusedError(
      EMBEDDED_PROVIDER_UNWIRED,
      'The wallet provider that is set has no adapter in this build yet, so no wallet can be made. Nothing was made.',
    );
  return setting.adapter;
}

export async function createEmbeddedWallet(
  deps: EmbeddedWalletDeps,
  input: { userId: string; passkey: EmbeddedWalletPasskey; forwarded?: Record<string, string> },
  now: Date = new Date(),
): Promise<{ row: EmbeddedWalletRow; created: boolean }> {
  const adapter = readyAdapter(deps.setting());
  // One wallet per person: the one already recorded comes back, and the provider is not asked again.
  const existing = await deps.store.find(input.userId);
  if (existing) return { row: existing, created: false };
  const idempotencyKey = embeddedWalletKey(input.userId);
  let wallet;
  try {
    wallet = await adapter.createWallet({
      ownerRef: input.userId,
      idempotencyKey,
      passkey: input.passkey,
      ...(input.forwarded ? { forwarded: input.forwarded } : {}),
    });
  } catch (err) {
    if (err instanceof ProviderRefusedError)
      throw new EmbeddedWalletRefusedError(
        EMBEDDED_WALLET_MISMATCH,
        `Your wallet provider (${err.providerName}) would not make a wallet with this passkey, so nothing was made or recorded. Try again with a new passkey.`,
      );
    if (err instanceof ProviderUnavailableError)
      throw new EmbeddedWalletRefusedError(
        EMBEDDED_PROVIDER_DOWN,
        `Your wallet provider (${err.providerName}) is not answering, so no wallet was made. Nothing was made or recorded.`,
      );
    throw err;
  }
  // The provider must have bound the wallet to this person. A wallet bound to anyone else is never recorded.
  if (wallet.ownerRef !== input.userId)
    throw new EmbeddedWalletRefusedError(
      EMBEDDED_WALLET_MISMATCH,
      'Your wallet provider returned a wallet that is not yours, so nothing was recorded.',
    );
  return deps.store.insert({
    userId: input.userId,
    idempotencyKey,
    provider: adapter.info.id,
    providerWalletId: wallet.walletId,
    address: getAddress(wallet.address),
    test: adapter.info.test,
    createdAt: now,
  });
}
