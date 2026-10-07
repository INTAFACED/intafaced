import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Amount } from '@intafaced/ledger-client';
import type { BroadcastStore } from './broadcast-store.js';
import {
  MemoryDepositAddressBook,
  depositBookKey,
  type DepositAddressAssignment,
  type DepositAddressBook,
} from './deposit-address-book.js';
import { runDurableBroadcast } from './durable-broadcast.js';
import { ERC20_TRANSFER_TOPIC, fromChainUnits, requireAsset, toChainUnits, type EvmAsset } from './evm-assets.js';
import type { ChainSendRequest, ConfirmedTransfer, CryptoChainPort } from './chain-port.js';

/**
 * LIVE EVM implementation of `CryptoChainPort`.
 *
 * This is what turns `crypto-native` from a sandbox into a rail that can move
 * value. `posture` is `'live'` — a returned txHash is look-up-able on the node
 * this port is pointed at. Pointing it at anvil makes the rail live against a
 * local chain; pointing it at a public RPC makes it live against that chain.
 * The code does not invent a production network decision; the operator does, by
 * supplying `PAY_CRYPTO_RPC_URL` + `PAY_CRYPTO_CHAIN_ID`.
 *
 * Acceptance addresses are HD-derived from `PAY_CRYPTO_DEPOSIT_MNEMONIC` at
 * account index `n` (viem `addressIndex`) where `n` is a stable function of
 * (paymentId, assetId). The assignment is journalled in `DepositAddressBook`.
 * A new `EvmLiveChain` on the same book returns that address. Two payments
 * that collide on index walk forward until the book has a free address — the
 * walk reads the book, not a map that dies with the process.
 *
 * Outbound sends go through a hot wallet (`PAY_CRYPTO_HOT_WALLET_KEY`) and the
 * `BroadcastStore`, so a retried business key never broadcasts twice.
 */

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export interface EvmLiveChainOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly chainName?: string;
  /** BIP-39 mnemonic that derives per-payment acceptance addresses. */
  readonly depositMnemonic: string;
  /** Hex private key (0x…) for outbound payouts/refunds. */
  readonly hotWalletKey: Hex;
  readonly assets: ReadonlyMap<string, EvmAsset>;
  readonly broadcasts: BroadcastStore;
  /**
   * Shared payment→address book. Omit only for a single process (a private
   * memory book). A restarted instance must receive the same book.
   */
  readonly depositAddresses?: DepositAddressBook;
  /** How deep a transfer must be before we report it as finalized. Owner-published — never invent 6. */
  readonly minConfirmations: number;
  readonly requestTimeoutMs?: number;
}

export interface FinalizedInbound {
  readonly address: string;
  readonly transfer: ConfirmedTransfer;
  /** Block the inbound landed in — watcher cursor, not money. */
  readonly blockNumber: bigint;
  /** EVM log index, or transaction index for native value transfers. */
  readonly logIndex: number;
}

interface AddressBookEntry {
  readonly paymentId: string;
  readonly assetId: string;
  readonly address: Address;
  readonly index: number;
}

interface ObservedInbound extends ConfirmedTransfer {
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

export class EvmLiveChain implements CryptoChainPort {
  readonly posture = 'live' as const;
  readonly description: string;

  private readonly public: PublicClient;
  private readonly wallet: WalletClient;
  private readonly hotAccount: PrivateKeyAccount;
  private readonly depositMnemonic: string;
  private readonly assets: ReadonlyMap<string, EvmAsset>;
  private readonly broadcasts: BroadcastStore;
  private readonly addressBook: DepositAddressBook;
  private readonly minConfirmations: number;

  private readonly byPayment = new Map<string, AddressBookEntry>();
  private readonly byAddress = new Map<string, AddressBookEntry>();
  private readonly observed = new Map<string, ObservedInbound>();
  private readonly finalizedEmitted = new Set<string>();

  private scanCursor = 0n;
  private tip = 0n;
  private started = false;

  constructor(private readonly options: EvmLiveChainOptions) {
    if (!Number.isInteger(options.minConfirmations) || options.minConfirmations < 1) {
      throw new Error('minConfirmations is unset. Blank refuses — never 6. Owner must set a positive integer (6 is allowed if explicit).');
    }
    const chain = defineChain({
      id: options.chainId,
      name: options.chainName ?? `pay-evm-${options.chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [options.rpcUrl] } },
    });

    const transport = http(options.rpcUrl, { timeout: options.requestTimeoutMs ?? 15_000 });
    this.public = createPublicClient({ chain, transport });
    this.hotAccount = privateKeyToAccount(options.hotWalletKey);
    this.wallet = createWalletClient({ account: this.hotAccount, chain, transport });

    // Validate mnemonic early — a typo here must fail boot, not the first payment.
    mnemonicToAccount(options.depositMnemonic);
    this.depositMnemonic = options.depositMnemonic;

    this.assets = options.assets;
    this.broadcasts = options.broadcasts;
    this.addressBook = options.depositAddresses ?? new MemoryDepositAddressBook();
    this.minConfirmations = options.minConfirmations;
    this.description =
      `live EVM chain id=${options.chainId} rpc=${redactRpc(options.rpcUrl)} ` +
      `hot=${this.hotAccount.address} assets=[${[...this.assets.keys()].join(',')}]`;
  }

  hotWalletAddress(): Address {
    return this.hotAccount.address;
  }

  async acceptanceAddress(paymentId: string, assetId: string): Promise<string> {
    requireAsset(this.assets, assetId);
    await this.hydrateAddressBook();
    const key = depositBookKey(paymentId, assetId);
    const existing = this.byPayment.get(key);
    if (existing) return existing.address;

    const stored = await this.addressBook.findByPayment(paymentId, assetId);
    if (stored) {
      this.remember(stored);
      return getAddress(stored.address);
    }

    let index = stableDepositIndex(paymentId, assetId);
    for (let guard = 0; guard < 1_000; guard++, index = (index + 1) >>> 0) {
      const address = deriveDepositAddress(this.depositMnemonic, index);
      const taken = this.byAddress.get(address.toLowerCase());
      if (taken && (taken.paymentId !== paymentId || taken.assetId !== assetId)) continue;

      const claimed = await this.addressBook.claim({ paymentId, assetId, address, index });
      this.remember(claimed.entry);
      if (claimed.kind === 'taken') continue;
      if (claimed.entry.paymentId !== paymentId || claimed.entry.assetId !== assetId) {
        throw new Error('deposit address book bound a different payment');
      }
      return getAddress(claimed.entry.address);
    }
    throw new Error('Could not allocate a unique acceptance address — address book exhausted');
  }

  async inboundTransfer(address: string): Promise<ConfirmedTransfer | null> {
    if (!isAddress(address)) return null;
    await this.refresh();
    const observed = this.observed.get(getAddress(address).toLowerCase());
    if (!observed) return null;
    const { blockNumber: _b, logIndex: _l, ...transfer } = observed;
    return transfer;
  }

  async send(request: ChainSendRequest): Promise<{ txHash: string }> {
    // Class M / DIRECTION §3.1: shape-check BEFORE claim → sign → putSigned →
    // sendRaw → put hash → wait. isAddress after claim left a permanent
    // __pending__ poison on a bad `to`. Signed bytes land before any broadcast
    // RPC so crash-resume rebroadcasts the identical payload (not a second spend).
    if (!isAddress(request.to)) {
      throw new Error(`Outbound destination is not an address: ${request.to}`);
    }
    const asset = requireAsset(this.assets, request.assetId);
    const units = toChainUnits(request.amount, asset.decimals);
    if (units <= 0n) throw new Error('Outbound amount must be positive');

    const to = getAddress(request.to);
    const stored = await runDurableBroadcast({
      store: this.broadcasts,
      idempotencyKey: request.idempotencyKey,
      sign: async () => {
        const chain = this.wallet.chain;
        if (asset.kind === 'native') {
          const prepared = await this.wallet.prepareTransactionRequest({
            account: this.hotAccount,
            to,
            value: units,
            chain,
          });
          return this.wallet.signTransaction({ ...prepared, chain });
        }
        const prepared = await this.wallet.prepareTransactionRequest({
          account: this.hotAccount,
          to: asset.address,
          data: encodeFunctionData({
            abi: ERC20_TRANSFER_ABI,
            functionName: 'transfer',
            args: [to, units],
          }),
          chain,
        });
        return this.wallet.signTransaction({ ...prepared, chain });
      },
      broadcast: async (signedRaw) => this.public.sendRawTransaction({ serializedTransaction: signedRaw as Hex }),
    });

    await this.public.waitForTransactionReceipt({ hash: stored as Hex });
    return { txHash: stored };
  }

  /**
   * Advance the tip and index new inbound transfers to watched addresses.
   *
   * Safe to call from `inboundTransfer` and from the watcher loop.
   */
  async refresh(): Promise<void> {
    await this.hydrateAddressBook();
    this.tip = await this.public.getBlockNumber();
    if (!this.started) {
      const lookback = 2_000n;
      this.scanCursor = this.tip > lookback ? this.tip - lookback : 0n;
      this.started = true;
    }

    const watched = [...this.byAddress.keys()];
    if (watched.length === 0) {
      this.scanCursor = this.tip + 1n;
      this.recomputeConfirmations();
      return;
    }

    const watchedSet = new Set(watched);
    while (this.scanCursor <= this.tip) {
      const block = await this.public.getBlock({ blockNumber: this.scanCursor, includeTransactions: true });
      for (const tx of block.transactions) {
        if (typeof tx === 'string') continue;
        if (!tx.to) continue;
        const to = tx.to.toLowerCase();
        if (!watchedSet.has(to)) continue;
        const entry = this.byAddress.get(to);
        if (!entry) continue;
        const asset = this.assets.get(entry.assetId);
        if (!asset || asset.kind !== 'native') continue;
        if (tx.value === 0n) continue;

        this.record({
          address: getAddress(tx.to),
          txHash: tx.hash,
          from: tx.from,
          assetId: entry.assetId,
          amount: fromChainUnits(tx.value, asset.decimals),
          blockNumber: block.number,
          logIndex: typeof tx.transactionIndex === 'number' ? tx.transactionIndex : 0,
        });
      }
      this.scanCursor += 1n;
    }

    await this.scanErc20(watchedSet);
    this.recomputeConfirmations();
  }

  /**
   * Transfers that have reached `minConfirmations` and have not yet been
   * successfully delivered by the watcher. **Does not mark** — call
   * `markFinalizedEmitted` only after webhook 2xx/202 so a failed POST retries.
   */
  drainFinalized(): FinalizedInbound[] {
    const out: FinalizedInbound[] = [];
    for (const [address, observed] of this.observed) {
      if (observed.confirmations < this.minConfirmations) continue;
      if (this.finalizedEmitted.has(address)) continue;
      const { blockNumber, logIndex, ...transfer } = observed;
      out.push({ address: getAddress(address), transfer, blockNumber, logIndex });
    }
    return out;
  }

  /** Record successful webhook delivery so the address is not re-drained. */
  markFinalizedEmitted(address: string): void {
    // Keys in `observed` / `finalizedEmitted` are lowercased (see `record`).
    this.finalizedEmitted.add(address.toLowerCase());
  }

  /** Test helper — force the scan cursor (e.g. after anvil restart). */
  resetScan(fromBlock = 0n): void {
    this.scanCursor = fromBlock;
    this.started = true;
    this.observed.clear();
    this.finalizedEmitted.clear();
  }

  private async hydrateAddressBook(): Promise<void> {
    for (const entry of await this.addressBook.list()) this.remember(entry);
  }

  private remember(entry: DepositAddressAssignment): void {
    const address = getAddress(entry.address);
    const stored: AddressBookEntry = {
      paymentId: entry.paymentId,
      assetId: entry.assetId,
      address,
      index: entry.index,
    };
    this.byPayment.set(depositBookKey(entry.paymentId, entry.assetId), stored);
    this.byAddress.set(address.toLowerCase(), stored);
  }

  private record(input: {
    address: Address;
    txHash: Hex;
    from: Address;
    assetId: string;
    amount: Amount;
    blockNumber: bigint;
    logIndex: number;
  }): void {
    const key = input.address.toLowerCase();
    const confirmations = Number(this.tip - input.blockNumber + 1n);
    const next: ObservedInbound = {
      txHash: input.txHash,
      from: getAddress(input.from),
      assetId: input.assetId,
      amount: input.amount,
      confirmations: confirmations < 0 ? 0 : confirmations,
      blockNumber: input.blockNumber,
      logIndex: input.logIndex,
    };
    const prev = this.observed.get(key);
    if (prev && prev.txHash !== next.txHash) return;
    this.observed.set(key, next);
  }

  private async scanErc20(watchedSet: Set<string>): Promise<void> {
    const erc20 = [...this.assets.values()].filter((a): a is Extract<EvmAsset, { kind: 'erc20' }> => a.kind === 'erc20');
    if (erc20.length === 0) return;

    const window = BigInt(Math.max(this.minConfirmations * 4, 64));
    const fromBlock = this.tip > window ? this.tip - window : 0n;

    for (const asset of erc20) {
      const logs = await this.public.getLogs({
        address: asset.address,
        fromBlock,
        toBlock: this.tip,
        events: [
          {
            type: 'event',
            name: 'Transfer',
            inputs: [
              { name: 'from', type: 'address', indexed: true },
              { name: 'to', type: 'address', indexed: true },
              { name: 'value', type: 'uint256', indexed: false },
            ],
          },
        ],
      });

      for (const log of logs) {
        const toTopic = log.topics[2];
        const fromTopic = log.topics[1];
        if (!toTopic || !fromTopic || !log.transactionHash) continue;
        if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase()) continue;

        const to = getAddress(`0x${toTopic.slice(26)}`);
        if (!watchedSet.has(to.toLowerCase())) continue;
        const entry = this.byAddress.get(to.toLowerCase());
        if (!entry || entry.assetId !== asset.assetId) continue;

        const from = getAddress(`0x${fromTopic.slice(26)}`);
        const value = log.data && log.data !== '0x' ? BigInt(log.data) : 0n;
        if (value <= 0n) continue;

        this.record({
          address: to,
          txHash: log.transactionHash,
          from,
          assetId: asset.assetId,
          amount: fromChainUnits(value, asset.decimals),
          blockNumber: log.blockNumber ?? 0n,
          logIndex: typeof log.logIndex === 'number' ? log.logIndex : 0,
        });
      }
    }
  }

  private recomputeConfirmations(): void {
    for (const [key, observed] of this.observed) {
      const confirmations = Number(this.tip - observed.blockNumber + 1n);
      this.observed.set(key, {
        ...observed,
        confirmations: confirmations < 0 ? 0 : confirmations,
      });
    }
  }
}

/** Stable HD slot for a payment and asset. The book, not this function, owns occupancy. */
export function stableDepositIndex(paymentId: string, assetId: string): number {
  const digest = keccak256(toBytes(`${paymentId}:${assetId}`));
  return Number(BigInt(digest) & 0x7fff_ffffn);
}

function deriveDepositAddress(mnemonic: string, index: number): Address {
  return mnemonicToAccount(mnemonic, { addressIndex: index }).address;
}

function redactRpc(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length > 1) {
      u.pathname = `/***/${parts[parts.length - 1]}`;
    }
    return u.toString();
  } catch {
    return '(rpc)';
  }
}
