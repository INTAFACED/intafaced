/**
 * Operator door that tops up the futures insurance fund (futures ADR 2026-10-20,
 * slice 4). It posts the existing `futuresInsuranceTopup` recipe, which moves
 * house trade fees into the fund. No other recipe, no inline entries.
 *
 * The amount is the operator's, with a second person's approval bound to the
 * asset, the amount and the reason. Nothing here picks a target size or a share
 * of fees; those stay with the owner (insurance fund funding policy ADR).
 *
 * The idempotency key is the operator's `clientRequestId`
 * (`futures.insurance.topup:<clientRequestId>`), so a retry posts once. If the
 * process dies after the approval is consumed and before the request is stored,
 * the retry finds the booked top-up on the ledger instead of failing on the
 * spent approval, and completes the record.
 */
import { z } from 'zod';
import type { Sql } from 'postgres';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { AuthError, type Principal } from '@intafaced/auth';
import {
  InsufficientFundsError,
  formatAmount,
  houseFees,
  parseAmount,
  recipes,
  type Amount,
  type LedgerClient,
  type LedgerTx,
} from '@intafaced/ledger-client';
import {
  consumeApproval,
  loadRequest,
  payloadHash,
  requireClientRequestId,
  requireOperatorWrite,
  requireReason,
  storeRequest,
  TradeOpsError,
  writeOperatorAudit,
  type ApprovalBook,
} from './common.js';

export interface InsuranceTopupDeps {
  readonly sql: Sql;
  readonly approvals: ApprovalBook;
  /** The ledger this service posts through. Null when no ledger is wired: the door refuses. */
  readonly ledger: Pick<LedgerClient, 'post' | 'getTxByKey' | 'balance'> | null;
  readonly now?: () => Date;
}

export interface InsuranceTopupResult {
  readonly assetId: string;
  readonly amount: string;
  readonly topupId: string;
  readonly txId: string;
}

const ACTION_TYPE = 'trade.insurance_topup';

/** A positive exact decimal with at most 18 places. A zero, a float or a blank refuses. */
function requireAmount(value: string): Amount {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(trimmed)) {
    throw new TradeOpsError('insurance_topup_amount_invalid', 'amount must be an exact positive decimal string');
  }
  const amount = parseAmount(trimmed);
  if (amount <= 0n) throw new TradeOpsError('insurance_topup_amount_invalid', 'amount must be an exact positive decimal string');
  return amount;
}

function requireAsset(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(trimmed)) {
    throw new TradeOpsError('insurance_topup_asset_invalid', 'asset is required (the margin asset of the market)');
  }
  return trimmed;
}

/** True when `tx` is the top-up this request books: same reason, same top-up id, this amount in this asset. */
function bookedThisTopup(tx: LedgerTx, topupId: string, assetId: string, amount: Amount): boolean {
  return (
    tx.reason === 'futures.insurance.topup' &&
    tx.meta.topupId === topupId &&
    tx.entries.some((entry) => entry.assetId === assetId && entry.direction === 'debit' && entry.amount === amount)
  );
}

export class InsuranceTopupAdmin {
  constructor(private readonly deps: InsuranceTopupDeps) {}

  async topup(
    principal: Principal,
    input: { assetId: string; amount: string; reason: string; approvalId: string; clientRequestId: string },
  ): Promise<InsuranceTopupResult> {
    requireOperatorWrite(principal);
    const reason = requireReason(input.reason);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const assetId = requireAsset(input.assetId);
    const amount = requireAmount(input.amount);
    const ledger = this.deps.ledger;
    if (!ledger) throw new TradeOpsError('insurance_topup_unwired', 'no ledger is wired on this process');

    const amountText = formatAmount(amount);
    const fingerprint = payloadHash({ kind: 'insurance_topup', assetId, amount: amountText, reason });
    const prior = await loadRequest(this.deps.sql, clientRequestId, 'insurance_topup', fingerprint);
    if (prior) return prior as InsuranceTopupResult;

    // Refuse before the approval is spent, so a short fees pot does not burn a second person's approval.
    // The ledger's own non-negative check still decides at post time.
    const request = recipes.futuresInsuranceTopup({ topupId: clientRequestId, assetId, amount });
    const alreadyBooked = await ledger.getTxByKey(request.idempotencyKey);
    if (!alreadyBooked) {
      const source = await ledger.balance(houseFees('trade', assetId));
      if (source.amount < amount) {
        throw new TradeOpsError('insurance_topup_source_short', 'the trade fees pot does not hold this amount');
      }
    }
    let approverId: string | null = null;
    let booked: LedgerTx | null = null;
    try {
      const consumed = await consumeApproval(this.deps.approvals, {
        approvalId: input.approvalId,
        actionType: ACTION_TYPE,
        targetId: assetId,
        expectedVersion: '0',
        payloadHash: payloadHash({ actionType: ACTION_TYPE, assetId, amount: amountText, reason }),
        operationId: clientRequestId,
      });
      approverId = consumed.approverId;
    } catch (error) {
      // The approval was spent by an earlier attempt of this same request that died before it stored its record.
      // Only a top-up already booked under this request's key and amount is accepted as that attempt.
      if (!(error instanceof TradeOpsError) || error.code !== 'approval_reused') throw error;
      if (!alreadyBooked || !bookedThisTopup(alreadyBooked, clientRequestId, assetId, amount)) throw error;
      booked = alreadyBooked;
    }

    if (!booked) {
      try {
        booked = await ledger.post(request);
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          throw new TradeOpsError('insurance_topup_source_short', 'the trade fees pot does not hold this amount');
        }
        throw error;
      }
    }
    if (!bookedThisTopup(booked, clientRequestId, assetId, amount)) {
      throw new TradeOpsError('insurance_topup_reply_mismatch', 'the ledger answered with a different movement than the one sent');
    }

    const result: InsuranceTopupResult = { assetId, amount: amountText, topupId: clientRequestId, txId: booked.id };
    await storeRequest(this.deps.sql, clientRequestId, 'insurance_topup', fingerprint, result);
    await writeOperatorAudit(
      this.deps.sql,
      {
        kind: 'insurance.topup',
        operatorId: principal.userId,
        accountId: null,
        objectId: assetId,
        approverId,
        reason,
        detail: { amount: amountText, topupId: clientRequestId, txId: booked.id },
      },
      this.deps.now?.() ?? new Date(),
    );
    return result;
  }
}

function fail(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  if (error instanceof AuthError) {
    throw new TRPCError({ code: error.code === 'mfa.required' ? 'UNAUTHORIZED' : 'FORBIDDEN', message: error.message, cause: error });
  }
  if (error instanceof TradeOpsError) throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause: error });
}

/** `admin.insurance.topup`, merged into the trade operator desk's `admin` router. */
export function insuranceAdminRouter(admin?: InsuranceTopupAdmin) {
  const operatorWrite = scopedProcedure('admin:write');
  return router({
    insurance: router({
      topup: operatorWrite
        .input(
          z
            .object({
              assetId: z.string().trim().min(1).max(32),
              amount: z.string().trim().min(1).max(64),
              reason: z.string().trim().min(3).max(500),
              approvalId: z.string().trim().min(1).max(128),
              clientRequestId: z.string().trim().min(1).max(128),
            })
            .strict(),
        )
        .mutation(({ ctx, input }) => {
          if (!admin) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'insurance_topup_unconfigured' });
          return admin.topup(ctx.principal, input).catch(fail);
        }),
    }),
  });
}
