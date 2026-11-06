/**
 * One customer's cards for the founder console's customer record (J-ops-console-04 #7, the record's cards tab).
 *
 * Read only: the same `cardsOf` query the owner's `cards.list` runs, asked for the customer the operator names. The operator
 * needs `admin:treasury`, the same scope as `ops.customerBalances`; a customer's own session never reaches it. No audit table
 * is merged for operator reads, so every read writes one structured log line with the operator and the customer BEFORE any
 * card is read; if that line cannot be written the read refuses and reads nothing.
 *
 * The page size is the caller's and is not defaulted: blank refuses `bank.cards_list_limit_unset`, as on the owner's list,
 * and it is capped at the owner list's 200. Nothing secret leaves: no card number, no security code, no PIN, no issuer
 * reference, and no shipping address (a home address the cards tab does not need). Nothing is inserted and there is no export.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { formatAmount } from '@intafaced/ledger-client';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { cardInactive, type CardRecord } from '../cards/card-service.js';
import { BankError } from '../errors.js';
import { assertCardsListLimit } from '../owner-list-limit.js';

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

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

const customerCardOutput = z.object({
  id: z.string(),
  assetId: z.string(),
  settlementAssetId: z.string(),
  issuer: z.string(),
  /** TRUE MEANS THERE IS NO CARD. Never omitted, never defaulted. */
  simulated: z.boolean(),
  /** Four digits. Not a card number and not part of one. */
  panTail: z.string(),
  /** `inactive`: issued but not activated yet (BK-cissue-04). */
  status: z.enum(['active', 'inactive', 'frozen', 'closed']),
  cardType: z.enum(['virtual', 'physical']),
  cashbackBps: z.number().int(),
  perAuthorizationLimit: amountString,
  dailyLimit: amountString.nullable(),
  monthlyLimit: amountString.nullable(),
  cashLimit: amountString.nullable(),
  online: z.boolean(),
  contactless: z.boolean(),
  atm: z.boolean(),
  abroad: z.boolean(),
  usesAllowed: z.number().int().nullable(),
  designId: z.string().nullable(),
  deliverySpeed: z.string().nullable(),
  replacesCardId: z.string().nullable(),
  replacedByCardId: z.string().nullable(),
});

export type CustomerCard = z.infer<typeof customerCardOutput>;

/** The owner list's non-secret fields, with the status the owner sees (`inactive` for an active card not yet activated). */
export function presentCustomerCard(c: CardRecord): CustomerCard {
  return {
    id: c.id,
    assetId: c.assetId,
    settlementAssetId: c.settlementAssetId,
    issuer: c.issuer,
    simulated: c.simulated,
    panTail: c.panTail,
    status: c.status === 'active' && cardInactive(c) ? 'inactive' : c.status,
    cardType: c.cardType ?? 'virtual',
    cashbackBps: c.cashbackBps,
    perAuthorizationLimit: formatAmount(c.perAuthorizationLimit),
    dailyLimit: c.dailyLimit == null ? null : formatAmount(c.dailyLimit),
    monthlyLimit: c.monthlyLimit == null ? null : formatAmount(c.monthlyLimit),
    cashLimit: c.cashLimit == null ? null : formatAmount(c.cashLimit),
    online: c.online ?? true,
    contactless: c.contactless ?? true,
    atm: c.atm ?? true,
    abroad: c.abroad ?? true,
    usesAllowed: c.usesAllowed ?? null,
    designId: c.designId ?? null,
    deliverySpeed: c.deliverySpeed ?? null,
    replacesCardId: c.replacesCardId ?? null,
    replacedByCardId: c.replacedByCardId ?? null,
  };
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function customerCardsProcedure(bank: BankServices, guard: Guard) {
  return scopedProcedure('admin:treasury')
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
        const cards = await bank.cards.cardsOf(input.userId, page);
        return { userId: input.userId, cards: cards.map(presentCustomerCard) };
      }),
    );
}
