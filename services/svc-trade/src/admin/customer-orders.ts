/**
 * One customer's orders for the console's customer record (OPS-founder-01, J-ops-console-02 #3: the trade tab).
 *
 * Read only: the orders the customer's own list shows, newest first, each in the support trade summary's narrowed view
 * (`toSupportOrder`: id, market, side, type, status, quantity, filled, limit price, reject code, when). No fill price, fee,
 * client order id or position is added. The operator needs the desk read scope (`admin:read`) and the customer lookup
 * scope (`support:lookup`), as the copy, bots and OTC lookup does.
 *
 * Audited like that lookup: one `trade.operator_audit` row (kind `customer_orders.read`) in the same repeatable-read
 * transaction as the read, written before anything is returned, with an id derived from operator, customer, page size and
 * the read's instant. When the row cannot be written nothing is served.
 *
 * The page size is the caller's, 1 to 200, never defaulted. `truncated` says an older order exists beyond the page.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { requireScope, type Principal } from '@intafaced/auth';
import type { SupportTradeOrder } from '@intafaced/contracts';
import { selectCustomerOrders, toSupportOrder } from '../support/trade-summary.js';
import { COPY_LOOKUP_SCOPE } from './copy-bots-otc.js';
import { requireOperator, writeOperatorAudit } from './common.js';

export const CUSTOMER_ORDERS_AUDIT_KIND = 'customer_orders.read' as const;

/** The audit id of one read: a UUID derived from what the read was, never random. */
export function customerOrdersAuditId(input: { operatorId: string; userId: string; limit: number; readAt: string }): string {
  const key = [CUSTOMER_ORDERS_AUDIT_KIND, input.operatorId, input.userId, String(input.limit), input.readAt].join('|');
  const bytes = Buffer.from(createHash('sha256').update(key).digest().subarray(0, 16));
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface CustomerOrders {
  readonly userId: string;
  readonly readAt: string;
  readonly orders: SupportTradeOrder[];
  readonly truncated: boolean;
}

export class CustomerOrdersAdmin {
  constructor(private readonly deps: { readonly sql: Sql; readonly now: () => Date }) {}

  async read(principal: Principal, input: { userId: string; limit: number }): Promise<CustomerOrders> {
    requireOperator(principal);
    requireScope(principal, COPY_LOOKUP_SCOPE);
    const readAt = this.deps.now();
    const auditId = customerOrdersAuditId({
      operatorId: principal.userId,
      userId: input.userId,
      limit: input.limit,
      readAt: readAt.toISOString(),
    });
    return this.deps.sql.begin('isolation level repeatable read', async (tx) => {
      const rows = await selectCustomerOrders(tx, input.userId, input.limit + 1);
      const page = rows.slice(0, input.limit);
      await writeOperatorAudit(
        tx,
        {
          id: auditId,
          kind: CUSTOMER_ORDERS_AUDIT_KIND,
          operatorId: principal.userId,
          accountId: input.userId,
          objectId: input.userId,
          approverId: null,
          reason: null,
          detail: { limit: input.limit, orders: page.length, truncated: rows.length > input.limit },
        },
        readAt,
      );
      return {
        userId: input.userId,
        readAt: readAt.toISOString(),
        orders: page.map(toSupportOrder),
        truncated: rows.length > input.limit,
      };
    });
  }
}
