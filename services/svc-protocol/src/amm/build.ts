import { encodeFunctionData, type Address, type Hex } from 'viem';
import { factoryAbi, poolAbi } from './abi.js';
import { erc20ApprovalAbi } from '../chain/abi.js';
import { getAmountOut, priceImpactBps } from './math.js';
import { pickBestRoute } from '../router/sovereign-quote.js';

/** Unsigned call the user's smart account (or EOA) will submit. Value always 0. */
export interface UnsignedAmmCall {
  to: Address;
  data: Hex;
  value: '0';
  summary: string;
}

export function buildCreatePool(factory: Address, tokenA: Address, tokenB: Address, feeBps: number): UnsignedAmmCall {
  return {
    to: factory,
    data: encodeFunctionData({
      abi: factoryAbi,
      functionName: 'createPool',
      args: [tokenA, tokenB, feeBps],
    }),
    value: '0',
    summary: `create AMM pool ${tokenA}/${tokenB} fee=${feeBps}bps`,
  };
}

export function buildSwapExactIn(pool: Address, tokenIn: Address, amountIn: bigint, minAmountOut: bigint, to: Address): UnsignedAmmCall {
  return {
    to: pool,
    data: encodeFunctionData({
      abi: poolAbi,
      functionName: 'swapExactIn',
      args: [tokenIn, amountIn, minAmountOut, to],
    }),
    value: '0',
    summary: `swapExactIn pool=${pool} tokenIn=${tokenIn} amountIn=${amountIn.toString()} minOut=${minAmountOut.toString()}`,
  };
}

export function buildMintLiquidity(pool: Address, to: Address, amount0Desired: bigint, amount1Desired: bigint): UnsignedAmmCall {
  return {
    to: pool,
    data: encodeFunctionData({
      abi: poolAbi,
      functionName: 'mint',
      args: [to, amount0Desired, amount1Desired],
    }),
    value: '0',
    summary: `mint LP pool=${pool} a0=${amount0Desired.toString()} a1=${amount1Desired.toString()}`,
  };
}

export function quoteExactIn(input: { amountIn: bigint; reserveIn: bigint; reserveOut: bigint; feeBps: number }): {
  amountOut: bigint;
  priceImpactBps: number;
} {
  const amountOut = getAmountOut(input.amountIn, input.reserveIn, input.reserveOut, input.feeBps);
  return {
    amountOut,
    priceImpactBps: priceImpactBps(input.amountIn, input.reserveIn, input.reserveOut, input.feeBps),
  };
}

/** Pool quote vs optional caller-supplied book out — never invents a book mid (S-A5). */
export function quoteBestExactIn(input: {
  amountIn: bigint;
  reserveIn: bigint;
  reserveOut: bigint;
  feeBps: number;
  bookAmountOut: bigint | null;
}) {
  return pickBestRoute(input);
}

/** 2^256 - 1: the "unlimited" allowance. Only ever built when the caller asks for it by name. */
export const MAX_UINT256 = (1n << 256n) - 1n;

/** `approve(spender, amount)` on `token`. The owner signs it; this service never does. */
export function buildApprove(token: Address, spender: Address, amount: bigint, unlimited = false): UnsignedAmmCall {
  const value = unlimited ? MAX_UINT256 : amount;
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20ApprovalAbi, functionName: 'approve', args: [spender, value] }),
    value: '0',
    summary: unlimited
      ? `approve UNLIMITED token=${token} spender=${spender}`
      : `approve token=${token} spender=${spender} amount=${value.toString()}`,
  };
}

/** `approve(spender, 0)`: takes the allowance away. */
export function buildRevoke(token: Address, spender: Address): UnsignedAmmCall {
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20ApprovalAbi, functionName: 'approve', args: [spender, 0n] }),
    value: '0',
    summary: `revoke approval token=${token} spender=${spender}`,
  };
}

export interface ApprovalPlan {
  needsApproval: boolean;
  /** The allowance is non-zero and the token refuses a direct change, so it is cleared first. */
  resetFirst: boolean;
  calls: UnsignedAmmCall[];
}

/**
 * ENGINE PRM-1. No call when the allowance already covers `amount`; one `approve(amount)` otherwise (exact unless
 * `unlimited`); a `[approve(0), approve(amount)]` pair when the token reverts on a direct non-zero to non-zero change.
 */
export function planApproval(input: {
  token: Address;
  spender: Address;
  amount: bigint;
  current: bigint;
  unlimited: boolean;
  directChangeReverts: boolean;
}): ApprovalPlan {
  if (input.current >= input.amount) return { needsApproval: false, resetFirst: false, calls: [] };
  const resetFirst = input.current > 0n && input.directChangeReverts;
  const calls = [
    ...(resetFirst ? [buildRevoke(input.token, input.spender)] : []),
    buildApprove(input.token, input.spender, input.amount, input.unlimited),
  ];
  return { needsApproval: true, resetFirst, calls };
}
