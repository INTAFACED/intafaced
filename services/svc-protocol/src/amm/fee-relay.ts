import { TRPCError } from '@trpc/server';
import {
  FEE_CHARGE_ABOVE_SIGNED,
  FEE_RELAY_REFUSED,
  FEE_RELAY_UNSET,
  FEE_SWAP_SIGNATURE_INVALID,
  FEE_TOKEN_NOT_ALLOWLISTED,
  FEE_TOKEN_ORACLE_STALE,
  FEE_TOKEN_ORACLE_UNREAD,
  FEE_TOKEN_PERMIT_UNREAD,
  type ProtocolFeeQuote,
  type ProtocolFeeSwapOrder,
  type ProtocolFeeSwapPlan,
  type ProtocolFeeSwapSubmitInput,
  type ProtocolFeeTokens,
  type ProtocolTypedData,
} from '@intafaced/contracts';
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseSignature,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';

/**
 * Paying a swap's network fee in a token the person holds (RC-dex-protocol-02), through the FeeTokenRelay contract
 * (contracts/paymaster/FeeTokenRelay.sol). This service holds no key and sends nothing itself: it reads the relay's
 * price, builds what the person signs, checks the signed order against the chain, and hands it to the relayer named by
 * PROTOCOL_FEE_RELAY_URL, which sends it and pays the gas in native currency. The relay contract prices the fee from the
 * fail-closed oracle plus its published markup; nothing here computes a price of its own.
 */

/** A refusal whose code the client can branch on: tRPC's error formatter sends `cause.code` as the code. */
export class FeeRelayRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'FeeRelayRefusal';
  }
}

export function feeRefusal(trpcCode: TRPCError['code'], code: string, message: string): TRPCError {
  const cause = new FeeRelayRefusal(code, message);
  return new TRPCError({ code: trpcCode, message: cause.message, cause });
}

export const FEE_RELAY_ABI = parseAbi([
  'function oracle() view returns (address)',
  'function markupBps() view returns (uint16)',
  'function feeTokens() view returns (address[])',
  'function allowlisted(address token) view returns (bool)',
  'function nonces(address owner) view returns (uint256)',
  'function quoteCharge(address token, uint256 gasWei) view returns (uint256 charge, uint256 markWad, uint64 updatedAt)',
  'struct Order { address owner; address pool; address tokenIn; uint256 amountIn; uint256 minAmountOut; address feeToken; uint256 gasWei; uint256 maxCharge; uint256 nonce; uint256 deadline; }',
  'struct Permit { address token; uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }',
  'function swap(Order order, bytes signature, Permit[] permits) returns (uint256 amountOut, uint256 charge)',
  'event FeeCharged(address indexed owner, address indexed relayer, address indexed feeToken, uint256 gasWei, uint256 markWad, uint16 markupBps, uint256 charge)',
  'event RelayedSwap(address indexed owner, address indexed pool, address tokenIn, uint256 amountIn, uint256 amountOut)',
  'error NotAllowlisted(address token)',
  'error ChargeAboveMax(uint256 charge, uint256 maxCharge)',
  'error OrderExpired()',
  'error BadNonce()',
  'error BadSignature()',
  'error TransferFailed()',
  'error Reentered()',
  // The oracle's own refusals, which quoteCharge passes through unchanged (oracle/FailClosedOracle.sol).
  'error Stale()',
  'error MissingReport()',
  'error Disagreement()',
]);

const TOKEN_ABI = parseAbi([
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'function version() view returns (string)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function nonces(address owner) view returns (uint256)',
]);

/** The three owner settings; any one blank and paying in a token refuses `protocol.fee_relay_unset`. */
export interface FeeRelaySetting {
  relay: Address;
  url: string;
  gasLimit: bigint;
}

/** `PROTOCOL_FEE_RELAY_GAS_LIMIT`: whole gas above zero, at most 30,000,000 (one block). Anything else is null. */
export function parseRelayGasLimit(raw: string | null | undefined): bigint | null {
  const text = (raw ?? '').trim();
  if (!/^[1-9]\d{0,7}$/.test(text)) return null;
  const value = BigInt(text);
  return value <= 30_000_000n ? value : null;
}

export function requireFeeRelay(setting: FeeRelaySetting | null | undefined): FeeRelaySetting {
  if (!setting)
    throw feeRefusal(
      'PRECONDITION_FAILED',
      FEE_RELAY_UNSET,
      `PROTOCOL_FEE_RELAY_ADDRESS, PROTOCOL_FEE_RELAY_URL and PROTOCOL_FEE_RELAY_GAS_LIMIT are owner settings; pay the network fee in native currency.`,
    );
  return setting;
}

/** The chain reads this module makes: a view on a contract, and an eth_call that may revert. */
export interface FeeRelayChain {
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown>;
  call(args: { account?: Address; to: Address; data: Hex; blockNumber?: bigint }): Promise<unknown>;
  /** Always `{ cacheTime: 0 }`: the node's block now, never a cached number, since every read here pins to it (#7192). */
  getBlockNumber(args: { cacheTime: 0 }): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

/** The custom error a reverted relay or oracle call named, or null when it was not a revert this ABI knows. */
export function revertName(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? null;
  return null;
}

/** The relay's own refusals of a fee token, as typed errors; any other failure is rethrown for the chain classifier. */
export function feeTokenRefusal(err: unknown, token: Address): TRPCError | null {
  const name = revertName(err);
  if (name === 'NotAllowlisted')
    return feeRefusal(
      'PRECONDITION_FAILED',
      FEE_TOKEN_NOT_ALLOWLISTED,
      `${token} is not on the relay's allowlist of fee tokens; pay the network fee in native currency.`,
    );
  if (name === 'Stale')
    return feeRefusal(
      'PRECONDITION_FAILED',
      FEE_TOKEN_ORACLE_STALE,
      `the oracle's mark for ${token} is older than its staleness bound; pay the network fee in native currency.`,
    );
  if (name === 'MissingReport' || name === 'Disagreement')
    return feeRefusal(
      'PRECONDITION_FAILED',
      FEE_TOKEN_ORACLE_UNREAD,
      `the oracle gives no mark for ${token} (${name === 'MissingReport' ? 'a source has not reported' : 'its sources disagree'}); pay the network fee in native currency.`,
    );
  return null;
}

/** The relay's tokens with names and whether each may pay, its published markup and the gas a relayed swap is priced for. */
export async function readFeeTokens(chain: FeeRelayChain, setting: FeeRelaySetting): Promise<ProtocolFeeTokens> {
  const blockNumber = await chain.getBlockNumber({ cacheTime: 0 });
  const at = { address: setting.relay, abi: FEE_RELAY_ABI, blockNumber };
  const [markupBps, listed] = (await Promise.all([
    chain.readContract({ ...at, functionName: 'markupBps' }),
    chain.readContract({ ...at, functionName: 'feeTokens' }),
  ])) as [number, Address[]];
  const tokens = await Promise.all(
    listed.map(async (token) => {
      const [allowlisted, name, symbol, decimals] = (await Promise.all([
        chain.readContract({ ...at, functionName: 'allowlisted', args: [token] }),
        chain.readContract({ address: token, abi: TOKEN_ABI, functionName: 'name', blockNumber }),
        chain.readContract({ address: token, abi: TOKEN_ABI, functionName: 'symbol', blockNumber }),
        chain.readContract({ address: token, abi: TOKEN_ABI, functionName: 'decimals', blockNumber }),
      ])) as [boolean, string, string, number];
      return { address: getAddress(token), name, symbol, decimals: Number(decimals), allowlisted };
    }),
  );
  return { relay: getAddress(setting.relay), markupBps: Number(markupBps), gasLimit: setting.gasLimit.toString(), tokens };
}

/**
 * What the gas costs in `feeToken`, priced by the relay contract itself at one block: `gasWei` is the gas limit times the
 * most per gas the person chose. A token off the allowlist, or a stale or missing oracle mark, refuses by name.
 */
export async function quoteFee(
  chain: FeeRelayChain,
  setting: FeeRelaySetting,
  feeToken: Address,
  maxFeePerGasWei: bigint,
): Promise<ProtocolFeeQuote> {
  // The node's block now, never a cached one: viem keeps a block number for its polling interval, and a quote pinned to
  // a block from before the relay or a token change reads no code or the old list (#7192).
  const blockNumber = await chain.getBlockNumber({ cacheTime: 0 });
  const gasWei = setting.gasLimit * maxFeePerGasWei;
  const at = { address: setting.relay, abi: FEE_RELAY_ABI, blockNumber };
  let priced: [bigint, bigint, bigint];
  let markup: number;
  try {
    [priced, markup] = (await Promise.all([
      chain.readContract({ ...at, functionName: 'quoteCharge', args: [feeToken, gasWei] }),
      chain.readContract({ ...at, functionName: 'markupBps' }),
    ])) as [[bigint, bigint, bigint], number];
  } catch (err) {
    throw feeTokenRefusal(err, feeToken) ?? err;
  }
  const markupBps = Number(markup);
  const [charge, markWad, updatedAt] = priced;
  return {
    relay: getAddress(setting.relay),
    feeToken: getAddress(feeToken),
    gasLimit: setting.gasLimit.toString(),
    maxFeePerGasWei: maxFeePerGasWei.toString(),
    gasWei: gasWei.toString(),
    markWad: markWad.toString(),
    markAsOf: new Date(Number(updatedAt) * 1000).toISOString(),
    markupBps,
    charge: charge.toString(),
    blockNumber: blockNumber.toString(),
  };
}

const DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];
const ORDER_FIELDS = [
  { name: 'owner', type: 'address' },
  { name: 'pool', type: 'address' },
  { name: 'tokenIn', type: 'address' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'minAmountOut', type: 'uint256' },
  { name: 'feeToken', type: 'address' },
  { name: 'gasWei', type: 'uint256' },
  { name: 'maxCharge', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
];
const PERMIT_FIELDS = [
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
];

/** The relay's EIP-712 domain, as FeeTokenRelay.domainSeparator() builds it. */
export const relayDomain = (relay: Address, chainId: number) => ({
  name: 'FeeTokenRelay',
  version: '1',
  chainId,
  verifyingContract: getAddress(relay),
});

export function orderTypedData(relay: Address, chainId: number, order: ProtocolFeeSwapOrder): ProtocolTypedData {
  return {
    types: { EIP712Domain: DOMAIN_FIELDS, FeeSwap: ORDER_FIELDS },
    primaryType: 'FeeSwap',
    domain: relayDomain(relay, chainId),
    message: { ...order },
  };
}

/**
 * How much of each token the relay must be allowed to pull: the swap's input, and the fee at most the signed charge,
 * summed when both are one token. One permit per token, in the order the tokens first appear.
 */
export function permitAmounts(order: Pick<ProtocolFeeSwapOrder, 'tokenIn' | 'amountIn' | 'feeToken' | 'maxCharge'>) {
  const amounts = new Map<string, { token: Address; value: bigint }>();
  for (const [token, value] of [
    [order.tokenIn, BigInt(order.amountIn)],
    [order.feeToken, BigInt(order.maxCharge)],
  ] as const) {
    const key = token.toLowerCase();
    const known = amounts.get(key);
    amounts.set(key, { token: getAddress(token), value: (known?.value ?? 0n) + value });
  }
  return [...amounts.values()].filter((entry) => entry.value > 0n);
}

/**
 * A token's own EIP-712 permit domain: its `eip712Domain()` (EIP-5267), else its `name()` and `version()`. A token that
 * answers neither refuses by name: a permit signed against a guessed version would never verify.
 */
async function permitDomain(chain: FeeRelayChain, token: Address, chainId: number, blockNumber: bigint) {
  const at = { address: token, abi: TOKEN_ABI, blockNumber };
  try {
    const [, name, version, domainChain, verifying] = (await chain.readContract({ ...at, functionName: 'eip712Domain' })) as [
      Hex,
      string,
      string,
      bigint,
      Address,
    ];
    if (Number(domainChain) === chainId && verifying.toLowerCase() === token.toLowerCase())
      return { name, version, chainId, verifyingContract: getAddress(token) };
  } catch {
    // No EIP-5267: fall back to name() and version().
  }
  try {
    const [name, version] = (await Promise.all([
      chain.readContract({ ...at, functionName: 'name' }),
      chain.readContract({ ...at, functionName: 'version' }),
    ])) as [string, string];
    return { name, version, chainId, verifyingContract: getAddress(token) };
  } catch {
    throw feeRefusal(
      'PRECONDITION_FAILED',
      FEE_TOKEN_PERMIT_UNREAD,
      `${token} gives no EIP-712 permit domain (eip712Domain or version), so no permit can be signed for it.`,
    );
  }
}

/**
 * The quote, then what the person signs: a permit for each token the relay pulls (EIP-2612, read from the token's own
 * name and nonce) and the FeeSwap order, which binds the pool, the minimum, the fee token, the gas and the exact charge.
 * Both expire at `deadline` (chain seconds).
 */
export async function planFeeSwap(
  chain: FeeRelayChain,
  setting: FeeRelaySetting,
  chainId: number,
  swap: { owner: Address; pool: Address; tokenIn: Address; amountIn: bigint; minAmountOut: bigint; feeToken: Address },
  maxFeePerGasWei: bigint,
  lifetimeSeconds: number,
): Promise<ProtocolFeeSwapPlan> {
  const quote = await quoteFee(chain, setting, swap.feeToken, maxFeePerGasWei);
  const blockNumber = BigInt(quote.blockNumber);
  const [{ timestamp }, nonce] = (await Promise.all([
    chain.getBlock({ blockNumber }),
    chain.readContract({ address: setting.relay, abi: FEE_RELAY_ABI, functionName: 'nonces', args: [swap.owner], blockNumber }),
  ])) as [{ timestamp: bigint }, bigint];
  const deadline = (timestamp + BigInt(lifetimeSeconds)).toString();
  const order: ProtocolFeeSwapOrder = {
    owner: getAddress(swap.owner),
    pool: getAddress(swap.pool),
    tokenIn: getAddress(swap.tokenIn),
    amountIn: swap.amountIn.toString(),
    minAmountOut: swap.minAmountOut.toString(),
    feeToken: getAddress(swap.feeToken),
    gasWei: quote.gasWei,
    maxCharge: quote.charge,
    nonce: nonce.toString(),
    deadline,
  };
  const permits = await Promise.all(
    permitAmounts(order).map(async ({ token, value }) => {
      const [domain, tokenNonce] = (await Promise.all([
        permitDomain(chain, token, chainId, blockNumber),
        chain.readContract({ address: token, abi: TOKEN_ABI, functionName: 'nonces', args: [swap.owner], blockNumber }),
      ])) as [Awaited<ReturnType<typeof permitDomain>>, bigint];
      return {
        types: { EIP712Domain: DOMAIN_FIELDS, Permit: PERMIT_FIELDS },
        primaryType: 'Permit',
        domain,
        message: {
          owner: order.owner,
          spender: getAddress(setting.relay),
          value: value.toString(),
          nonce: tokenNonce.toString(),
          deadline,
        },
      } satisfies ProtocolTypedData;
    }),
  );
  return { quote, permits, order: orderTypedData(setting.relay, chainId, order) };
}

/** The signer of the order, or a refusal: a signature that does not recover to the order's owner is never relayed. */
export async function checkOrderSignature(relay: Address, chainId: number, order: ProtocolFeeSwapOrder, signature: Hex) {
  const typed = orderTypedData(relay, chainId, order);
  const { EIP712Domain: _domain, ...types } = typed.types;
  let signer: Address | null = null;
  try {
    signer = await recoverTypedDataAddress({
      domain: { ...typed.domain, verifyingContract: typed.domain.verifyingContract as Address },
      types,
      primaryType: 'FeeSwap',
      message: {
        ...order,
        amountIn: BigInt(order.amountIn),
        minAmountOut: BigInt(order.minAmountOut),
        gasWei: BigInt(order.gasWei),
        maxCharge: BigInt(order.maxCharge),
        nonce: BigInt(order.nonce),
        deadline: BigInt(order.deadline),
      },
      signature,
    });
  } catch {
    signer = null;
  }
  if (!signer || signer.toLowerCase() !== order.owner.toLowerCase())
    throw feeRefusal('FORBIDDEN', FEE_SWAP_SIGNATURE_INVALID, `the order is not signed by its owner ${order.owner}.`);
}

/** The relay's swap() call for a signed order and its permits, as the relayer sends it. */
export function encodeRelaySwap(input: Pick<ProtocolFeeSwapSubmitInput, 'order' | 'signature' | 'permits'>): Hex {
  const { order } = input;
  return encodeFunctionData({
    abi: FEE_RELAY_ABI,
    functionName: 'swap',
    args: [
      {
        owner: order.owner as Address,
        pool: order.pool as Address,
        tokenIn: order.tokenIn as Address,
        amountIn: BigInt(order.amountIn),
        minAmountOut: BigInt(order.minAmountOut),
        feeToken: order.feeToken as Address,
        gasWei: BigInt(order.gasWei),
        maxCharge: BigInt(order.maxCharge),
        nonce: BigInt(order.nonce),
        deadline: BigInt(order.deadline),
      },
      input.signature as Hex,
      input.permits.map((permit) => {
        const { v, yParity, r, s } = parseSignature(permit.signature as Hex);
        return {
          token: permit.token as Address,
          value: BigInt(permit.value),
          deadline: BigInt(permit.deadline),
          v: Number(v ?? BigInt(yParity + 27)),
          r,
          s,
        };
      }),
    ],
  });
}

/**
 * Checks a signed order and hands it to the relayer: the signature recovers to the owner; the per-gas fee is within the
 * owner's cap and matches the gas signed for; the relay prices the fee at no more than the signed charge right now; and
 * the call succeeds when tried against the chain. Only then is it posted to the relayer, which answers the hash.
 */
export async function relayFeeSwap(
  chain: FeeRelayChain,
  setting: FeeRelaySetting,
  chainId: number,
  input: ProtocolFeeSwapSubmitInput,
  feeCapWei: bigint,
  post: (url: string, body: unknown) => Promise<{ status: number; body: unknown }>,
): Promise<{ hash: Hex; relayer: Address }> {
  const { order } = input;
  await checkOrderSignature(setting.relay, chainId, order, input.signature as Hex);
  const maxFee = BigInt(input.maxFeePerGasWei);
  const priority = BigInt(input.maxPriorityFeePerGasWei);
  if (maxFee > feeCapWei || priority > maxFee || setting.gasLimit * maxFee !== BigInt(order.gasWei))
    throw feeRefusal(
      'BAD_REQUEST',
      'protocol.fee_relay_gas_mismatch',
      'the per-gas fee is over the cap, or does not match the gas the order was signed for.',
    );
  const quote = await quoteFee(chain, setting, order.feeToken as Address, maxFee);
  if (BigInt(quote.charge) > BigInt(order.maxCharge))
    throw feeRefusal(
      'CONFLICT',
      FEE_CHARGE_ABOVE_SIGNED,
      `the relay now prices the fee at ${quote.charge}, above the ${order.maxCharge} signed for; get a new quote.`,
    );
  const data = encodeRelaySwap(input);
  try {
    // Tried as if the relay contract itself sent it: a real token refuses a fee paid to the zero address (an eth_call's
    // default sender), and the relayer's own address is not known here. The fee then goes to the relay, which a token
    // accepts like any holder; every pull, permit and the swap run as they will.
    await chain.call({ account: setting.relay, to: setting.relay, data });
  } catch (err) {
    const refusal = feeTokenRefusal(err, order.feeToken as Address);
    if (refusal) throw refusal;
    throw feeRefusal(
      'CONFLICT',
      FEE_RELAY_REFUSED,
      `the swap would not succeed on the chain now (${revertName(err) ?? 'reverted'}); nothing was sent.`,
    );
  }
  const sent = await post(setting.url, {
    to: getAddress(setting.relay),
    data,
    gas: `0x${setting.gasLimit.toString(16)}`,
    maxFeePerGas: `0x${maxFee.toString(16)}`,
    maxPriorityFeePerGas: `0x${priority.toString(16)}`,
  }).catch(() => null);
  const body = (sent?.body ?? {}) as { hash?: unknown; relayer?: unknown };
  if (
    !sent ||
    sent.status !== 200 ||
    typeof body.hash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(body.hash) ||
    typeof body.relayer !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(body.relayer)
  )
    throw feeRefusal('BAD_GATEWAY', FEE_RELAY_REFUSED, `the relayer did not take the swap; nothing was sent.`);
  return { hash: body.hash as Hex, relayer: getAddress(body.relayer) };
}
