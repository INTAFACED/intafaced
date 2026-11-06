/**
 * Production wiring. Cancel goes through TradeService.cancelOrder as the
 * order's owner so the existing path releases the hold via ledger-client.
 */
import type { Sql } from 'postgres';
import type { AccountRef } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type { TradeService } from '../spot/trade-service.js';
import type { OwnerFeeSchedule } from '../spot/fee-schedule.js';
import type { OtcDeskLaw } from '../otc/desk-law.js';
import type { ApprovalBook } from './common.js';
import type { ConvertOwnerValues } from './fees-convert-desk.js';
import { TradeOpsAdmin } from './service.js';

/** A principal that may only read trading, for the operator's view of what Convert offers a customer. */
function reader(): Principal {
  return {
    sub: 'svc-trade:operator-read',
    userId: 'svc-trade:operator-read',
    scopes: ['trade:read'],
    tier: 'basic',
    mfa: false,
    sid: '00000000-0000-4000-8000-000000000002',
    expiresAt: new Date(Date.now() + 60_000),
  };
}

export function wireTradeOpsAdmin(deps: {
  sql: Sql;
  trade: Pick<TradeService, 'cancelOrder' | 'reconcileOrder' | 'listMarket' | 'convertPairs'>;
  ledger: { balance(ref: AccountRef): Promise<{ accountId: string; amount: bigint }> } | null;
  approvals: ApprovalBook;
  feeSchedule?: OwnerFeeSchedule;
  vipProofKey?: Buffer | null;
  otcLaw?: OtcDeskLaw;
  metricsWindowSeconds?: number | null;
  /** Convert's owner values; what Convert offers now is read from `trade` as a reader principal. */
  convert?: Omit<ConvertOwnerValues, 'pairs'>;
}): TradeOpsAdmin {
  return new TradeOpsAdmin({
    sql: deps.sql,
    ...(deps.otcLaw ? { otcLaw: deps.otcLaw } : {}),
    metricsWindowSeconds: deps.metricsWindowSeconds ?? null,
    ...(deps.convert ? { convert: { ...deps.convert, pairs: () => deps.trade.convertPairs(reader()) } } : {}),
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
