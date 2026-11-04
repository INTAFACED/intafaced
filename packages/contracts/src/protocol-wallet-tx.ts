import { z } from 'zod';

/**
 * Wire types for two wallet-signed transfer tools of the wallet room. Nothing here posts to the ledger; svc-protocol only
 * reads the chain and builds unsigned calls, and the person's own wallet signs and sends.
 *
 * - Claim links (D-swap-12): tokens locked in the ClaimLinkEscrow contract under a one-time link key, claimed once by
 *   whoever holds the link, or taken back by the sender after expiry. The link key never reaches a service.
 * - Speed up and cancel (RC-dex-protocol-01): one unsigned same-nonce replacement for a pending transaction; a mined one
 *   is final and refuses `protocol.tx_final`.
 *
 * Amounts and wei are base-unit decimal strings, never numbers.
 */
export const CLAIM_ESCROW_UNSET = 'protocol.claim_escrow_unset' as const;
export const CLAIM_LINK_NOT_FOUND = 'protocol.claim_link_not_found' as const;
export const TX_FINAL = 'protocol.tx_final' as const;
export const TX_NOT_FOUND = 'protocol.tx_not_found' as const;
export const TX_NOT_YOURS = 'protocol.tx_not_yours' as const;
export const FEE_BUMP_UNSET = 'protocol.fee_bump_unset' as const;
export const FEE_CEILING_UNSET = 'protocol.fee_ceiling_unset' as const;
export const FEE_ABOVE_CEILING = 'protocol.fee_above_ceiling' as const;

const units = z.string().regex(/^(0|[1-9][0-9]*)$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/);
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** `protocol.claimLink.config`: the escrow and its published expiry bounds, read from the contract itself. */
export const protocolClaimLinkConfigOutputSchema = z
  .object({
    escrow: address,
    chainId: z.number().int().positive(),
    minExpirySeconds: z.number().int().positive(),
    maxExpirySeconds: z.number().int().positive(),
  })
  .strict();
export type ProtocolClaimLinkConfig = z.infer<typeof protocolClaimLinkConfigOutputSchema>;

export const protocolClaimLinkStateSchema = z.enum(['open', 'claimed', 'expired', 'clawed_back']);
export type ProtocolClaimLinkState = z.infer<typeof protocolClaimLinkStateSchema>;

export const protocolClaimLinkSchema = z
  .object({
    /** The link key's address: the link's id on chain. Never the key. */
    id: address,
    sender: address,
    token: z
      .object({ address, name: z.string().nullable(), symbol: z.string().nullable(), decimals: z.number().int().min(0).max(36).nullable() })
      .strict(),
    amount: units,
    /** Unix seconds. After this, nobody can claim and only the sender can claw back. */
    expiresAt: z.number().int().nonnegative(),
    /** `expired` is an open link past its expiry by the chain's own clock (`chainTime`). */
    state: protocolClaimLinkStateSchema,
    /** Who the link paid, from its `Claimed` event; null unless claimed. */
    claimedBy: address.nullable(),
  })
  .strict();
export type ProtocolClaimLink = z.infer<typeof protocolClaimLinkSchema>;

export const protocolClaimLinkGetInputSchema = z.object({ id: address }).strict();
/** `protocol.claimLink.get`: one link, read from the escrow at the latest block, and that block's time. */
export const protocolClaimLinkGetOutputSchema = z
  .object({ link: protocolClaimLinkSchema, chainTime: z.number().int().nonnegative() })
  .strict();

export const protocolClaimLinkListInputSchema = z.object({ sender: address }).strict();
/** `protocol.claimLink.list`: every link `sender` created, newest first, from the escrow's `Created` events. */
export const protocolClaimLinkListOutputSchema = z
  .object({ links: z.array(protocolClaimLinkSchema), chainTime: z.number().int().nonnegative() })
  .strict();

export const protocolReplacementModeSchema = z.enum(['speedUp', 'cancel']);
export const protocolReplacementInputSchema = z
  .object({
    txHash,
    /** The connected wallet. The service re-reads the sender from the chain and refuses another's transaction. */
    from: address,
    mode: protocolReplacementModeSchema,
  })
  .strict();
export type ProtocolReplacementInput = z.infer<typeof protocolReplacementInputSchema>;

const fees = z.object({ maxFeePerGas: units, maxPriorityFeePerGas: units }).strict();

/**
 * `protocol.tx.buildReplacement`: one unsigned transaction at the pending one's nonce. Speed up repeats its call with
 * both fees raised by the published bump; cancel is a zero-value send to oneself. Never above the published ceiling.
 */
export const protocolReplacementOutputSchema = z
  .object({
    mode: protocolReplacementModeSchema,
    chainId: z.number().int().positive(),
    from: address,
    nonce: z.number().int().nonnegative(),
    to: address,
    value: units,
    data: hex,
    original: fees,
    replacement: fees,
    bumpBps: z.number().int().positive(),
    ceilingWei: units,
  })
  .strict();
export type ProtocolReplacement = z.infer<typeof protocolReplacementOutputSchema>;
