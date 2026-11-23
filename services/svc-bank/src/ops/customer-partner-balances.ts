/**
 * J-derivatives-26 #8: one customer's spending balances as the partner holding their money reports them, for the founder
 * console beside their venue account (`BANK_OPS_CUSTOMER_PARTNER_BALANCES`, `admin:read`).
 *
 * Read only: each figure is the one the customer's own `spaces.list` shows (`SpaceService.partnerHeldFigures`, built as
 * `overview` builds it), with the partner's label as its source and its as-of time. No partner holding this person's money
 * answers `heldByPartner: false` with no spaces; ledger figures are never mixed in. No audit table is merged for operator
 * reads, so every read writes one structured log line naming the operator and the customer BEFORE anything is read; if that
 * line cannot be written the read refuses and reads nothing. Nothing is inserted and there is no export.
 */
import { BANK_OPS_CUSTOMER_PARTNER_BALANCES } from '@intafaced/contracts/bank-ops-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import type { BankServices } from '../bank-service.js';
import { bankRefusal } from '../router/errors.js';
import { writeOpsReadAudit } from './customer-balances.js';

function writeCustomerPartnerBalancesAudit(actorUserId: string, ownerUserId: string): void {
  writeOpsReadAudit({ event: 'bank.ops.customer_partner_balances_read', actorUserId, ownerUserId });
}

/** `ops.customerPartnerBalances`, mounted from its record. */
export function customerPartnerBalancesDoor(bank: BankServices) {
  return mountRecord(
    BANK_OPS_CUSTOMER_PARTNER_BALANCES,
    async ({ ctx, input }) => {
      writeCustomerPartnerBalancesAudit(ctx.principal.userId, input.userId);
      const held = await bank.spaces.partnerHeldFigures(input.userId);
      if (held === null) return { userId: input.userId, heldByPartner: false, spaces: [] };
      return {
        userId: input.userId,
        heldByPartner: true,
        spaces: held.map(({ space, label, figure }) => ({
          spaceId: space.id,
          assetId: space.assetId,
          kind: space.kind,
          name: space.name,
          balance: figure.amount,
          source: label,
          asOf: figure.asOf,
          state: figure.state,
          staleAfterMs: figure.staleAfterMs,
        })),
      };
    },
    bankRefusal,
  );
}
