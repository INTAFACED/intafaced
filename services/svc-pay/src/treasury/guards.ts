import type { Sql } from 'postgres';
import { compare, parseAmount, type Amount } from '@intafaced/ledger-client';
import { PayGuardRefusal, type PartialPayGuards } from '../seams/guards.js';
import type { TreasuryLimits, TreasuryMode } from './config.js';
import { assetExposure, type ConversionInventorySource } from './exposure.js';
import { INTERNAL_RAIL } from '../withdrawals/internal.js';

/**
 * TREASURY EXPOSURE GUARDS (W5).
 *
 *   beforePayoutAdmit  adds the payout's amount to the asset's exposure
 *   beforeConversion   adds the conversion's from-amount to the from-asset's exposure
 *   beforeUserMoneyWithdrawal  adds the withdrawal's amount to the asset's exposure
 *                      (in-flight withdrawals already count in pending payouts, see
 *                      exposure.ts, so a limit that ignored a NEW one would be a hole)
 *
 * A fresh operation is refused when it would take exposure ABOVE the limit by even
 * one minor unit (1e-18); exactly AT the limit passes. No limit configured for
 * the asset = refused (`pay.guard_treasury_limit_unset`), never "unlimited".
 *
 * Exposure is a CAP: it is counted once, at admission. `beforePayoutExecute`,
 * replays and recoveries are never refused here (seams/guards.ts), because the
 * payout is already counted in the pending sum and refusing it would strand a hold.
 *
 * Concurrency: a per-asset advisory lock is taken inside the caller's transaction
 * and held until it commits, so two admissions cannot both read the same headroom.
 * (Taken after the merchant lock, in the guard step of the seam lock order, and before
 * any W9/W1 guard lock: the registry runs W5 first, so the order is fixed.) A caller
 * that passes a pool instead of a transaction gets no such protection; the
 * conversion path must pass its transaction.
 */

export const GUARD_TREASURY_LIMIT_UNSET = 'pay.guard_treasury_limit_unset' as const;
export const GUARD_TREASURY_EXCEEDED = 'pay.guard_treasury_exposure_exceeded' as const;
export const GUARD_TREASURY_INVENTORY_UNWIRED = 'pay.guard_treasury_inventory_unwired' as const;

export function createTreasuryGuards(deps: {
  /** `off` (the default): no limit enforcement at all. `required`: limits as described above. */
  mode: TreasuryMode;
  limits: TreasuryLimits;
  inventory: ConversionInventorySource;
}): PartialPayGuards {
  async function admit(conn: Sql, assetId: string, candidate: Amount, alreadyCounted: Amount = 0n): Promise<void> {
    const limit = deps.limits.byAsset.get(assetId);
    if (limit === undefined) throw new PayGuardRefusal(GUARD_TREASURY_LIMIT_UNSET, 'refused');
    await conn`SELECT pg_advisory_xact_lock(hashtext(${`pay.treasury:${assetId}`}))`;
    const current = await assetExposure(conn, assetId, deps.limits, deps.inventory);
    const total = (current.openConversionInventory ?? 0n) + current.pendingPayouts - alreadyCounted + candidate;
    if (compare(total, limit) > 0) throw new PayGuardRefusal(GUARD_TREASURY_EXCEEDED, 'refused');
  }

  async function admitWithdrawal(conn: Sql, ctx: { userId: string; clientRef: string; assetId: string; amount: Amount }): Promise<void> {
    if (deps.limits.byAsset.get(ctx.assetId) === undefined) throw new PayGuardRefusal(GUARD_TREASURY_LIMIT_UNSET, 'refused');
    // Take the lock first, then read the own row, so the read cannot go stale.
    await conn`SELECT pg_advisory_xact_lock(hashtext(${`pay.treasury:${ctx.assetId}`}))`;
    const own = await conn<Array<{ amount: string }>>`
      SELECT amount::text AS amount FROM pay.withdrawals
       WHERE user_id = ${ctx.userId} AND client_ref = ${ctx.clientRef} AND asset_id = ${ctx.assetId} AND status IN ('pending', 'held')
    `;
    await admit(conn, ctx.assetId, ctx.amount, own[0] ? parseAmount(own[0].amount) : 0n);
  }

  // Enforcement off: exposure stays readable, nothing here ever refuses.
  if (deps.mode === 'off') return {};

  return {
    beforePayoutAdmit: async (ctx) => {
      if (ctx.replay.kind !== 'fresh') return;
      await admit(ctx.tx, ctx.assetId, ctx.amount);
    },
    beforeConversion: async (ctx) => {
      if (ctx.replay.kind !== 'fresh') return;
      // An unwired source measured nothing, so it is not evidence of an empty book.
      if (!deps.inventory.wired) throw new PayGuardRefusal(GUARD_TREASURY_INVENTORY_UNWIRED, 'unavailable');
      await admit(ctx.tx, ctx.fromAsset, ctx.fromAmount);
    },
    beforeUserMoneyWithdrawal: async (ctx) => {
      if (ctx.replay.kind !== 'fresh') return;
      // An internal withdrawal (W-withdraw-14) moves value between two accounts inside the book: nothing leaves custody.
      if (ctx.rail === INTERNAL_RAIL) return;
      // A `pending` claim with no hold on the ledger is classified fresh but its row
      // is already in the pending sum. Take that row out so a retry does not count twice.
      await admitWithdrawal(ctx.tx, ctx);
    },
  };
}
