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
  readonly address: Address;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  /** True only after this refresh re-read a receipt that still contains the transfer. */
  readonly inReceipt: boolean;
}

/**
 * The outbound transaction was included, and the receipt is not a success.
 * The hash may already be in the broadcast journal — it left this process —
 * but `send` must not hand it back as a completed transfer.
 */
export class EvmSendRevertedError extends Error {
  readonly code = 'pay.evm_send_reverted';
  readonly txHash: string;
  readonly status: string;

  constructor(txHash: string, status: string) {
    super(
      `Outbound transaction ${txHash} receipt status is ${status} — refusing to report the send as success`,
    );
    this.name = 'EvmSendRevertedError';
    this.txHash = txHash;
    this.status = status;
  }
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
  /** One row per address + tx + log. An address holds every inbound. */
  private readonly observed = new Map<string, ObservedInbound>();
  /** Observation keys already handed to the watcher after webhook 2xx/202. */
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
    const addr = getAddress(address).toLowerCase();
    const matches = [...this.observed.values()]
      .filter((observed) => observed.address.toLowerCase() === addr && observed.inReceipt)
      .sort(compareObserved);
    const observed = matches[0];
    if (!observed) return null;
    return toTransfer(observed);
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

    // Owner depth, not viem's one-block default. A non-success receipt is a refusal.
    const receipt = await this.public.waitForTransactionReceipt({
      hash: stored as Hex,
      confirmations: this.minConfirmations,
    });
    if (receipt.status !== 'success') {
      throw new EvmSendRevertedError(stored, receipt.status);
    }
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

    // An empty watch set must not move the cursor to tip+1. The first refresh
    // after a restart often runs before open payments are registered again;
    // jumping the cursor would discard the lookback and skip native deposits
    // already mined. The cursor stays at the lookback until a later refresh
    // has addresses and scans those blocks.
    if (this.byAddress.size === 0) {
      await this.recomputeConfirmations();
      return;
    }

    // ERC-20 logs use the cursor this refresh is about to walk, including the
    // first-refresh lookback. The loop moves scanCursor to tip+1; reading it
    // afterward would request an empty range and drop every Transfer in it.
    const erc20FromBlock = this.scanCursor;

    while (this.scanCursor <= this.tip) {
      const block = await this.public.getBlock({ blockNumber: this.scanCursor, includeTransactions: true });
      // Read the watch set for this block. acceptanceAddress may add an address
      // during the awaited getBlock; a snapshot taken before the walk would
      // miss it on every block still ahead while the cursor still advances.
      for (const tx of block.transactions) {
        if (typeof tx === 'string') continue;
        if (!tx.to) continue;
        const to = tx.to.toLowerCase();
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

    await this.scanErc20(erc20FromBlock);
    await this.recomputeConfirmations();
  }

  /**
   * Transfers that have reached `minConfirmations` and have not yet been
   * successfully delivered by the watcher. **Does not mark** — call
   * `markFinalizedEmitted` only after webhook 2xx/202 so a failed POST retries.
   *
   * Tip distance is not enough. An observation is omitted when this refresh
   * did not re-read a receipt that still contains the transfer.
   */
  drainFinalized(): FinalizedInbound[] {
    const ready = [...this.observed.entries()]
      .filter(([key, observed]) => {
        if (!observed.inReceipt) return false;
        if (observed.confirmations < this.minConfirmations) return false;
        return !this.finalizedEmitted.has(key);
      })
      .sort((a, b) => compareObserved(a[1], b[1]));
    return ready.map(([, observed]) => ({
      address: getAddress(observed.address),
      transfer: toTransfer(observed),
      blockNumber: observed.blockNumber,
      logIndex: observed.logIndex,
    }));
  }

  /**
   * Record successful webhook delivery for one inbound at this address.
   *
   * The watcher calls this once per drained item, in cursor order. Each call
   * marks the earliest unmarked finalized inbound so a later log or a later
   * transaction to the same address is still drained.
   */
  markFinalizedEmitted(address: string): void {
    const addr = address.toLowerCase();
    const pending = [...this.observed.entries()]
      .filter(([key, observed]) => {
        if (observed.address.toLowerCase() !== addr) return false;
        if (this.finalizedEmitted.has(key)) return false;
        if (!observed.inReceipt) return false;
        return observed.confirmations >= this.minConfirmations;
      })
      .sort((a, b) => compareObserved(a[1], b[1]));
    const first = pending[0];
    if (!first) return;
    this.finalizedEmitted.add(first[0]);
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
    // Same tx and same log updates that one row. A different log index is a
    // second inbound — its amount stays. A different txHash is recorded too.
    const key = observationKey(input.address, input.txHash, input.logIndex);
    const confirmations = Number(this.tip - input.blockNumber + 1n);
    const next: ObservedInbound = {
      address: getAddress(input.address),
      txHash: input.txHash,
      from: getAddress(input.from),
      assetId: input.assetId,
      amount: input.amount,
      confirmations: confirmations < 0 ? 0 : confirmations,
      blockNumber: input.blockNumber,
      logIndex: input.logIndex,
      inReceipt: false,
    };
    this.observed.set(key, next);
  }

  private async scanErc20(fromBlock: bigint): Promise<void> {
    const erc20 = [...this.assets.values()].filter((a): a is Extract<EvmAsset, { kind: 'erc20' }> => a.kind === 'erc20');
    if (erc20.length === 0) return;
    // Nothing new since the cursor already passed the tip.
    if (fromBlock > this.tip) return;

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

  private async recomputeConfirmations(): Promise<void> {
    for (const [key, observed] of [...this.observed.entries()]) {
      const receipt = await this.receiptFor(observed.txHash as Hex);
      if (!receipt || !this.transferStillInReceipt(observed, receipt)) {
        // A dropped or reverted transfer must not age in on tip distance.
        this.observed.set(key, { ...observed, inReceipt: false, confirmations: 0 });
        continue;
      }
      const blockNumber = typeof receipt.blockNumber === 'bigint' ? receipt.blockNumber : observed.blockNumber;
      const confirmations = Number(this.tip - blockNumber + 1n);
      this.observed.set(key, {
        ...observed,
        blockNumber,
        inReceipt: true,
        confirmations: confirmations < 0 ? 0 : confirmations,
      });
    }
  }

  private async receiptFor(txHash: Hex): Promise<Awaited<ReturnType<PublicClient['getTransactionReceipt']>> | null> {
    try {
      return (await this.public.getTransactionReceipt({ hash: txHash })) ?? null;
    } catch {
      // Missing receipt, or the node did not answer. This refresh has not
      // seen the transfer, so it must not count as confirmed.
      return null;
    }
  }

  private transferStillInReceipt(
    observed: ObservedInbound,
    receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>,
  ): boolean {
    if (receipt.status !== 'success') return false;
    if (receipt.transactionHash.toLowerCase() !== observed.txHash.toLowerCase()) return false;
    const asset = this.assets.get(observed.assetId);
    if (!asset) return false;
    if (asset.kind === 'native') {
      if (receipt.to && getAddress(receipt.to).toLowerCase() !== observed.address.toLowerCase()) return false;
      return true;
    }
    for (const log of receipt.logs) {
      if (log.logIndex !== observed.logIndex) continue;
      if (!log.transactionHash || log.transactionHash.toLowerCase() !== observed.txHash.toLowerCase()) continue;
      if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase()) continue;
      const toTopic = log.topics[2];
      if (!toTopic) continue;
      const to = getAddress(`0x${toTopic.slice(26)}`);
      if (to.toLowerCase() !== observed.address.toLowerCase()) continue;
      const value = log.data && log.data !== '0x' ? BigInt(log.data) : 0n;
      if (fromChainUnits(value, asset.decimals) !== observed.amount) continue;
      return true;
    }
    return false;
  }
}

function observationKey(address: string, txHash: string, logIndex: number): string {
  return `${address.toLowerCase()}:${txHash.toLowerCase()}:${logIndex}`;
}

/** Same order as the watcher cursor: block, log index, tx hash. */
function compareObserved(a: ObservedInbound, b: ObservedInbound): number {
  if (a.blockNumber < b.blockNumber) return -1;
  if (a.blockNumber > b.blockNumber) return 1;
  if (a.logIndex !== b.logIndex) return a.logIndex < b.logIndex ? -1 : 1;
  if (a.txHash.toLowerCase() === b.txHash.toLowerCase()) return 0;
  return a.txHash.toLowerCase() < b.txHash.toLowerCase() ? -1 : 1;
}

function toTransfer(observed: ObservedInbound): ConfirmedTransfer {
  return {
    txHash: observed.txHash,
    from: observed.from,
    assetId: observed.assetId,
    amount: observed.amount,
    confirmations: observed.confirmations,
  };
}

/** Stable HD slot for a payment and asset. The book, not this function, owns occupancy. */
export function stableDepositIndex(paymentId: string, assetId: string): number {
  const digest = keccak256(toBytes(`${paymentId}:${assetId}`));
  return Number(BigInt(digest) & 0x7fff_ffffn);
}

function deriveDepositAddress(mnemonic: string, index: number): Address {
  return mnemonicToAccount(mnemonic, { addressIndex: index }).address;
}

/**
 * Host stays so an operator can see which endpoint failed.
 * Userinfo, every path segment, and the query are blank: providers put the
 * key in the last segment (`/v2/<key>`), in a single segment (`/<key>`),
 * or in the query (`?apikey=`). This string is what `description` publishes.
 */
function redactRpc(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    if (u.pathname.split('/').filter(Boolean).length > 0) {
      u.pathname = '/***';
    }
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '(rpc)';
  }
}
