import type { Address, PublicClient } from 'viem';
import {
  FEE_SHARE_TOTAL_BPS,
  PROTOCOL_FEE_POLICY_FIELDS,
  PROTOCOL_FEE_POLICY_UNSET,
  PROTOCOL_NOT_FACTORY_POOL,
  protocolPoolFeesInputSchema,
  protocolPoolFeesOutputSchema,
  protocolRequestProtocolFeeInputSchema,
  publicJurisdictionProcedure,
  router,
  TRPCError,
  type ProtocolPoolFees,
} from '@intafaced/contracts';
import { classifyChainError, isZeroAddress } from '../chain/availability.js';
import { factoryAbi, poolAbi } from './abi.js';

/** The reads `readPoolFees` needs, all at one block. `ChainClient` provides them through `poolFeesChain`. */
export interface PoolFeesChain {
  headBlock(): Promise<bigint>;
  /** The pool's `token0`, `token1` and `feeBps`; null when the address does not answer as a pool (a revert, or no code). */
  poolFields(pool: Address, blockNumber: bigint): Promise<{ token0: Address; token1: Address; feeBps: number } | null>;
  /** The factory's `getPool(token0, token1, feeBps)`. */
  factoryPool(factory: Address, token0: Address, token1: Address, feeBps: number, blockNumber: bigint): Promise<Address>;
}

/** A call that reverted or returned nothing: the address answered, but not as a pool. Never a chain outage. */
const NOT_AN_ANSWER = new Set(['ContractFunctionRevertedError', 'ContractFunctionZeroDataError', 'AbiDecodingZeroDataError']);
function notAnAnswer(err: unknown): boolean {
  for (let link: unknown = err, depth = 0; link && depth < 8; link = (link as { cause?: unknown }).cause, depth++) {
    if (NOT_AN_ANSWER.has(String((link as { name?: unknown }).name))) return true;
  }
  return false;
}

/** `PoolFeesChain` over viem. A refusal from the node itself stays the shared typed chain refusal. */
export function poolFeesChain(client: () => PublicClient, rpcUrl: () => string, headBlock: () => Promise<bigint>): PoolFeesChain {
  return {
    headBlock,
    async poolFields(pool, blockNumber) {
      try {
        const [token0, token1, feeBps] = await Promise.all([
          client().readContract({ address: pool, abi: poolAbi, functionName: 'token0', blockNumber }),
          client().readContract({ address: pool, abi: poolAbi, functionName: 'token1', blockNumber }),
          client().readContract({ address: pool, abi: poolAbi, functionName: 'feeBps', blockNumber }),
        ]);
        return { token0, token1, feeBps: Number(feeBps) };
      } catch (err) {
        if (notAnAnswer(err)) return null;
        throw classifyChainError(err, 'poolFields', rpcUrl());
      }
    },
    async factoryPool(factory, token0, token1, feeBps, blockNumber) {
      try {
        return await client().readContract({
          address: factory,
          abi: factoryAbi,
          functionName: 'getPool',
          args: [token0, token1, feeBps],
          blockNumber,
        });
      } catch (err) {
        throw classifyChainError(err, 'factoryPool', rpcUrl());
      }
    },
  };
}

/**
 * Who gets a factory pool's fees, from the pool's own fee fields at one block (D-fees-governance-04 (a)). The factory
 * deploys only `ConstantProductPool`, whose swap fee stays in the pool for its liquidity providers and which has no fee
 * recipient (`ConstantProductPool.sol:12-13,27`; `src/amm/invariants.test.ts` fails the build if one appears). So the
 * whole fee is the LPs' and there is no third share. An address the factory did not create gets no claim at all: it
 * refuses `protocol.not_factory_pool`, since any contract can answer `feeBps()`.
 */
export async function readPoolFees(chain: PoolFeesChain, factory: Address, pool: Address): Promise<ProtocolPoolFees> {
  const blockNumber = await chain.headBlock();
  const fields = await chain.poolFields(pool, blockNumber);
  const listed = fields ? await chain.factoryPool(factory, fields.token0, fields.token1, fields.feeBps, blockNumber) : null;
  if (!fields || !listed || listed.toLowerCase() !== pool.toLowerCase()) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `${PROTOCOL_NOT_FACTORY_POOL}: ${pool} is not a pool the configured factory created, so nothing is said about its fees.`,
    });
  }
  const shares = [{ to: 'liquidity_providers' as const, bps: FEE_SHARE_TOTAL_BPS }];
  return {
    pool: pool.toLowerCase(),
    factory: factory.toLowerCase(),
    feeBps: fields.feeBps,
    shares,
    thirdShare: shares.some((share) => share.to !== 'liquidity_providers' && share.bps > 0),
    contract: 'ConstantProductPool v1',
    blockNumber: blockNumber.toString(),
  };
}

export interface PoolFeesRouterDeps {
  chain: PoolFeesChain;
  /** `PROTOCOL_AMM_FACTORY_ADDRESS`. Zero refuses. */
  factory: () => Address;
  /** Shapes a chain refusal the way the rest of the router does. */
  toTrpcError: (err: unknown) => TRPCError;
}

/**
 * `protocol.amm.poolFees` and `protocol.amm.requestProtocolFee` (D-fees-governance-04 (a), (b)). Public chain reads
 * behind the same permissionless guard as `amm.pairs`. The request moves nothing and records nothing: with the owner's
 * fee policy blank, it refuses by name and lists the fields the owner must publish first.
 */
export function createPoolFeesProcedures(deps: PoolFeesRouterDeps) {
  return {
    poolFees: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolPoolFeesInputSchema)
      .output(protocolPoolFeesOutputSchema)
      .query(async ({ input }) => {
        const factory = deps.factory();
        if (isZeroAddress(factory))
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'protocol.amm_factory_unset: AMM factory is not configured (PROTOCOL_AMM_FACTORY_ADDRESS).',
          });
        try {
          return await readPoolFees(deps.chain, factory, input.pool as Address);
        } catch (err) {
          throw deps.toTrpcError(err);
        }
      }),

    requestProtocolFee: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolRequestProtocolFeeInputSchema)
      .mutation(() => {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            `${PROTOCOL_FEE_POLICY_UNSET}: the protocol fee policy is not set. The owner has not published ` +
            `${PROTOCOL_FEE_POLICY_FIELDS.join(', ')}; a protocol fee would also need new contracts, and the existing pools take no protocol fee.`,
        });
      }),
  };
}

/** The same procedures as a router, for tests that call them alone. */
export const createPoolFeesRouter = (deps: PoolFeesRouterDeps) => router(createPoolFeesProcedures(deps));
