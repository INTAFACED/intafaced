import { GAS_PERCENTILES_UNSET } from '@intafaced/contracts';
import { classifyChainError } from './availability.js';

/**
 * D-explorer-01 gas tracker. The three percentiles and the block count are owner
 * settings. Blank, or a value that is not three increasing percentiles in 0..100
 * and a block count in 1..1024, refuses `protocol.gas_percentiles_unset`.
 * Nothing here invents 10, 50 and 90.
 */

export const MAX_GAS_HISTORY_BLOCKS = 1024;

export class GasPercentilesUnsetError extends Error {
  readonly code = GAS_PERCENTILES_UNSET;

  constructor() {
    super(
      `${GAS_PERCENTILES_UNSET}: PROTOCOL_GAS_PERCENTILES and PROTOCOL_GAS_HISTORY_BLOCKS are unset — refusing rather than inventing a gas percentile`,
    );
    this.name = 'GasPercentilesUnsetError';
  }
}

export interface GasPercentileSetting {
  readonly percentiles: readonly [number, number, number];
  readonly blocks: number;
}

/** Blank / malformed → null. Never coerces a blank to 0 or to 10/50/90. */
export function parseGasPercentileSetting(
  percentilesRaw: string | null | undefined,
  blocksRaw: string | number | null | undefined,
): GasPercentileSetting | null {
  const raw = (percentilesRaw ?? '').trim();
  if (raw === '') return null;
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.length !== 3) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 100) return null;
    nums.push(n);
  }
  const low = nums[0]!;
  const average = nums[1]!;
  const high = nums[2]!;
  if (!(low < average && average < high)) return null;

  if (blocksRaw == null) return null;
  const blocksText = String(blocksRaw).trim();
  if (!/^\d+$/.test(blocksText)) return null;
  const blocks = Number(blocksText);
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > MAX_GAS_HISTORY_BLOCKS) return null;
  return { percentiles: [low, average, high], blocks };
}

export function requireGasPercentileSetting(
  percentilesRaw: string | null | undefined,
  blocksRaw: string | number | null | undefined,
): GasPercentileSetting {
  const setting = parseGasPercentileSetting(percentilesRaw, blocksRaw);
  if (!setting) throw new GasPercentilesUnsetError();
  return setting;
}

export interface GasPriceQuote {
  asOf: string;
  chainId: number;
  blocks: number;
  percentiles: [number, number, number];
  gasPriceWei: string;
  baseFeePerGasWei: string | null;
  priorityFeeWei: { low: string; average: string; high: string } | null;
}

function floorMean(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  let sum = 0n;
  for (const value of values) sum += value;
  return sum / BigInt(values.length);
}

function column(reward: readonly (readonly bigint[])[] | null, index: number): bigint[] {
  if (!reward) return [];
  const out: bigint[] = [];
  for (const row of reward) {
    const value = row[index];
    if (value !== undefined) out.push(value);
  }
  return out;
}

/**
 * A pre-EIP-1559 node reports no base fee. viem fills that as an all-zero array
 * and omits rewards. All-zero base fees are absent only in that case. When reward
 * columns are present, the last base fee is returned, including 0. A zero beside
 * a non-zero base fee stays zero.
 */
function reportedBaseFee(baseFeePerGas: readonly bigint[] | null, reward: readonly (readonly bigint[])[] | null): bigint | null {
  if (!baseFeePerGas || baseFeePerGas.length === 0) return null;
  const anyFee = baseFeePerGas.some((fee) => fee > 0n);
  if (!anyFee && reward == null) return null;
  return baseFeePerGas[baseFeePerGas.length - 1]!;
}

export function quoteFromHistory(input: {
  gasPrice: bigint;
  baseFeePerGas: readonly bigint[] | null;
  reward: readonly (readonly bigint[])[] | null;
  setting: GasPercentileSetting;
  asOf: Date;
  chainId: number;
}): GasPriceQuote {
  if (input.gasPrice < 0n) {
    throw new Error('eth_gasPrice returned a negative value');
  }
  const base = reportedBaseFee(input.baseFeePerGas, input.reward);
  let priority: GasPriceQuote['priorityFeeWei'] = null;
  if (base !== null && input.reward) {
    const low = floorMean(column(input.reward, 0));
    const average = floorMean(column(input.reward, 1));
    const high = floorMean(column(input.reward, 2));
    if (low !== null && average !== null && high !== null) {
      priority = { low: low.toString(), average: average.toString(), high: high.toString() };
    }
  }
  return {
    asOf: input.asOf.toISOString(),
    chainId: input.chainId,
    blocks: input.setting.blocks,
    percentiles: [input.setting.percentiles[0], input.setting.percentiles[1], input.setting.percentiles[2]],
    gasPriceWei: input.gasPrice.toString(),
    baseFeePerGasWei: base === null ? null : base.toString(),
    priorityFeeWei: priority,
  };
}

function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 12; depth += 1) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** The node answered, and it does not offer `eth_feeHistory`. A dead node is not this. */
export function feeHistoryUnsupported(err: unknown): boolean {
  for (const link of causeChain(err)) {
    const name = typeof (link as { name?: unknown }).name === 'string' ? (link as { name: string }).name : '';
    const code = (link as { code?: unknown }).code;
    const message = typeof (link as { message?: unknown }).message === 'string' ? (link as { message: string }).message : '';
    if (name === 'MethodNotFoundRpcError') return true;
    if (code === -32601 || code === '-32601') return true;
    if (/method .*not found/i.test(message) || /method .*does not exist/i.test(message)) return true;
  }
  return false;
}

export interface GasHistoryReader {
  getGasPrice(): Promise<bigint>;
  getFeeHistory(args: { blockCount: number; rewardPercentiles: number[] }): Promise<{
    baseFeePerGas: readonly bigint[];
    reward?: readonly (readonly bigint[])[] | null;
  }>;
}

/**
 * `eth_gasPrice` plus `eth_feeHistory`. A node without fee history still returns
 * the gas price and null base fee. A node that does not answer refuses; no price is invented.
 */
export async function readGasPrice(
  reader: GasHistoryReader,
  setting: GasPercentileSetting,
  asOf: Date,
  chainId: number,
  rpcUrl: string,
): Promise<GasPriceQuote> {
  let gasPrice: bigint;
  try {
    gasPrice = await reader.getGasPrice();
  } catch (err) {
    throw classifyChainError(err, 'gasPrice', rpcUrl);
  }
  let baseFeePerGas: readonly bigint[] | null = null;
  let reward: readonly (readonly bigint[])[] | null = null;
  try {
    const history = await reader.getFeeHistory({
      blockCount: setting.blocks,
      rewardPercentiles: [...setting.percentiles],
    });
    baseFeePerGas = history.baseFeePerGas;
    reward = history.reward ?? null;
  } catch (err) {
    if (!feeHistoryUnsupported(err)) throw classifyChainError(err, 'feeHistory', rpcUrl);
  }
  return quoteFromHistory({ gasPrice, baseFeePerGas, reward, setting, asOf, chainId });
}
