import { z } from 'zod';

/**
 * Wire types for one account's position in the isolated lending market (D-portfolio-wallet-04, J-dex-protocol-06 #4):
 * the published IsolatedLendingMarket contract's own public state (`collateralOf`, `debtOf`), read from the chain at one
 * block. Nothing here posts to the ledger and nothing is a second book: the position is the contract's state, and
 * svc-protocol keeps no copy of it.
 *
 * Amounts are decimal strings in each token's own units ("25", "0.5"), never numbers.
 */
export const LENDING_MARKET_UNSET = 'protocol.lending_market_unset' as const;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
/** A non-negative decimal string, as read back. */
const decimal = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const token = z.object({ address, symbol: z.string().nullable(), decimals: z.number().int().min(0).max(36) }).strict();

export const protocolLendingPositionInputSchema = z.object({ account: address }).strict();

/** `protocol.lending.position`: the account's collateral and debt in the market, read at the block the answer names. */
export const protocolLendingPositionOutputSchema = z
  .object({
    market: address,
    chainId: z.number().int().positive(),
    account: address,
    blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
    collateralToken: token,
    borrowToken: token,
    /** What the account has deposited as collateral, in the collateral token's units. */
    collateral: decimal,
    /** What the account owes, interest to the read block included, in the borrow token's units. */
    debt: decimal,
    /** The market's own maximum loan to value, in basis points (its immutable construction parameter). */
    maxLtvBps: z.number().int().min(0).max(10_000),
  })
  .strict();
export type ProtocolLendingPosition = z.infer<typeof protocolLendingPositionOutputSchema>;
