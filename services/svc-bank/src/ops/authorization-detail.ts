/**
 * BK-cops-01 (`ops.authorizationGet` row): one card authorisation for a
 * compliance operator (`admin:compliance`).
 *
 * Scope: the roadmap journey for this slice (J-bank-26) names an
 * `operator:support` persona, but no svc-bank read is mounted on
 * `support:ops` today and the slice spec does not name a scope. This read
 * stays on `admin:compliance`, like `ops.transferDetail`. Opening it to
 * `support:ops` is an owner decision for a later change.
 *
 * It returns what svc-bank stores for the decision: amount, channel, merchant
 * category, decision, decline code, status, hold and conversion (both legs).
 * `amount` is in `assetId`, the card's funding asset. The fields
 * card-sim does not produce or svc-bank does not store (merchant name and
 * country, network data, method, card presence, initiator, authorisation type) are named in `notAvailable`
 * with the reason "not available on card-sim" rather than returned as blanks
 * or made up. Unknown and malformed ids are the same not-found. The read
 * writes one structured log line (actor and id), like `ops.transferDetail`;
 * nothing is inserted.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { formatAmount } from '@intafaced/ledger-client';
import { z } from 'zod';
import type { BankServices } from '../bank-service.js';
import { BankError } from '../errors.js';

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = 'No such card authorisation (bank.ops_authorization_not_found)';

/**
 * Fields a live issuer would send that card-sim does not. Named, never blank.
 *
 * Socket: card-sim is the only card issuer adapter today. When a live issuer
 * adapter lands, these fields must come from it and this list must be derived
 * from what that adapter supplies, not sent for every card.
 */
export const AUTHORIZATION_FIELDS_NOT_ON_CARD_SIM = [
  'merchantName',
  'merchantCountry',
  'networkData',
  'method',
  'cardPresence',
  'initiator',
  'type',
] as const;

export const NOT_AVAILABLE_ON_CARD_SIM = 'not available on card-sim' as const;

export function writeAuthorizationReadAudit(actorUserId: string, id: string): void {
  console.info(JSON.stringify({ level: 'info', service: 'svc-bank', event: 'bank.ops.authorization_read', actorUserId, id }));
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function authorizationGetProcedure(bank: BankServices, guard: Guard) {
  return scopedProcedure('admin:compliance')
    .input(z.object({ id: z.string().max(64) }).strict())
    .output(
      z.object({
        id: z.string(),
        cardId: z.string(),
        userId: z.string(),
        assetId: z.string(),
        authorizationRef: z.string(),
        amount: amountString,
        merchantCategory: z.string().nullable(),
        channel: z.string(),
        decision: z.enum(['approved', 'declined']),
        declineCode: z.string().nullable(),
        status: z.enum(['pending', 'settled', 'rejected']),
        holdLedgerTxId: z.string().nullable(),
        decidedAt: z.string(),
        conversion: z
          .object({
            settlementAssetId: z.string(),
            settlementAmount: amountString,
            fundingAssetId: z.string(),
            fundingAmount: amountString,
            rate: amountString,
            rateQuality: z.string(),
            rateAsOf: z.string(),
          })
          .nullable(),
        notAvailable: z.array(
          z.object({
            field: z.enum(AUTHORIZATION_FIELDS_NOT_ON_CARD_SIM),
            reason: z.literal(NOT_AVAILABLE_ON_CARD_SIM),
          }),
        ),
      }),
    )
    .query(({ ctx, input }) =>
      guard(async () => {
        writeAuthorizationReadAudit(ctx.principal.userId, input.id);
        const a = UUID.test(input.id) ? await bank.cards.authorizationById(input.id) : null;
        if (!a) throw new BankError(NOT_FOUND, 'bank.ops_authorization_not_found');
        return {
          id: a.id,
          cardId: a.cardId,
          userId: a.userId,
          assetId: a.assetId,
          authorizationRef: a.authorizationRef,
          amount: formatAmount(a.amount),
          merchantCategory: a.merchantCategory,
          channel: a.channel,
          decision: a.decision,
          declineCode: a.declineCode,
          status: a.status,
          holdLedgerTxId: a.holdLedgerTxId,
          decidedAt: a.decidedAt.toISOString(),
          conversion: a.conversion
            ? {
                settlementAssetId: a.conversion.settlementAssetId,
                settlementAmount: formatAmount(a.conversion.settlementAmount),
                fundingAssetId: a.conversion.fundingAssetId,
                fundingAmount: formatAmount(a.conversion.fundingAmount),
                rate: formatAmount(a.conversion.rate),
                rateQuality: a.conversion.quality,
                rateAsOf: a.conversion.rateAsOf.toISOString(),
              }
            : null,
          notAvailable: AUTHORIZATION_FIELDS_NOT_ON_CARD_SIM.map((field) => ({ field, reason: NOT_AVAILABLE_ON_CARD_SIM })),
        };
      }),
    );
}
