/**
 * The bank's part of the Home work list (HM-dashboard-03): `workItems.list` answers the signed person's bank kinds,
 * derived from svc-bank's own records and never stored. A row exists while its record says so and is gone when the record
 * is resolved.
 *
 * - `margin_health:<loan id>`: an open loan of theirs with an open margin call. In a margin call the borrower is the only one
 *   who can cure it (`action`, due when the call's grace ends, with the collateral to post and the loan-to-value the call
 *   was raised at). Once the loan is liquidating it is `warning`. A loan that is only drifting towards its call band would
 *   need the margin warning level, an owner value with no value yet: while it is blank Home shows no such item and no
 *   error (`BANK_MARGIN_WARNING_UNSET` is for the settings desk only), so only loans already in a call are listed.
 * - `loan_payment_due`: never listed. The crypto-backed loan has no repayment schedule or due date
 *   (`loan-servicing-preview.ts`), so there is no record a payment could be due on, and none is invented.
 * - `card_frozen:<card id>`: a card of theirs that is frozen. Frozen by them, only they can lift it (`action`); frozen by
 *   the bank, they wait on the bank (`info`). A freeze with no recorded actor (cards frozen before migration 0040) is
 *   theirs to lift too. The reason code names who froze it, when that is recorded.
 *
 * The bank sends copy keys and record values, never sentences, and links only into its own rooms (`/bank`).
 */
import type { Sql } from 'postgres';
import { router, scopedProcedure, TRPCError, workItemsOutputSchema, type WorkItem, type WorkItemsOutput } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';

type MarginRow = {
  loan_id: string;
  status: 'active' | 'margin_call' | 'liquidating';
  collateral_asset_id: string;
  ltv_bps: number;
  cure_collateral_amount: string;
  grace_expires_at: Date;
};

type FrozenCardRow = { id: string; frozen_by: string | null };

/** Basis points as the contract's ratio, where 1 is 100%: 8500 is "0.85". */
export function bpsRatio(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps < 0) throw new Error(`Not a basis-point value: ${bps}`);
  const whole = Math.floor(bps / 10_000);
  const part = String(bps % 10_000)
    .padStart(4, '0')
    .replace(/0+$/, '');
  return part ? `${whole}.${part}` : String(whole);
}

export function marginItem(row: MarginRow): WorkItem {
  // A call written just before its loan's status moved is still a call: only liquidation changes what is owed.
  const calling = row.status !== 'liquidating';
  return {
    id: `margin_health:${row.loan_id}`,
    kind: 'margin_health',
    source: 'bank',
    severity: calling ? 'action' : 'warning',
    titleKey: calling ? 'bank.margin.call_open' : 'bank.margin.liquidating',
    link: '/bank/loans',
    dueAt: row.grace_expires_at.toISOString(),
    amount: { value: formatAmount(parseAmount(row.cure_collateral_amount)), asset: row.collateral_asset_id },
    ratio: bpsRatio(row.ltv_bps),
  };
}

export function frozenCardItem(row: FrozenCardRow): WorkItem {
  // Only a freeze the bank made is out of the owner's hands; one with no recorded actor (before 0040) is theirs to lift.
  const byBank = row.frozen_by === 'operator';
  return {
    id: `card_frozen:${row.id}`,
    kind: 'card_frozen',
    source: 'bank',
    severity: byBank ? 'info' : 'action',
    titleKey: byBank ? 'bank.card.frozen_by_bank' : row.frozen_by === 'owner' ? 'bank.card.frozen_by_you' : 'bank.card.frozen',
    link: '/bank/cards',
    ...(row.frozen_by === 'owner' || row.frozen_by === 'operator' ? { reasonCode: `bank.card_frozen_by_${row.frozen_by}` } : {}),
  };
}

export async function listBankWorkItems(sql: Sql, userId: string): Promise<WorkItemsOutput> {
  const [margins, cards] = await Promise.all([
    // The newest open call of each open loan. A cured call has `cleared_at`; a repaid or liquidated loan is closed.
    sql<MarginRow[]>`
      SELECT DISTINCT ON (l.id)
             l.id AS loan_id, l.status, l.collateral_asset_id, c.ltv_bps, c.cure_collateral_amount::text, c.grace_expires_at
        FROM bank.loans l
        JOIN bank.loan_margin_calls c ON c.loan_id = l.id AND c.cleared_at IS NULL
       WHERE l.user_id = ${userId} AND l.status IN ('active', 'margin_call', 'liquidating')
       ORDER BY l.id, c.sequence DESC
    `,
    sql<FrozenCardRow[]>`
      SELECT id, frozen_by FROM bank.cards WHERE user_id = ${userId} AND status = 'frozen' ORDER BY created_at, id
    `,
  ]);
  const items = [
    ...margins.sort((a, b) => a.grace_expires_at.getTime() - b.grace_expires_at.getTime()).map(marginItem),
    ...cards.map(frozenCardItem),
  ];
  return workItemsOutputSchema.parse({ items: items.slice(0, 100) });
}

/**
 * `workItems.list` (WORK_ITEMS_PROCEDURE) for the signed person: only the bank's own kinds, empty when nothing is owed.
 * An API key or a sub-account has no Home of its own, as identity's answer says too.
 */
export function createWorkItemsRouter(sql: () => Sql, guard: <T>(fn: () => Promise<T>) => Promise<T>) {
  return router({
    list: scopedProcedure('bank:read', { module: 'bank' })
      .output(workItemsOutputSchema)
      .query(({ ctx }) => {
        const principal = ctx.principal;
        if (principal.kid || principal.sub_account) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Sign in on this device to see what needs you [bank.work_items_delegated]' });
        }
        return guard(() => listBankWorkItems(sql(), principal.userId));
      }),
  });
}
