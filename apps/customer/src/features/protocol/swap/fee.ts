import type { ProtocolSwapFees } from '@intafaced/contracts/protocol-swap';
import { toBaseUnits } from '../wallet/transfer';
import { formatUnits } from './swap-math';

/**
 * The network fee the person picks for a swap (D-swap-11): one of the three levels the service read from the last
 * blocks, or a custom most-per-gas in gwei. Wei is bigint throughout; a gwei figure is only ever parsed or shown.
 */
export const FEE_LEVELS = ['slow', 'normal', 'fast'] as const;
export type FeeLevel = (typeof FEE_LEVELS)[number];
export type FeeChoice = FeeLevel | 'custom';

export type ChosenFee =
  { ok: true; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { ok: false; reason: 'custom_invalid' | 'over_cap' | 'under_base' };

const GWEI_DECIMALS = 9;

/** Wei per gas as gwei for reading, every decimal kept (a TEST chain's base fee can be a few wei). */
export const toGwei = (wei: bigint) => formatUnits(wei, GWEI_DECIMALS, GWEI_DECIMALS);

/**
 * What the wallet is asked to offer. A level is taken as the service priced it; it is refused, never lowered, when it is
 * above the cap. A custom fee is the most per gas: above the cap or under the next block's base fee it is refused, and its
 * priority fee is Normal's, capped at the custom most.
 */
export function chosenFee(fees: ProtocolSwapFees, choice: FeeChoice, customGwei: string): ChosenFee {
  const cap = BigInt(fees.feeCapWei);
  if (choice !== 'custom') {
    const level = fees.levels[choice];
    if (level.overCap) return { ok: false, reason: 'over_cap' };
    return { ok: true, maxFeePerGas: BigInt(level.maxFeePerGasWei), maxPriorityFeePerGas: BigInt(level.maxPriorityFeePerGasWei) };
  }
  const most = toBaseUnits(customGwei, GWEI_DECIMALS);
  if (most === null) return { ok: false, reason: 'custom_invalid' };
  if (most > cap) return { ok: false, reason: 'over_cap' };
  if (most < BigInt(fees.baseFeePerGasWei)) return { ok: false, reason: 'under_base' };
  const normal = BigInt(fees.levels.normal.maxPriorityFeePerGasWei);
  return { ok: true, maxFeePerGas: most, maxPriorityFeePerGas: normal < most ? normal : most };
}

/** The two EIP-1559 fields of a transaction request, as hex wei per gas. */
export function feeFields(fee: Extract<ChosenFee, { ok: true }>): { maxFeePerGas: string; maxPriorityFeePerGas: string } {
  return { maxFeePerGas: `0x${fee.maxFeePerGas.toString(16)}`, maxPriorityFeePerGas: `0x${fee.maxPriorityFeePerGas.toString(16)}` };
}
