import type { Sql } from 'postgres';
import { compare, type Amount } from '@intafaced/ledger-client';
import { PayGuardRefusal, type PartialPayGuards } from '../seams/guards.js';
import type { TreasuryLimits } from './config.js';
import { assetExposure, type ConversionInventorySource } from './exposure.js';

/**
 * TREASURY EXPOSURE GUARDS (W5).
 *
 *   beforePayoutAdmit  adds the payout's amount to the asset's exposure
 *   beforeConversion   adds the conversion's from-amount to the from-asset's exposure
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
 * (Taken last, after the merchant lock, as the seam lock order requires.) A caller
 * that passes a pool instead of a transaction gets no such protection; the
 * conversion path must pass its transaction.
 */

export const GUARD_TREASURY_LIMIT_UNSET = 'pay.guard_treasury_limit_unset' as const;
export const GUARD_TREASURY_EXCEEDED = 'pay.guard_treasury_exposure_exceeded' as const;
export const GUARD_TREASURY_INVENTORY_UNWIRED = 'pay.guard_treasury_inventory_unwired' as const;

export function createTreasuryGuards(deps: { limits: TreasuryLimits; inventory: ConversionInventorySource }): PartialPayGuards {
  async function admit(conn: Sql, assetId: string, candidate: Amount): Promise<void> {
    const limit = deps.limits.byAsset.get(assetId);
    if (limit === undefined) throw new PayGuardRefusal(GUARD_TREASURY_LIMIT_UNSET, 'refused');
    await conn`SELECT pg_advisory_xact_lock(hashtext(${`pay.treasury:${assetId}`}))`;
    const current = await assetExposure(conn, assetId, deps.limits, deps.inventory);
    const total = current.openConversionInventory + current.pendingPayouts + candidate;
    if (compare(total, limit) > 0) throw new PayGuardRefusal(GUARD_TREASURY_EXCEEDED, 'refused');
  }

  return {
    beforePayoutAdmit: async (ctx) => {
      if (ctx.replay.kind !== 'fresh') return;
      await admit(ctx.tx, ctx.assetId, ctx.amount);
    },
    beforeConversion: async (ctx) => {
      if (ctx.replay.kind !== 'fresh') return;
      // The zero from an unwired source is not evidence of an empty book.
      if (!deps.inventory.wired) throw new PayGuardRefusal(GUARD_TREASURY_INVENTORY_UNWIRED, 'unavailable');
      await admit(ctx.sql, ctx.fromAsset, ctx.fromAmount);
    },
  };
}
