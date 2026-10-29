import { FEE_MARKET_UNREAD, SWAP_FEE_CAP_UNSET, type ProtocolSwapFeeLevel, type ProtocolSwapFees } from '@intafaced/contracts';
import type { GasPriceQuote } from '../chain/gas-price.js';

/**
 * The swap form's network fee levels (D-swap-11). Slow, Normal and Fast are the owner percentiles (low, average, high) of
 * the priority fees paid in the last N blocks, as `protocol.gasPrice` reads them; nothing here invents a gwei figure.
 * The owner's fee cap is the most per gas any level or custom fee may offer. A blank cap refuses
 * `protocol.swap_fee_cap_unset`; a node with no EIP-1559 fee history refuses `protocol.fee_market_unread`.
 */

export type SwapFeeRefusal = typeof SWAP_FEE_CAP_UNSET | typeof FEE_MARKET_UNREAD;

export class SwapFeeError extends Error {
  constructor(
    readonly code: SwapFeeRefusal,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'SwapFeeError';
  }
}

/** The largest uint256: no per-gas figure above it can be signed. */
const MAX_UINT256 = (1n << 256n) - 1n;

/** `PROTOCOL_SWAP_MAX_FEE_PER_GAS_WEI`: whole wei above zero. Blank or anything else is null, never a default. */
export function parseFeeCapWei(raw: string | null | undefined): bigint | null {
  const text = (raw ?? '').trim();
  if (!/^[1-9]\d{0,77}$/.test(text)) return null;
  const value = BigInt(text);
  return value <= MAX_UINT256 ? value : null;
}

export function requireFeeCapWei(cap: bigint | null | undefined): bigint {
  if (cap === null || cap === undefined)
    throw new SwapFeeError(
      SWAP_FEE_CAP_UNSET,
      'PROTOCOL_SWAP_MAX_FEE_PER_GAS_WEI is an owner setting; no fee level is offered until it is set.',
    );
  return cap;
}

/**
 * How far above the next block's base fee a level's most per gas sits. A technical bound from EIP-1559, not a price: the
 * base fee can rise at most 12.5% a block, and twice it covers six full blocks in a row (1.125^6 ≈ 2.03), so a sent
 * transaction stays includable that long. The wallet pays the base fee actually charged plus the priority fee, never
 * this most.
 */
export const BASE_FEE_HEADROOM = 2n;

function level(baseFee: bigint, priority: bigint, cap: bigint): ProtocolSwapFeeLevel {
  const most = baseFee * BASE_FEE_HEADROOM + priority;
  return { maxFeePerGasWei: most.toString(), maxPriorityFeePerGasWei: priority.toString(), overCap: most > cap };
}

/** The three levels from one gas read and the owner's cap. Refuses when the node gave no base fee or no priority history. */
export function feeLevels(quote: GasPriceQuote, capWei: bigint): ProtocolSwapFees {
  if (quote.baseFeePerGasWei === null || quote.priorityFeeWei === null)
    throw new SwapFeeError(
      FEE_MARKET_UNREAD,
      'this network’s node reports no base fee or no priority-fee history, so no fee level can be priced from the last blocks.',
    );
  const base = BigInt(quote.baseFeePerGasWei);
  const { low, average, high } = quote.priorityFeeWei;
  return {
    asOf: quote.asOf,
    chainId: quote.chainId,
    blocks: quote.blocks,
    percentiles: quote.percentiles,
    baseFeePerGasWei: base.toString(),
    feeCapWei: capWei.toString(),
    levels: {
      slow: level(base, BigInt(low), capWei),
      normal: level(base, BigInt(average), capWei),
      fast: level(base, BigInt(high), capWei),
    },
    // No paymaster is wired in this service (RC-dex-protocol-02), so the person's wallet pays the fee.
    sponsored: false,
  };
}
