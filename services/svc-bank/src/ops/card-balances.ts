/**
 * Card balances for the finance-treasury desk (BK-cops-04, #5787's `bankCardBalances` shape).
 *
 * Read only and ledger reads only (`CardService.cardBalancesOf`). The operator needs `admin:treasury`, like
 * `ops.customerBalances`; a customer session never reaches this. Only the `individual` scope is answered. `programme`
 * and `business` need an aggregate over many customers' card holds that no ledger read gives today, and under the jit
 * model there is no programme account to read, so they refuse `bank.card_funds_scope_unwired` rather than sum
 * something invented. Each read writes one structured log line with the operator and the customer before any figure is
 * read; if that line cannot be written the read refuses (same as `ops.customerBalances`).
 */
import { bankCardBalancesInputSchema, bankCardBalancesSchema, scopedProcedure } from '@intafaced/contracts';
import { formatAmount } from '@intafaced/ledger-client';
import type { BankServices } from '../bank-service.js';
import { BankError } from '../errors.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

function writeCardBalancesAudit(actorUserId: string, ownerUserId: string): void {
  try {
    console.info(JSON.stringify({ level: 'info', service: 'svc-bank', event: 'bank.ops.card_balances_read', actorUserId, ownerUserId }));
  } catch {
    throw new BankError('The read could not be recorded, so nothing was read', 'bank.ops_audit_unavailable');
  }
}

export function cardBalancesProcedure(bank: BankServices, guard: Guard) {
  return scopedProcedure('admin:treasury')
    .input(bankCardBalancesInputSchema)
    .output(bankCardBalancesSchema)
    .query(({ ctx, input }) =>
      guard(async () => {
        const scope = input.scope;
        if (scope.kind !== 'individual') {
          throw new BankError(
            `Card balances for the ${scope.kind} scope are not wired: no ledger read aggregates them (bank.card_funds_scope_unwired)`,
            'bank.card_funds_scope_unwired',
          );
        }
        writeCardBalancesAudit(ctx.principal.userId, scope.userId);
        const rows = await bank.cards.cardBalancesOf(scope.userId, input.assetCode);
        return {
          scope,
          readAt: new Date().toISOString(),
          rows: rows.map((r) => ({
            assetCode: r.assetId,
            ledger: formatAmount(r.ledger),
            available: formatAmount(r.available),
            pending: formatAmount(r.pending),
          })),
        };
      }),
    );
}
