import type { Sql } from 'postgres';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import type { FundsPort, FundsReading } from '../funds.js';
import type { UsagePaymentPort } from '../payment/usage-payment.js';

/**
 * What covers a run before it starts (OWNER 107), team runs included (J-agents-11). A business team's run is paid by
 * the business, so it is covered by what the business's payment method reports (svc-bank, read with the session's
 * business), never by the member's own money: a business with no payment method covers nothing, and a partner figure
 * not reported is unread, never 0. On the custodial layer the member's own ledger balance covers it, as their fee charge
 * is what pays it. Every other session reads the person's own payment method, as before (`own`).
 */
export function teamFunds(deps: {
  readonly sql: Sql;
  readonly payment: UsagePaymentPort;
  readonly ledger: (userId: string, assetId: string) => Promise<Amount>;
  readonly own: FundsPort;
}): FundsPort {
  return {
    async available(userId, assetId, agentId, sessionId): Promise<Amount | FundsReading> {
      const [team] = sessionId
        ? await deps.sql<Array<{ business_id: string }>>`
            SELECT business_id::text FROM agents.team_sessions WHERE session_id = ${sessionId}
          `
        : [];
      if (!team) return deps.own.available(userId, assetId, agentId, sessionId);
      const held = await deps.payment.read(userId, assetId, team.business_id);
      if (held.heldBy === 'none') return 0n;
      if (held.heldBy === 'partner') {
        if (held.available === null) throw new Error("the partner has not reported the business's balance");
        return parseAmount(held.available);
      }
      return deps.ledger(userId, assetId);
    },
  };
}
