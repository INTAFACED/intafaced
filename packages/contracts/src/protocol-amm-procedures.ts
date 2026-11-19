import { z } from 'zod';
import { defineProcedure, NO_INPUT, type Refusals, type RefusalStatus } from './procedure.js';
import {
  PROTOCOL_FEE_POLICY_UNSET,
  PROTOCOL_NOT_FACTORY_POOL,
  protocolPoolFeesInputSchema,
  protocolPoolFeesOutputSchema,
} from './protocol-fees.js';
import { GAS_PERCENTILES_UNSET } from './protocol-gas.js';
import {
  AMM_FEE_OUT_OF_RANGE,
  AMM_FEE_TIERS_UNSET,
  LIQUIDITY_BOUNDS_UNSET,
  LIQUIDITY_FEES_COMPOUND,
  LIQUIDITY_NOT_A_POOL,
  LIQUIDITY_POOL_EXISTS,
  LIQUIDITY_ROUTER_UNSET,
  liquidityBuildAddInputSchema,
  liquidityBuildAddOutputSchema,
  liquidityBuildRemoveInputSchema,
  liquidityBuildRemoveOutputSchema,
  liquidityBuildSwapAddInputSchema,
  liquidityBuildSwapAddOutputSchema,
  liquidityCreateInputSchema,
  liquidityCreateOutputSchema,
  liquidityExplainInputSchema,
  liquidityExplainOutputSchema,
  liquidityFeeTiersOutputSchema,
  liquidityPoolExistsInputSchema,
  liquidityPoolExistsOutputSchema,
  liquidityPositionInputSchema,
  liquidityPositionOutputSchema,
  liquidityPositionsInputSchema,
  liquidityPositionsOutputSchema,
  liquidityQuoteAddInputSchema,
  liquidityQuoteAddOutputSchema,
  liquidityQuoteSwapAddInputSchema,
  liquidityQuoteSwapAddOutputSchema,
  liquiditySendSharesInputSchema,
  liquiditySendSharesOutputSchema,
} from './protocol-liquidity.js';
import {
  FEE_CHARGE_ABOVE_SIGNED,
  FEE_MARKET_UNREAD,
  FEE_RELAY_UNSET,
  FEE_SWAP_SIGNATURE_INVALID,
  FEE_TOKEN_NOT_ALLOWLISTED,
  FEE_TOKEN_ORACLE_STALE,
  FEE_TOKEN_ORACLE_UNREAD,
  FEE_TOKEN_PERMIT_UNREAD,
  PRICE_SETTINGS_UNSET,
  SWAP_FEE_CAP_UNSET,
  SWAP_SETTINGS_UNSET,
  protocolAllowancesOutputSchema,
  protocolApprovalCheckOutputSchema,
  protocolFeeQuoteOutputSchema,
  protocolFeeSwapPlanOutputSchema,
  protocolFeeSwapSubmitInputSchema,
  protocolFeeSwapSubmitOutputSchema,
  protocolFeeTokensOutputSchema,
  protocolPoolQuoteOutputSchema,
  protocolRouteOptionsOutputSchema,
  protocolSwapFeesOutputSchema,
  protocolSwapPairsOutputSchema,
  protocolSwapSettingsOutputSchema,
  protocolTokenPricesOutputSchema,
  protocolUnsignedCallSchema,
} from './protocol-swap.js';
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
} from './protocol-swap-v2.js';

/**
 * svc-protocol's AMM calls (`amm.*`), one record per call: the pools' pairs, prices and quotes, the swap's settings,
 * fees and calls, router v2, the fee relay, allowances, liquidity and pool fees. Every call is permissionless chain data
 * or an unsigned call the person's own wallet signs, behind the protocol module's jurisdiction guard; nothing here holds a
 * key or posts to the ledger. svc-protocol mounts each from here (`mountRecord`), so its path, guard, input, output and
 * named refusals are this file, not its router.
 *
 * Failures that are not named refusals are not listed: an unknown error sent as INTERNAL_SERVER_ERROR (`Protocol request
 * failed`) and the relayer's own refusal of a fee-token swap (`protocol.fee_relay_refused`, sent as BAD_GATEWAY).
 */

const JURISDICTION = { caller: 'jurisdiction', module: 'protocol', plane: 'protocol' } as const;
const base = { service: 'svc-protocol', module: 'protocol', transport: 'trpc', access: JURISDICTION } as const;

const refuse = (...groups: Readonly<Record<string, RefusalStatus>>[]): Refusals => Object.freeze(Object.assign({}, ...groups));

/** The chain could not be asked: no node, the wrong chain, or no contract at the address (`chain/availability.ts`). */
const CHAIN = {
  'protocol.chain_unreachable': 'SERVICE_UNAVAILABLE',
  'protocol.contract_not_deployed': 'SERVICE_UNAVAILABLE',
  'protocol.chain_not_configured': 'SERVICE_UNAVAILABLE',
  'protocol.chain_id_mismatch': 'SERVICE_UNAVAILABLE',
} as const;
const FACTORY_UNSET = { 'protocol.amm_factory_unset': 'PRECONDITION_FAILED' } as const;
const SLIPPAGE_UNSET = { 'protocol.swap_slippage_unset': 'PRECONDITION_FAILED' } as const;
const MIN_OUT_BELOW_BOUND = { 'protocol.swap_min_out_below_bound': 'BAD_REQUEST' } as const;
/** A quote from one pool's reserves (`amm/math.ts`, `amm/pool-quote.ts`). */
const POOL_QUOTE = {
  'amm.zero_input': 'BAD_REQUEST',
  'amm.no_liquidity': 'BAD_REQUEST',
  'amm.bad_fee': 'BAD_REQUEST',
  'amm.token_not_in_pool': 'BAD_REQUEST',
} as const;
const FEE_CAP = { [SWAP_FEE_CAP_UNSET]: 'PRECONDITION_FAILED', 'protocol.swap_fee_over_cap': 'BAD_REQUEST' } as const;
const FEE_RELAY = { [FEE_RELAY_UNSET]: 'PRECONDITION_FAILED' } as const;
const FEE_TOKEN = {
  [FEE_TOKEN_NOT_ALLOWLISTED]: 'PRECONDITION_FAILED',
  [FEE_TOKEN_ORACLE_STALE]: 'PRECONDITION_FAILED',
  [FEE_TOKEN_ORACLE_UNREAD]: 'PRECONDITION_FAILED',
} as const;
const FEE_SWAP_POOL = { 'protocol.fee_swap_pool_unlisted': 'BAD_REQUEST' } as const;
const APPROVAL_TARGET = { 'protocol.approval_target_zero': 'BAD_REQUEST' } as const;
/** The liquidity calls' own settings (`liquidity/procedures.ts`). */
const LIQUIDITY_ROUTER = { [LIQUIDITY_ROUTER_UNSET]: 'PRECONDITION_FAILED' } as const;
const LISTED_POOL = { [LIQUIDITY_NOT_A_POOL]: 'NOT_FOUND' } as const;
const BOUNDS = { [LIQUIDITY_BOUNDS_UNSET]: 'BAD_REQUEST' } as const;
const QUOTE_TTL_UNSET = { [SWAP_SETTINGS_UNSET]: 'PRECONDITION_FAILED' } as const;
const ROUTER_V2 = { [ROUTER_V2_UNSET]: 'PRECONDITION_FAILED' } as const;

/**
 * An address as svc-protocol has always taken it: viem's `isAddress(v, { strict: false })` (0x and 40 hex digits, any
 * case), refused with the same words. The service checksums it on arrival.
 */
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const evmAddress = z.string().refine((value) => EVM_ADDRESS.test(value), { message: 'not an EVM address' });
const evmAddressCheck = (at: string | readonly string[]) => ({
  evmAddress: { at, says: 'each address is 0x followed by 40 hex digits, in any case; the service checksums it' },
});
/** A positive whole number of base units, at most 78 digits. */
const positiveUnits = z.string().regex(/^[1-9][0-9]{0,77}$/);
/** A whole number of base units, zero allowed (the quote and exact-in builder). */
const digits = z.string().regex(/^\d+$/);
/** A plain 0x-and-40-hex address, the router v2 and fee-claim inputs' own form (no checksum step). */
const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const NOT_ADDRESS = '';

// ── Pools, prices and the swap's settings ─────────────────────────────────────────────────────────────────────────

/** Every pool the configured factory lists and the tokens they trade, read from the chain (D-swap-01). */
export const PROTOCOL_AMM_PAIRS = defineProcedure({
  ...base,
  name: 'protocol.amm.pairs',
  kind: 'query',
  path: 'amm.pairs',
  refusals: refuse(FACTORY_UNSET, CHAIN),
  input: NO_INPUT,
  output: protocolSwapPairsOutputSchema,
  samples: [{ verdict: 'accept' }],
});

/** Every listed token's USD price from the pools, at one block, with the block's own time (D-swap-11). */
export const PROTOCOL_AMM_PRICES = defineProcedure({
  ...base,
  name: 'protocol.amm.prices',
  kind: 'query',
  path: 'amm.prices',
  refusals: refuse({ [PRICE_SETTINGS_UNSET]: 'PRECONDITION_FAILED' }, FACTORY_UNSET, CHAIN),
  input: NO_INPUT,
  output: protocolTokenPricesOutputSchema,
  samples: [{ verdict: 'accept' }],
});

/** The owner's swap settings: the slippage ceiling, the quote lifetime and the confirmations. Blank refuses. */
export const PROTOCOL_AMM_SWAP_SETTINGS = defineProcedure({
  ...base,
  name: 'protocol.amm.swapSettings',
  kind: 'query',
  path: 'amm.swapSettings',
  refusals: refuse(SLIPPAGE_UNSET, QUOTE_TTL_UNSET),
  input: NO_INPUT,
  output: protocolSwapSettingsOutputSchema,
  samples: [{ verdict: 'accept' }],
});

/** The swap form's Slow, Normal and Fast network fees with the owner's fee cap (D-swap-11). */
export const PROTOCOL_AMM_FEE_LEVELS = defineProcedure({
  ...base,
  name: 'protocol.amm.feeLevels',
  kind: 'query',
  path: 'amm.feeLevels',
  refusals: refuse(
    { [SWAP_FEE_CAP_UNSET]: 'PRECONDITION_FAILED', [FEE_MARKET_UNREAD]: 'PRECONDITION_FAILED' },
    { [GAS_PERCENTILES_UNSET]: 'PRECONDITION_FAILED' },
    CHAIN,
  ),
  input: NO_INPUT,
  output: protocolSwapFeesOutputSchema,
  samples: [{ verdict: 'accept' }],
});

/** Every factory pool for the pair ranked for `amountIn` at one block, best first (J-dex-protocol-02 #4). */
export const PROTOCOL_AMM_ROUTES = defineProcedure({
  ...base,
  name: 'protocol.amm.routes',
  kind: 'query',
  path: 'amm.routes',
  refusals: refuse(FACTORY_UNSET, { 'protocol.route_same_token': 'BAD_REQUEST' }, POOL_QUOTE, CHAIN),
  input: z.object({
    tokenIn: evmAddress,
    tokenOut: evmAddress,
    amountIn: positiveUnits,
    exclude: z.array(evmAddress).max(200).default([]),
  }),
  output: protocolRouteOptionsOutputSchema,
  checks: evmAddressCheck(['input.tokenIn', 'input.tokenOut', 'input.exclude[]']),
  samples: [
    { verdict: 'accept', input: { tokenIn: A, tokenOut: B, amountIn: '1000' } },
    { verdict: 'accept', input: { tokenIn: A, tokenOut: B, amountIn: '1000', exclude: [C] } },
    { verdict: 'refuse', input: { tokenIn: A, tokenOut: B, amountIn: '0' } },
    { verdict: 'refuse', by: 'evmAddress', input: { tokenIn: NOT_ADDRESS, tokenOut: B, amountIn: '1000' } },
  ],
});

/** A quote from one pool's reserves as read now: reserves from the chain, never from the caller. */
export const PROTOCOL_AMM_QUOTE_FROM_POOL = defineProcedure({
  ...base,
  name: 'protocol.amm.quoteFromPool',
  kind: 'query',
  path: 'amm.quoteFromPool',
  refusals: refuse(POOL_QUOTE, CHAIN),
  input: z.object({ pool: evmAddress, tokenIn: evmAddress, amountIn: digits }),
  output: protocolPoolQuoteOutputSchema,
  checks: evmAddressCheck(['input.pool', 'input.tokenIn']),
  samples: [
    { verdict: 'accept', input: { pool: A, tokenIn: B, amountIn: '1000' } },
    { verdict: 'refuse', input: { pool: A, tokenIn: B, amountIn: '-1' } },
    { verdict: 'refuse', by: 'evmAddress', input: { pool: NOT_ADDRESS, tokenIn: B, amountIn: '1000' } },
  ],
});

/** The exact-in swap call the wallet signs: the pool is read again and a minimum under the slippage ceiling refuses. */
export const PROTOCOL_AMM_BUILD_SWAP_EXACT_IN = defineProcedure({
  ...base,
  name: 'protocol.amm.buildSwapExactIn',
  kind: 'query',
  path: 'amm.buildSwapExactIn',
  refusals: refuse(SLIPPAGE_UNSET, MIN_OUT_BELOW_BOUND, POOL_QUOTE, CHAIN),
  input: z.object({ pool: evmAddress, tokenIn: evmAddress, amountIn: digits, minAmountOut: digits, to: evmAddress }),
  output: protocolUnsignedCallSchema,
  checks: evmAddressCheck(['input.pool', 'input.tokenIn', 'input.to']),
  samples: [
    { verdict: 'accept', input: { pool: A, tokenIn: B, amountIn: '1000', minAmountOut: '990', to: C } },
    { verdict: 'refuse', input: { pool: A, tokenIn: B, amountIn: '1000', to: C } },
    { verdict: 'refuse', by: 'evmAddress', input: { pool: A, tokenIn: B, amountIn: '1000', minAmountOut: '990', to: NOT_ADDRESS } },
  ],
});

// ── Approvals ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The live allowances `owner` has given for the tokens the factory's pools trade, read at one block (D-swap-09). */
export const PROTOCOL_AMM_ALLOWANCES = defineProcedure({
  ...base,
  name: 'protocol.amm.allowances',
  kind: 'query',
  path: 'amm.allowances',
  refusals: refuse(FACTORY_UNSET, CHAIN),
  input: z.object({ owner: evmAddress }),
  output: protocolAllowancesOutputSchema,
  checks: evmAddressCheck('input.owner'),
  samples: [
    { verdict: 'accept', input: { owner: A } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', by: 'evmAddress', input: { owner: NOT_ADDRESS } },
  ],
});

/** Whether `spender` already may move `amount` of `token` for `owner`, and if not, the calls that fix it. */
export const PROTOCOL_AMM_CHECK_APPROVAL = defineProcedure({
  ...base,
  name: 'protocol.amm.checkApproval',
  kind: 'query',
  path: 'amm.checkApproval',
  refusals: refuse(APPROVAL_TARGET, { 'protocol.approval_amount_invalid': 'BAD_REQUEST' }, CHAIN),
  input: z.object({
    owner: evmAddress,
    token: evmAddress,
    spender: evmAddress,
    amount: z
      .string()
      .regex(/^[1-9]\d{0,77}$/, 'protocol.approval_amount_invalid: use a positive whole number, or revoke to remove an approval'),
    unlimited: z.boolean().default(false),
  }),
  output: protocolApprovalCheckOutputSchema,
  checks: evmAddressCheck(['input.owner', 'input.token', 'input.spender']),
  samples: [
    { verdict: 'accept', input: { owner: A, token: B, spender: C, amount: '1000' } },
    { verdict: 'accept', input: { owner: A, token: B, spender: C, amount: '1000', unlimited: true } },
    { verdict: 'refuse', input: { owner: A, token: B, spender: C, amount: '0' } },
    { verdict: 'refuse', by: 'evmAddress', input: { owner: A, token: NOT_ADDRESS, spender: C, amount: '1000' } },
  ],
});

/** `approve(spender, 0)` for the wallet to sign and send. */
export const PROTOCOL_AMM_BUILD_REVOKE = defineProcedure({
  ...base,
  name: 'protocol.amm.buildRevoke',
  kind: 'query',
  path: 'amm.buildRevoke',
  refusals: refuse(APPROVAL_TARGET),
  input: z.object({ token: evmAddress, spender: evmAddress }),
  output: protocolUnsignedCallSchema,
  checks: evmAddressCheck(['input.token', 'input.spender']),
  samples: [
    { verdict: 'accept', input: { token: A, spender: B } },
    { verdict: 'refuse', input: { token: A } },
    { verdict: 'refuse', by: 'evmAddress', input: { token: A, spender: NOT_ADDRESS } },
  ],
});

// ── The network fee paid in a token (RC-dex-protocol-02) ──────────────────────────────────────────────────────────

/** The tokens the fee relay lists, its published markup and the gas a relayed swap is priced for. */
export const PROTOCOL_AMM_FEE_TOKENS = defineProcedure({
  ...base,
  name: 'protocol.amm.feeTokens',
  kind: 'query',
  path: 'amm.feeTokens',
  refusals: refuse(FEE_RELAY, CHAIN),
  input: NO_INPUT,
  output: protocolFeeTokensOutputSchema,
  samples: [{ verdict: 'accept' }],
});

/** What the gas of a relayed swap costs in `feeToken` at the most per gas chosen, priced by the relay contract. */
export const PROTOCOL_AMM_FEE_QUOTE = defineProcedure({
  ...base,
  name: 'protocol.amm.feeQuote',
  kind: 'query',
  path: 'amm.feeQuote',
  refusals: refuse(FEE_RELAY, FEE_CAP, FEE_TOKEN, CHAIN),
  input: z.object({ feeToken: evmAddress, maxFeePerGasWei: positiveUnits }),
  output: protocolFeeQuoteOutputSchema,
  checks: evmAddressCheck('input.feeToken'),
  samples: [
    { verdict: 'accept', input: { feeToken: A, maxFeePerGasWei: '1000000000' } },
    { verdict: 'refuse', input: { feeToken: A, maxFeePerGasWei: '0' } },
    { verdict: 'refuse', by: 'evmAddress', input: { feeToken: NOT_ADDRESS, maxFeePerGasWei: '1000000000' } },
  ],
});

/** A swap whose network fee is paid in `feeToken`: the quote, a permit per token the relay pulls, and the order to sign. */
export const PROTOCOL_AMM_PREPARE_FEE_SWAP = defineProcedure({
  ...base,
  name: 'protocol.amm.prepareFeeSwap',
  kind: 'query',
  path: 'amm.prepareFeeSwap',
  refusals: refuse(
    FEE_RELAY,
    SLIPPAGE_UNSET,
    QUOTE_TTL_UNSET,
    FEE_CAP,
    FACTORY_UNSET,
    FEE_SWAP_POOL,
    MIN_OUT_BELOW_BOUND,
    POOL_QUOTE,
    FEE_TOKEN,
    { [FEE_TOKEN_PERMIT_UNREAD]: 'PRECONDITION_FAILED' },
    CHAIN,
  ),
  input: z.object({
    owner: evmAddress,
    pool: evmAddress,
    tokenIn: evmAddress,
    amountIn: positiveUnits,
    minAmountOut: positiveUnits,
    feeToken: evmAddress,
    maxFeePerGasWei: positiveUnits,
  }),
  output: protocolFeeSwapPlanOutputSchema,
  checks: evmAddressCheck(['input.owner', 'input.pool', 'input.tokenIn', 'input.feeToken']),
  samples: [
    {
      verdict: 'accept',
      input: { owner: A, pool: B, tokenIn: C, amountIn: '1000', minAmountOut: '990', feeToken: C, maxFeePerGasWei: '1000000000' },
    },
    {
      verdict: 'refuse',
      input: { owner: A, pool: B, tokenIn: C, amountIn: '0', minAmountOut: '990', feeToken: C, maxFeePerGasWei: '1000000000' },
    },
    {
      verdict: 'refuse',
      by: 'evmAddress',
      input: { owner: A, pool: NOT_ADDRESS, tokenIn: C, amountIn: '1000', minAmountOut: '990', feeToken: C, maxFeePerGasWei: '1' },
    },
  ],
});

/** Hands a signed fee-token swap to the relayer once it checks out; the relayer sends it and pays the gas. */
export const PROTOCOL_AMM_RELAY_FEE_SWAP = defineProcedure({
  ...base,
  name: 'protocol.amm.relayFeeSwap',
  kind: 'mutation',
  path: 'amm.relayFeeSwap',
  refusals: refuse(
    FEE_RELAY,
    FEE_CAP,
    SLIPPAGE_UNSET,
    FACTORY_UNSET,
    FEE_SWAP_POOL,
    MIN_OUT_BELOW_BOUND,
    POOL_QUOTE,
    FEE_TOKEN,
    {
      [FEE_SWAP_SIGNATURE_INVALID]: 'FORBIDDEN',
      'protocol.fee_relay_gas_mismatch': 'BAD_REQUEST',
      [FEE_CHARGE_ABOVE_SIGNED]: 'CONFLICT',
    },
    CHAIN,
  ),
  input: protocolFeeSwapSubmitInputSchema,
  output: protocolFeeSwapSubmitOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        order: {
          owner: A,
          pool: B,
          tokenIn: C,
          amountIn: '1000',
          minAmountOut: '990',
          feeToken: C,
          gasWei: '1',
          maxCharge: '1',
          nonce: '0',
          deadline: '1',
        },
        signature: `0x${'ab'.repeat(65)}`,
        permits: [],
        maxFeePerGasWei: '1',
        maxPriorityFeePerGasWei: '1',
      },
    },
    { verdict: 'refuse', input: { signature: `0x${'ab'.repeat(65)}`, permits: [], maxFeePerGasWei: '1', maxPriorityFeePerGasWei: '1' } },
  ],
});

// ── Router v2 (D-swap-03, D-swap-intents-01, -02) ─────────────────────────────────────────────────────────────────

/** Router v2's deployment on this network and the owner's permit lifetime cap. */
export const PROTOCOL_AMM_V2_SETTINGS = defineProcedure({
  ...base,
  name: 'protocol.amm.v2Settings',
  kind: 'query',
  path: 'amm.v2Settings',
  refusals: refuse(ROUTER_V2, CHAIN),
  input: NO_INPUT,
  output: protocolSwapV2SettingsSchema,
  samples: [{ verdict: 'accept' }],
});

/** Whether the token has its own permit, works through SovereignPermit, or needs an approve transaction. */
export const PROTOCOL_AMM_APPROVAL_ROUTE = defineProcedure({
  ...base,
  name: 'protocol.amm.approvalRoute',
  kind: 'query',
  path: 'amm.approvalRoute',
  refusals: refuse(ROUTER_V2, CHAIN),
  input: z.object({ owner: hexAddress, token: hexAddress }).strict(),
  output: protocolApprovalRouteOutputSchema,
  samples: [
    { verdict: 'accept', input: { owner: A, token: B } },
    { verdict: 'refuse', input: { owner: A, token: B, spender: C } },
    { verdict: 'refuse', input: { owner: A, token: NOT_ADDRESS } },
  ],
});

/** The permits a person signs for a router v2 swap: one exact amount, or a standing allowance. */
export const PROTOCOL_AMM_BUILD_PERMIT = defineProcedure({
  ...base,
  name: 'protocol.amm.buildPermit',
  kind: 'query',
  path: 'amm.buildPermit',
  refusals: refuse(
    ROUTER_V2,
    {
      [PERMIT_LIFETIME_UNSET]: 'PRECONDITION_FAILED',
      'protocol.permit.amount_invalid': 'BAD_REQUEST',
      [DEADLINE_PAST]: 'BAD_REQUEST',
      [PERMIT_LIFETIME_OVER_CAP]: 'BAD_REQUEST',
      [PERMIT_NOT_SUPPORTED]: 'PRECONDITION_FAILED',
    },
    CHAIN,
  ),
  input: protocolBuildPermitInputSchema,
  output: protocolBuildPermitOutputSchema,
  samples: [
    { verdict: 'accept', input: { owner: A, token: B, amount: '1000', mode: 'exact', expiresAt: '1900000000' } },
    { verdict: 'refuse', input: { owner: A, token: B, amount: '1000', mode: 'forever', expiresAt: '1900000000' } },
  ],
});

/** The best path with exactly `hops` pools under the person's hop limit, at one block. */
export const PROTOCOL_AMM_PATHS = defineProcedure({
  ...base,
  name: 'protocol.amm.paths',
  kind: 'query',
  path: 'amm.paths',
  refusals: refuse(
    ROUTER_V2,
    FACTORY_UNSET,
    {
      [ROUTE_MAX_HOPS_UNSET]: 'BAD_REQUEST',
      [ROUTE_OVER_MAX_HOPS]: 'BAD_REQUEST',
      'protocol.route_same_token': 'BAD_REQUEST',
      [ROUTE_NO_PATH]: 'NOT_FOUND',
    },
    CHAIN,
  ),
  input: protocolPathsInputSchema,
  output: protocolPathOutputSchema,
  samples: [
    { verdict: 'accept', input: { tokenIn: A, tokenOut: B, kind: 'exact_in', amount: '1000', hops: 1, maxHops: null } },
    { verdict: 'refuse', input: { tokenIn: A, tokenOut: B, kind: 'exact_in', amount: '1000', hops: 0, maxHops: null } },
  ],
});

/** The one router v2 call the wallet sends, with the minimum each hop must pay and the limits signed. */
export const PROTOCOL_AMM_BUILD_SWAP_V2 = defineProcedure({
  ...base,
  name: 'protocol.amm.buildSwapV2',
  kind: 'query',
  path: 'amm.buildSwapV2',
  refusals: refuse(
    ROUTER_V2,
    FACTORY_UNSET,
    SLIPPAGE_UNSET,
    MIN_OUT_BELOW_BOUND,
    {
      [DEADLINE_REQUIRED]: 'BAD_REQUEST',
      [DEADLINE_PAST]: 'BAD_REQUEST',
      'protocol.swap_slippage_over_ceiling': 'BAD_REQUEST',
      'protocol.swap.bad_path': 'BAD_REQUEST',
      'protocol.swap.pool_unlisted': 'BAD_REQUEST',
      'protocol.swap.native_path': 'BAD_REQUEST',
      'protocol.swap_max_in_above_bound': 'BAD_REQUEST',
      [ROUTE_MAX_HOPS_UNSET]: 'BAD_REQUEST',
      [ROUTE_OVER_MAX_HOPS]: 'BAD_REQUEST',
      [HOP_BELOW_MIN]: 'CONFLICT',
      [PERMIT_ALLOWANCE_EXPIRED]: 'CONFLICT',
      [PERMIT_ALLOWANCE_LOW]: 'CONFLICT',
      'protocol.swap.simulation_reverted': 'CONFLICT',
      'protocol.swap.price_moved': 'CONFLICT',
    },
    CHAIN,
  ),
  input: protocolBuildSwapV2InputSchema,
  output: protocolBuildSwapV2OutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        owner: A,
        kind: 'exact_in',
        path: [B, C],
        pools: [A],
        amount: '1000',
        slippageBps: 50,
        deadline: '1900000000',
        pull: 'allowance',
      },
    },
    {
      verdict: 'refuse',
      input: {
        owner: A,
        kind: 'exact_in',
        path: [B],
        pools: [A],
        amount: '1000',
        slippageBps: 50,
        deadline: '1900000000',
        pull: 'allowance',
      },
    },
  ],
});

// ── Liquidity (D-liquidity-01..04, J-dex-protocol-12) ─────────────────────────────────────────────────────────────

/** The owner's fee tiers for a new pool. Blank refuses `amm.fee_tiers_unset`; the form then offers a custom fee only. */
export const PROTOCOL_AMM_FEE_TIERS = defineProcedure({
  ...base,
  name: 'protocol.amm.feeTiers',
  kind: 'query',
  path: 'amm.feeTiers',
  refusals: refuse({ [AMM_FEE_TIERS_UNSET]: 'PRECONDITION_FAILED' }),
  input: NO_INPUT,
  output: liquidityFeeTiersOutputSchema,
  samples: [{ verdict: 'accept' }],
});

/** Whether the factory already has a pool for the pair at this fee, and its address (or the address it would get). */
export const PROTOCOL_AMM_POOL_EXISTS = defineProcedure({
  ...base,
  name: 'protocol.amm.poolExists',
  kind: 'query',
  path: 'amm.poolExists',
  refusals: refuse(FACTORY_UNSET, { 'amm.identical_tokens': 'BAD_REQUEST' }, CHAIN),
  input: liquidityPoolExistsInputSchema,
  output: liquidityPoolExistsOutputSchema,
  samples: [
    { verdict: 'accept', input: { tokenA: A, tokenB: B, feeBps: 30 } },
    { verdict: 'refuse', input: { tokenA: A, tokenB: B, feeBps: 5000 } },
  ],
});

/** One call through the router that creates the pool and makes its first deposit. */
export const PROTOCOL_AMM_BUILD_CREATE_AND_SEED = defineProcedure({
  ...base,
  name: 'protocol.amm.buildCreateAndSeed',
  kind: 'query',
  path: 'amm.buildCreateAndSeed',
  refusals: refuse(
    { [AMM_FEE_OUT_OF_RANGE]: 'BAD_REQUEST' },
    FACTORY_UNSET,
    LIQUIDITY_ROUTER,
    { 'amm.identical_tokens': 'BAD_REQUEST', 'amm.seed_too_small': 'BAD_REQUEST', [LIQUIDITY_POOL_EXISTS]: 'CONFLICT' },
    BOUNDS,
    QUOTE_TTL_UNSET,
    CHAIN,
  ),
  input: liquidityCreateInputSchema,
  output: liquidityCreateOutputSchema,
  samples: [
    { verdict: 'accept', input: { owner: A, tokenA: B, tokenB: C, feeBps: 30, amountA: '1000', amountB: '1000' } },
    { verdict: 'refuse', input: { owner: A, tokenA: B, tokenB: C, feeBps: 30, amountA: '1.5', amountB: '1000' } },
  ],
});

/** What adding deposits (the pool's ratio of what was offered) and mints, from the pool as read now. */
export const PROTOCOL_AMM_QUOTE_ADD_LIQUIDITY = defineProcedure({
  ...base,
  name: 'protocol.amm.quoteAddLiquidity',
  kind: 'query',
  path: 'amm.quoteAddLiquidity',
  refusals: refuse(LIQUIDITY_ROUTER, QUOTE_TTL_UNSET, FACTORY_UNSET, LISTED_POOL, BOUNDS, CHAIN),
  input: liquidityQuoteAddInputSchema,
  output: liquidityQuoteAddOutputSchema,
  samples: [
    { verdict: 'accept', input: { pool: A, amount0Desired: '1000', amount1Desired: '1000' } },
    { verdict: 'refuse', input: { pool: A, amount0Desired: '1000' } },
  ],
});

/** The add call, from a fresh read: both minimums are the owner's slippage under what the pool takes now. */
export const PROTOCOL_AMM_BUILD_ADD_LIQUIDITY = defineProcedure({
  ...base,
  name: 'protocol.amm.buildAddLiquidity',
  kind: 'query',
  path: 'amm.buildAddLiquidity',
  refusals: refuse(LIQUIDITY_ROUTER, SLIPPAGE_UNSET, BOUNDS, FACTORY_UNSET, LISTED_POOL, QUOTE_TTL_UNSET, CHAIN),
  input: liquidityBuildAddInputSchema,
  output: liquidityBuildAddOutputSchema,
  samples: [
    { verdict: 'accept', input: { owner: A, pool: B, amount0Desired: '1000', amount1Desired: '1000', minShares: '1' } },
    { verdict: 'refuse', input: { owner: A, pool: B, amount0Desired: '1000', amount1Desired: '1000' } },
  ],
});

/** How much of one token swap-and-add swaps first, what the swap gives, and the shares the add then mints. */
export const PROTOCOL_AMM_QUOTE_SWAP_AND_ADD = defineProcedure({
  ...base,
  name: 'protocol.amm.quoteSwapAndAdd',
  kind: 'query',
  path: 'amm.quoteSwapAndAdd',
  refusals: refuse(
    LIQUIDITY_ROUTER,
    QUOTE_TTL_UNSET,
    FACTORY_UNSET,
    LISTED_POOL,
    BOUNDS,
    { 'amm.token_not_in_pool': 'BAD_REQUEST' },
    CHAIN,
  ),
  input: liquidityQuoteSwapAddInputSchema,
  output: liquidityQuoteSwapAddOutputSchema,
  samples: [
    { verdict: 'accept', input: { pool: A, tokenIn: B, amountIn: '1000' } },
    { verdict: 'refuse', input: { pool: A, tokenIn: NOT_ADDRESS, amountIn: '1000' } },
  ],
});

/** The swap-and-add call: one transaction, so if the add does not mint `minShares` the swap is undone with it. */
export const PROTOCOL_AMM_BUILD_SWAP_AND_ADD = defineProcedure({
  ...base,
  name: 'protocol.amm.buildSwapAndAdd',
  kind: 'query',
  path: 'amm.buildSwapAndAdd',
  refusals: refuse(LIQUIDITY_ROUTER, BOUNDS, FACTORY_UNSET, LISTED_POOL, QUOTE_TTL_UNSET, CHAIN),
  input: liquidityBuildSwapAddInputSchema,
  output: liquidityBuildSwapAddOutputSchema,
  samples: [
    { verdict: 'accept', input: { owner: A, pool: B, tokenIn: C, amountIn: '1000', minShares: '1' } },
    { verdict: 'refuse', input: { owner: A, pool: B, tokenIn: C, amountIn: '1000' } },
  ],
});

/** Removing shares: both tokens pro rata, each at least the owner's slippage under what they are worth now. */
export const PROTOCOL_AMM_BUILD_REMOVE_LIQUIDITY = defineProcedure({
  ...base,
  name: 'protocol.amm.buildRemoveLiquidity',
  kind: 'query',
  path: 'amm.buildRemoveLiquidity',
  refusals: refuse(
    LIQUIDITY_ROUTER,
    SLIPPAGE_UNSET,
    BOUNDS,
    FACTORY_UNSET,
    LISTED_POOL,
    { 'amm.shares_above_balance': 'BAD_REQUEST' },
    QUOTE_TTL_UNSET,
    CHAIN,
  ),
  input: liquidityBuildRemoveInputSchema,
  output: liquidityBuildRemoveOutputSchema,
  samples: [
    { verdict: 'accept', input: { owner: A, pool: B, shares: '1000' } },
    { verdict: 'refuse', input: { owner: A, pool: B, shares: '-1' } },
  ],
});

/** Sending shares to another address: the pool share token's own `transfer`. */
export const PROTOCOL_AMM_BUILD_SEND_SHARES = defineProcedure({
  ...base,
  name: 'protocol.amm.buildSendShares',
  kind: 'query',
  path: 'amm.buildSendShares',
  refusals: refuse(FACTORY_UNSET, LISTED_POOL, BOUNDS, { 'amm.send_to_zero': 'BAD_REQUEST' }, CHAIN),
  input: liquiditySendSharesInputSchema,
  output: liquiditySendSharesOutputSchema,
  samples: [
    { verdict: 'accept', input: { owner: A, pool: B, to: C, shares: '1000' } },
    { verdict: 'refuse', input: { owner: A, pool: B, shares: '1000' } },
  ],
});

/**
 * There is nothing separate to collect: swap fees compound into every share and are paid out when liquidity is removed,
 * so this always refuses `protocol.fees_compound`. It never answers, so its answer is `never`.
 */
export const PROTOCOL_AMM_CLAIM_FEES = defineProcedure({
  ...base,
  name: 'protocol.amm.claimFees',
  kind: 'mutation',
  path: 'amm.claimFees',
  refusals: refuse({ [LIQUIDITY_FEES_COMPOUND]: 'PRECONDITION_FAILED' }),
  input: z.object({ pool: hexAddress }),
  output: z.never(),
  samples: [
    { verdict: 'accept', input: { pool: A } },
    { verdict: 'refuse', input: { pool: NOT_ADDRESS } },
  ],
});

/** Every factory pool `account` holds shares in, read from the pools at one block. */
export const PROTOCOL_AMM_POSITIONS = defineProcedure({
  ...base,
  name: 'protocol.amm.positions',
  kind: 'query',
  path: 'amm.positions',
  refusals: refuse(FACTORY_UNSET, CHAIN),
  input: liquidityPositionsInputSchema,
  output: liquidityPositionsOutputSchema,
  samples: [
    { verdict: 'accept', input: { account: A } },
    { verdict: 'refuse', input: { account: NOT_ADDRESS } },
  ],
});

/** One position: shares, share of the pool, what they are worth now and, with an entry, what holding would have now. */
export const PROTOCOL_AMM_POSITION = defineProcedure({
  ...base,
  name: 'protocol.amm.position',
  kind: 'query',
  path: 'amm.position',
  refusals: refuse(FACTORY_UNSET, LISTED_POOL, CHAIN),
  input: liquidityPositionInputSchema,
  output: liquidityPositionOutputSchema,
  samples: [
    { verdict: 'accept', input: { pool: A, account: B } },
    { verdict: 'refuse', input: { pool: A } },
  ],
});

/** Why a liquidity call failed: the same call from the same wallet run against the chain now; the contract's error name. */
export const PROTOCOL_AMM_EXPLAIN_LIQUIDITY_CALL = defineProcedure({
  ...base,
  name: 'protocol.amm.explainLiquidityCall',
  kind: 'query',
  path: 'amm.explainLiquidityCall',
  refusals: refuse(LIQUIDITY_ROUTER, FACTORY_UNSET, LISTED_POOL, CHAIN),
  input: liquidityExplainInputSchema,
  output: liquidityExplainOutputSchema,
  samples: [
    { verdict: 'accept', input: { from: A, to: B, data: '0xabcd' } },
    { verdict: 'refuse', input: { from: A, to: B, data: '0xabc' } },
  ],
});

// ── Pool fees (D-fees-governance-04) ──────────────────────────────────────────────────────────────────────────────

/** A factory pool's own fee fields, read from the chain at one block: the swap fee and who gets it. */
export const PROTOCOL_AMM_POOL_FEES = defineProcedure({
  ...base,
  name: 'protocol.amm.poolFees',
  kind: 'query',
  path: 'amm.poolFees',
  refusals: refuse(FACTORY_UNSET, { [PROTOCOL_NOT_FACTORY_POOL]: 'NOT_FOUND' }, CHAIN),
  input: protocolPoolFeesInputSchema,
  output: protocolPoolFeesOutputSchema,
  samples: [
    { verdict: 'accept', input: { pool: A } },
    { verdict: 'refuse', input: { pool: A, extra: true } },
  ],
});

/**
 * Asks for a protocol fee on a pool. It moves nothing and records nothing: with the owner's fee policy blank it always
 * refuses `protocol.fee_policy_unset`, so its answer is `never`.
 */
export const PROTOCOL_AMM_REQUEST_PROTOCOL_FEE = defineProcedure({
  ...base,
  name: 'protocol.amm.requestProtocolFee',
  kind: 'mutation',
  path: 'amm.requestProtocolFee',
  refusals: refuse({ [PROTOCOL_FEE_POLICY_UNSET]: 'PRECONDITION_FAILED' }),
  input: protocolPoolFeesInputSchema,
  output: z.never(),
  samples: [
    { verdict: 'accept', input: { pool: A } },
    { verdict: 'refuse', input: { pool: NOT_ADDRESS } },
  ],
});

/** Every amm record, in the order the router mounts them. */
export const PROTOCOL_AMM_PROCEDURES = [
  PROTOCOL_AMM_PAIRS,
  PROTOCOL_AMM_PRICES,
  PROTOCOL_AMM_SWAP_SETTINGS,
  PROTOCOL_AMM_FEE_LEVELS,
  PROTOCOL_AMM_ROUTES,
  PROTOCOL_AMM_QUOTE_FROM_POOL,
  PROTOCOL_AMM_BUILD_SWAP_EXACT_IN,
  PROTOCOL_AMM_ALLOWANCES,
  PROTOCOL_AMM_CHECK_APPROVAL,
  PROTOCOL_AMM_BUILD_REVOKE,
  PROTOCOL_AMM_FEE_TOKENS,
  PROTOCOL_AMM_FEE_QUOTE,
  PROTOCOL_AMM_PREPARE_FEE_SWAP,
  PROTOCOL_AMM_RELAY_FEE_SWAP,
  PROTOCOL_AMM_V2_SETTINGS,
  PROTOCOL_AMM_APPROVAL_ROUTE,
  PROTOCOL_AMM_BUILD_PERMIT,
  PROTOCOL_AMM_PATHS,
  PROTOCOL_AMM_BUILD_SWAP_V2,
  PROTOCOL_AMM_FEE_TIERS,
  PROTOCOL_AMM_POOL_EXISTS,
  PROTOCOL_AMM_BUILD_CREATE_AND_SEED,
  PROTOCOL_AMM_QUOTE_ADD_LIQUIDITY,
  PROTOCOL_AMM_BUILD_ADD_LIQUIDITY,
  PROTOCOL_AMM_QUOTE_SWAP_AND_ADD,
  PROTOCOL_AMM_BUILD_SWAP_AND_ADD,
  PROTOCOL_AMM_BUILD_REMOVE_LIQUIDITY,
  PROTOCOL_AMM_BUILD_SEND_SHARES,
  PROTOCOL_AMM_CLAIM_FEES,
  PROTOCOL_AMM_POSITIONS,
  PROTOCOL_AMM_POSITION,
  PROTOCOL_AMM_EXPLAIN_LIQUIDITY_CALL,
  PROTOCOL_AMM_POOL_FEES,
  PROTOCOL_AMM_REQUEST_PROTOCOL_FEE,
] as const;
