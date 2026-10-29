import { decodeFunctionData, formatUnits, parseAbi, type Abi } from 'viem';

/**
 * Interfaces this explorer can read a transaction's input against: the ERC-20 standard with permit, the platform's own
 * pool, router and factory, and the TEST token's mint. An input whose method is in none of them is reported undecoded with its selector, never guessed.
 */
const KNOWN: readonly Abi[] = [
  parseAbi([
    'function transfer(address to, uint256 amount)',
    'function approve(address spender, uint256 amount)',
    'function transferFrom(address from, address to, uint256 amount)',
    'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  ]),
  // The router names the pool it swaps through; the pool's own swapExactIn does not.
  parseAbi(['function swapExactIn(address pool, address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)']),
  // The TEST token's faucet mint (two arguments; a pool's mint takes three).
  parseAbi(['function mint(address to, uint256 amount)']),
  parseAbi([
    'function swap(uint256 amount0Out, uint256 amount1Out, address to)',
    'function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)',
    'function mint(address to, uint256 amount0Desired, uint256 amount1Desired)',
    'function burn(address to, uint256 liquidity)',
  ]),
  parseAbi(['function createPool(address tokenA, address tokenB, uint16 feeBps)']),
];

export interface DecodedArg {
  name: string;
  type: string;
  value: string;
}
export type DecodedInput =
  | { kind: 'empty' }
  | { kind: 'creation' }
  | { kind: 'decoded'; method: string; args: DecodedArg[] }
  | { kind: 'unknown'; selector: string };

function show(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
  return String(value);
}

/** Reads `input` against the known interfaces. `to === null` is a contract creation: its input is bytecode, not a call. */
export function decodeInput(input: string, to: string | null): DecodedInput {
  if (to === null) return { kind: 'creation' };
  if (input === '0x' || input === '') return { kind: 'empty' };
  const selector = input.slice(0, 10).toLowerCase();
  for (const abi of KNOWN) {
    try {
      const { functionName, args } = decodeFunctionData({ abi, data: input as `0x${string}` });
      const item = abi.find((entry) => entry.type === 'function' && entry.name === functionName);
      const inputs = item && item.type === 'function' ? item.inputs : [];
      return {
        kind: 'decoded',
        method: functionName,
        args: inputs.map((param, i) => ({ name: param.name ?? `arg${i}`, type: param.type, value: show(args?.[i]) })),
      };
    } catch {
      // Not this interface (or not well-formed for it): try the next one.
    }
  }
  return { kind: 'unknown', selector };
}

/** A wei amount (decimal string) in the network's native unit, exact: no float on the way. */
export const nativeAmount = (wei: string) => formatUnits(BigInt(wei), 18);
/** A wei price (decimal string) in gwei, exact. */
export const gwei = (wei: string) => formatUnits(BigInt(wei), 9);
