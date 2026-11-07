import { z } from 'zod';
import {
  liquidityBuildAddOutputSchema,
  liquidityBuildRemoveOutputSchema,
  liquidityBuildSwapAddOutputSchema,
  liquidityCreateOutputSchema,
  liquidityExplainOutputSchema,
  liquidityFeeTiersOutputSchema,
  liquidityPoolExistsOutputSchema,
  liquidityPositionOutputSchema,
  liquidityPositionsOutputSchema,
  liquidityQuoteAddOutputSchema,
  liquidityQuoteSwapAddOutputSchema,
  liquiditySendSharesOutputSchema,
} from '@intafaced/contracts/protocol-liquidity';
import type { ApiClient } from '../../../shared/api';

/**
 * The liquidity rooms' calls to the protocol service (D-liquidity-01..04). Reads and unsigned calls only: every call that
 * moves tokens is signed by the person's wallet in the room, never here.
 */
export function createLiquidityApi(api: ApiClient) {
  return {
    feeTiers: (signal?: AbortSignal) => api.query('protocol', 'amm.feeTiers', undefined, liquidityFeeTiersOutputSchema, { signal }),
    poolExists: (input: { tokenA: string; tokenB: string; feeBps: number }, signal?: AbortSignal) =>
      api.query('protocol', 'amm.poolExists', input, liquidityPoolExistsOutputSchema, { signal }),
    buildCreate: (input: { owner: string; tokenA: string; tokenB: string; feeBps: number; amountA: string; amountB: string }) =>
      api.query('protocol', 'amm.buildCreateAndSeed', input, liquidityCreateOutputSchema),
    quoteAdd: (input: { pool: string; amount0Desired: string; amount1Desired: string }, signal?: AbortSignal) =>
      api.query('protocol', 'amm.quoteAddLiquidity', input, liquidityQuoteAddOutputSchema, { signal }),
    buildAdd: (input: { owner: string; pool: string; amount0Desired: string; amount1Desired: string; minShares: string }) =>
      api.query('protocol', 'amm.buildAddLiquidity', input, liquidityBuildAddOutputSchema),
    quoteSwapAdd: (input: { pool: string; tokenIn: string; amountIn: string }, signal?: AbortSignal) =>
      api.query('protocol', 'amm.quoteSwapAndAdd', input, liquidityQuoteSwapAddOutputSchema, { signal }),
    buildSwapAdd: (input: { owner: string; pool: string; tokenIn: string; amountIn: string; minShares: string }) =>
      api.query('protocol', 'amm.buildSwapAndAdd', input, liquidityBuildSwapAddOutputSchema),
    buildRemove: (input: { owner: string; pool: string; shares: string }) =>
      api.query('protocol', 'amm.buildRemoveLiquidity', input, liquidityBuildRemoveOutputSchema),
    buildSend: (input: { owner: string; pool: string; to: string; shares: string }) =>
      api.query('protocol', 'amm.buildSendShares', input, liquiditySendSharesOutputSchema),
    claimFees: (pool: string) => api.mutate('protocol', 'amm.claimFees', { pool }, z.unknown()),
    positions: (account: string, signal?: AbortSignal) =>
      api.query('protocol', 'amm.positions', { account }, liquidityPositionsOutputSchema, { signal }),
    position: (pool: string, account: string, signal?: AbortSignal) =>
      api.query('protocol', 'amm.position', { pool, account }, liquidityPositionOutputSchema, { signal }),
    explain: (input: { from: string; to: string; data: string }) =>
      api.query('protocol', 'amm.explainLiquidityCall', input, liquidityExplainOutputSchema),
  };
}
export type LiquidityApi = ReturnType<typeof createLiquidityApi>;

/** A refusal's code, matched exactly from the service's code or its message prefix; never guessed from other prose. */
export function refusalCode(failure: { code?: string; message?: string }): string | null {
  if (failure.code && /^[a-z_]+\.[a-z_.]+$/.test(failure.code)) return failure.code;
  const match = /^([a-z_]+\.[a-z_.]+):/.exec(failure.message ?? '');
  return match ? match[1]! : null;
}
