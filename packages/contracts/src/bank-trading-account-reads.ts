/**
 * svc-bank's answers the customer's trading account room reads. Browser-safe (zod only). The `ownMoves.*` answers
 * (J-derivatives-25 #2 #3: moves between the person's own spending money at the partner bank and their own trading
 * account at the venue) are svc-bank's own output schemas: its router checks its output with them. Nothing here posts to
 * the ledger.
 */
import { z } from 'zod';

/** One own move, as `ownMoves.toWallet`, `recordDeposit`, `get` and `list` answer it. */
export const ownMoveViewSchema = z.object({
  id: z.string(),
  direction: z.literal('in'),
  assetId: z.string(),
  amount: z.string(),
  wallet: z.string(),
  status: z.enum(['opening', 'sent']),
  partner: z.string(),
  partnerRef: z.string().nullable(),
  partnerFee: z.string().nullable(),
  deliveryTx: z.string().nullable(),
  depositTx: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  depositAt: z.string().nullable(),
});
export type OwnMoveView = z.infer<typeof ownMoveViewSchema>;

/** `ownMoves.message`: the words the person's wallet signs for one move. */
export const ownMoveMessageSchema = z.object({ message: z.string() });

/**
 * The fields of one `cards.list` row the trading account room reads; the rest of the row passes through as sent.
 * svc-bank's own card answer is wider (`apps/customer/src/features/money/contracts-cards.ts` reads it whole).
 */
export const tradingCardRowSchema = z
  .object({ id: z.string(), assetId: z.string(), status: z.string(), panTail: z.string() })
  .passthrough();

/** The fields of `cards.partnerHeld` the trading account room reads: who holds the card's money and its available figure. */
export const tradingCardHeldSchema = z.object({
  heldBy: z.enum(['ledger', 'partner', 'none']),
  figures: z.object({ assetId: z.string(), available: z.string().nullable() }).passthrough().nullable(),
});
