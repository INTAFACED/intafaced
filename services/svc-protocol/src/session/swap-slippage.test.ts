import { describe, expect, it } from 'vitest';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import type { Address, Hex } from 'viem';
import { poolAbi } from '../amm/abi.js';
import { createSessionSpec, evaluateSessionCall, readSwapExactInCall } from './spec.js';

const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
const POOL: Address = '0x2222222222222222222222222222222222222222';
const TOKEN: Address = '0x3333333333333333333333333333333333333333';
const KEY: Address = '0x5555555555555555555555555555555555555555';
const ROUTER: Address = '0x6666666666666666666666666666666666666666';
const NOW = 1_700_000_000;
const POOL_SWAP = toFunctionSelector('swapExactIn(address,uint256,uint256,address)');
const ROUTER_SWAP = toFunctionSelector('swapExactIn(address,address,uint256,uint256,address)');

function spec(selector: Hex, targets: Address[]) {
  return createSessionSpec(
    { key: KEY, validAfter: 0, validUntil: NOW + 1000, spendLimitWei: '0', targets, selectors: [selector] },
    { account: ACCOUNT, now: NOW },
  );
}

function poolSwap(minAmountOut: bigint): Hex {
  return encodeFunctionData({
    abi: poolAbi,
    functionName: 'swapExactIn',
    args: [TOKEN, 10_000n, minAmountOut, ACCOUNT],
  });
}

function routerSwap(minAmountOut: bigint): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'swapExactIn',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'pool', type: 'address' },
          { name: 'tokenIn', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'minAmountOut', type: 'uint256' },
          { name: 'to', type: 'address' },
        ],
        outputs: [{ name: 'amountOut', type: 'uint256' }],
      },
    ],
    functionName: 'swapExactIn',
    args: [POOL, TOKEN, 10_000n, minAmountOut, ACCOUNT],
  });
}

describe('session spec rejects unbounded swap slippage', () => {
  it('refuses a pool swap that carries no quote and no slippage', () => {
    const data = poolSwap(0n);
    expect(readSwapExactInCall(data)).toMatchObject({ kind: 'pool', minAmountOut: 0n });
    const decision = evaluateSessionCall({
      spec: spec(POOL_SWAP, [POOL]),
      account: ACCOUNT,
      target: POOL,
      value: 0n,
      data,
      spentWei: 0n,
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('session.slippage_unbounded');
  });

  it('refuses a router swap the same way', () => {
    const decision = evaluateSessionCall({
      spec: spec(ROUTER_SWAP, [ROUTER, POOL]),
      account: ACCOUNT,
      target: ROUTER,
      value: 0n,
      data: routerSwap(1n),
      spentWei: 0n,
      now: NOW,
    });
    expect(decision.code).toBe('session.slippage_unbounded');
  });

  it('refuses a floor that rounds to 0, and a minimum under a real floor', () => {
    const dust = evaluateSessionCall({
      spec: spec(POOL_SWAP, [POOL]),
      account: ACCOUNT,
      target: POOL,
      value: 0n,
      data: poolSwap(1n),
      spentWei: 0n,
      now: NOW,
      swapBound: { quoteOut: 1n, slippageBps: 1 },
    });
    expect(dust.code).toBe('session.slippage_unbounded');

    const under = evaluateSessionCall({
      spec: spec(POOL_SWAP, [POOL]),
      account: ACCOUNT,
      target: POOL,
      value: 0n,
      data: poolSwap(19_544n),
      spentWei: 0n,
      now: NOW,
      swapBound: { quoteOut: 19_743n, slippageBps: 100 },
    });
    expect(under.code).toBe('session.swap_min_out_below_bound');
  });

  it('allows the minimum exactly at the floor for pool and router swaps', () => {
    const bound = { quoteOut: 19_743n, slippageBps: 100 };
    const pool = evaluateSessionCall({
      spec: spec(POOL_SWAP, [POOL]),
      account: ACCOUNT,
      target: POOL,
      value: 0n,
      data: poolSwap(19_545n),
      spentWei: 0n,
      now: NOW,
      swapBound: bound,
    });
    expect(pool).toMatchObject({ allowed: true, code: 'allowed' });

    const router = evaluateSessionCall({
      spec: spec(ROUTER_SWAP, [ROUTER, POOL]),
      account: ACCOUNT,
      target: ROUTER,
      value: 0n,
      data: routerSwap(19_545n),
      spentWei: 0n,
      now: NOW,
      swapBound: bound,
    });
    expect(router).toMatchObject({ allowed: true, code: 'allowed' });
  });

  it('still refuses a stranger recipient before it talks about slippage', () => {
    const data = encodeFunctionData({
      abi: poolAbi,
      functionName: 'swapExactIn',
      args: [TOKEN, 10_000n, 0n, KEY],
    });
    const decision = evaluateSessionCall({
      spec: spec(POOL_SWAP, [POOL]),
      account: ACCOUNT,
      target: POOL,
      value: 0n,
      data,
      spentWei: 0n,
      now: NOW,
    });
    expect(decision.code).toBe('session.recipient_not_account');
  });
});
