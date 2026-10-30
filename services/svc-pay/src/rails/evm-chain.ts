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
import type { Amount } from '@intafaced/ledger-client';
import type { BroadcastStore } from './broadcast-store.js';
import { SignerChainRefusedError, type EvmSigner } from './evm-signer.js';
import { DepositSourceChainRefusedError, type DepositAddressSource } from './deposit-source.js';
import { runDurableBroadcast } from './durable-broadcast.js';
import { ERC20_TRANSFER_TOPIC, fromChainUnits, requireAsset, toChainUnits, type EvmAsset } from './evm-assets.js';
import type { ChainSendLookup, ChainSendRequest, ConfirmedTransfer, CryptoChainPort } from './chain-port.js';

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
 * Acceptance addresses come from an injected `DepositAddressSource` (no seed phrase in settings). The testnet source derives at
 * path `m/44'/60'/0'/<high>/<low>`, where `high` and `low` are the two 31-bit
 * halves (bits 31-61 and 0-30) of keccak256(`${paymentId}:${assetId}`). The
 * address is a pure function of the payment, so a restart gives the same one.
 * To recover funds by hand, recompute that path from the payment id and asset.
 * Occupancy is still process-local, so a clash between two payments in one
 * process (about 2^-62 per pair) refuses rather than walking to another index.
 *
 * Outbound sends are signed by an injected `EvmSigner` (no key in settings) and
 * journalled in the `BroadcastStore`, so a retried business key never broadcasts twice.
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
  /** Hands out per-payment acceptance addresses. The seed phrase lives behind this interface, never in settings. */
  readonly deposits: DepositAddressSource;
  /** Signs outbound payouts/refunds. The key lives behind this interface, never in settings. */
  readonly signer: EvmSigner;
  readonly assets: ReadonlyMap<string, EvmAsset>;
  readonly broadcasts: BroadcastStore;
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
    super(`Outbound transaction ${txHash} receipt status is ${status} — refusing to report the send as success`);
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
  private readonly signer: EvmSigner;
  private readonly deposits: DepositAddressSource;
  private readonly assets: ReadonlyMap<string, EvmAsset>;
  private readonly broadcasts: BroadcastStore;
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
    if (!options.signer.supportsChain(options.chainId)) {
      throw new SignerChainRefusedError(options.signer.kind, options.chainId);
    }
    this.signer = options.signer;
    this.wallet = createWalletClient({ account: options.signer.account(), chain, transport });

    if (!options.deposits.supportsChain(options.chainId)) {
      throw new DepositSourceChainRefusedError(options.deposits.kind, options.chainId);
    }
    this.deposits = options.deposits;

    this.assets = options.assets;
    this.broadcasts = options.broadcasts;
    this.minConfirmations = options.minConfirmations;
    this.description =
      `live EVM chain id=${options.chainId} rpc=${redactRpc(options.rpcUrl)} ` +
      `hot=${this.signer.address} signer=${this.signer.kind} assets=[${[...this.assets.keys()].join(',')}]`;
  }

  hotWalletAddress(): Address {
    return this.signer.address;
  }

  /** Chain id only. Not `refresh()` — that scans blocks. */
  async ping(): Promise<void> {
    const id = await this.public.getChainId();
    if (id !== this.options.chainId) {
      throw new Error(`chain id ${id} does not match configured ${this.options.chainId}`);
    }
  }

  async acceptanceAddress(paymentId: string, assetId: string): Promise<string> {
    requireAsset(this.assets, assetId);
    const key = `${paymentId}\0${assetId}`;
    const existing = this.byPayment.get(key);
    if (existing) return existing.address;

    // The address is a pure function of the payment, so a restart (or another replica) hands out the same one. There is no
    // collision walk: a walk depends on which payments this process has already seen, and that order differs after a restart.
    const index = stableDepositIndex(paymentId, assetId);
    const address = this.deposits.addressFor(paymentId, assetId);
    const taken = this.byAddress.get(address.toLowerCase());
    if (taken && (taken.paymentId !== paymentId || taken.assetId !== assetId)) {
      throw new Error('Deposit address collision between two payments — refusing to hand one address to both');
    }

    const entry: AddressBookEntry = { paymentId, assetId, address, index };
    this.byPayment.set(key, entry);
    this.byAddress.set(address.toLowerCase(), entry);
    return address;
  }

  async inboundTransfer(address: string): Promise<ConfirmedTransfer | null> {
    return (await this.inboundTransfers(address))[0] ?? null;
  }

  async inboundTransfers(address: string): Promise<readonly ConfirmedTransfer[]> {
    if (!isAddress(address)) return [];
    await this.refresh();
    const addr = getAddress(address).toLowerCase();
    return [...this.observed.values()]
      .filter((observed) => observed.address.toLowerCase() === addr && observed.inReceipt)
      .sort(compareObserved)
      .map(toTransfer);
  }

  async lookupSend(idempotencyKey: string): Promise<ChainSendLookup> {
    const hash = await this.broadcasts.get(idempotencyKey);
    if (hash) return { state: 'sent', txHash: hash, amount: null, assetId: null };
    // Signed bytes are journalled before the broadcast RPC. No hash yet means
    // the send may already have left. That is not proof it did not.
    if (await this.broadcasts.hasSigned(idempotencyKey)) return { state: 'unknown' };
    return { state: 'not_sent' };
  }

  /**
   * The depth of the send journalled under this key: the block that mined it and every block since. No hash journalled, no
   * receipt yet, or a node that does not answer is `null` or 0, never a guess; a reverted receipt is `null` (it never
   * counts as confirmed).
   */
  async sendDepth(idempotencyKey: string): Promise<number | null> {
    const hash = await this.broadcasts.get(idempotencyKey);
    if (!hash) return null;
    const receipt = await this.receiptFor(hash as Hex);
    if (!receipt) return 0;
    if (receipt.status !== 'success') return null;
    const tip = await this.public.getBlockNumber();
    const depth = tip - receipt.blockNumber + 1n;
    return depth < 0n ? 0 : Number(depth);
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
            account: this.signer.account(),
            to,
            value: units,
            chain,
          });
          return this.wallet.signTransaction({ ...prepared, chain });
        }
        const prepared = await this.wallet.prepareTransactionRequest({
          account: this.signer.account(),
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

    // Keep the original range until every native block and configured token
    // scan succeeds. A failed later RPC must retry earlier observations with
    // their same transaction/log identity rather than discard the whole range.
    const fromBlock = this.scanCursor;
    const toBlock = this.tip;

    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1n) {
      const block = await this.public.getBlock({ blockNumber, includeTransactions: true });
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
    }

    await this.scanErc20(fromBlock, toBlock);
    await this.recomputeConfirmations();
    if (fromBlock <= toBlock) this.scanCursor = toBlock + 1n;
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
   * Every inbound whose transfer this refresh re-read in a receipt, finalized or not, delivered or not. The deposit record
   * follows these for confirmation progress; it moves no money. Same order as the watcher cursor.
   */
  observedInbound(): FinalizedInbound[] {
    return [...this.observed.values()]
      .filter((observed) => observed.inReceipt)
      .sort(compareObserved)
      .map((observed) => ({
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

  private async scanErc20(fromBlock: bigint, toBlock: bigint): Promise<void> {
    const erc20 = [...this.assets.values()].filter((a): a is Extract<EvmAsset, { kind: 'erc20' }> => a.kind === 'erc20');
    if (erc20.length === 0) return;
    // Nothing new since the cursor already passed the tip.
    if (fromBlock > toBlock) return;

    for (const asset of erc20) {
      const logs = await this.public.getLogs({
        address: asset.address,
        fromBlock,
        toBlock,
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

  private transferStillInReceipt(observed: ObservedInbound, receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>): boolean {
    if (receipt.status !== 'success') return false;
    if (receipt.transactionHash.toLowerCase() !== observed.txHash.toLowerCase()) return false;
    const asset = this.assets.get(observed.assetId);
    if (!asset) return false;
    if (asset.kind === 'native') {
      if (receipt.to && getAddress(receipt.to).toLowerCase() !== observed.address.toLowerCase()) return false;
      return true;
    }
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== asset.address.toLowerCase()) continue;
      if (log.logIndex !== observed.logIndex) continue;
      if (!log.transactionHash || log.transactionHash.toLowerCase() !== observed.txHash.toLowerCase()) continue;
      if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase()) continue;
      const toTopic = log.topics[2];
      const fromTopic = log.topics[1];
      if (!toTopic || !fromTopic) continue;
      const to = getAddress(`0x${toTopic.slice(26)}`);
      if (to.toLowerCase() !== observed.address.toLowerCase()) continue;
      const from = getAddress(`0x${fromTopic.slice(26)}`);
      if (from.toLowerCase() !== observed.from.toLowerCase()) continue;
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

/** Stable HD slot for a payment and asset. Process occupancy is tracked separately. */
export function stableDepositIndex(paymentId: string, assetId: string): number {
  const digest = keccak256(toBytes(`${paymentId}:${assetId}`));
  return Number(BigInt(digest) & 0x7fff_ffffn);
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
