import { z } from 'zod';

/**
 * Wire types for moving a wallet's own tokens into and out of the trading venue (D-bridge-chain-04,
 * J-dex-protocol-05 #9): the published SovereignVenue contract's `deposit(baseAmount, quoteAmount)` and
 * `withdraw(baseAmount, quoteAmount)`, and its public balances (`baseBal`, `quoteBal`, `reservedBase`, `reservedQuote`).
 *
 * Nothing here posts to the ledger and nothing is a second book: the venue balance is the contract's own state, read
 * from the chain, and svc-protocol only builds unsigned calls that the person's own wallet signs and sends.
 *
 * Amounts are decimal strings in the token's own units ("10", "0.5"), never numbers. The venue keeps 18-decimal
 * amounts inside; an amount finer than the token's own decimals can't be moved and is refused.
 */
export const VENUE_UNSET = 'protocol.venue_unset' as const;
export const VENUE_INSUFFICIENT_FREE = 'protocol.venue_insufficient_free' as const;
export const VENUE_BAD_AMOUNT = 'protocol.venue_bad_amount' as const;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/);
/** A non-negative decimal string, as read back. */
const decimal = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
/** A positive decimal string, as typed: at most 18 decimal places (the venue's own precision). */
const amount = z
  .string()
  .trim()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/, 'an amount is a decimal number with at most 18 decimal places');

/** The venue's two assets: base (what the market trades) and quote (what it is priced in). */
export const protocolVenueSideSchema = z.enum(['base', 'quote']);
export type ProtocolVenueSide = z.infer<typeof protocolVenueSideSchema>;

const token = z.object({ address, symbol: z.string().nullable(), decimals: z.number().int().min(0).max(36) }).strict();

/** One asset's balance in the venue for one account: total, reserved by open orders, and free (total less reserved). */
export const protocolVenueAssetSchema = z
  .object({ side: protocolVenueSideSchema, token, total: decimal, reserved: decimal, free: decimal })
  .strict();
export type ProtocolVenueAsset = z.infer<typeof protocolVenueAssetSchema>;

export const protocolVenueBalancesInputSchema = z.object({ account: address }).strict();

/** `protocol.venue.balances`: read from the contract at one block, which the answer names. */
export const protocolVenueBalancesOutputSchema = z
  .object({
    venue: address,
    chainId: z.number().int().positive(),
    account: address,
    blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
    assets: z.array(protocolVenueAssetSchema).length(2),
  })
  .strict();
export type ProtocolVenueBalances = z.infer<typeof protocolVenueBalancesOutputSchema>;

export const protocolVenueBuildInputSchema = z.object({ account: address, side: protocolVenueSideSchema, amount }).strict();
export type ProtocolVenueBuildInput = z.infer<typeof protocolVenueBuildInputSchema>;

const unsignedCall = z.object({ to: address, data: hex, value: z.string(), summary: z.string() }).strict();

/**
 * `protocol.venue.buildDeposit` and `protocol.venue.buildWithdraw`: the unsigned calls in order (a deposit's token
 * approval first, when the allowance doesn't cover it), for the account's own wallet to sign. Nothing is sent.
 */
export const protocolVenueBuildOutputSchema = z
  .object({
    kind: z.enum(['deposit', 'withdraw']),
    venue: address,
    chainId: z.number().int().positive(),
    account: address,
    side: protocolVenueSideSchema,
    token,
    amount: decimal,
    /** The asset's free amount in the venue at `blockNumber`, before this call. */
    free: decimal,
    blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
    calls: z.array(unsignedCall).min(1),
  })
  .strict();
export type ProtocolVenueBuild = z.infer<typeof protocolVenueBuildOutputSchema>;

/** A token address that is not an ERC-20 on the venue's chain (no code, or no `decimals()`): there is nothing to review. */
export const ASSET_LINK_NOT_TOKEN = 'protocol.asset_link_not_token' as const;

export const protocolAssetLinkReviewInputSchema = z.object({ token: address }).strict();
export type ProtocolAssetLinkReviewInput = z.infer<typeof protocolAssetLinkReviewInputSchema>;

/**
 * `protocol.venue.assetLinkReview` (D-bridge-chain-04, J-dex-protocol-05 #10): whether an ERC-20 is one of the trading
 * venue's own two assets, read from the token and the venue contract at one block. `linked` means the venue trades this
 * very token (its `baseToken` or `quoteToken`), so moving it in and out carries no bridging risk; anything else is
 * `not_linked` with the reason. A read: nothing is stored, signed or posted.
 */
export const protocolAssetLinkReviewOutputSchema = z
  .object({
    venue: address,
    chainId: z.number().int().positive(),
    blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
    token,
    verdict: z.enum(['linked', 'not_linked']),
    /** The venue asset the token is, when linked. */
    side: protocolVenueSideSchema.nullable(),
    /** The venue's two assets as the contract names them, so the reason can be checked. */
    venueAssets: z.array(z.object({ side: protocolVenueSideSchema, token }).strict()).length(2),
    reason: z.string(),
  })
  .strict();
export type ProtocolAssetLinkReview = z.infer<typeof protocolAssetLinkReviewOutputSchema>;

/** One read-only call on the venue contract, with an example a developer can paste. */
export const protocolVenueReadCallSchema = z
  .object({
    name: z.string(),
    signature: z.string(),
    description: z.string(),
    example: z.string(),
  })
  .strict();
export type ProtocolVenueReadCall = z.infer<typeof protocolVenueReadCallSchema>;

/**
 * `protocol.venue.reads`: the contract-read docs. The venue's public getters, the core state any contract or client can
 * read, each with an example aimed at the configured venue on its chain. Reads of the trading core itself (precompile-style
 * reads and delayed core actions) belong to INTACORE and wait on its published interface (`owner.decision`).
 */
export const protocolVenueReadsOutputSchema = z
  .object({
    venue: address,
    chainId: z.number().int().positive(),
    calls: z.array(protocolVenueReadCallSchema).min(1),
  })
  .strict();
export type ProtocolVenueReads = z.infer<typeof protocolVenueReadsOutputSchema>;
