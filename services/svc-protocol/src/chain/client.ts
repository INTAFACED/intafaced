import {
  ContractFunctionZeroDataError,
  createPublicClient,
  decodeFunctionResult,
  defineChain,
  encodeFunctionData,
  getAddress,
  getContractError,
  http,
} from 'viem';
import type { Abi, BaseError } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { accountFactoryAbi, smartAccountAbi } from './abi.js';
import { factoryAbi, poolAbi } from '../amm/abi.js';
import { erc20ApprovalAbi, erc20ApprovalEvent, erc20ReadAbi, tokenFactoryAbi } from './abi.js';
import {
  ChainUnavailableError,
  chainIdMismatchRefusal,
  classifyChainError,
  isZeroAddress,
  publicRefusalText,
  ZERO_ADDRESS,
} from './availability.js';
import type { TokenParams } from '../launch/params.js';
import { withSpan } from '../tracing.js';
import { isExecutionRevert } from './revert.js';
import { readGasPrice, type GasPercentileSetting, type GasPriceQuote } from './gas-price.js';

/**
 * Chain access — read-only, by construction.
 *
 * This service holds a `PublicClient` and nothing else. There is no
 * `WalletClient` here and no private key in this file, because there is no
 * transaction this service is entitled to originate on a user's account: every
 * state change on this plane is a user-signed operation that we forward to a
 * bundler (see `session/relay.ts`).
 *
 * A relayer that pays gas is a separate, optional concern and still cannot
 * originate anything — a user operation is bound to its hash, and the hash
 * covers everything except the signature.
 */

export interface ChainConfig {
  readonly chainId: number;
  readonly rpcUrl: string;
  /** ERC-4337 EntryPoint v0.7 singleton for this chain. */
  readonly entryPoint: Address;
  readonly factory: Address;
  readonly implementation: Address;
  /**
   * `TokenFactory` for `launch.token-factory` (§8.4).
   *
   * Optional here and normalised to the zero address on the class below, so
   * that "the caller did not mention it" and "it is not deployed" collapse into
   * one state downstream rather than two. Two spellings of absence is how one
   * of them ends up unhandled.
   */
  readonly tokenFactory?: Address;
  /** ERC-4337 bundler JSON-RPC. Absent = relaying is unavailable, reads still work. */
  readonly bundlerUrl?: string;
}

/** What a launched token says about itself — read from the token, never from our config. */
export interface TokenMetadata {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  /** Scaled by `decimals`. A bigint until the edge of the process, never a number. */
  readonly totalSupply: bigint;
  readonly initialHolder: Address;
}

export interface OnChainSession {
  readonly specHash: Hex;
  readonly validAfter: number;
  readonly validUntil: number;
  readonly spentWei: bigint;
  readonly epoch: bigint;
  readonly revoked: boolean;
}

const NO_SESSION_HASH = `0x${'00'.repeat(32)}` as Hex;

/** Reserves as the pool itself reports them. `blockTimestampLast` is the pool's own clock. */
export interface PoolReserves {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly blockTimestampLast: number;
}

/** What `chainStatus` reports. Never throws — being down is an answer, not a fault. */
export interface ChainStatus {
  readonly reachable: boolean;
  /** The chain id we derive addresses for. */
  readonly configuredChainId: number;
  /** What the RPC says it is. Null when it did not answer. */
  readonly observedChainId: number | null;
  readonly blockNumber: string | null;
  /**
   * Both addresses are non-zero. A statement about configuration and nothing
   * more — it says somebody set an env var, not that anything exists.
   */
  readonly suiteConfigured: boolean;
  /**
   * VERIFIED: the factory AND the implementation hold contract code on this
   * chain, read this call.
   *
   * This used to be the same boolean as `suiteConfigured`, and that was the
   * remaining place this service could still claim something it had not
   * checked. The moment real addresses go into a compose file — which is
   * exactly what a local dev chain makes possible — "configured" and "deployed"
   * come apart: point the stack at a chain where the suite was never deployed,
   * or at a restarted anvil that lost its state, and the addresses are still
   * non-zero while nothing is there. `usable` is derived from this one, so it
   * has to be the read and not the guess.
   *
   * False whenever the chain could not be reached, because an unverifiable
   * claim is not a true one.
   */
  readonly suiteDeployed: boolean;
  /**
   * `PROTOCOL_TOKEN_FACTORY_ADDRESS` is non-zero. Config, not evidence.
   *
   * SEPARATE from `suiteConfigured` rather than folded into it, deliberately.
   * Folding it in would make the smart-account layer report itself unusable
   * because a launch contract is missing — two unrelated features, one boolean,
   * and the more important one goes dark for the wrong reason.
   */
  readonly tokenFactoryConfigured: boolean;
  /** VERIFIED by `eth_getCode`: the token factory holds code on this chain. */
  readonly tokenFactoryDeployed: boolean;
  readonly refusalCode: string | null;
  readonly reason: string | null;
  /**
   * Populated only when `refusalCode` is `protocol.chain_id_mismatch`.
   * The chain the service derives addresses for, and the chain the RPC answered as.
   * Null on every other answer. The endpoint is not here.
   */
  readonly expectedChainId: number | null;
  readonly actualChainId: number | null;
}

/**
 * The most gas one view on a token contract may burn on the node (`balanceOf`, `allowance`, `name`, `decimals` …). A
 * token is a contract anyone can write and these reads serve public requests, so an unbounded call could spend the
 * node's whole call gas cap each time. An ERC-20 view needs a few thousand gas; this leaves ample room for a token with
 * hooks. The listing reads cap theirs the same way (`listing/ownership-chain.ts`).
 */
export const TOKEN_READ_GAS = 100_000n;

export class ProtocolChain {
  readonly client: PublicClient;

  /**
   * The launch factory, with absence spelled exactly one way.
   *
   * `env.ts` defaults it to the zero address on purpose — a loud zero rather
   * than a plausible-looking address — and an omitted config field means the
   * same thing. Collapsing both here means every caller below has one check to
   * make instead of two.
   */
  readonly tokenFactory: Address;

  constructor(readonly config: ChainConfig) {
    this.tokenFactory = config.tokenFactory ?? (ZERO_ADDRESS as Address);
    const chain = defineChain({
      id: config.chainId,
      name: `intafaced-protocol-${config.chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });
    this.client = createPublicClient({ chain, transport: http(config.rpcUrl) }) as PublicClient;
  }

  /**
   * Every read goes through here.
   *
   * A chain read has exactly two honest outcomes: an answer, or a typed refusal
   * naming why there was none. `classifyChainError` is what keeps the second
   * from degrading into an opaque 500 — or, worse, into a default value.
   */
  async #read<T>(what: string, span: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await withSpan(span, fn);
    } catch (err) {
      throw classifyChainError(err, what, this.config.rpcUrl);
    }
  }

  /**
   * One view on a token contract, as `readContract` makes it but with `TOKEN_READ_GAS` as its gas cap (`readContract`
   * takes none). Its errors keep viem's types, so `classifyChainError` and `isExecutionRevert` read them as before: an
   * empty answer is an absent contract, a revert is a revert.
   */
  async #tokenView<T>(token: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<T> {
    const request = { abi, functionName, args } as Parameters<typeof encodeFunctionData>[0];
    let data: `0x${string}` | undefined;
    try {
      ({ data } = await this.client.call({
        to: token,
        data: encodeFunctionData(request),
        gas: TOKEN_READ_GAS,
        ...(blockNumber === undefined ? {} : { blockNumber }),
      }));
    } catch (err) {
      throw getContractError(err as BaseError, { abi, address: token, args: [...args], functionName });
    }
    if (!data || data === '0x') throw new ContractFunctionZeroDataError({ functionName });
    return decodeFunctionResult({ abi, functionName, data } as Parameters<typeof decodeFunctionResult>[0]) as T;
  }

  /** Whether an account address has code yet. A predicted address has none. */
  async isDeployed(address: Address): Promise<boolean> {
    return this.#read('isDeployed', 'chain.isDeployed', async () => {
      const code = await this.client.getCode({ address });
      return code !== undefined && code !== '0x';
    });
  }

  /**
   * The runtime bytecode at an address, or null when there is none.
   *
   * `isDeployed` answers the same `eth_getCode` and throws the bytes away. This
   * returns them, because "there is code here" and "the code here is the code we
   * compiled" are different claims, and only the second one rules out a factory
   * that deploys something other than the template it is documented to deploy.
   */
  async runtimeCode(address: Address): Promise<Hex | null> {
    return this.#read('runtimeCode', 'chain.getCode', async () => {
      const code = await this.client.getCode({ address });
      return code === undefined || code === '0x' ? null : code;
    });
  }

  /** The factory's own answer, so a derivation bug in this repo cannot go unnoticed. */
  async predictAddressOnChain(owner: Address, userSalt: Hex): Promise<Address> {
    return this.#read('predictAddressOnChain', 'chain.getAddress', async () =>
      this.client.readContract({
        address: this.config.factory,
        abi: accountFactoryAbi,
        functionName: 'getAddress',
        args: [owner, userSalt],
      }),
    );
  }

  async ownerOf(account: Address): Promise<Address> {
    return this.#read('ownerOf', 'chain.owner', async () =>
      this.client.readContract({ address: account, abi: smartAccountAbi, functionName: 'owner' }),
    );
  }

  async sessionEpoch(account: Address): Promise<bigint> {
    return this.#read('sessionEpoch', 'chain.sessionEpoch', async () =>
      this.client.readContract({ address: account, abi: smartAccountAbi, functionName: 'sessionEpoch' }),
    );
  }

  /**
   * Null when the key was never granted — not an error, just absence.
   *
   * The distinction only holds because `#read` converts a call against an
   * address with no code into `protocol.contract_not_deployed` instead of
   * letting it surface as a decode failure. Null here means the account exists
   * and the owner granted this key nothing. It never means "we could not ask".
   */
  async sessionOf(account: Address, sessionKey: Address): Promise<OnChainSession | null> {
    return this.#read('sessionOf', 'chain.getSession', async () => {
      const record = await this.client.readContract({
        address: account,
        abi: smartAccountAbi,
        functionName: 'getSession',
        args: [sessionKey],
      });
      if (record.specHash === NO_SESSION_HASH) return null;
      return {
        specHash: record.specHash,
        validAfter: Number(record.validAfter),
        validUntil: Number(record.validUntil),
        spentWei: record.spentWei,
        epoch: record.epoch,
        revoked: record.revoked,
      };
    });
  }

  async isSessionLive(account: Address, sessionKey: Address): Promise<boolean> {
    return this.#read('isSessionLive', 'chain.isSessionLive', async () =>
      this.client.readContract({
        address: account,
        abi: smartAccountAbi,
        functionName: 'isSessionLive',
        args: [sessionKey],
      }),
    );
  }

  /**
   * Live reserves for a constant-product pool.
   *
   * `amm.quoteExactIn` took reserves as an input and nothing in the repo ever
   * supplied them, which made a correct AMM implementation into a calculator
   * with no inputs — `getReserves` was in the ABI and called from nowhere. This
   * is the read that closes that loop. Today it refuses, because there is no
   * chain; it refuses with `protocol.contract_not_deployed` or
   * `protocol.chain_unreachable`, and never with a zero reserve.
   *
   * A zero reserve would be the worst possible answer: `getAmountOut` treats
   * empty reserves as `amm.no_liquidity`, so fabricated zeros would surface to a
   * user as the confident claim "this pool has no liquidity" about a pool nobody
   * has looked at.
   */
  async poolReserves(pool: Address): Promise<PoolReserves> {
    return this.#read('poolReserves', 'chain.getReserves', async () => {
      const [reserve0, reserve1, blockTimestampLast] = await this.client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: 'getReserves',
      });
      return { reserve0, reserve1, blockTimestampLast: Number(blockTimestampLast) };
    });
  }

  /** Which token is `reserve0`. Needed to orient a quote; a pool sorts its pair. */
  async poolToken0(pool: Address): Promise<Address> {
    return this.#read('poolToken0', 'chain.token0', async () =>
      this.client.readContract({ address: pool, abi: poolAbi, functionName: 'token0' }),
    );
  }

  async poolToken1(pool: Address): Promise<Address> {
    return this.#read('poolToken1', 'chain.token1', async () =>
      this.client.readContract({ address: pool, abi: poolAbi, functionName: 'token1' }),
    );
  }

  async poolFeeBps(pool: Address): Promise<number> {
    return this.#read('poolFeeBps', 'chain.feeBps', async () =>
      this.client.readContract({ address: pool, abi: poolAbi, functionName: 'feeBps' }).then(Number),
    );
  }

  /** When `blockNumber` was made, from the block itself. */
  async blockTimestamp(blockNumber: bigint): Promise<Date> {
    return this.#read('blockTimestamp', 'chain.getBlock', async () => {
      const block = await this.client.getBlock({ blockNumber });
      return new Date(Number(block.timestamp) * 1000);
    });
  }

  /**
   * The hash of block 0. Together with the chain id it names one chain: a TEST chain started again under the same id
   * has a new genesis, so a row read from the old one can be told apart (`chain/identity.ts`).
   */
  async genesisHash(): Promise<Hex> {
    return this.#read('genesisHash', 'chain.getBlock', async () => {
      const block = await this.client.getBlock({ blockNumber: 0n });
      if (!block.hash) throw new Error('block 0 has no hash');
      return block.hash.toLowerCase() as Hex;
    });
  }

  /** The block the node is at now. */
  async headBlock(): Promise<bigint> {
    return this.#read('headBlock', 'chain.blockNumber', async () => this.client.getBlockNumber());
  }

  /**
   * Every pool `factory` lists at `blockNumber`, at most `limit` of them (the factory's own order). A factory with no
   * code refuses rather than reading as "no pools".
   */
  async factoryPools(factory: Address, limit: number, blockNumber: bigint): Promise<Address[]> {
    return this.#read('factoryPools', 'chain.allPools', async () => {
      const length = await this.client.readContract({ address: factory, abi: factoryAbi, functionName: 'allPoolsLength', blockNumber });
      const count = Number(length < BigInt(limit) ? length : BigInt(limit));
      return Promise.all(
        Array.from({ length: count }, (_, index) =>
          this.client.readContract({ address: factory, abi: factoryAbi, functionName: 'allPools', args: [BigInt(index)], blockNumber }),
        ),
      );
    });
  }

  /** One pool's pair, fee and reserves, all read at `blockNumber`. */
  async poolSnapshot(
    pool: Address,
    blockNumber: bigint,
  ): Promise<{ token0: Address; token1: Address; feeBps: number; reserve0: bigint; reserve1: bigint; blockTimestampLast: number }> {
    return this.#read('poolSnapshot', 'chain.poolSnapshot', async () => {
      const [token0, token1, feeBps, [reserve0, reserve1, blockTimestampLast]] = await Promise.all([
        this.client.readContract({ address: pool, abi: poolAbi, functionName: 'token0', blockNumber }),
        this.client.readContract({ address: pool, abi: poolAbi, functionName: 'token1', blockNumber }),
        this.client.readContract({ address: pool, abi: poolAbi, functionName: 'feeBps', blockNumber }),
        this.client.readContract({ address: pool, abi: poolAbi, functionName: 'getReserves', blockNumber }),
      ]);
      return { token0, token1, feeBps: Number(feeBps), reserve0, reserve1, blockTimestampLast: Number(blockTimestampLast) };
    });
  }

  /** A token's name, symbol and decimals, as the token contract answers them. */
  async tokenBasics(token: Address): Promise<{ name: string; symbol: string; decimals: number }> {
    return this.#read('tokenBasics', 'chain.tokenBasics', async () => {
      const [name, symbol, decimals] = await Promise.all([
        this.#tokenView<string>(token, erc20ReadAbi, 'name'),
        this.#tokenView<string>(token, erc20ReadAbi, 'symbol'),
        this.#tokenView<number>(token, erc20ReadAbi, 'decimals'),
      ]);
      return { name, symbol, decimals: Number(decimals) };
    });
  }

  // ── launch.token-factory (§8.4) ──────────────────────────────────────────

  /**
   * The factory's own answer for where a token will land.
   *
   * The same role `predictAddressOnChain` plays for accounts, and for the same
   * reason: `launch/address.ts` derives this independently, and a derivation bug
   * in this repository would otherwise be invisible until a creator published
   * an address nothing would ever be deployed to.
   */
  async predictTokenAddressOnChain(creator: Address, userSalt: Hex, params: TokenParams): Promise<Address> {
    return this.#read('predictTokenAddressOnChain', 'chain.tokenGetAddress', async () =>
      this.client.readContract({
        address: this.tokenFactory,
        abi: tokenFactoryAbi,
        functionName: 'getAddress',
        args: [creator, userSalt, params],
      }),
    );
  }

  /**
   * The factory's own init code for these parameters.
   *
   * Not needed to serve a request — it exists so a test can compare bytes with
   * `tokenInitCode()` directly. An address mismatch tells you something is
   * wrong; these bytes tell you WHERE, and the difference is an afternoon.
   */
  async tokenInitCodeOnChain(params: TokenParams): Promise<Hex> {
    return this.#read('tokenInitCodeOnChain', 'chain.tokenInitCode', async () =>
      this.client.readContract({ address: this.tokenFactory, abi: tokenFactoryAbi, functionName: 'initCode', args: [params] }),
    );
  }

  /**
   * Who launched a token through this factory, or `null` if it did not come
   * from here.
   *
   * The null is the point. §35 wants deployer reputation, and a token whose
   * creator we cannot name must read as unknown provenance rather than as
   * `0x0` — an address that looks like an answer and is not one.
   */
  async tokenCreator(token: Address): Promise<Address | null> {
    const creator = await this.#read('tokenCreator', 'chain.tokenCreatorOf', async () =>
      this.client.readContract({ address: this.tokenFactory, abi: tokenFactoryAbi, functionName: 'creatorOf', args: [token] }),
    );
    return isZeroAddress(creator) ? null : creator;
  }

  /**
   * What a token says about itself.
   *
   * Five reads, batched. Every value comes from the token contract; none is
   * echoed back from what a caller asked for. That distinction is the whole
   * value of this call — a surface that displayed the requested supply rather
   * than the deployed supply could not tell a creator that their launch did
   * something other than what they typed.
   */
  async tokenMetadata(token: Address): Promise<TokenMetadata> {
    return this.#read('tokenMetadata', 'chain.tokenMetadata', async () => {
      const [name, symbol, decimals, totalSupply, initialHolder] = await Promise.all([
        this.#tokenView<string>(token, erc20ReadAbi, 'name'),
        this.#tokenView<string>(token, erc20ReadAbi, 'symbol'),
        this.#tokenView<number>(token, erc20ReadAbi, 'decimals'),
        this.#tokenView<bigint>(token, erc20ReadAbi, 'totalSupply'),
        this.#tokenView<Address>(token, erc20ReadAbi, 'initialHolder'),
      ]);
      return { name, symbol, decimals: Number(decimals), totalSupply, initialHolder };
    });
  }

  /**
   * `owner`'s allowance for `spender`, read at ONE pinned block so the answer says which block it describes.
   * The block is the latest the node reports when the read starts; if the chain moves, the swap's own revert is the backstop.
   */
  async tokenAllowance(token: Address, owner: Address, spender: Address): Promise<{ value: bigint; blockNumber: bigint }> {
    return this.#read('tokenAllowance', 'chain.tokenAllowance', async () => {
      const blockNumber = await this.client.getBlockNumber();
      const value = await this.#tokenView<bigint>(token, erc20ApprovalAbi, 'allowance', [owner, spender], blockNumber);
      return { value, blockNumber };
    });
  }

  /**
   * Every (token, spender) pair `owner`'s `Approval` logs name for `tokens` between two blocks, deduplicated. One
   * `eth_getLogs` with the owner as the indexed topic. The amounts in the logs are not used: the current allowance is
   * read separately, because a later transfer spends an allowance without any Approval log.
   */
  async approvalSpenders(
    tokens: readonly Address[],
    owner: Address,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Array<{ token: Address; spender: Address }>> {
    return this.#read('approvalSpenders', 'chain.approvalLogs', async () => {
      const logs = await this.client.getLogs({
        address: [...tokens],
        event: erc20ApprovalEvent,
        args: { owner },
        fromBlock,
        toBlock,
      });
      const found = new Map<string, { token: Address; spender: Address }>();
      for (const log of logs) {
        const spender = log.args.spender;
        if (!spender) continue;
        found.set(`${log.address.toLowerCase()}:${spender.toLowerCase()}`, {
          token: getAddress(log.address),
          spender: getAddress(spender),
        });
      }
      return [...found.values()];
    });
  }

  /** `holder`'s balance of `token` at `blockNumber`, so a pool's holdings compare with its reserves at the same block. */
  async tokenBalanceAt(token: Address, holder: Address, blockNumber: bigint): Promise<bigint> {
    return this.#read('tokenBalanceAt', 'chain.tokenBalanceAt', async () =>
      this.#tokenView<bigint>(token, erc20ReadAbi, 'balanceOf', [holder], blockNumber),
    );
  }

  /** `owner`'s allowance for `spender` at `blockNumber`. Null when the token reverts rather than answering. */
  async allowanceAt(token: Address, owner: Address, spender: Address, blockNumber: bigint): Promise<bigint | null> {
    return this.#read('allowanceAt', 'chain.allowanceAt', async () => {
      try {
        return await this.#tokenView<bigint>(token, erc20ApprovalAbi, 'allowance', [owner, spender], blockNumber);
      } catch (err) {
        if (isExecutionRevert(err)) return null;
        throw err;
      }
    });
  }

  /**
   * Whether `owner` changing a non-zero allowance straight to `amount` REVERTS on this token (USDT-style tokens that demand
   * a reset to zero first). Only an execution revert counts as yes; a node that cannot answer is a chain refusal, never a "yes"
   * or a "no" the caller could mistake for knowledge.
   */
  async directApproveReverts(token: Address, owner: Address, spender: Address, amount: bigint): Promise<boolean> {
    return this.#read('directApproveReverts', 'chain.directApproveReverts', async () => {
      try {
        const { result } = await this.client.simulateContract({
          address: token,
          abi: erc20ApprovalAbi,
          functionName: 'approve',
          args: [spender, amount],
          account: owner,
        });
        // A token that answers `false` instead of reverting refuses the direct change just the same.
        return result === false;
      } catch (err) {
        if (isExecutionRevert(err)) return true;
        throw err;
      }
    });
  }

  /**
   * What this node and the configured bundler can actually do, found by asking. `null` means the question could not be put
   * (no bundler configured, no probe timeout published, the node did not answer), never a guess.
   *   · `pendingTag`: the node answers a `pending` block query. A JSON-RPC error reply is "no"; no reply at all is `null`.
   *   · `bundlerReachable`: the bundler answers `eth_supportedEntryPoints` inside the published probe timeout.
   *   · `paymasterFunded`: not measured here (it needs the paymaster deposit read); always `null`.
   */
  async probeCapabilities(timeoutMs: number | undefined): Promise<{
    pendingTag: boolean | null;
    bundlerReachable: boolean | null;
    paymasterFunded: null;
  }> {
    let pendingTag: boolean | null = null;
    try {
      const pending: unknown = await this.client.getBlock({ blockTag: 'pending' });
      // A reply that is not a block (`{}`, `"0x1"`, `42`) is not proof the node serves the tag.
      const shaped = !!pending && typeof pending === 'object' && typeof (pending as { timestamp?: unknown }).timestamp === 'bigint';
      pendingTag = shaped ? true : null;
    } catch (err) {
      for (let link: unknown = err, depth = 0; link && typeof link === 'object' && depth < 8; depth += 1) {
        const code = (link as { code?: unknown }).code;
        // Only the JSON-RPC "method not found" / "invalid params" replies mean the node does not serve the tag.
        if (code === -32601 || code === -32602) pendingTag = false;
        link = (link as { cause?: unknown }).cause;
      }
    }
    let bundlerReachable: boolean | null = null;
    const bundlerUrl = this.config.bundlerUrl;
    if (bundlerUrl && timeoutMs !== undefined) {
      try {
        const response = await fetch(bundlerUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_supportedEntryPoints', params: [] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Reachable means a JSON-RPC result that is a list of entry points; a 200 with an error, HTML or nothing is not.
        const body: unknown = response.ok ? await response.json().catch(() => null) : null;
        const result = body && typeof body === 'object' ? (body as { result?: unknown; error?: unknown }) : null;
        bundlerReachable = !!result && result.error === undefined && Array.isArray(result.result);
      } catch {
        bundlerReachable = false;
      }
    }
    return { pendingTag, bundlerReachable, paymasterFunded: null };
  }

  async tokenBalanceOf(token: Address, holder: Address): Promise<bigint> {
    return this.#read('tokenBalanceOf', 'chain.tokenBalanceOf', async () =>
      this.client.readContract({ address: token, abi: erc20ReadAbi, functionName: 'balanceOf', args: [holder] }),
    );
  }

  /**
   * Assert the RPC is the chain we derive addresses for.
   *
   * A CREATE2 address is only meaningful on the chain its factory is deployed
   * to. If `PROTOCOL_CHAIN_ID` says 31337 while the RPC is answering for
   * mainnet, every address this service predicts is wrong in a way no amount of
   * correct arithmetic can catch — so it is checked against the endpoint rather
   * than trusted from config.
   */
  async assertChainId(): Promise<number> {
    const observed = await this.#read('assertChainId', 'chain.chainId', async () => this.client.getChainId());
    if (observed !== this.config.chainId) {
      throw chainIdMismatchRefusal(this.config.rpcUrl, this.config.chainId, observed);
    }
    return observed;
  }

  /**
   * D-explorer-01. `eth_gasPrice` and `eth_feeHistory` for the chain page.
   * The caller has already refused a blank percentile setting.
   */
  async gasPrice(setting: GasPercentileSetting, asOf: Date = new Date()): Promise<GasPriceQuote> {
    return readGasPrice(this.client, setting, asOf, this.config.chainId, this.config.rpcUrl);
  }

  /**
   * The honest self-report. Answers "is any of this real yet?" without throwing,
   * because a product surface needs to render the refusal, not catch it.
   */
  async status(): Promise<ChainStatus> {
    const suiteConfigured = !isZeroAddress(this.config.factory) && !isZeroAddress(this.config.implementation);
    const tokenFactoryConfigured = !isZeroAddress(this.tokenFactory);

    try {
      const observedChainId = await this.assertChainId();
      const blockNumber = await this.#read('blockNumber', 'chain.blockNumber', async () => this.client.getBlockNumber());
      // Two `eth_getCode` calls, only when the addresses are worth asking
      // about. This is the difference between "somebody set an env var" and
      // "the contracts are there", and it is cheap enough to do on every probe.
      const suiteDeployed =
        suiteConfigured && (await this.isDeployed(this.config.factory)) && (await this.isDeployed(this.config.implementation));
      // Same rule, applied to the launch factory: configured is not deployed,
      // and the only way to know the difference is to ask the chain.
      const tokenFactoryDeployed = tokenFactoryConfigured && (await this.isDeployed(this.tokenFactory));
      return {
        reachable: true,
        configuredChainId: this.config.chainId,
        observedChainId,
        blockNumber: blockNumber.toString(),
        suiteConfigured,
        suiteDeployed,
        tokenFactoryConfigured,
        tokenFactoryDeployed,
        refusalCode: null,
        reason: null,
        expectedChainId: null,
        actualChainId: null,
      };
    } catch (err) {
      const refusal = err instanceof ChainUnavailableError ? err : classifyChainError(err, 'status', this.config.rpcUrl);
      return {
        reachable: false,
        configuredChainId: this.config.chainId,
        // Null even on a chain-id mismatch: the endpoint answered, but not for a
        // chain this service can serve, so there is no id here worth reporting
        // as ours. The observed id is `actualChainId`, and both ids are in `reason`.
        observedChainId: null,
        blockNumber: null,
        suiteConfigured,
        // Nobody looked, so nothing is deployed as far as this answer goes.
        suiteDeployed: false,
        tokenFactoryConfigured,
        tokenFactoryDeployed: false,
        refusalCode: refusal.code,
        // Customer copy. A message that grew a URL or a spec id falls back to
        // the fixed sentence for that code.
        reason: publicRefusalText(refusal),
        expectedChainId: refusal.expectedChainId,
        actualChainId: refusal.actualChainId,
      };
    }
  }
}
