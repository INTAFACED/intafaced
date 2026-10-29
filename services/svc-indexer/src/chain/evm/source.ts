import { createPublicClient, defineChain, http } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { assertValidBlock, type ChainBlock, type ChainHead, type ChainSource, type ChainToken } from '../source.js';
import { decodeVenueLogs, type RawLog } from './decode.js';
import { ChainUnavailableError, classifyChainError, isBlockNotFound, isZeroAddress } from './availability.js';
import { lookupExplorerTx, readBlockTransactions, transactionHashes } from './explorer-txs.js';
import { readBlockInternal } from './internal-txs.js';
import { readAccount, readBalance, readTokenBalances } from './address-state.js';
import { TOKEN_READS_PER_BLOCK, TokenMetaReader } from './token-meta.js';
import { transferOf } from '../../explorer/address.js';
import { withSpan } from '../../tracing.js';

/**
 * THE REAL EVM `ChainSource` — SOCKET §13 `socket.evm-rpc`, closed here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS REAL AND WHAT IS STILL A SOCKET
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * REAL: everything in this file. It walks a chain over a real JSON-RPC endpoint,
 * reads real block hashes and real parent hashes, pulls real logs, and hands the
 * ingest loop blocks that link. The reorg machinery downstream was written
 * against `MemoryChainSource`, whose hashes this repository computes itself —
 * which proves the projection matches the design, and proves nothing about
 * whether the design survives an EVM. It does now: `evm/reorg.live.test.ts`
 * forks a real chain and asserts the orphaned rows are gone.
 *
 * STILL A SOCKET: the ABI. No audited production venue emits the three events in
 * `abi.ts` — `contracts/dev/DevVenue.sol` is a test fixture and says so.
 * `socket.clob-contracts` is that gap, and it is a contracts problem, not an
 * indexer one. This adapter does not depend on which events it decodes: swap the
 * ABI and every line below is unchanged.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READ-ONLY BY CONSTRUCTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A `PublicClient` and nothing else. There is no `WalletClient` in this service,
 * no key in `env.ts`, and no function on `venueAbi` that changes state — the ABI
 * carries three events and zero functions, so there is nothing here to call even
 * by accident (§16.10). `sovereignty.test.ts` asserts all of that over the
 * shipped tree on every run.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE DECISIONS WORTH READING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── 1. Logs are fetched BY BLOCK HASH, never by block number ────────────────
 *
 * `eth_getLogs({ blockHash })`, not `{ fromBlock, toBlock }`. This is the single
 * most important line in the file.
 *
 * Reading a header at height N and then asking for the logs *at height N* is two
 * questions about "height N", and between them the chain can reorg. The node
 * answers both, correctly, about two different blocks — and the adapter staples
 * branch B's logs onto branch A's header. The result is a block that never
 * existed, carrying a hash that says it did, and the projection records it as
 * canonical. No error, no gap, nothing to detect it by afterwards, because the
 * provenance the whole read model relies on is now a lie.
 *
 * Asking by hash cannot do that. The hash names one block; if that block is gone
 * the node says so and the height is simply retried.
 *
 * ── 2. A failure NEVER comes back as `null` ─────────────────────────────────
 *
 * `ChainSource.head()` uses `null` for "this source has no chain to report", and
 * the ingest loop reads that as *nothing to do* — idle, no error, no halt. That
 * is right for `NullChainSource`. For an RPC adapter it would be a disaster: an
 * indexer pointed at a dead endpoint would be indistinguishable from one that was
 * never given a chain, the cursor would stop moving without saying why, and
 * `book` would keep serving its last projection as though it were current.
 *
 * So this class throws `ChainUnavailableError` with a code. `Indexer` records it
 * on `lastError` and `status` publishes it beside the cursor it explains.
 * `null` from here means exactly one thing: the chain answered, and there is no
 * block at that height yet.
 *
 * ── 3. The venue's code is re-read on every pass ────────────────────────────
 *
 * `eth_getLogs` against an address with no contract on it returns `[]`. Not an
 * error — a perfectly formed empty answer, forever. Project that and every read
 * reports an empty book, confidently, about a market that may be busy. It is the
 * `suiteDeployed` lesson from #210 in its most dangerous form: there, a missing
 * contract made a read fail; here it makes a read succeed with nothing in it.
 *
 * `#verifyVenue` is therefore an actual `eth_getCode` on every `head()`, not a
 * boolean memoised at boot. The dev chain holds no volume, so a `docker compose
 * restart evm` genuinely removes the contract while leaving the endpoint up and
 * the chain id unchanged — the exact shape that a boot-time check misses.
 */

export interface EvmChainSourceConfig {
  /** The chain we are projecting. Verified against the endpoint, never trusted. */
  readonly chainId: number;
  readonly rpcUrl: string;
  /** The contract whose logs are the read model's input. */
  readonly venue: Address;
  /** Bounded so one unreachable endpoint cannot hold the ingest loop open. */
  readonly requestTimeoutMs?: number;
}

/**
 * The honest self-report, as DATA. Never throws — "the chain is down" is an
 * answer a status endpoint has to render, not an exception it has to catch.
 */
export interface EvmChainProbe {
  readonly kind: 'evm';
  readonly rpcUrl: string;
  readonly venue: string;
  readonly reachable: boolean;
  /** What the endpoint says it is. Null when it did not answer. */
  readonly observedChainId: number | null;
  /** The chain's own tip, so a caller can compute how stale we are. */
  readonly chainHeight: number | null;
  /**
   * VERIFIED by `eth_getCode` on this call — not "somebody set an env var".
   * False whenever the chain could not be reached, because an unverifiable claim
   * is not a true one.
   */
  readonly venueDeployed: boolean;
  readonly refusalCode: string | null;
  readonly reason: string | null;
}

/**
 * Bound the getLogs answer to the block we asked about.
 *
 * Asking by blockHash is reorg-safe only if we refuse answers that name a
 * different block, a different address, or a removed log. A lying / load-
 * balanced RPC that returns foreign logs would otherwise project them under
 * our requested hash — the race-safe request shape without a safe response.
 */
export function assertLogsBoundToBlock(
  logs: readonly RawLog[],
  expected: { hash: Hex; venue: Address; height: number; rpcUrl: string },
): void {
  const wantHash = expected.hash.toLowerCase();
  const wantVenue = expected.venue.toLowerCase();
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i]!;
    if (log.removed === true) {
      throw new ChainUnavailableError(
        'indexer.malformed_block',
        `getLogs for ${wantHash} at ${expected.rpcUrl} returned a removed log at index ${i}. Refusing to project a log the node says is gone.`,
      );
    }
    const logHash = (log.blockHash ?? '').toLowerCase();
    if (logHash !== wantHash) {
      throw new ChainUnavailableError(
        'indexer.malformed_block',
        `getLogs asked for blockHash ${wantHash} but log[${i}] carries blockHash ${log.blockHash ?? 'null'}. ` +
          `Refusing: stapling foreign logs onto our header is exactly the reorg race the hash fetch exists to prevent.`,
      );
    }
    const logAddr = (log.address ?? '').toLowerCase();
    if (logAddr !== wantVenue) {
      throw new ChainUnavailableError(
        'indexer.malformed_block',
        `getLogs filtered address ${wantVenue} but log[${i}] is from ${log.address ?? 'null'}. Refusing to project another contract's log.`,
      );
    }
    // Height bind is mandatory. Omitting blockNumber used to skip this check —
    // a partial answer could still name the right hash and wrong height.
    if (log.blockNumber === null || log.blockNumber === undefined) {
      throw new ChainUnavailableError(
        'indexer.malformed_block',
        `getLogs for ${wantHash} at ${expected.rpcUrl} returned log[${i}] with no blockNumber. Refusing to project an unbound log.`,
      );
    }
    const n = typeof log.blockNumber === 'bigint' ? Number(log.blockNumber) : Number(log.blockNumber);
    if (!Number.isFinite(n) || n !== expected.height) {
      throw new ChainUnavailableError(
        'indexer.malformed_block',
        `getLogs for height ${expected.height} returned log[${i}] at height ${n}. Refusing to project it.`,
      );
    }
  }
}

export class EvmChainSource implements ChainSource {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly venue: Address;
  readonly client: PublicClient;

  /**
   * Memoised only on SUCCESS, and only for the chain id.
   *
   * A cached FAILURE would mean an indexer that started before its chain came up
   * never recovered. And the chain id is the one property an endpoint cannot
   * change without becoming a different endpoint — unlike the venue's code, which
   * is re-read every pass for the reason in the class header.
   */
  #chainIdVerified = false;

  /** D-explorer-03. Each Transfer emitter's symbol, name and decimals, read once per process. */
  readonly #tokens: TokenMetaReader;

  constructor(config: EvmChainSourceConfig) {
    if (!config.rpcUrl) {
      throw new ChainUnavailableError(
        'indexer.chain_not_configured',
        'EvmChainSource needs an RPC URL. Use NullChainSource when there is no chain — it reports one honestly.',
      );
    }
    if (isZeroAddress(config.venue)) {
      throw new ChainUnavailableError(
        'indexer.venue_unset',
        `INDEXER_VENUE_ADDRESS is the zero address. eth_getLogs against 0x0 succeeds and returns [] forever, ` +
          `which would fill this read model with a confident, permanent "no liquidity". Refusing to start on it.`,
      );
    }

    this.chainId = config.chainId;
    this.rpcUrl = config.rpcUrl;
    this.venue = config.venue;

    const chain = defineChain({
      id: config.chainId,
      name: `intafaced-indexer-${config.chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });
    this.client = createPublicClient({
      chain,
      // `retryCount: 0` — the ingest loop is the retry. A transport retry inside
      // one pass just delays the honest "unreachable" the loop needs to see, and
      // holds the poll interval open while it does.
      transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs ?? 10_000, retryCount: 0 }),
    }) as PublicClient;
    this.#tokens = new TokenMetaReader(this.client, config.rpcUrl);
  }

  /**
   * Every read goes through here: an answer, or a typed refusal naming the
   * question that went unanswered.
   */
  async #read<T>(what: string, span: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await withSpan(span, fn);
    } catch (err) {
      throw classifyChainError(err, what, this.rpcUrl);
    }
  }

  /**
   * Assert the endpoint is the chain we are labelling every row with.
   *
   * `blocks.chain_id` is part of every primary key in the read model. Projecting
   * chain 1's blocks into rows stamped 31337 does not fail anywhere — it produces
   * a book that claims to describe a chain it has never read, and no later query
   * can tell.
   */
  async assertChainId(): Promise<number> {
    const observed = await this.#read('chainId', 'indexer.chain.chainId', async () => this.client.getChainId());
    if (observed !== this.chainId) {
      throw new ChainUnavailableError(
        'indexer.chain_id_mismatch',
        `The RPC at ${this.rpcUrl} is chain ${observed}, but this projection stamps every row with chain ` +
          `${this.chainId}. Refusing: a read model labelled with the wrong chain cannot be detected afterwards.`,
      );
    }
    this.#chainIdVerified = true;
    return observed;
  }

  /** Real `eth_getCode`. See decision 3 in the class header. */
  async venueDeployed(): Promise<boolean> {
    const code = await this.#read('venueCode', 'indexer.chain.getCode', async () => this.client.getCode({ address: this.venue }));
    return code !== undefined && code !== '0x';
  }

  #venueMissingReason(): string {
    return (
      `No contract code at ${this.venue} on chain ${this.chainId} (${this.rpcUrl}). ` +
      `Refusing to index: eth_getLogs against an empty address returns [] rather than failing, so projecting ` +
      `it would publish an empty book as though the market were quiet. Deploy the venue, or point ` +
      `INDEXER_VENUE_ADDRESS at one.`
    );
  }

  async #verifyVenue(): Promise<void> {
    if (!(await this.venueDeployed())) {
      throw new ChainUnavailableError('indexer.venue_not_deployed', this.#venueMissingReason());
    }
  }

  /**
   * The canonical tip.
   *
   * Never `null` — see decision 2. An EVM endpoint that answers has a tip; one
   * that does not answer gets a code.
   */
  async head(): Promise<ChainHead | null> {
    // Re-assert every pass. A latch would miss an endpoint that later answers for
    // a different chain (proxy/fleet swap) while we keep stamping INDEXER_CHAIN_ID.
    await this.assertChainId();
    await this.#verifyVenue();

    const block = await this.#read('head', 'indexer.chain.head', async () => this.client.getBlock({ blockTag: 'latest' }));
    if (block.hash === null) {
      // `latest` should never be pending. If a node says otherwise, it has no
      // hash, and a block with no hash cannot anchor provenance.
      throw new ChainUnavailableError(
        'indexer.malformed_block',
        `The node at ${this.rpcUrl} returned a head block with no hash. Nothing is projectable from that.`,
      );
    }
    return { height: heightOf(block.number, this.rpcUrl), hash: block.hash.toLowerCase() };
  }

  /**
   * The canonical block at a height, with this venue's logs from THAT block.
   *
   * `null` means the chain has no block there yet — which is how the ingest loop
   * learns it has caught up. Every other negative outcome throws.
   */
  async blockAt(height: number): Promise<ChainBlock | null> {
    if (!Number.isSafeInteger(height) || height < 0) {
      throw new ChainUnavailableError('indexer.malformed_block', `blockAt(${height}): height must be a non-negative integer`);
    }
    await this.assertChainId();
    // Venue code is re-read here too — not only on head(). After head() succeeds,
    // a self-destruct / redeploy mid-batch would otherwise make getLogs return []
    // and look like a quiet market for every remaining height.
    await this.#verifyVenue();

    let header;
    try {
      header = await withSpan('indexer.chain.getBlock', async () =>
        this.client.getBlock({ blockNumber: BigInt(height), includeTransactions: false }),
      );
    } catch (err) {
      // The one negative answer that is information rather than failure.
      if (isBlockNotFound(err)) return null;
      throw classifyChainError(err, `blockAt(${height})`, this.rpcUrl);
    }

    if (header.hash === null) return null; // pending: not a block we can anchor to
    // Lowercased because a hash compared two ways is a bug, and `blockHash` on
    // the log fetch below must be the same word this block is stored under.
    const hash = header.hash.toLowerCase() as Hex;

    // The node answered for a different height than we asked about. Either it is
    // broken or something is proxying us somewhere else; projecting it would put
    // one block's contents under another block's height.
    const observedHeight = heightOf(header.number, this.rpcUrl);
    if (observedHeight !== height) {
      throw new ChainUnavailableError(
        'indexer.malformed_block',
        `Asked ${this.rpcUrl} for block ${height} and it returned block ${observedHeight}. Refusing to project it.`,
      );
    }

    // ── The reorg-safe fetch. See decision 1 in the class header. ────────────
    const logs = (await this.#read(`logsFor(${hash})`, 'indexer.chain.getLogs', async () =>
      this.client.getLogs({ address: this.venue, blockHash: hash }),
    )) as unknown as RawLog[];
    // Request shape is not enough — refuse answers that name another block.
    assertLogsBoundToBlock(logs, { hash, venue: this.venue, height, rpcUrl: this.rpcUrl });

    const hashes = transactionHashes(header.transactions, hash, this.rpcUrl);
    const transactions = hashes.length === 0 ? [] : await readBlockTransactions(this.client, hashes, hash, this.rpcUrl);
    const emitters = [
      ...new Set(transactions.flatMap((tx) => tx.logs.flatMap((log) => (transferOf(log) ? [log.address.toLowerCase()] : [])))),
    ];
    // Past the per-block cap the rest stay unread here; the token sweep reads them (D-explorer-03).
    const tokens = emitters.length === 0 ? [] : await this.#tokens.read(emitters.slice(0, TOKEN_READS_PER_BLOCK), height);
    const internal = await readBlockInternal(
      this.client,
      { hash, height },
      transactions.map((tx) => tx.hash),
      this.rpcUrl,
    );

    const block: ChainBlock = {
      chainId: this.chainId,
      height,
      hash,
      parentHash: header.parentHash.toLowerCase(),
      timestamp: timestampOf(header.timestamp, height, this.rpcUrl),
      events: decodeVenueLogs(logs),
      header: {
        gasUsed: header.gasUsed,
        gasLimit: header.gasLimit,
        baseFeePerGas: header.baseFeePerGas ?? null,
        miner: header.miner.toLowerCase(),
        txCount: header.transactions.length,
        size: Number(header.size),
      },
      transactions,
      tokens,
      internal,
    };

    // The port's own validation, run on this adapter's output. An adapter is
    // exactly the component that yields a malformed price, and it should be told
    // so where it can still be blamed.
    assertValidBlock(block);
    return block;
  }

  /** D-explorer-02. `null` means the node does not know the hash. Transport failure throws. */
  lookupExplorerTx(hash: string) {
    return lookupExplorerTx(this.client, hash, this.rpcUrl);
  }

  /** D-explorer-03. An address's native balance and kind at a stored height. */
  readAccountAt(address: string, height: number) {
    return readAccount(this.client, address, height, this.rpcUrl);
  }

  /** D-explorer-03. An address's native balance at a stored height (the past balance). */
  readBalanceAt(address: string, height: number) {
    return readBalance(this.client, address, height, this.rpcUrl);
  }

  /** D-explorer-03. Each token's own `balanceOf(address)` at a stored height; null where the contract did not answer. */
  readTokenBalancesAt(tokens: readonly string[], address: string, height: number) {
    return readTokenBalances(this.client, tokens, address, height, this.rpcUrl);
  }

  /** What token contracts say about themselves, read at the chain's head (the D-explorer-03 backfill). */
  async readTokenMeta(addresses: readonly string[]): Promise<{ height: number; tokens: ChainToken[] }> {
    let height: number;
    try {
      height = Number(await this.client.getBlockNumber());
    } catch (err) {
      throw classifyChainError(err, 'tokenMeta(head)', this.rpcUrl);
    }
    return { height, tokens: await this.#tokens.read(addresses, height) };
  }

  /**
   * Everything a status endpoint needs, and nothing thrown.
   *
   * Three RPC calls (`eth_chainId`, `eth_blockNumber`, `eth_getCode`) on a path
   * nobody polls in a loop. It is deliberately live rather than a cached copy of
   * what the last sync pass saw: the question it answers is "how stale is this
   * projection RIGHT NOW", and a cached answer to that is a contradiction.
   */
  async probe(): Promise<EvmChainProbe> {
    const base = { kind: 'evm' as const, rpcUrl: this.rpcUrl, venue: this.venue };
    try {
      const observedChainId = await this.assertChainId();
      // `cacheTime: 0` is load-bearing. viem memoises `eth_blockNumber` for
      // `client.cacheTime` (which defaults to the polling interval), and a cached
      // tip here would make `behindBy` report zero on a projection that is
      // genuinely behind — a staleness marker that lies about staleness is worse
      // than not having one. Caught by `source.live.test.ts`, which mines a block
      // and asserts the number moves.
      const chainHeight = await this.#read('blockNumber', 'indexer.chain.blockNumber', async () =>
        this.client.getBlockNumber({ cacheTime: 0 }),
      );
      const venueDeployed = await this.venueDeployed();
      if (!venueDeployed) {
        // Reachable is true — the node answered. The book is still a lie if we
        // projected getLogs [] from an empty address, so name the refuse.
        return {
          ...base,
          reachable: true,
          observedChainId,
          chainHeight: heightOf(chainHeight, this.rpcUrl),
          venueDeployed: false,
          refusalCode: 'indexer.venue_not_deployed',
          reason: this.#venueMissingReason(),
        };
      }
      return {
        ...base,
        reachable: true,
        observedChainId,
        chainHeight: heightOf(chainHeight, this.rpcUrl),
        venueDeployed: true,
        refusalCode: null,
        reason: null,
      };
    } catch (err) {
      const refusal = err instanceof ChainUnavailableError ? err : classifyChainError(err, 'probe', this.rpcUrl);
      return {
        ...base,
        reachable: false,
        // Null even on a chain-id mismatch: the endpoint answered, but not for a
        // chain this projection can serve, so there is no id here worth
        // reporting as ours. The observed id is named in `reason`.
        observedChainId: null,
        chainHeight: null,
        // Nobody looked, so nothing is deployed as far as this answer goes.
        venueDeployed: false,
        refusalCode: refusal.code,
        reason: refusal.message,
      };
    }
  }
}

/**
 * `bigint` block number → `number` height, refusing rather than truncating.
 *
 * Heights are the one chain quantity this service does hold in a `number`, and
 * that is fine — `Number.MAX_SAFE_INTEGER` is nine quadrillion blocks, which at
 * one block per second is 285 million years. The check exists anyway because the
 * failure mode of a silent `Number()` on a bigint that does not fit is a height
 * that is *nearly* right, and every hash comparison downstream would then be
 * against the wrong block. Amounts are a different story and never become a
 * `number` at all — see `decode.ts`.
 */
function heightOf(value: bigint, rpcUrl: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ChainUnavailableError('indexer.malformed_block', `${rpcUrl} reported block number ${value}, which is not a usable height.`);
  }
  return Number(value);
}

/** Unix seconds from the block itself. Same reasoning as `heightOf`. */
function timestampOf(value: bigint, height: number, rpcUrl: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ChainUnavailableError(
      'indexer.malformed_block',
      `${rpcUrl} reported timestamp ${value} for block ${height}, which is not a usable date.`,
    );
  }
  return Number(value);
}
