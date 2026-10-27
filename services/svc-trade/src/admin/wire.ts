/**
 * Production wiring. Cancel goes through TradeService.cancelOrder as the
 * order's owner so the existing path releases the hold via ledger-client.
 */
import type { Sql } from 'postgres';
import type { AccountRef } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type { TradeService } from '../spot/trade-service.js';
import type { OwnerFeeSchedule } from '../spot/fee-schedule.js';
import type { ApprovalBook } from './common.js';
import { TradeOpsAdmin } from './service.js';

export function wireTradeOpsAdmin(deps: {
  sql: Sql;
  trade: Pick<TradeService, 'cancelOrder' | 'reconcileOrder' | 'listMarket'>;
  ledger: { balance(ref: AccountRef): Promise<{ accountId: string; amount: bigint }> } | null;
  approvals: ApprovalBook;
  feeSchedule?: OwnerFeeSchedule;
  vipProofKey?: Buffer | null;
}): TradeOpsAdmin {
  return new TradeOpsAdmin({
    sql: deps.sql,
    ...(deps.feeSchedule ? { feeSchedule: deps.feeSchedule } : {}),
    vipProofKey: deps.vipProofKey ?? null,
    ledger: deps.ledger,
    approvals: deps.approvals,
    reconcileOrder: (orderId) => deps.trade.reconcileOrder(orderId),
    listMarket: (input) => deps.trade.listMarket(input),
    cancelOrder: async (orderId, userId) => {
      const owner: Principal = {
        sub: userId,
        userId,
        scopes: ['trade:write'],
        tier: 'basic',
        mfa: false,
        sid: '00000000-0000-4000-8000-000000000001',
        expiresAt: new Date(Date.now() + 60_000),
      };
      await deps.trade.cancelOrder(owner, orderId);
    },
  });
}
