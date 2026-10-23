/**
 * The confirm step before an order moves a position into a higher margin tier (D-orders-10, J-derivatives-02 #6).
 *
 * The owner's ladder rates a position by its notional as a share of the book depth it would close into
 * (`maintenance-ladder.ts`), and a higher tier carries a higher maintenance rate, so the same leverage sits nearer its
 * liquidation price. An opening order that would carry the position (with the side's live opening orders, which can
 * still fill into it) above the tier it sits in now, or above the first tier for a new position, is refused
 * `trade.risk_limit_confirm_required` until the trader names that tier back in `confirmTier`. Nothing is held or
 * stored by the refusal; the same request with `confirmTier` goes ahead.
 *
 * The acknowledgement travels on the order rather than being stored on the position: the ladder is keyed on depth,
 * so the tier a size lands in moves with the book, and an acknowledgement kept from an earlier order would vouch for
 * a tier the trader never saw. `confirmTier` names the highest tier the trader has accepted; a projection above it
 * asks again.
 *
 * The ladder publishes no leverage of its own (`GET /api/v1/futures/tiers`), so every tier answers to the listing
 * cap, and the refusal names the order's leverage and that cap rather than inventing a per-tier figure.
 */
import { formatAmount, mul, type Amount } from '@intafaced/ledger-client';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';
import { tierOf } from './risk-calculator.js';

export const RISK_LIMIT_CONFIRM_REQUIRED = 'trade.risk_limit_confirm_required';
export const CONFIRM_TIER_INVALID = 'trade.confirm_tier_invalid';

export interface RiskTierCrossing {
  /** The tier the side's position and live opening orders sit in now; null when there are none. */
  readonly currentTier: number | null;
  /** The tier they would sit in with this order. */
  readonly projectedTier: number;
  /** The projected tier's maintenance rate, in bps of notional. */
  readonly maintenanceBps: number;
  /** The projected notional at the mark, rounded up as the ladder rates it. */
  readonly notional: Amount;
  /** True when the projected tier is above the current one (above tier 1 when there is nothing yet). */
  readonly confirmRequired: boolean;
}

/**
 * Rates the side's exposure before and after the order at one mark against one depth, as the liquidation tick would.
 * `exposure` is the position's size plus what the side's live opening orders can still fill, in base units.
 */
export function tierCrossing(input: {
  readonly policy: FuturesLadderPolicy;
  readonly depthNotional: Amount;
  readonly mark: Amount;
  readonly exposure: Amount;
  readonly qty: Amount;
}): RiskTierCrossing {
  const currentTier = input.exposure > 0n ? tierOf(mul(input.exposure, input.mark, 'ceil'), input.depthNotional, input.policy).tier : null;
  const notional = mul((input.exposure + input.qty) as Amount, input.mark, 'ceil');
  const projected = tierOf(notional, input.depthNotional, input.policy);
  return {
    currentTier,
    projectedTier: projected.tier,
    maintenanceBps: projected.maintenanceBps,
    notional,
    confirmRequired: projected.tier > (currentTier ?? 1),
  };
}

/** `confirmTier` as sent: absent, or a whole number from 1. Anything else is malformed. */
export function readConfirmTier(value: unknown): { ok: true; tier: number | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, tier: undefined };
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return { ok: false };
  return { ok: true, tier: value };
}

/** Basis points as a percentage with two places, for the refusal's words (250 → "2.50%"). */
function bpsPercent(bps: number): string {
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;
}

/** The refusal an order meets when it crosses into a tier the trader has not named, or null. */
export function unconfirmedTierRefusal(
  crossing: RiskTierCrossing,
  confirmTier: number | undefined,
  leverage: Amount,
  leverageCap: Amount | null,
): { code: string; message: string } | null {
  if (!crossing.confirmRequired || (confirmTier !== undefined && confirmTier >= crossing.projectedTier)) return null;
  const from = crossing.currentTier === null ? 'opens the position in' : `moves the position from tier ${crossing.currentTier} into`;
  const cap = leverageCap === null ? 'the listing cap is unset' : `every tier answers to the listing cap of ${formatAmount(leverageCap)}x`;
  return {
    code: RISK_LIMIT_CONFIRM_REQUIRED,
    message:
      `this order ${from} tier ${crossing.projectedTier} (maintenance ${bpsPercent(crossing.maintenanceBps)}) at ` +
      `${formatAmount(leverage)}x leverage; ${cap}. Send confirmTier ${crossing.projectedTier} to place it`,
  };
}
