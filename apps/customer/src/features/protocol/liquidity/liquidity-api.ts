import {
  PROTOCOL_AMM_BUILD_ADD_LIQUIDITY,
  PROTOCOL_AMM_BUILD_CREATE_AND_SEED,
  PROTOCOL_AMM_BUILD_REMOVE_LIQUIDITY,
  PROTOCOL_AMM_BUILD_SEND_SHARES,
  PROTOCOL_AMM_BUILD_SWAP_AND_ADD,
  PROTOCOL_AMM_CLAIM_FEES,
  PROTOCOL_AMM_EXPLAIN_LIQUIDITY_CALL,
  PROTOCOL_AMM_FEE_TIERS,
  PROTOCOL_AMM_POOL_EXISTS,
  PROTOCOL_AMM_POSITION,
  PROTOCOL_AMM_POSITIONS,
  PROTOCOL_AMM_QUOTE_ADD_LIQUIDITY,
  PROTOCOL_AMM_QUOTE_SWAP_AND_ADD,
} from '@intafaced/contracts/protocol-amm-procedures';
import type { ApiClient } from '../../../shared/api';

/**
 * The liquidity rooms' calls to the protocol service (D-liquidity-01..04). Reads and unsigned calls only: every call that
 * moves tokens is signed by the person's wallet in the room, never here.
 */
export function createLiquidityApi(api: ApiClient) {
  return {
    feeTiers: (signal?: AbortSignal) => api.call(PROTOCOL_AMM_FEE_TIERS, undefined, { signal }),
    poolExists: (input: { tokenA: string; tokenB: string; feeBps: number }, signal?: AbortSignal) =>
      api.call(PROTOCOL_AMM_POOL_EXISTS, input, { signal }),
    buildCreate: (input: { owner: string; tokenA: string; tokenB: string; feeBps: number; amountA: string; amountB: string }) =>
      api.call(PROTOCOL_AMM_BUILD_CREATE_AND_SEED, input),
    quoteAdd: (input: { pool: string; amount0Desired: string; amount1Desired: string }, signal?: AbortSignal) =>
      api.call(PROTOCOL_AMM_QUOTE_ADD_LIQUIDITY, input, { signal }),
    buildAdd: (input: { owner: string; pool: string; amount0Desired: string; amount1Desired: string; minShares: string }) =>
      api.call(PROTOCOL_AMM_BUILD_ADD_LIQUIDITY, input),
    quoteSwapAdd: (input: { pool: string; tokenIn: string; amountIn: string }, signal?: AbortSignal) =>
      api.call(PROTOCOL_AMM_QUOTE_SWAP_AND_ADD, input, { signal }),
    buildSwapAdd: (input: { owner: string; pool: string; tokenIn: string; amountIn: string; minShares: string }) =>
      api.call(PROTOCOL_AMM_BUILD_SWAP_AND_ADD, input),
    buildRemove: (input: { owner: string; pool: string; shares: string }) => api.call(PROTOCOL_AMM_BUILD_REMOVE_LIQUIDITY, input),
    buildSend: (input: { owner: string; pool: string; to: string; shares: string }) => api.call(PROTOCOL_AMM_BUILD_SEND_SHARES, input),
    claimFees: (pool: string) => api.call(PROTOCOL_AMM_CLAIM_FEES, { pool }),
    positions: (account: string, signal?: AbortSignal) => api.call(PROTOCOL_AMM_POSITIONS, { account }, { signal }),
    position: (pool: string, account: string, signal?: AbortSignal) => api.call(PROTOCOL_AMM_POSITION, { pool, account }, { signal }),
    explain: (input: { from: string; to: string; data: string }) => api.call(PROTOCOL_AMM_EXPLAIN_LIQUIDITY_CALL, input),
  };
}
export type LiquidityApi = ReturnType<typeof createLiquidityApi>;

/** A refusal's code, matched exactly from the service's code or its message prefix; never guessed from other prose. */
export function refusalCode(failure: { code?: string; message?: string }): string | null {
  if (failure.code && /^[a-z_]+\.[a-z_.]+$/.test(failure.code)) return failure.code;
  const match = /^([a-z_]+\.[a-z_.]+):/.exec(failure.message ?? '');
  return match ? match[1]! : null;
}

/** The refusals that mean the network's pool factory, router or node is not there: the rooms show the crypto network notice. */
export const NO_NETWORK = new Set(['protocol.amm_factory_unset', 'protocol.chain_unreachable', 'protocol.liquidity_router_unset']);
export const isNoNetwork = (failure: { code?: string; message?: string }) => NO_NETWORK.has(refusalCode(failure) ?? '');

/** A refusal's words without its leading machine code ("protocol.x: words" → "words"). */
export const plainReason = (message: string) => message.replace(/^[a-z_]+\.[a-z_.]+: /, '');
