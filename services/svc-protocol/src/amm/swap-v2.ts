import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseSignature,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  DEADLINE_PAST,
  DEADLINE_REQUIRED,
  HOP_BELOW_MIN,
  PERMIT_ALLOWANCE_EXPIRED,
  PERMIT_ALLOWANCE_LOW,
  PERMIT_LIFETIME_OVER_CAP,
  PERMIT_LIFETIME_UNSET,
  PERMIT_NOT_SUPPORTED,
  ROUTE_MAX_HOPS_UNSET,
  ROUTE_NO_PATH,
  ROUTE_OVER_MAX_HOPS,
  ROUTER_V2_UNSET,
  protocolApprovalRouteOutputSchema,
  protocolBuildPermitInputSchema,
  protocolBuildPermitOutputSchema,
  protocolBuildSwapV2InputSchema,
  protocolBuildSwapV2OutputSchema,
  protocolPathOutputSchema,
  protocolPathsInputSchema,
  protocolSwapV2SettingsSchema,
  publicJurisdictionProcedure,
  type ProtocolApprovalRoute,
  type ProtocolApprovalRouteOutput,
  type ProtocolBuildPermitInput,
  type ProtocolBuildPermitOutput,
  type ProtocolBuildSwapV2Input,
  type ProtocolBuildSwapV2Output,
  type ProtocolPathOutput,
  type ProtocolPathsInput,
  type ProtocolSwapPairs,
  type ProtocolTypedData,
  TRPCError,
} from '@intafaced/contracts';
import { z } from 'zod';
import { isZeroAddress } from '../chain/availability.js';
import { feeRefusal } from './fee-relay.js';

/**
 * Router v2 swaps (D-swap-03, D-swap-intents-01, -02): how a token may be approved, the permits a person signs, the best
 * path with a chosen number of hops, and the one call the person's wallet sends. Every amount is read from the chain at
 * one block; nothing is invented and nothing posts to the ledger. A blank owner setting refuses by name.
 */

/** The most hops one path may have: a read bound of this service (each extra hop multiplies the paths read), not a limit. */
export const MAX_PATH_HOPS = 4;
/** The most candidate paths one request quotes: a read bound, so one request cannot flood the node. */
export const MAX_PATH_CANDIDATES = 64;

export const ROUTER_V2_ABI = parseAbi([
  'struct Swap { address[] path; address[] pools; uint256 amount; uint256 limit; uint256[] minOutPerHop; address to; uint256 deadline; uint8 pull; bool unwrapOut; }',
  'function exactIn(Swap p) payable returns (uint256)',
  'function exactOut(Swap p) payable returns (uint256)',
  'function multicall(bytes[] calls) returns (bytes[])',
  'function selfPermit(address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s, bool toPermitContract)',
  'function standingPermit(address token, uint160 amount, uint48 expiration, uint48 nonce, uint256 sigDeadline, bytes signature)',
  'function quoteExactIn(address[] path, address[] pools, uint256 amountIn) view returns (uint256[])',
  'function quoteExactOut(address[] path, address[] pools, uint256 amountOut) view returns (uint256[])',
  'error Expired()',
  'error BadPath()',
  'error BadAmount()',
  'error HopBelowMin(uint256 hop)',
  'error InsufficientOut()',
  'error ExcessiveInput()',
  'error InsufficientLiquidity()',
  'error TransferFailed()',
  'error NativeMismatch()',
  'error Reentrant()',
  'error ZeroAddress()',
  // SovereignPermit's own errors pass through the router unchanged.
  'error SignatureExpired()',
  'error AmountOverPermit()',
  'error NonceUsed()',
  'error BadSignature()',
  'error AllowanceExpired()',
  'error AllowanceTooLow()',
  'error ExpirationInPast()',
  'error BadNonce()',
]);
export const SOVEREIGN_PERMIT_ABI = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
]);
const TOKEN_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function nonces(address owner) view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
]);
const PULL = { allowance: 0, standing: 1, native: 2 } as const;
const DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];
const PERMIT_FIELDS = [
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
];
const ALLOWANCE_FIELDS = [
  { name: 'token', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'amount', type: 'uint160' },
  { name: 'expiration', type: 'uint48' },
  { name: 'nonce', type: 'uint48' },
  { name: 'sigDeadline', type: 'uint256' },
];
const UINT160_MAX = (1n << 160n) - 1n;
const UINT48_MAX = (1n << 48n) - 1n;

export interface SwapV2Setting {
  router: Address;
  sovereignPermit: Address;
  wrappedNative: Address;
}

export interface SwapV2Deps {
  client: () => PublicClient;
  chainId: () => number;
  /** Router v2, SovereignPermit and the wrapped native token; null when any is unset (`protocol.router_v2_unset`). */
  setting: () => SwapV2Setting | null;
  /** `PROTOCOL_PERMIT_LIFETIME_CAP_SECONDS`; null when blank (`protocol.permit.lifetime_unset`). */
  permitLifetimeCapSeconds: () => number | null;
  /** The owner's slippage ceiling in bps; throws its own refusal when blank. */
  slippageCeilingBps: () => number;
  /** The factory's pools, read from the chain; refuses by name when the factory is unset. */
  pairs: () => Promise<ProtocolSwapPairs>;
  toTrpcError: (err: unknown) => TRPCError;
}

const refuse = (code: TRPCError['code'], name: string, message: string) => feeRefusal(code, name, message);

function requireSetting(deps: SwapV2Deps): SwapV2Setting {
  const setting = deps.setting();
  if (!setting || isZeroAddress(setting.router) || isZeroAddress(setting.sovereignPermit) || isZeroAddress(setting.wrappedNative))
    throw refuse(
      'PRECONDITION_FAILED',
      ROUTER_V2_UNSET,
      'Router v2, SovereignPermit or the wrapped native token is not configured (PROTOCOL_ROUTER_V2_ADDRESS, PROTOCOL_SOVEREIGN_PERMIT_ADDRESS, PROTOCOL_WRAPPED_NATIVE_ADDRESS).',
    );
  return setting;
}

async function head(client: PublicClient) {
  const block = await client.getBlock({ blockTag: 'latest' });
  return { blockNumber: block.number, blockTime: block.timestamp };
}

/** The token's EIP-712 permit domain from EIP-5267, only when it names this chain and this token; else null. */
async function nativePermitDomain(client: PublicClient, token: Address, chainId: number, owner: Address, blockNumber: bigint) {
  try {
    const [[, name, version, domainChain, verifying], nonce] = await Promise.all([
      client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'eip712Domain', blockNumber }),
      client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'nonces', args: [owner], blockNumber }),
    ]);
    if (Number(domainChain) !== chainId || verifying.toLowerCase() !== token.toLowerCase()) return null;
    return { domain: { name, version, chainId, verifyingContract: getAddress(token) }, nonce };
  } catch {
    return null;
  }
}

/** How `owner` may let router v2 move `token` now, with both allowances and the standing allowance, read at one block. */
export async function readApprovalRoute(deps: SwapV2Deps, owner: Address, token: Address): Promise<ProtocolApprovalRouteOutput> {
  const setting = requireSetting(deps);
  const client = deps.client();
  const { blockNumber, blockTime } = await head(client);
  const [permit, routerAllowance, permitContractAllowance, standing] = await Promise.all([
    nativePermitDomain(client, token, deps.chainId(), owner, blockNumber),
    client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'allowance', args: [owner, setting.router], blockNumber }),
    client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'allowance', args: [owner, setting.sovereignPermit], blockNumber }),
    client.readContract({
      address: setting.sovereignPermit,
      abi: SOVEREIGN_PERMIT_ABI,
      functionName: 'allowance',
      args: [owner, token, setting.router],
      blockNumber,
    }),
  ]);
  const [amount, expiration, nonce] = standing;
  const route: ProtocolApprovalRoute = permit ? 'native_permit' : permitContractAllowance > 0n ? 'permit_contract' : 'approve_only';
  return {
    token: getAddress(token),
    route,
    routerAllowance: routerAllowance.toString(),
    permitContractAllowance: permitContractAllowance.toString(),
    standing:
      expiration === 0 && amount === 0n && nonce === 0 ? null : { amount: amount.toString(), expiration: String(expiration), nonce },
    blockNumber: blockNumber.toString(),
    blockTime: blockTime.toString(),
  };
}

/**
 * What the person signs for an approval. Exact: the token's own EIP-2612 permit for exactly `amount` to router v2,
 * usable until `expiresAt`. Standing: SovereignPermit's allowance for router v2 of `amount` until `expiresAt`, plus the
 * token-level approval of SovereignPermit for the same amount when it is short (the token's permit, or an approve
 * transaction for a token with none). Never unlimited. The owner's lifetime cap bounds both; blank refuses.
 */
export async function buildPermit(deps: SwapV2Deps, input: ProtocolBuildPermitInput): Promise<ProtocolBuildPermitOutput> {
  const setting = requireSetting(deps);
  const cap = deps.permitLifetimeCapSeconds();
  if (cap === null)
    throw refuse(
      'PRECONDITION_FAILED',
      PERMIT_LIFETIME_UNSET,
      'The permit lifetime cap (PROTOCOL_PERMIT_LIFETIME_CAP_SECONDS) is an owner setting; no permit is built while it is blank.',
    );
  const owner = getAddress(input.owner);
  const token = getAddress(input.token);
  const amount = BigInt(input.amount);
  const expiresAt = BigInt(input.expiresAt);
  if (amount > UINT160_MAX) throw refuse('BAD_REQUEST', 'protocol.permit.amount_invalid', 'The amount is larger than a permit can hold.');
  const client = deps.client();
  const { blockNumber, blockTime } = await head(client);
  if (expiresAt <= blockTime)
    throw refuse('BAD_REQUEST', DEADLINE_PAST, `The expiry ${expiresAt} is not after the chain's time ${blockTime}.`);
  if (expiresAt - blockTime > BigInt(cap) || expiresAt > UINT48_MAX)
    throw refuse('BAD_REQUEST', PERMIT_LIFETIME_OVER_CAP, `The expiry is more than the owner's cap of ${cap} seconds away.`);
  const chainId = deps.chainId();
  const permit = await nativePermitDomain(client, token, chainId, owner, blockNumber);
  const tokenPermitTo = (spender: Address): ProtocolTypedData => ({
    types: { EIP712Domain: DOMAIN_FIELDS, Permit: PERMIT_FIELDS },
    primaryType: 'Permit',
    domain: permit!.domain,
    message: { owner, spender, value: amount.toString(), nonce: permit!.nonce.toString(), deadline: expiresAt.toString() },
  });
  if (input.mode === 'exact') {
    if (!permit)
      throw refuse(
        'PRECONDITION_FAILED',
        PERMIT_NOT_SUPPORTED,
        `${token} publishes no permit of its own; it needs an approve transaction.`,
      );
    return {
      mode: 'exact',
      route: 'native_permit',
      token,
      amount: amount.toString(),
      expiresAt: expiresAt.toString(),
      tokenPermit: tokenPermitTo(setting.router),
      standing: null,
      approveCalls: [],
    };
  }
  const [contractAllowance, [, , nonce]] = await Promise.all([
    client.readContract({ address: token, abi: TOKEN_ABI, functionName: 'allowance', args: [owner, setting.sovereignPermit], blockNumber }),
    client.readContract({
      address: setting.sovereignPermit,
      abi: SOVEREIGN_PERMIT_ABI,
      functionName: 'allowance',
      args: [owner, token, setting.router],
      blockNumber,
    }),
  ]);
  const short = contractAllowance < amount;
  const route: ProtocolApprovalRoute = permit ? 'native_permit' : contractAllowance > 0n ? 'permit_contract' : 'approve_only';
  return {
    mode: 'standing',
    route,
    token,
    amount: amount.toString(),
    expiresAt: expiresAt.toString(),
    tokenPermit: short && permit ? tokenPermitTo(setting.sovereignPermit) : null,
    standing: {
      types: { EIP712Domain: DOMAIN_FIELDS, PermitAllowance: ALLOWANCE_FIELDS },
      primaryType: 'PermitAllowance',
      domain: { name: 'SovereignPermit', version: '1', chainId, verifyingContract: getAddress(setting.sovereignPermit) },
      message: {
        token,
        spender: getAddress(setting.router),
        amount: amount.toString(),
        expiration: expiresAt.toString(),
        nonce: String(nonce),
        sigDeadline: expiresAt.toString(),
      },
    },
    approveCalls:
      short && !permit
        ? [
            {
              to: token,
              data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: [setting.sovereignPermit, amount] }),
              value: '0',
              summary: `approve(${setting.sovereignPermit}, ${amount}) on ${token}: exactly the standing allowance, never unlimited`,
            },
          ]
        : [],
  };
}

/** Every simple path of exactly `hops` pools from `tokenIn` to `tokenOut` (no token twice), at most MAX_PATH_CANDIDATES. */
export function candidatePaths(pairs: ProtocolSwapPairs, tokenIn: Address, tokenOut: Address, hops: number) {
  const key = (address: string) => address.toLowerCase();
  const edges = new Map<string, Array<{ pool: Address; other: Address }>>();
  for (const pool of pairs.pools) {
    if (BigInt(pool.reserve0) === 0n || BigInt(pool.reserve1) === 0n) continue;
    for (const [from, to] of [
      [pool.token0, pool.token1],
      [pool.token1, pool.token0],
    ] as const) {
      const list = edges.get(key(from)) ?? [];
      list.push({ pool: getAddress(pool.pool), other: getAddress(to) });
      edges.set(key(from), list);
    }
  }
  const found: Array<{ path: Address[]; pools: Address[] }> = [];
  const walk = (path: Address[], pools: Address[]) => {
    if (found.length >= MAX_PATH_CANDIDATES) return;
    const at = path[path.length - 1]!;
    if (pools.length === hops) {
      if (key(at) === key(tokenOut)) found.push({ path: [...path], pools: [...pools] });
      return;
    }
    for (const edge of edges.get(key(at)) ?? []) {
      const last = pools.length + 1 === hops;
      if (path.some((token) => key(token) === key(edge.other))) continue;
      if (last !== (key(edge.other) === key(tokenOut))) continue;
      walk([...path, edge.other], [...pools, edge.pool]);
    }
  };
  walk([getAddress(tokenIn)], []);
  return found;
}

/**
 * The best path with exactly `hops` pools, quoted by router v2 at one block: the most out for exact input, the least in
 * for exact output. A multi-hop request with no hop limit refuses `dex.route.max_hops_unset`; more hops than the limit
 * refuses `dex.route.over_max_hops`.
 */
export async function bestPath(deps: SwapV2Deps, input: ProtocolPathsInput): Promise<ProtocolPathOutput> {
  if (input.hops > 1 && input.maxHops === null)
    throw refuse('BAD_REQUEST', ROUTE_MAX_HOPS_UNSET, `A ${input.hops}-hop route needs a hop limit; none is set.`);
  if (input.maxHops !== null && input.hops > input.maxHops)
    throw refuse('BAD_REQUEST', ROUTE_OVER_MAX_HOPS, `${input.hops} hops is more than the hop limit of ${input.maxHops}.`);
  if (input.hops > MAX_PATH_HOPS)
    throw refuse('BAD_REQUEST', ROUTE_OVER_MAX_HOPS, `This service reads paths of at most ${MAX_PATH_HOPS} hops.`);
  if (input.tokenIn.toLowerCase() === input.tokenOut.toLowerCase())
    throw refuse('BAD_REQUEST', 'protocol.route_same_token', 'Pay and receive name the same token.');
  const setting = requireSetting(deps);
  const client = deps.client();
  const pairs = await deps.pairs();
  const blockNumber = BigInt(pairs.blockNumber);
  const amount = BigInt(input.amount);
  const candidates = candidatePaths(pairs, input.tokenIn as Address, input.tokenOut as Address, input.hops);
  const quoted = await Promise.allSettled(
    candidates.map((candidate) =>
      client.readContract({
        address: setting.router,
        abi: ROUTER_V2_ABI,
        functionName: input.kind === 'exact_in' ? 'quoteExactIn' : 'quoteExactOut',
        args: [candidate.path, candidate.pools, amount],
        blockNumber,
      }),
    ),
  );
  let best: { index: number; amounts: readonly bigint[] } | null = null;
  quoted.forEach((entry, index) => {
    if (entry.status !== 'fulfilled') return;
    const amounts = entry.value;
    if (input.kind === 'exact_in') {
      const out = amounts[amounts.length - 1] ?? 0n;
      if (out > 0n && (!best || out > best.amounts[best.amounts.length - 1]!)) best = { index, amounts };
    } else if (!best || amounts[0]! < best.amounts[0]!) best = { index, amounts };
  });
  if (!best)
    throw refuse('NOT_FOUND', ROUTE_NO_PATH, `No path of ${input.hops} hop(s) joins these tokens through pools that can quote the amount.`);
  const { index, amounts } = best as { index: number; amounts: readonly bigint[] };
  const { path, pools } = candidates[index]!;
  // Exact in: amounts[i] is what hop i pays. Exact out: amounts[i] is what hop i is paid in, amounts[n] the output.
  const hopsOut = pools.map((pool, hop) => {
    const amountIn = input.kind === 'exact_in' ? (hop === 0 ? amount : amounts[hop - 1]!) : amounts[hop]!;
    const amountOut = input.kind === 'exact_in' ? amounts[hop]! : amounts[hop + 1]!;
    return { pool, tokenIn: path[hop]!, tokenOut: path[hop + 1]!, amountIn: amountIn.toString(), amountOut: amountOut.toString() };
  });
  const block = await client.getBlock({ blockNumber });
  return {
    kind: input.kind,
    path,
    pools,
    hops: hopsOut,
    amountIn: hopsOut[0]!.amountIn,
    amountOut: hopsOut[hopsOut.length - 1]!.amountOut,
    blockNumber: blockNumber.toString(),
    blockTime: block.timestamp.toString(),
  };
}

/** The named refusal for a router v2 revert the simulation saw. */
function simulationRefusal(err: unknown): TRPCError | null {
  let data: Hex | undefined;
  if (err instanceof BaseError) {
    const reverted = err.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
      return refusalFor(reverted.data.errorName, reverted.data.args as readonly unknown[] | undefined);
    }
    const raw = err.walk((cause) => typeof (cause as { data?: unknown }).data === 'string') as { data?: unknown } | null;
    if (raw && typeof raw.data === 'string' && /^0x[0-9a-fA-F]{8}/.test(raw.data)) data = raw.data as Hex;
  }
  if (!data) return null;
  try {
    const decoded = decodeErrorResult({ abi: ROUTER_V2_ABI, data });
    return refusalFor(decoded.errorName, decoded.args as readonly unknown[] | undefined);
  } catch {
    return null;
  }
}

function refusalFor(name: string, args: readonly unknown[] | undefined): TRPCError {
  if (name === 'AllowanceExpired')
    return refuse('CONFLICT', PERMIT_ALLOWANCE_EXPIRED, 'The standing allowance has expired; SovereignPermit refuses the pull.');
  if (name === 'AllowanceTooLow')
    return refuse('CONFLICT', PERMIT_ALLOWANCE_LOW, 'The standing allowance left is less than this swap needs.');
  if (name === 'HopBelowMin')
    return refuse('CONFLICT', HOP_BELOW_MIN, `Hop ${Number(args?.[0] ?? 0) + 1} would pay less than its minimum.`);
  if (name === 'Expired') return refuse('BAD_REQUEST', DEADLINE_PAST, 'The deadline has passed.');
  return refuse('CONFLICT', 'protocol.swap.simulation_reverted', `The swap would revert on chain (${name}).`);
}

/**
 * The router v2 call for one swap, its limits taken from a fresh read at the person's slippage: exact input sets a
 * minimum for every hop and for the total; exact output sets the most that may be paid. A signed permit goes in front of
 * the swap in one multicall. A deadline of zero or at or before the chain's time refuses; slippage above the owner's
 * ceiling refuses. With `simulate`, the call is run from the owner first and a revert refuses by name.
 */
export async function buildSwapV2(deps: SwapV2Deps, input: ProtocolBuildSwapV2Input): Promise<ProtocolBuildSwapV2Output> {
  const setting = requireSetting(deps);
  const client = deps.client();
  if (input.deadline === '0') throw refuse('BAD_REQUEST', DEADLINE_REQUIRED, 'Every swap has a deadline; zero is not one.');
  const ceiling = deps.slippageCeilingBps();
  if (input.slippageBps > ceiling)
    throw refuse(
      'BAD_REQUEST',
      'protocol.swap_slippage_over_ceiling',
      `${input.slippageBps} bps is above the owner's ceiling of ${ceiling}.`,
    );
  const path = input.path.map((token) => getAddress(token));
  const pools = input.pools.map((pool) => getAddress(pool));
  if (path.length !== pools.length + 1) throw refuse('BAD_REQUEST', 'protocol.swap.bad_path', 'A path has one more token than pools.');
  if (pools.length > MAX_PATH_HOPS)
    throw refuse('BAD_REQUEST', ROUTE_OVER_MAX_HOPS, `This service builds paths of at most ${MAX_PATH_HOPS} hops.`);
  if (pools.length > 1 && input.maxHops === null)
    throw refuse('BAD_REQUEST', ROUTE_MAX_HOPS_UNSET, `A ${pools.length}-hop route needs a hop limit; none is set.`);
  if (input.maxHops !== null && pools.length > input.maxHops)
    throw refuse('BAD_REQUEST', ROUTE_OVER_MAX_HOPS, `${pools.length} hops is more than the hop limit of ${input.maxHops}.`);
  const pairs = await deps.pairs();
  const listed = new Set(pairs.pools.map((pool) => pool.pool.toLowerCase()));
  const unlisted = pools.find((pool) => !listed.has(pool.toLowerCase()));
  if (unlisted) throw refuse('BAD_REQUEST', 'protocol.swap.pool_unlisted', `${unlisted} is not a pool the network's factory lists.`);
  const native = input.pull === 'native';
  if (native && path[0]!.toLowerCase() !== setting.wrappedNative.toLowerCase())
    throw refuse('BAD_REQUEST', 'protocol.swap.native_path', 'A native-input swap starts at the wrapped native token.');
  if (native && (input.tokenPermit || input.standing))
    throw refuse('BAD_REQUEST', 'protocol.swap.native_path', 'A native-input swap needs no permit.');
  const blockNumber = BigInt(pairs.blockNumber);
  const amount = BigInt(input.amount);
  const bps = BigInt(input.slippageBps);
  const [block, quoted] = await Promise.all([
    client.getBlock({ blockNumber }),
    client.readContract({
      address: setting.router,
      abi: ROUTER_V2_ABI,
      functionName: input.kind === 'exact_in' ? 'quoteExactIn' : 'quoteExactOut',
      args: [path, pools, amount],
      blockNumber,
    }),
  ]);
  const deadline = BigInt(input.deadline);
  if (deadline <= block.timestamp)
    throw refuse('BAD_REQUEST', DEADLINE_PAST, `The deadline ${deadline} is not after the chain's time ${block.timestamp}.`);
  const ceilingBps = BigInt(ceiling);
  let minOutPerHop: bigint[] = [];
  let limit: bigint;
  let amountIn: bigint;
  let amountOut: bigint;
  if (input.kind === 'exact_in') {
    // Each hop's minimum is the one the person saw, checked against this fresh read: never looser than the owner's
    // ceiling allows, never above what the hop pays now. Absent, it is the fresh output less the slippage.
    if (input.minOutPerHop) {
      if (input.minOutPerHop.length !== quoted.length) throw refuse('BAD_REQUEST', 'protocol.swap.bad_path', 'One minimum per hop.');
      input.minOutPerHop.forEach((text, hop) => {
        const min = BigInt(text);
        if (min < (quoted[hop]! * (10_000n - ceilingBps)) / 10_000n)
          throw refuse(
            'BAD_REQUEST',
            'protocol.swap_min_out_below_bound',
            `Hop ${hop + 1}'s minimum is looser than the slippage ceiling allows.`,
          );
        if (min > quoted[hop]!) throw refuse('CONFLICT', HOP_BELOW_MIN, `Hop ${hop + 1} now pays less than its minimum; the price moved.`);
      });
    }
    minOutPerHop = input.minOutPerHop
      ? input.minOutPerHop.map((text) => BigInt(text))
      : quoted.map((out) => (out * (10_000n - bps)) / 10_000n);
    if (minOutPerHop.some((min) => min === 0n))
      throw refuse(
        'BAD_REQUEST',
        'protocol.swap_min_out_below_bound',
        'A hop minimum rounds to zero; the amount is too small for this path.',
      );
    limit = minOutPerHop[minOutPerHop.length - 1]!;
    amountIn = amount;
    amountOut = limit;
  } else {
    // The most paid is the one the person saw, checked against this fresh read; absent, the fresh input plus the
    // slippage, rounded up.
    const fresh = quoted[0]!;
    if (input.maxIn) {
      const maxIn = BigInt(input.maxIn);
      if (maxIn > (fresh * (10_000n + ceilingBps) + 9_999n) / 10_000n)
        throw refuse('BAD_REQUEST', 'protocol.swap_max_in_above_bound', 'The most paid is looser than the slippage ceiling allows.');
      if (maxIn < fresh)
        throw refuse('CONFLICT', 'protocol.swap.price_moved', 'The swap now costs more than the most you set; the price moved.');
    }
    limit = input.maxIn ? BigInt(input.maxIn) : (fresh * (10_000n + bps) + 9_999n) / 10_000n;
    amountIn = limit;
    amountOut = amount;
  }
  const swap = {
    path,
    pools,
    amount,
    limit,
    minOutPerHop,
    to: getAddress(input.owner),
    deadline,
    pull: PULL[input.pull],
    unwrapOut: input.unwrapOut,
  };
  const swapData = encodeFunctionData({
    abi: ROUTER_V2_ABI,
    functionName: input.kind === 'exact_in' ? 'exactIn' : 'exactOut',
    args: [swap],
  });
  const calls: Hex[] = [];
  if (input.tokenPermit) {
    const { v, yParity, r, s } = parseSignature(input.tokenPermit.signature as Hex);
    calls.push(
      encodeFunctionData({
        abi: ROUTER_V2_ABI,
        functionName: 'selfPermit',
        args: [
          path[0]!,
          BigInt(input.tokenPermit.value),
          BigInt(input.tokenPermit.deadline),
          Number(v ?? BigInt(yParity + 27)),
          r,
          s,
          input.pull === 'standing',
        ],
      }),
    );
  }
  if (input.standing) {
    calls.push(
      encodeFunctionData({
        abi: ROUTER_V2_ABI,
        functionName: 'standingPermit',
        args: [
          path[0]!,
          BigInt(input.standing.amount),
          Number(input.standing.expiration),
          input.standing.nonce,
          BigInt(input.standing.sigDeadline),
          input.standing.signature as Hex,
        ],
      }),
    );
  }
  const data =
    calls.length > 0 ? encodeFunctionData({ abi: ROUTER_V2_ABI, functionName: 'multicall', args: [[...calls, swapData]] }) : swapData;
  const value = native ? (input.kind === 'exact_in' ? amount : limit) : 0n;
  if (input.simulate) {
    try {
      await client.call({ account: getAddress(input.owner), to: setting.router, data, value });
    } catch (err) {
      const named = simulationRefusal(err);
      if (named) throw named;
      throw err;
    }
  }
  const words = input.kind === 'exact_in' ? `at least ${amountOut} out` : `exactly ${amountOut} out for at most ${amountIn}`;
  return {
    call: {
      to: setting.router,
      data,
      value: value.toString(),
      summary: `router v2 ${input.kind === 'exact_in' ? 'exactIn' : 'exactOut'} over ${pools.length} pool(s): ${words}, deadline ${deadline}`,
    },
    kind: input.kind,
    path,
    pools,
    minOutPerHop: minOutPerHop.map(String),
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    quoted: quoted.map(String),
    deadline: deadline.toString(),
    blockNumber: blockNumber.toString(),
  };
}

/** The procedures, spread into `amm`. Each refusal keeps its code; a chain failure is shaped by the router's own mapper. */
export function createSwapV2Procedures(deps: SwapV2Deps) {
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      throw deps.toTrpcError(err);
    }
  };
  const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
  return {
    /** Router v2's deployment on this network and the owner's permit lifetime cap. */
    v2Settings: publicJurisdictionProcedure('protocol', 'protocol')
      .output(protocolSwapV2SettingsSchema)
      .query(() =>
        run(async () => {
          const setting = requireSetting(deps);
          const client = deps.client();
          const at = { address: setting.wrappedNative, abi: TOKEN_ABI } as const;
          const [name, symbol, decimals] = await Promise.all([
            client.readContract({ ...at, functionName: 'name' }),
            client.readContract({ ...at, functionName: 'symbol' }),
            client.readContract({ ...at, functionName: 'decimals' }),
          ]);
          return {
            router: getAddress(setting.router),
            sovereignPermit: getAddress(setting.sovereignPermit),
            wrappedNative: { address: getAddress(setting.wrappedNative), name, symbol, decimals },
            permitLifetimeCapSeconds: deps.permitLifetimeCapSeconds(),
            maxPathHops: MAX_PATH_HOPS,
          };
        }),
      ),
    /** Whether the token has its own permit, works through SovereignPermit, or needs an approve transaction. */
    approvalRoute: publicJurisdictionProcedure('protocol', 'protocol')
      .input(z.object({ owner: address, token: address }).strict())
      .output(protocolApprovalRouteOutputSchema)
      .query(({ input }) => run(() => readApprovalRoute(deps, getAddress(input.owner), getAddress(input.token)))),
    buildPermit: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolBuildPermitInputSchema)
      .output(protocolBuildPermitOutputSchema)
      .query(({ input }) => run(() => buildPermit(deps, input))),
    paths: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolPathsInputSchema)
      .output(protocolPathOutputSchema)
      .query(({ input }) => run(() => bestPath(deps, input))),
    buildSwapV2: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolBuildSwapV2InputSchema)
      .output(protocolBuildSwapV2OutputSchema)
      .query(({ input }) => run(() => buildSwapV2(deps, input))),
  };
}
