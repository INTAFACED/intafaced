import { z } from 'zod';
import { protocolSwapTokenSchema, protocolTypedDataSchema, protocolUnsignedCallSchema } from './protocol-swap.js';

/**
 * Wire types for the router v2 swap (D-swap-03, D-swap-intents-01, -02): how a token may be approved (its own permit, the
 * SovereignPermit contract, or only an approve transaction), the permits a person signs, a path of one or more pools with
 * the minimum each hop must pay, and the one call the wallet sends. Amounts are base-unit decimal strings. The person's
 * own wallet signs and sends everything; nothing here posts to the ledger.
 */
const units = z.string().regex(/^(0|[1-9][0-9]*)$/);
const positive = z.string().regex(/^[1-9][0-9]{0,77}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);

/** Router v2, SovereignPermit or the wrapped native token is not configured for this network. */
export const ROUTER_V2_UNSET = 'protocol.router_v2_unset' as const;
/** `PROTOCOL_PERMIT_LIFETIME_CAP_SECONDS` is blank: no permit is built. */
export const PERMIT_LIFETIME_UNSET = 'protocol.permit.lifetime_unset' as const;
/** A permit deadline or a standing allowance's expiry is further out than the owner's cap. */
export const PERMIT_LIFETIME_OVER_CAP = 'protocol.permit.lifetime_over_cap' as const;
/** The token publishes no permit of its own, so a one-signature approval is not possible for it. */
export const PERMIT_NOT_SUPPORTED = 'protocol.permit.not_supported' as const;
/** The standing allowance the swap would pull through has expired: the pull is refused on chain. */
export const PERMIT_ALLOWANCE_EXPIRED = 'protocol.permit.allowance_expired' as const;
/** The standing allowance left is less than the swap needs. */
export const PERMIT_ALLOWANCE_LOW = 'protocol.permit.allowance_low' as const;
/** A multi-hop route was asked for with no hop limit. */
export const ROUTE_MAX_HOPS_UNSET = 'dex.route.max_hops_unset' as const;
/** A route with more hops than the hop limit the person set. */
export const ROUTE_OVER_MAX_HOPS = 'dex.route.over_max_hops' as const;
/** No path with that many hops joins the two tokens through pools that can quote the amount. */
export const ROUTE_NO_PATH = 'dex.route.no_path' as const;
/** Zero is never a deadline. */
export const DEADLINE_REQUIRED = 'protocol.deadline_required' as const;
/** The deadline is at or before the chain's latest block time. */
export const DEADLINE_PAST = 'protocol.deadline_past' as const;
/** The route's quote moved: a hop's fresh output is under the minimum the person signed for. */
export const HOP_BELOW_MIN = 'protocol.swap.hop_below_min' as const;

/** How `owner` can let router v2 move `token`: the token's own permit, SovereignPermit, or only an approve transaction. */
export const protocolApprovalRouteSchema = z.enum(['native_permit', 'permit_contract', 'approve_only']);
export type ProtocolApprovalRoute = z.infer<typeof protocolApprovalRouteSchema>;

/** `protocol.amm.v2Settings`: the router v2 deployment and the permit lifetime cap (null when the owner left it blank). */
export const protocolSwapV2SettingsSchema = z
  .object({
    router: address,
    sovereignPermit: address,
    wrappedNative: protocolSwapTokenSchema,
    permitLifetimeCapSeconds: z.number().int().positive().nullable(),
    /** The most hops one path may have, a read bound of this service (not a product limit). */
    maxPathHops: z.number().int().positive(),
  })
  .strict();
export type ProtocolSwapV2Settings = z.infer<typeof protocolSwapV2SettingsSchema>;

/** `protocol.amm.approvalRoute`. */
export const protocolApprovalRouteOutputSchema = z
  .object({
    token: address,
    route: protocolApprovalRouteSchema,
    /** The owner's allowance to router v2 now. */
    routerAllowance: units,
    /** The owner's allowance to SovereignPermit now. */
    permitContractAllowance: units,
    /** The owner's standing allowance for router v2 in SovereignPermit: amount left and expiry (chain seconds), or null. */
    standing: z
      .object({ amount: units, expiration: units, nonce: z.number().int().min(0) })
      .strict()
      .nullable(),
    blockNumber: units,
    blockTime: units,
  })
  .strict();
export type ProtocolApprovalRouteOutput = z.infer<typeof protocolApprovalRouteOutputSchema>;

/** `protocol.amm.buildPermit` input: the exact amount for this swap, or a standing allowance until `expiration`. */
export const protocolBuildPermitInputSchema = z
  .object({
    owner: address,
    token: address,
    amount: positive,
    mode: z.enum(['exact', 'standing']),
    /** Chain seconds: when the signature stops being usable (exact), or when the standing allowance expires. */
    expiresAt: positive,
  })
  .strict();
export type ProtocolBuildPermitInput = z.infer<typeof protocolBuildPermitInputSchema>;

/**
 * `protocol.amm.buildPermit`: what the person signs, in order, and any approve transaction that must be sent first (a
 * standing allowance on a token with no permit needs SovereignPermit approved once on chain).
 */
export const protocolBuildPermitOutputSchema = z
  .object({
    mode: z.enum(['exact', 'standing']),
    route: protocolApprovalRouteSchema,
    token: address,
    amount: units,
    expiresAt: units,
    /** EIP-2612 permit of the token itself (exact: to router v2; standing: to SovereignPermit), when one is needed. */
    tokenPermit: protocolTypedDataSchema.nullable(),
    /** SovereignPermit's PermitAllowance (standing only). */
    standing: protocolTypedDataSchema.nullable(),
    /** Approve transactions the wallet sends before the swap (standing on a token with no permit). */
    approveCalls: z.array(protocolUnsignedCallSchema),
  })
  .strict();
export type ProtocolBuildPermitOutput = z.infer<typeof protocolBuildPermitOutputSchema>;

/** `protocol.amm.paths` input: the best path with exactly `hops` pools, under the person's hop limit. */
export const protocolPathsInputSchema = z
  .object({
    tokenIn: address,
    tokenOut: address,
    kind: z.enum(['exact_in', 'exact_out']),
    /** Exact in: what the person pays. Exact out: what they receive. */
    amount: positive,
    hops: z.number().int().positive(),
    /** The person's hop limit; blank (null) refuses a multi-hop request. */
    maxHops: z.number().int().positive().nullable(),
  })
  .strict();
export type ProtocolPathsInput = z.infer<typeof protocolPathsInputSchema>;

/** One hop of a path: the pool, the token it pays and what it pays (exact in) or must be paid (exact out) at the read. */
export const protocolPathHopSchema = z
  .object({ pool: address, tokenIn: address, tokenOut: address, amountIn: units, amountOut: units })
  .strict();

/** `protocol.amm.paths`: the best path for the request at one block, with each hop's amounts. */
export const protocolPathOutputSchema = z
  .object({
    kind: z.enum(['exact_in', 'exact_out']),
    path: z.array(address).min(2),
    pools: z.array(address).min(1),
    hops: z.array(protocolPathHopSchema).min(1),
    amountIn: units,
    amountOut: units,
    blockNumber: units,
    blockTime: units,
  })
  .strict();
export type ProtocolPathOutput = z.infer<typeof protocolPathOutputSchema>;

/** `protocol.amm.buildSwapV2` input. */
export const protocolBuildSwapV2InputSchema = z
  .object({
    owner: address,
    kind: z.enum(['exact_in', 'exact_out']),
    path: z.array(address).min(2),
    pools: z.array(address).min(1),
    amount: positive,
    slippageBps: z.number().int().min(0).max(10_000),
    deadline: units,
    pull: z.enum(['allowance', 'standing', 'native']),
    unwrapOut: z.boolean().default(false),
    /** A signed EIP-2612 permit of the input token to router v2 (one signature for this swap). */
    tokenPermit: z.object({ value: positive, deadline: positive, signature }).strict().optional(),
    /** A signed SovereignPermit standing allowance for router v2. */
    standing: z
      .object({ amount: positive, expiration: positive, nonce: z.number().int().min(0), sigDeadline: positive, signature })
      .strict()
      .optional(),
    /**
     * The limits the person saw and signs for. Exact in: each hop's minimum. Exact out: the most paid. The service checks
     * them against its own fresh read: looser than the owner's slippage ceiling allows refuses, and tighter than the fresh
     * read (the price already moved) refuses. Absent, the service sets them from `slippageBps`.
     */
    minOutPerHop: z.array(positive).optional(),
    maxIn: positive.optional(),
    /** The person's hop limit; a multi-hop path with none refuses `dex.route.max_hops_unset`. */
    maxHops: z.number().int().positive().nullable().default(null),
    /** Simulate the call from the owner before returning it (no approve transaction is still waiting to be sent). */
    simulate: z.boolean().default(false),
  })
  .strict();
export type ProtocolBuildSwapV2Input = z.infer<typeof protocolBuildSwapV2InputSchema>;

/** `protocol.amm.buildSwapV2`: the one call the wallet sends, the minimum each hop must pay, and the limits signed. */
export const protocolBuildSwapV2OutputSchema = z
  .object({
    call: protocolUnsignedCallSchema,
    kind: z.enum(['exact_in', 'exact_out']),
    path: z.array(address),
    pools: z.array(address),
    /** Exact in: the least each hop pays. Exact out: empty. */
    minOutPerHop: z.array(units),
    /** Exact in: what is paid. Exact out: the most that may be paid. */
    amountIn: units,
    /** Exact in: the least received. Exact out: exactly what is received. */
    amountOut: units,
    /** The quote the limits were taken from, per hop. */
    quoted: z.array(units),
    deadline: units,
    blockNumber: units,
    /** With `simulate`: the gas the call used in the simulation plus a fifth, as the wallet's gas limit; else null. */
    gas: units.nullable(),
  })
  .strict();
export type ProtocolBuildSwapV2Output = z.infer<typeof protocolBuildSwapV2OutputSchema>;
