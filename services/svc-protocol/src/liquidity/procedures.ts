import {
  decodeErrorResult,
  encodeFunctionData,
  getAddress,
  parseAbiItem,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { z } from 'zod';
import {
  AMM_FEE_OUT_OF_RANGE,
  AMM_FEE_TIERS_UNSET,
  LIQUIDITY_BOUNDS_UNSET,
  LIQUIDITY_FEES_COMPOUND,
  LIQUIDITY_NOT_A_POOL,
  LIQUIDITY_POOL_EXISTS,
  LIQUIDITY_ROUTER_UNSET,
  POOL_FEE_CAP_BPS,
  SWAP_SETTINGS_UNSET,
  liquidityBuildAddInputSchema,
  liquidityBuildAddOutputSchema,
  liquidityBuildRemoveInputSchema,
  liquidityBuildRemoveOutputSchema,
  liquidityBuildSwapAddInputSchema,
  liquidityBuildSwapAddOutputSchema,
  liquidityCreateInputSchema,
  liquidityCreateOutputSchema,
  liquidityExplainInputSchema,
  liquidityExplainOutputSchema,
  liquidityFeeTiersOutputSchema,
  liquidityPoolExistsInputSchema,
  liquidityPoolExistsOutputSchema,
  liquidityPositionInputSchema,
  liquidityPositionOutputSchema,
  liquidityPositionsInputSchema,
  liquidityPositionsOutputSchema,
  liquidityQuoteAddInputSchema,
  liquidityQuoteAddOutputSchema,
  liquidityQuoteSwapAddInputSchema,
  liquidityQuoteSwapAddOutputSchema,
  liquiditySendSharesInputSchema,
  liquiditySendSharesOutputSchema,
  publicJurisdictionProcedure,
  TRPCError,
  type LiquidityToken,
  type ProtocolSwapPairs,
} from '@intafaced/contracts';
import { chainDown, classifyChainError, isZeroAddress } from '../chain/availability.js';
import { loadArtifact } from '../chain/artifacts.js';
import { amountOut, entryOf, floorBy, optimalPair, positionFigures, sharesFor, swapPart } from './maths.js';

/**
 * Providing liquidity (D-liquidity-01..04, J-dex-protocol-12), Protocol Plane only. Every procedure reads the chain the
 * way the swap procedures do and answers with figures or unsigned calls; the person's wallet signs each call and nothing
 * here holds a key, a balance or a ledger entry. Pools are only those the configured factory lists; the router is the
 * owner's published `PROTOCOL_LIQUIDITY_ROUTER_ADDRESS`. A blank setting refuses by name, never a default:
 *   · no factory: `protocol.amm_factory_unset`, which the rooms show as the crypto network notice (rail.crypto)
 *   · no router: `protocol.liquidity_router_unset`; no fee tiers: `amm.fee_tiers_unset` (the form offers a custom fee)
 *   · no quote lifetime or slippage ceiling: the swap settings' own refusals, since a deadline and the minimums come
 *     from them
 * Positions and entries are read from the pools' own state and logs, not from an indexer view: a position is "this
 * address's shares in this pool", and its history is that pool's Transfer and Mint events.
 */
export interface LiquidityDeps {
  client: () => PublicClient;
  rpcUrl: () => string;
  /** `PROTOCOL_AMM_FACTORY_ADDRESS`. Zero refuses. */
  factory: () => Address;
  /** `PROTOCOL_LIQUIDITY_ROUTER_ADDRESS`. Zero or null refuses. */
  router: () => Address | null;
  /** `PROTOCOL_AMM_FEE_TIERS_BPS`. Null refuses `amm.fee_tiers_unset`. */
  feeTiers: () => number[] | null;
  /** `PROTOCOL_SWAP_QUOTE_TTL_SECONDS`: how long a quote lives, and so each call's deadline. */
  quoteTtlSeconds: () => number | null;
  /** `PROTOCOL_SWAP_SLIPPAGE_BPS`: how far under a quote a call's minimums may sit. */
  slippageBps: () => number | null;
  /** Every pool the factory lists with its tokens, at one block (the swap's own reader). */
  readPairs: (factory: Address) => Promise<ProtocolSwapPairs>;
  toTrpcError: (err: unknown) => TRPCError;
}

/** A refusal with its code in `cause`, so the rooms read the code and never the prose. */
class LiquidityRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'LiquidityRefusal';
  }
}
export const refuse = (trpcCode: TRPCError['code'], code: string, message: string) =>
  new TRPCError({ code: trpcCode, message: `${code}: ${message}`, cause: new LiquidityRefusal(code, message) });

const routerAbi = () => loadArtifact('LiquidityRouter').abi as Abi;
const poolAbi = () => loadArtifact('LiquidityPool').abi as Abi;
const factoryAbi = () => loadArtifact('LiquidityFactory').abi as Abi;
const ERC20_META = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const satisfies Abi;
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const MINT = parseAbiItem('event Mint(address indexed sender, uint256 amount0, uint256 amount1, uint256 liquidity)');

const call = (to: Address, data: Hex, summary: string) => ({ to, data, value: '0', summary });

export function createLiquidityProcedures(deps: LiquidityDeps) {
  const fail = (err: unknown, what: string): TRPCError =>
    err instanceof TRPCError ? err : deps.toTrpcError(err instanceof LiquidityRefusal ? err : classifyChainError(err, what, deps.rpcUrl()));

  const factory = (): Address => {
    const f = deps.factory();
    if (isZeroAddress(f))
      throw refuse('PRECONDITION_FAILED', 'protocol.amm_factory_unset', 'AMM factory is not configured (PROTOCOL_AMM_FACTORY_ADDRESS).');
    return getAddress(f);
  };
  const router = (): Address => {
    const r = deps.router();
    if (!r || isZeroAddress(r))
      throw refuse(
        'PRECONDITION_FAILED',
        LIQUIDITY_ROUTER_UNSET,
        'the liquidity router is not configured (PROTOCOL_LIQUIDITY_ROUTER_ADDRESS), so no liquidity call is built.',
      );
    return getAddress(r);
  };
  const ttl = (): number => {
    const seconds = deps.quoteTtlSeconds();
    if (seconds === null)
      throw refuse(
        'PRECONDITION_FAILED',
        SWAP_SETTINGS_UNSET,
        'PROTOCOL_SWAP_QUOTE_TTL_SECONDS is an owner setting; a liquidity call needs a deadline and none is invented.',
      );
    return seconds;
  };
  const slippage = (): number => {
    const bps = deps.slippageBps();
    if (bps === null)
      throw refuse(
        'PRECONDITION_FAILED',
        'protocol.swap_slippage_unset',
        'PROTOCOL_SWAP_SLIPPAGE_BPS is an owner setting; the minimums of a liquidity call come from it and none is invented.',
      );
    return bps;
  };
  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) =>
    deps.client().readContract({ address, abi, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) }) as Promise<T>;
  /** The deadline: the head block's time plus the owner's quote lifetime. */
  const deadline = async (): Promise<number> => {
    const block = await deps.client().getBlock();
    return Number(block.timestamp) + ttl();
  };

  /** A token's name, symbol and decimals, read from the token itself. */
  const tokenInfo = async (address: Address, block: bigint): Promise<LiquidityToken> => {
    const [name, symbol, decimals] = await Promise.all([
      read<string>(address, ERC20_META, 'name', [], block),
      read<string>(address, ERC20_META, 'symbol', [], block),
      read<number>(address, ERC20_META, 'decimals', [], block),
    ]);
    return { address, name, symbol, decimals: Number(decimals) };
  };

  /**
   * A pool the configured factory created, read from the pool and checked with the factory's own `getPool` at one block
   * (not looked up in a capped listing, so the factory's thousandth pool is as reachable as its first). An address that
   * does not answer as a pool, or one the factory did not create, refuses `protocol.not_factory_pool`; a chain that
   * cannot be read refuses as a chain outage.
   */
  const listedPool = async (address: string) => {
    const f = factory();
    const pool = getAddress(address);
    const block = await deps.client().getBlockNumber();
    const notAPool = () =>
      refuse('NOT_FOUND', LIQUIDITY_NOT_A_POOL, `${pool} is not a pool the configured factory created, so nothing is built for it.`);
    let fields: [Address, Address, number, readonly [bigint, bigint, number], bigint];
    try {
      fields = await Promise.all([
        read<Address>(pool, poolAbi(), 'token0', [], block),
        read<Address>(pool, poolAbi(), 'token1', [], block),
        read<number>(pool, poolAbi(), 'feeBps', [], block),
        read<readonly [bigint, bigint, number]>(pool, poolAbi(), 'getReserves', [], block),
        read<bigint>(pool, poolAbi(), 'totalSupply', [], block),
      ]);
    } catch (err) {
      const refusal = classifyChainError(err, 'amm.liquidityPool', deps.rpcUrl());
      if (chainDown(refusal)) throw refusal;
      throw notAPool();
    }
    const [t0, t1, fee, [reserve0, reserve1], supply] = fields;
    const listed = await read<Address>(f, factoryAbi(), 'getPool', [t0, t1, Number(fee)], block);
    if (getAddress(listed) !== pool) throw notAPool();
    const [token0, token1] = await Promise.all([tokenInfo(getAddress(t0), block), tokenInfo(getAddress(t1), block)]);
    return { pool, row: { feeBps: Number(fee) }, token0, token1, reserve0, reserve1, supply, block };
  };

  const positive = (value: string, what: string): bigint => {
    const n = BigInt(value);
    if (n <= 0n) throw refuse('BAD_REQUEST', LIQUIDITY_BOUNDS_UNSET, `${what} must be above zero.`);
    return n;
  };

  return {
    /** The owner's fee tiers for a new pool. Blank refuses `amm.fee_tiers_unset`; the form then offers a custom fee only. */
    feeTiers: publicJurisdictionProcedure('protocol', 'protocol')
      .output(liquidityFeeTiersOutputSchema)
      .query(() => {
        const tiers = deps.feeTiers();
        if (!tiers || tiers.length === 0)
          throw refuse(
            'PRECONDITION_FAILED',
            AMM_FEE_TIERS_UNSET,
            'the owner has not published fee tiers (PROTOCOL_AMM_FEE_TIERS_BPS); a custom fee from 0 to 10% can still be entered.',
          );
        return { tiers, capBps: POOL_FEE_CAP_BPS };
      }),

    /** Whether the factory already has a pool for the pair at this fee, and its address (or the address it would get). */
    poolExists: publicJurisdictionProcedure('protocol', 'protocol')
      .input(liquidityPoolExistsInputSchema)
      .output(liquidityPoolExistsOutputSchema)
      .query(async ({ input }) => {
        try {
          const f = factory();
          const block = await deps.client().getBlockNumber();
          const [a, b] = [getAddress(input.tokenA), getAddress(input.tokenB)];
          if (a === b) throw refuse('BAD_REQUEST', 'amm.identical_tokens', 'a pool needs two different tokens.');
          const existing = await read<Address>(f, factoryAbi(), 'getPool', [a, b, input.feeBps], block);
          if (!isZeroAddress(existing)) return { exists: true, pool: existing, blockNumber: block.toString() };
          const predicted = await read<Address>(f, factoryAbi(), 'predictPoolAddress', [a, b, input.feeBps], block);
          return { exists: false, pool: predicted, blockNumber: block.toString() };
        } catch (err) {
          throw fail(err, 'amm.poolExists');
        }
      }),

    /**
     * One call through the router that creates the pool and makes its first deposit: the price is the deposit's ratio.
     * A fee above the pool's 10% cap refuses `amm.fee_out_of_range`; a pool that already exists refuses `amm.pool_exists`.
     */
    buildCreateAndSeed: publicJurisdictionProcedure('protocol', 'protocol')
      .input(liquidityCreateInputSchema)
      .output(liquidityCreateOutputSchema)
      .query(async ({ input }) => {
        try {
          if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > POOL_FEE_CAP_BPS)
            throw refuse(
              'BAD_REQUEST',
              AMM_FEE_OUT_OF_RANGE,
              `a pool's fee is 0 to ${POOL_FEE_CAP_BPS} bps (10%); ${input.feeBps} is above the cap.`,
            );
          const f = factory();
          const r = router();
          const [a, b, owner] = [getAddress(input.tokenA), getAddress(input.tokenB), getAddress(input.owner)];
          if (a === b) throw refuse('BAD_REQUEST', 'amm.identical_tokens', 'a pool needs two different tokens.');
          const amountA = positive(input.amountA, 'the first amount');
          const amountB = positive(input.amountB, 'the second amount');
          const existing = await read<Address>(f, factoryAbi(), 'getPool', [a, b, input.feeBps]);
          if (!isZeroAddress(existing))
            throw refuse(
              'CONFLICT',
              LIQUIDITY_POOL_EXISTS,
              `this pair already has a pool at this fee (${existing}); add liquidity to it instead.`,
            );
          const minShares = sharesFor(0n, 0n, 0n, amountA, amountB);
          if (minShares === 0n) throw refuse('BAD_REQUEST', 'amm.seed_too_small', 'the first deposit is too small to mint any shares.');
          const pool = await read<Address>(f, factoryAbi(), 'predictPoolAddress', [a, b, input.feeBps]);
          const due = await deadline();
          const data = encodeFunctionData({
            abi: routerAbi(),
            functionName: 'createAndSeed',
            args: [a, b, input.feeBps, amountA, amountB, minShares, owner, BigInt(due)],
          });
          return {
            call: call(r, data, `Create the pool and deposit its first liquidity, minting at least ${minShares} shares`),
            router: r,
            pool,
            minShares: minShares.toString(),
            deadline: due,
          };
        } catch (err) {
          throw fail(err, 'amm.buildCreateAndSeed');
        }
      }),

    /** What adding deposits (the pool's ratio of what was offered) and mints, from the pool as read now. */
    quoteAddLiquidity: publicJurisdictionProcedure('protocol', 'protocol')
      .input(liquidityQuoteAddInputSchema)
      .output(liquidityQuoteAddOutputSchema)
      .query(async ({ input }) => {
        try {
          const r = router();
          const quoteTtlSeconds = ttl();
          const p = await listedPool(input.pool);
          const pair = optimalPair(
            p.reserve0,
            p.reserve1,
            positive(input.amount0Desired, 'the first amount'),
            positive(input.amount1Desired, 'the second amount'),
          );
          const shares = sharesFor(p.supply, p.reserve0, p.reserve1, pair.amount0, pair.amount1);
          return {
            pool: p.pool,
            token0: p.token0,
            token1: p.token1,
            reserve0: p.reserve0.toString(),
            reserve1: p.reserve1.toString(),
            amount0: pair.amount0.toString(),
            amount1: pair.amount1.toString(),
            shares: shares.toString(),
            totalSupply: p.supply.toString(),
            shareOfPoolBps: Number((shares * 10_000n) / (p.supply + shares || 1n)),
            blockNumber: p.block.toString(),
            quoteTtlSeconds,
            router: r,
          };
        } catch (err) {
          throw fail(err, 'amm.quoteAddLiquidity');
        }
      }),

    /**
     * The add call, from a fresh read: both minimums are the owner's slippage under the amounts the pool takes now, and
     * `minShares` is the person's own. A missing minimum refuses `protocol.bounds_unset`.
     */
    buildAddLiquidity: publicJurisdictionProcedure('protocol', 'protocol')
      .input(liquidityBuildAddInputSchema)
      .output(liquidityBuildAddOutputSchema)
      .query(async ({ input }) => {
        try {
          const r = router();
          const bps = slippage();
          const minShares = positive(input.minShares, 'the minimum shares');
          const p = await listedPool(input.pool);
          const d0 = positive(input.amount0Desired, 'the first amount');
          const d1 = positive(input.amount1Desired, 'the second amount');
          const pair = optimalPair(p.reserve0, p.reserve1, d0, d1);
          const [min0, min1] = [floorBy(pair.amount0, bps), floorBy(pair.amount1, bps)];
          const due = await deadline();
          const data = encodeFunctionData({
            abi: routerAbi(),
            functionName: 'addLiquidity',
            args: [p.pool, d0, d1, min0, min1, minShares, getAddress(input.owner), BigInt(due)],
          });
          return {
            call: call(r, data, `Add liquidity, minting at least ${minShares} shares`),
            router: r,
            amount0Min: min0.toString(),
            amount1Min: min1.toString(),
            deadline: due,
          };
        } catch (err) {
          throw fail(err, 'amm.buildAddLiquidity');
        }
      }),

    /** How much of one token swap-and-add swaps first, what the swap gives, and the shares the add then mints. */
    quoteSwapAndAdd: publicJurisdictionProcedure('protocol', 'protocol')
      .input(liquidityQuoteSwapAddInputSchema)
      .output(liquidityQuoteSwapAddOutputSchema)
      .query(async ({ input }) => {
        try {
          const r = router();
          const quoteTtlSeconds = ttl();
          const p = await listedPool(input.pool);
          const amountIn = positive(input.amountIn, 'the amount');
          const zeroIn = input.tokenIn.toLowerCase() === p.token0.address.toLowerCase();
          if (!zeroIn && input.tokenIn.toLowerCase() !== p.token1.address.toLowerCase())
            throw refuse('BAD_REQUEST', 'amm.token_not_in_pool', `${input.tokenIn} is not one of this pool's tokens.`);
          const [rIn, rOut] = zeroIn ? [p.reserve0, p.reserve1] : [p.reserve1, p.reserve0];
          const swapped = swapPart(rIn, amountIn, p.row.feeBps);
          if (swapped <= 0n || swapped >= amountIn)
            throw refuse('BAD_REQUEST', LIQUIDITY_BOUNDS_UNSET, 'this amount is too small to swap and add in this pool.');
          const received = amountOut(swapped, rIn, rOut, p.row.feeBps);
          const [n0, n1] = zeroIn ? [rIn + swapped, rOut - received] : [rOut - received, rIn + swapped];
          const [k0, k1] = zeroIn ? [amountIn - swapped, received] : [received, amountIn - swapped];
          const pair = optimalPair(n0, n1, k0, k1);
          const shares = sharesFor(p.supply, n0, n1, pair.amount0, pair.amount1);
          return {
            swapped: swapped.toString(),
            received: received.toString(),
            shares: shares.toString(),
            blockNumber: p.block.toString(),
            quoteTtlSeconds,
            router: r,
          };
        } catch (err) {
          throw fail(err, 'amm.quoteSwapAndAdd');
        }
      }),

    /** The swap-and-add call: one transaction, so if the add does not mint `minShares` the swap is undone with it. */
    buildSwapAndAdd: publicJurisdictionProcedure('protocol', 'protocol')
      .input(liquidityBuildSwapAddInputSchema)
      .output(liquidityBuildSwapAddOutputSchema)
      .query(async ({ input }) => {
        try {
          const r = router();
          const minShares = positive(input.minShares, 'the minimum shares');
          const p = await listedPool(input.pool);
          const amountIn = positive(input.amountIn, 'the amount');
          const due = await deadline();
          const data = encodeFunctionData({
            abi: routerAbi(),
            functionName: 'swapAndAdd',
            args: [p.pool, getAddress(input.tokenIn), amountIn, minShares, getAddress(input.owner), BigInt(due)],
          });
          return {
            call: call(r, data, `Swap part of one token and add both, minting at least ${minShares} shares`),
            router: r,
            deadline: due,
          };
        } catch (err) {
          throw fail(err, 'amm.buildSwapAndAdd');
        }
      }),

    /** Removing shares: both tokens pro rata, each at least the owner's slippage under what they are worth now. */
    buildRemoveLiquidity: publicJurisdictionProcedure('protocol', 'protocol')
      .input(liquidityBuildRemoveInputSchema)
      .output(liquidityBuildRemoveOutputSchema)
      .query(async ({ input }) => {
        try {
          const r = router();
          const bps = slippage();
          const shares = positive(input.shares, 'the shares');
          const p = await listedPool(input.pool);
          const held = await read<bigint>(p.pool, poolAbi(), 'balanceOf', [getAddress(input.owner)], p.block);
          if (shares > held)
            throw refuse('BAD_REQUEST', 'amm.shares_above_balance', `the wallet holds ${held} shares, fewer than ${shares}.`);
          const amount0 = (shares * p.reserve0) / p.supply;
          const amount1 = (shares * p.reserve1) / p.supply;
          const [min0, min1] = [floorBy(amount0, bps), floorBy(amount1, bps)];
          const due = await deadline();
          const data = encodeFunctionData({
            abi: routerAbi(),
            functionName: 'removeLiquidity',
            args: [p.pool, shares, min0, min1, getAddress(input.owner), BigInt(due)],
          });
          return {
            call: call(r, data, `Remove ${shares} shares for both tokens`),
            router: r,
            amount0: amount0.toString(),
            amount1: amount1.toString(),
            amount0Min: min0.toString(),
            amount1Min: min1.toString(),
            deadline: due,
          };
        } catch (err) {
          throw fail(err, 'amm.buildRemoveLiquidity');
        }
      }),

    /** Sending shares to another address: the pool share token's own `transfer`. The receiver then holds the position. */
    buildSendShares: publicJurisdictionProcedure('protocol', 'protocol')
      .input(liquiditySendSharesInputSchema)
      .output(liquiditySendSharesOutputSchema)
      .query(async ({ input }) => {
        try {
          const p = await listedPool(input.pool);
          const shares = positive(input.shares, 'the shares');
          const to = getAddress(input.to);
          if (isZeroAddress(to)) throw refuse('BAD_REQUEST', 'amm.send_to_zero', 'shares cannot be sent to the zero address.');
          const data = encodeFunctionData({ abi: poolAbi(), functionName: 'transfer', args: [to, shares] });
          return { call: call(p.pool, data, `Send ${shares} pool shares to ${to}`) };
        } catch (err) {
          throw fail(err, 'amm.buildSendShares');
        }
      }),

    /**
     * There is nothing separate to collect: swap fees stay in the pool's reserves and compound into every share, and are
     * paid out when liquidity is removed. So this always refuses `protocol.fees_compound`, saying why.
     */
    claimFees: publicJurisdictionProcedure('protocol', 'protocol')
      .input(z.object({ pool: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }))
      .mutation(() => {
        throw refuse(
          'PRECONDITION_FAILED',
          LIQUIDITY_FEES_COMPOUND,
          'fees are compounded into the position: they stay in the pool and are paid out when liquidity is removed.',
        );
      }),

    /** Every factory pool `account` holds shares in, read from the pools at one block. */
    positions: publicJurisdictionProcedure('protocol', 'protocol')
      .input(liquidityPositionsInputSchema)
      .output(liquidityPositionsOutputSchema)
      .query(async ({ input }) => {
        try {
          const account = getAddress(input.account);
          const pairs = await deps.readPairs(factory());
          const block = BigInt(pairs.blockNumber);
          const token = (a: string): LiquidityToken => {
            const t = pairs.tokens.find((x) => x.address.toLowerCase() === a.toLowerCase())!;
            return { address: t.address, name: t.name, symbol: t.symbol, decimals: t.decimals };
          };
          const held = await Promise.all(
            pairs.pools.map(async (row) => {
              const pool = getAddress(row.pool);
              const shares = await read<bigint>(pool, poolAbi(), 'balanceOf', [account], block);
              if (shares === 0n) return null;
              const supply = await read<bigint>(pool, poolAbi(), 'totalSupply', [], block);
              return {
                pool,
                token0: token(row.token0),
                token1: token(row.token1),
                feeBps: row.feeBps,
                shares: shares.toString(),
                totalSupply: supply.toString(),
              };
            }),
          );
          return { account, blockNumber: block.toString(), positions: held.filter((row) => row !== null) };
        } catch (err) {
          throw fail(err, 'amm.positions');
        }
      }),

    /**
     * One position: shares, share of the pool and what they are worth now; with an entry (every share from the account's
     * own deposits), what holding would have now, the difference and the fees earned. Read at one block.
     */
    position: publicJurisdictionProcedure('protocol', 'protocol')
      .input(liquidityPositionInputSchema)
      .output(liquidityPositionOutputSchema)
      .query(async ({ input }) => {
        try {
          const account = getAddress(input.account);
          const p = await listedPool(input.pool);
          const shares = await read<bigint>(p.pool, poolAbi(), 'balanceOf', [account], p.block);
          // The account's share history from the pool's own logs: every share that came to it, and the deposit behind
          // each one minted to it (the Mint in the same transaction with the same share amount). From the first block:
          // a node that bounds log ranges answers with a refusal, never a partial entry.
          const incoming = await deps
            .client()
            .getLogs({ address: p.pool, event: TRANSFER, args: { to: account }, fromBlock: 0n, toBlock: p.block });
          // The deposits behind the shares minted to it: the pool's Mint in each such transaction's own receipt, so only
          // the account's own transactions are read, never the pool's whole history.
          const minted = [...new Set(incoming.filter((log) => isZeroAddress(log.args.from!)).map((log) => log.transactionHash!))];
          const receipts = await Promise.all(minted.map((hash) => deps.client().getTransactionReceipt({ hash })));
          const mints = new Map<string, { liquidity: bigint; amount0: bigint; amount1: bigint }[]>();
          for (const receipt of receipts) {
            const found = parseEventLogs({ abi: [MINT], logs: receipt.logs.filter((log) => getAddress(log.address) === p.pool) });
            mints.set(
              receipt.transactionHash,
              found.map((log) => ({ liquidity: log.args.liquidity, amount0: log.args.amount0, amount1: log.args.amount1 })),
            );
          }
          const entry = entryOf(
            incoming.map((log) => {
              const mint = mints.get(log.transactionHash!)?.find((m) => m.liquidity === log.args.value);
              return {
                from: log.args.from!,
                value: log.args.value!,
                deposit: mint ? { amount0: mint.amount0, amount1: mint.amount1 } : null,
              };
            }),
          );
          const f = positionFigures(shares, p.supply, p.reserve0, p.reserve1, shares === 0n ? null : entry);
          const s = (n: bigint) => n.toString();
          return {
            pool: p.pool,
            account,
            token0: p.token0,
            token1: p.token1,
            feeBps: p.row.feeBps,
            shares: s(shares),
            totalSupply: s(p.supply),
            shareOfPoolBps: f.shareOfPoolBps,
            reserve0: s(p.reserve0),
            reserve1: s(p.reserve1),
            amount0: s(f.amount0),
            amount1: s(f.amount1),
            entry: entry && shares > 0n ? { amount0: s(entry.amount0), amount1: s(entry.amount1), shares: s(entry.shares) } : null,
            feesEarned: f.feesEarned ? { amount0: s(f.feesEarned.amount0), amount1: s(f.feesEarned.amount1) } : null,
            impermanentLoss: f.impermanentLoss
              ? {
                  held0: s(f.impermanentLoss.held0),
                  held1: s(f.impermanentLoss.held1),
                  now0: s(f.impermanentLoss.now0),
                  now1: s(f.impermanentLoss.now1),
                  diff0: s(f.impermanentLoss.diff0),
                  diff1: s(f.impermanentLoss.diff1),
                  valueHeld1: s(f.impermanentLoss.valueHeld1),
                  valueNow1: s(f.impermanentLoss.valueNow1),
                  diffBps: f.impermanentLoss.diffBps,
                  closedFormBps: f.impermanentLoss.closedFormBps,
                }
              : null,
            feeModel: 'compounding' as const,
            blockNumber: s(p.block),
          };
        } catch (err) {
          throw fail(err, 'amm.position');
        }
      }),

    /**
     * Why a liquidity call failed: the same call from the same wallet, run against the chain now. Only the router and the
     * factory's pools are asked about. When it reverts, the answer is the contract's own error name, never a guess.
     */
    explainLiquidityCall: publicJurisdictionProcedure('protocol', 'protocol')
      .input(liquidityExplainInputSchema)
      .output(liquidityExplainOutputSchema)
      .query(async ({ input }) => {
        try {
          const r = router();
          const to = getAddress(input.to);
          if (to !== r) await listedPool(to);
          const block = await deps.client().getBlockNumber();
          try {
            await deps.client().call({ account: getAddress(input.from), to, data: input.data as Hex, blockNumber: block });
            return { reverts: false, error: null, blockNumber: block.toString() };
          } catch (err) {
            const data = revertData(err);
            if (data === null) throw err;
            return { reverts: true, error: errorName(data), blockNumber: block.toString() };
          }
        } catch (err) {
          throw fail(err, 'amm.explainLiquidityCall');
        }
      }),
  };
}

/** The revert data a failed `eth_call` carries, found down viem's error chain; null when it is not a revert. */
function revertData(err: unknown): Hex | null {
  for (let link: unknown = err, depth = 0; link && depth < 10; link = (link as { cause?: unknown }).cause, depth++) {
    const data = (link as { data?: unknown }).data;
    if (typeof data === 'string' && /^0x[0-9a-fA-F]*$/.test(data)) return data as Hex;
    if (data && typeof data === 'object' && typeof (data as { data?: unknown }).data === 'string') return (data as { data: Hex }).data;
  }
  return null;
}

/** The custom error's name from the router's, pool's and factory's ABIs (createAndSeed bubbles the factory's); `revert` when the data names no error either declares. */
function errorName(data: Hex): string {
  for (const abi of [routerAbi(), poolAbi(), factoryAbi()]) {
    try {
      return decodeErrorResult({ abi, data }).errorName;
    } catch {
      /* not this contract's error */
    }
  }
  return 'revert';
}
