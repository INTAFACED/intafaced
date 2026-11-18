import { z } from 'zod';

/**
 * Wire types for the sovereign P2P escrow (RC-p2p-01): the SovereignEscrow contract holds a seller's tokens for one P2P
 * order, and the parties sign every call from their own wallets. svc-protocol only reads the contract and builds unsigned
 * calls; it never signs, never sends and never posts to the ledger. The contract has no platform role: no arbiter is
 * offered, and a dispute settles after its window by the refund both parties agreed when the deal opened.
 *
 * Amounts are base-unit decimal strings, never numbers. `audited` is always false: the audit is external.
 */
export const ESCROW_NOT_DEPLOYED = 'protocol.escrow_not_deployed' as const;
export const ESCROW_AMOUNT_INVALID = 'protocol.escrow_amount_invalid' as const;
export const ESCROW_DEAL_NOT_FOUND = 'protocol.escrow_deal_not_found' as const;
/** The contract's audit is external and not done: a mainnet deal is switched off in this build. */
export const ESCROW_AUDIT_EXTERNAL = 'audit.external' as const;

const units = z.string().regex(/^[1-9][0-9]*$/);
const unitsOrZero = z.string().regex(/^(0|[1-9][0-9]*)$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/);
const dealId = z.string().regex(/^[1-9][0-9]{0,77}$/);

/**
 * `protocol.escrow.status`: whether the contract is deployed on the configured chain, and the two networks a person may
 * ask for. The testnet row is the configured chain; mainnet is always switched off here (`audit.external`).
 */
export const protocolEscrowStatusOutputSchema = z
  .object({
    testnet: z
      .object({
        chainId: z.number().int().positive(),
        /** Plain words for the network, e.g. "Base Sepolia testnet, not INTACHAIN". */
        label: z.string().min(1),
        deployed: z.boolean(),
        /** The contract's address when deployed, else null. */
        escrow: address.nullable(),
        /** Set when `deployed` is false. */
        blocker: z.literal(ESCROW_NOT_DEPLOYED).nullable(),
      })
      .strict(),
    mainnet: z.object({ available: z.literal(false), blocker: z.literal(ESCROW_AUDIT_EXTERNAL) }).strict(),
    audited: z.literal(false),
  })
  .strict();
export type ProtocolEscrowStatus = z.infer<typeof protocolEscrowStatusOutputSchema>;

export const protocolEscrowDealStateSchema = z.enum(['open', 'locked', 'disputed', 'released', 'refunded']);
export type ProtocolEscrowDealState = z.infer<typeof protocolEscrowDealStateSchema>;
export const protocolEscrowTimeoutSchema = z.enum(['refund_seller', 'release_buyer']);

export const protocolEscrowDealInputSchema = z.object({ dealId }).strict();
/** `protocol.escrow.deal`: one deal as the contract holds it at the latest block, with that block's time. */
export const protocolEscrowDealOutputSchema = z
  .object({
    dealId,
    chainId: z.number().int().positive(),
    escrow: address,
    seller: address,
    buyer: address,
    token: address,
    /** The amount the deal was opened for, from `DealOpened`; the contract zeroes its own once released or refunded. */
    amount: units,
    /** What the contract holds for this deal now. */
    held: unitsOrZero,
    arbiter: address.nullable(),
    disputeWindowSeconds: z.number().int().positive(),
    /** Unix seconds; null until disputed. */
    disputeDeadline: z.number().int().nonnegative().nullable(),
    timeout: protocolEscrowTimeoutSchema,
    state: protocolEscrowDealStateSchema,
    chainTime: z.number().int().nonnegative(),
    audited: z.literal(false),
  })
  .strict();
export type ProtocolEscrowDeal = z.infer<typeof protocolEscrowDealOutputSchema>;

/** `protocol.escrow.build`: one unsigned call. `open` fixes the terms; the others act on an opened deal. */
export const protocolEscrowBuildInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('open'),
      buyer: address,
      token: address,
      /** Base units of `token`. */
      amount: units,
      disputeWindowSeconds: z.number().int().positive().max(4_294_967_295),
      timeout: protocolEscrowTimeoutSchema,
    })
    .strict(),
  z.object({ action: z.literal('approve'), token: address, amount: units }).strict(),
  z.object({ action: z.enum(['lock', 'release', 'refund', 'dispute', 'settleTimeout']), dealId }).strict(),
]);
export type ProtocolEscrowBuildInput = z.infer<typeof protocolEscrowBuildInputSchema>;

export const protocolEscrowBuildOutputSchema = z
  .object({ chainId: z.number().int().positive(), to: address, data: hex, value: z.literal('0'), summary: z.string().min(1) })
  .strict();
export type ProtocolEscrowBuild = z.infer<typeof protocolEscrowBuildOutputSchema>;
