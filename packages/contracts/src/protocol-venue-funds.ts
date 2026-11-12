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
