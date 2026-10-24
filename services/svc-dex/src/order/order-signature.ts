/**
 * EIP-712 recovery for a price-trigger order (D-limit-dca-02).
 *
 * The published domain is the owner's. Blank is refused by the caller; this
 * file does not fill one in. Recovery uses viem's `recoverAddress`, the same
 * helper svc-protocol uses. This process holds no key and does not sign.
 */

import { getAddress, hashTypedData, recoverAddress, type Address, type Hex } from 'viem';
import type { TriggerVariant } from './trigger-math.js';

export interface OrderDomain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

export const PRICE_ORDER_TYPES = {
  PriceOrder: [
    { name: 'variant', type: 'string' },
    { name: 'maker', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'triggerPrice', type: 'uint256' },
    { name: 'minOut', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'slippageBps', type: 'uint256' },
  ],
} as const;

export interface PriceOrderBody {
  readonly variant: TriggerVariant;
  readonly maker: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly triggerPrice: bigint;
  readonly minOut: bigint;
  readonly expiry: string;
  readonly slippageBps: number;
}

/** Owner JSON. A blank string is handled by the env field; a partial object fails boot. */
export function parseOrderDomain(raw: string): OrderDomain {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DEX_ORDER_DOMAIN is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DEX_ORDER_DOMAIN must be a JSON object');
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.name !== 'string' || row.name.trim() === '') throw new Error('DEX_ORDER_DOMAIN name is blank');
  if (typeof row.version !== 'string' || row.version.trim() === '') throw new Error('DEX_ORDER_DOMAIN version is blank');
  if (typeof row.chainId !== 'number' || !Number.isSafeInteger(row.chainId) || row.chainId <= 0) {
    throw new Error('DEX_ORDER_DOMAIN chainId must be a positive integer');
  }
  if (typeof row.verifyingContract !== 'string' || row.verifyingContract.trim() === '') {
    throw new Error('DEX_ORDER_DOMAIN verifyingContract is blank');
  }
  let verifyingContract: Address;
  try {
    verifyingContract = getAddress(row.verifyingContract.trim());
  } catch {
    throw new Error('DEX_ORDER_DOMAIN verifyingContract must be a 20-byte hex address');
  }
  return { name: row.name.trim(), version: row.version.trim(), chainId: row.chainId, verifyingContract };
}

/** Lowercase address, or undefined when the signature does not recover. */
export async function recoverOrderMaker(domain: OrderDomain, order: PriceOrderBody, signature: string): Promise<string | undefined> {
  try {
    const hash = hashTypedData({
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract,
      },
      types: PRICE_ORDER_TYPES,
      primaryType: 'PriceOrder',
      message: {
        variant: order.variant,
        maker: getAddress(order.maker),
        tokenIn: getAddress(order.tokenIn),
        tokenOut: getAddress(order.tokenOut),
        amountIn: order.amountIn,
        triggerPrice: order.triggerPrice,
        minOut: order.minOut,
        expiry: BigInt(Date.parse(order.expiry)),
        slippageBps: BigInt(order.slippageBps),
      },
    });
    const recovered = await recoverAddress({ hash, signature: signature as Hex });
    return recovered.toLowerCase();
  } catch {
    return undefined;
  }
}
