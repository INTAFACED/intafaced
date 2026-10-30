import { z } from 'zod';

/**
 * Wire types for who gets a pool's fees (D-fees-governance-04). The pools that exist take no fee for anyone but their
 * liquidity providers by design: a factory pool is the one `ConstantProductPool` contract, whose only fee is the swap fee
 * fixed at construction, kept in the pool for its LPs, with no fee recipient (`ConstantProductPool.sol:12-13,27`). A
 * protocol, creator or governance share would need new contracts, and the owner has published no fee policy, so a
 * request for one refuses by name. Nothing here moves value.
 */
export const PROTOCOL_FEE_POLICY_UNSET = 'protocol.fee_policy_unset' as const;
/** The address is not a pool the configured factory created, so nothing is said about its fees. */
export const PROTOCOL_NOT_FACTORY_POOL = 'protocol.not_factory_pool' as const;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const height = z.string().regex(/^(0|[1-9][0-9]*)$/);

/** The basis points of every swap fee, the whole fee. */
export const FEE_SHARE_TOTAL_BPS = 10_000 as const;

export const protocolFeeShareSchema = z
  .object({
    to: z.enum(['liquidity_providers', 'creator', 'platform', 'governance']),
    /** Share of the swap fee in bps of the fee (10000 = all of it). */
    bps: z.number().int().min(0).max(FEE_SHARE_TOTAL_BPS),
  })
  .strict();
export type ProtocolFeeShare = z.infer<typeof protocolFeeShareSchema>;

/** `protocol.amm.poolFees`: the pool's own fee fields, read from the chain at one block. */
export const protocolPoolFeesOutputSchema = z
  .object({
    pool: address,
    factory: address,
    /** The pool's `feeBps()`: the swap fee in bps of the input amount. */
    feeBps: z.number().int().min(0).max(1000),
    /** Every share of the swap fee; they add up to `FEE_SHARE_TOTAL_BPS`. */
    shares: z.array(protocolFeeShareSchema).min(1),
    /** True when any share goes to someone other than the liquidity providers. */
    thirdShare: z.boolean(),
    /** Which contract the shares are read from, so a later fee-switch contract is told apart. */
    contract: z.literal('ConstantProductPool v1'),
    blockNumber: height,
  })
  .strict();
export type ProtocolPoolFees = z.infer<typeof protocolPoolFeesOutputSchema>;

/**
 * The fields the owner must publish before any protocol fee contract is written (the spec's order: a new fee-switch
 * factory with the share fixed at construction, then a collector whose release is permissionless and bounded). All of
 * them are blank today.
 */
export const PROTOCOL_FEE_POLICY_FIELDS = [
  'protocol share per pool class (percent of the swap fee)',
  'which pools are enabled',
  'collector address per network',
  'release thresholds',
] as const;

/** `protocol.amm.poolFees` and `protocol.amm.requestProtocolFee` both take one pool address. */
export const protocolPoolFeesInputSchema = z.object({ pool: address }).strict();
export const protocolRequestProtocolFeeInputSchema = protocolPoolFeesInputSchema;
