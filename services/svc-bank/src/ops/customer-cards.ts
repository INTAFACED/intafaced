/**
 * One customer's cards for the founder console's customer record (J-ops-console-04 #7, the record's cards tab).
 *
 * Read only: the same query the owner's `cards.list` runs, asked for the customer the operator names, presented by the same
 * `presentCard` and schema (`cards/card-view.ts`) without `shippingAddress`, a home address the cards tab does not need. The
 * operator needs `admin:read`, the operator read scope a founder console session carries, as `ops.customerBalances` (owner
 * approval 2026-11-06: no PAN, CVC, PIN or address is ever returned); a customer's own session never reaches it. No audit
 * table is merged for operator reads, so every read writes one structured log line with the operator and the customer BEFORE
 * any card is read; if that line cannot be written the read refuses and reads nothing.
 *
 * The page size is the caller's and is not defaulted: blank refuses `bank.cards_list_limit_unset`, as on the owner's list,
 * checked once, before the audit line, and capped at the owner list's 200. Nothing is inserted and there is no export.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { cardOutput, presentCard } from '../cards/card-view.js';
import { BankError } from '../errors.js';
import { assertCardsListLimit } from '../owner-list-limit.js';

export function writeCustomerCardsAudit(actorUserId: string, ownerUserId: string): void {
  try {
    console.info(
      JSON.stringify({
        level: 'info',
        service: 'svc-bank',
        event: 'bank.ops.customer_cards_read',
        actorUserId,
        ownerUserId,
      }),
    );
  } catch {
    throw new BankError('The read could not be recorded, so nothing was read', 'bank.ops_audit_unavailable');
  }
}

/** The owner's card view without the shipping address. */
export const customerCardOutput = cardOutput.omit({ shippingAddress: true });

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function customerCardsProcedure(bank: BankServices, guard: Guard) {
  return scopedProcedure('admin:read')
    .input(
      z
        .object({
          userId: z.string().guid(),
          /** Page size. Optional so omit reaches `bank.cards_list_limit_unset` instead of a Zod "Required". Never defaulted. */
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict(),
    )
    .output(z.object({ userId: z.string(), cards: z.array(customerCardOutput) }))
    .query(({ ctx, input }) =>
      guard(async () => {
        const page = assertCardsListLimit(input.limit);
        writeCustomerCardsAudit(ctx.principal.userId, input.userId);
        const cards = await bank.cards.cardsPage(input.userId, page);
        return {
          userId: input.userId,
          cards: cards.map((c) => {
            const { shippingAddress: _home, ...view } = presentCard(c);
            return view;
          }),
        };
      }),
    );
}
