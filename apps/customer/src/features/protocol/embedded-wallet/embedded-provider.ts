import { parseChainId, toHexChainId, type Eip1193Provider, type WalletInfo } from '../../../shared/eip1193';
import { APP_CHAIN_ID } from '../wallet/eip1193';
import type { ChainReadMethod, ClientFailure, EmbeddedWalletClient } from './provider-client';

/**
 * The person's own embedded wallet (J-wallet-22) as a browser wallet: an EIP-1193 provider the page announces by
 * EIP-6963, so Money's wallet panel and the venue desks find it, connect it and ask it to sign exactly as they ask an
 * extension wallet. Every signature is the provider client's, after the person's passkey; no key is held here, and
 * nothing new is sent to any INTAFACED service (the client talks only to the person's provider).
 *
 * The chain: an embedded key signs for any chain, so the provider starts on the app's chain and accepts a switch to any
 * chain the room names (`wallet_switchEthereumChain`). It reads and sends only on the chain its provider's own
 * connection is on: a read or a send on another chain is refused (4901), never answered from the wrong chain.
 */

/** An EIP-1193 error: `code` is the standard's (4001 rejected, 4100 unauthorised, 4200 unsupported, 4900/4901 disconnected). */
export class ProviderRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderRpcError';
  }
}

export const USER_REJECTED = 4001;
export const UNAUTHORIZED = 4100;
export const UNSUPPORTED_METHOD = 4200;
export const DISCONNECTED = 4900;
export const CHAIN_DISCONNECTED = 4901;
const INTERNAL = -32603;
const INVALID_PARAMS = -32602;

/** A provider client's failure as the EIP-1193 error a dapp reads: a passkey that did not pass is the person's no. */
export function failureError(failure: ClientFailure): ProviderRpcError {
  switch (failure) {
    case 'passkey':
      return new ProviderRpcError(USER_REJECTED, 'The passkey check did not pass. Nothing was signed or sent.');
    case 'refused':
      return new ProviderRpcError(UNAUTHORIZED, 'The wallet provider refused the passkey check. Nothing was signed or sent.');
    case 'unsupported':
      return new ProviderRpcError(UNSUPPORTED_METHOD, 'This wallet cannot sign or send here yet. Nothing was signed or sent.');
    case 'down':
      return new ProviderRpcError(DISCONNECTED, 'The wallet provider is not answering. Nothing was signed or sent.');
    case 'chain':
      return new ProviderRpcError(INTERNAL, 'The chain refused this transaction before it was sent. Nothing was sent.');
    case 'spent':
      return new ProviderRpcError(INTERNAL, 'The wallet provider refused this request. Nothing was signed or sent.');
  }
}

/** The chain reads passed to the provider's own connection; none of them signs or sends. `eth_chainId` is the wallet's own. */
const READS: ReadonlySet<string> = new Set<ChainReadMethod>([
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBalance',
  'eth_call',
  'eth_getTransactionReceipt',
  'eth_getTransactionCount',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
]);

export interface EmbeddedProviderOptions {
  client: EmbeddedWalletClient;
  /** The provider's own id for the wallet (svc-protocol's record). */
  walletId: string;
  /** The wallet's address, as svc-protocol records it. */
  address: string;
  /** Where the wallet starts. Default: the app's chain. */
  chainId?: number;
  /** Whether this page already connected it (eth_accounts answers it without a prompt). */
  authorised?: boolean;
  /** Called when the page connects it, so a later room's restore finds it connected. */
  onAuthorised?: () => void;
}

type Listener = (...args: unknown[]) => void;

const sameAddress = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const isHex = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v);

export function embeddedProvider(options: EmbeddedProviderOptions): Eip1193Provider {
  const { client, walletId } = options;
  const address = options.address.toLowerCase();
  let chainId = options.chainId ?? APP_CHAIN_ID;
  let authorised = options.authorised ?? false;
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  // The chain the provider's own connection reads and sends on, asked once; null when it does not answer.
  let connected: Promise<number | null> | null = null;
  const connectionChain = () => {
    connected ??= client.read('eth_chainId', []).then(parseChainId, () => null);
    return connected.then((id) => {
      if (id === null) connected = null; // not answered: ask again next time
      return id;
    });
  };
  const onConnectionChain = async (what: string) => {
    const on = await connectionChain();
    if (on === null)
      throw new ProviderRpcError(DISCONNECTED, `The wallet provider's chain connection is not answering, so the ${what} was not made.`);
    if (on !== chainId)
      throw new ProviderRpcError(
        CHAIN_DISCONNECTED,
        `The wallet provider's connection is on chain ${on}, not ${chainId}: the ${what} was not made.`,
      );
  };
  const requireAccount = (account: unknown) => {
    if (!authorised) throw new ProviderRpcError(UNAUTHORIZED, 'Connect the wallet first. Nothing was signed or sent.');
    if (!sameAddress(account, address))
      throw new ProviderRpcError(UNAUTHORIZED, `This wallet signs only for ${address}. Nothing was signed.`);
  };
  const list = (params: unknown): unknown[] => (Array.isArray(params) ? params : []);

  async function request({ method, params }: { method: string; params?: unknown[] | object }): Promise<unknown> {
    const args = list(params);
    switch (method) {
      case 'eth_requestAccounts':
        if (!authorised) {
          authorised = true;
          options.onAuthorised?.();
          emit('connect', { chainId: toHexChainId(chainId) });
        }
        return [address];
      case 'eth_accounts':
        return authorised ? [address] : [];
      case 'eth_chainId':
        return toHexChainId(chainId);
      case 'wallet_switchEthereumChain': {
        const asked = parseChainId((args[0] as { chainId?: unknown } | undefined)?.chainId);
        if (asked === null || asked <= 0) throw new ProviderRpcError(INVALID_PARAMS, 'Name the chain to switch to as a hex chain id.');
        if (asked !== chainId) {
          chainId = asked;
          emit('chainChanged', toHexChainId(chainId));
        }
        return null;
      }
      case 'eth_signTypedData_v4': {
        requireAccount(args[0]);
        let typedData: unknown;
        try {
          typedData = typeof args[1] === 'string' ? JSON.parse(args[1]) : args[1];
        } catch {
          throw new ProviderRpcError(INVALID_PARAMS, 'The typed data is not JSON. Nothing was signed.');
        }
        if (!typedData || typeof typedData !== 'object')
          throw new ProviderRpcError(INVALID_PARAMS, 'No typed data to sign. Nothing was signed.');
        const signed = await client.signTypedData(walletId, typedData);
        if (!signed.ok) throw failureError(signed.failure);
        if (!sameAddress(signed.data.address, address))
          throw new ProviderRpcError(INTERNAL, 'The wallet provider signed with another address. The signature was not used.');
        return signed.data.signature;
      }
      case 'personal_sign': {
        requireAccount(args[1]);
        if (!isHex(args[0])) throw new ProviderRpcError(INVALID_PARAMS, 'The message must be hex-encoded. Nothing was signed.');
        const signed = await client.signMessage(walletId, utf8Of(args[0]));
        if (!signed.ok) throw failureError(signed.failure);
        if (!sameAddress(signed.data.address, address))
          throw new ProviderRpcError(INTERNAL, 'The wallet provider signed with another address. The signature was not used.');
        return signed.data.signature;
      }
      case 'eth_sendTransaction': {
        const tx = (args[0] ?? {}) as Record<string, unknown>;
        requireAccount(tx.from);
        if (typeof tx.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(tx.to))
          throw new ProviderRpcError(INVALID_PARAMS, 'A transaction needs a contract or address to send to. Nothing was sent.');
        // The provider prices the transaction from the chain and sends one per nonce: a chosen fee or a replacement's
        // nonce would be dropped, so it is refused rather than sent differently from what the person reviewed.
        if (['gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce'].some((field) => tx[field] !== undefined))
          throw new ProviderRpcError(
            UNSUPPORTED_METHOD,
            'This wallet sets the network fee and nonce itself, so a chosen fee or a replacement is not offered. Nothing was sent.',
          );
        if (tx.chainId !== undefined && parseChainId(tx.chainId) !== chainId)
          throw new ProviderRpcError(CHAIN_DISCONNECTED, `The transaction names another chain than ${chainId}. Nothing was sent.`);
        if ((tx.data !== undefined && !isHex(tx.data)) || (tx.value !== undefined && !isHex(tx.value)))
          throw new ProviderRpcError(INVALID_PARAMS, 'The data and value must be hex. Nothing was sent.');
        await onConnectionChain('transaction');
        const count = quantity(await client.read('eth_getTransactionCount', [address, 'pending']));
        if (count === null) throw new ProviderRpcError(DISCONNECTED, "The wallet's nonce could not be read. Nothing was sent.");
        const sent = await client.sendTransaction(walletId, {
          chainId,
          to: tx.to,
          data: (tx.data as string | undefined) ?? '0x',
          value: (tx.value as string | undefined) ?? '0x0',
          nonce: count,
        });
        if (!sent.ok) throw failureError(sent.failure);
        return sent.data.hash;
      }
      default: {
        if (!READS.has(method)) throw new ProviderRpcError(UNSUPPORTED_METHOD, `This wallet does not offer ${method}.`);
        await onConnectionChain('read');
        const result = await client.read(method as ChainReadMethod, args);
        if (result === null) throw new ProviderRpcError(DISCONNECTED, `The wallet provider could not answer ${method}.`);
        return result;
      }
    }
  }

  return {
    request,
    on(event, listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
  };
}

/** A hex quantity (`0x0` included) as a number; null for anything else. */
function quantity(value: unknown): number | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function utf8Of(hex: string): string {
  const body = hex.slice(2);
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

/** The wallet's EIP-6963 name for discovery. The rdns is what a room remembers it by. */
export const EMBEDDED_WALLET_RDNS = 'com.intafaced.wallet';
/** A plain square mark, inline (discovery shows only inline images); it takes no colour of its own. */
export const EMBEDDED_WALLET_ICON =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"%3E%3Crect width="32" height="32" rx="8"/%3E%3C/svg%3E';

export interface Announced {
  info: WalletInfo;
  provider: Eip1193Provider;
}

/** One EIP-6963 announcement of the wallet on `target`, as a wallet answers `eip6963:requestProvider`. */
export function announce(target: Pick<Window, 'dispatchEvent'>, detail: Announced): void {
  target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ ...detail }) }));
}
