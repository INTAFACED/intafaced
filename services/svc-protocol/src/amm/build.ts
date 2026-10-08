import { encodeFunctionData, type Address, type Hex } from 'viem';
import { factoryAbi, poolAbi } from './abi.js';
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

export function buildSwapExactIn(
  pool: Address,
  tokenIn: Address,
  amountIn: bigint,
  minAmountOut: bigint,
  to: Address,
  deadline: bigint,
): UnsignedAmmCall {
  return {
    to: pool,
    data: encodeFunctionData({
      abi: poolAbi,
      functionName: 'swapExactIn',
      args: [tokenIn, amountIn, minAmountOut, to, deadline],
    }),
    value: '0',
    summary: `swapExactIn pool=${pool} tokenIn=${tokenIn} amountIn=${amountIn.toString()} minOut=${minAmountOut.toString()} deadline=${deadline.toString()}`,
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
