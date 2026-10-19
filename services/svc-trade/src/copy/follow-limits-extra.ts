/**
 * Follower limits the follow did not take yet (TRD-0676).
 *
 * Slippage uses COPYRESULT's divergence: follower limit price minus leader
 * fill price, in whole basis points, half away from zero. No tolerance and
 * no invented cap. A figure that cannot be computed refuses.
 *
 * Concurrency counts this follow's placed mirrors that are not terminal.
 * A missing or unreadable order state counts as open.
 *
 * Drawdown is peak result minus the current result. The peak moves only
 * when a new mirror is planned, in that same transaction. Existing
 * positions are not closed.
 */
import { formatAmount, parseAmount, sub, type Amount } from '@intafaced/ledger-client';
import { CopyError } from './errors.js';
import { mirrorDivergence } from './mirror-events.js';

export const SLIPPAGE_BPS_MIN = 1;
export const SLIPPAGE_BPS_MAX = 10_000;
/** Postgres integer. A storage bound, not a default cap. */
export const CONCURRENT_MAX = 2_147_483_647;

export const TERMINAL_MIRROR_ORDER_STATUSES: ReadonlySet<string> = new Set(['filled', 'cancelled', 'rejected', 'expired']);

export function mirrorOccupiesConcurrencySlot(status: string | null | undefined): boolean {
  if (status == null) return true;
  const trimmed = status.trim();
  if (!trimmed) return true;
  return !TERMINAL_MIRROR_ORDER_STATUSES.has(trimmed);
}

function present(raw: string | number | null | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed ? trimmed : undefined;
}

export function parseOptionalSlippageBps(raw: number | null | undefined, owner: 'follower' | 'leader'): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= SLIPPAGE_BPS_MIN && raw <= SLIPPAGE_BPS_MAX) return raw;
  throw new CopyError(
    `${owner} slippage cap must be an integer from ${SLIPPAGE_BPS_MIN} to ${SLIPPAGE_BPS_MAX}`,
    'trade.copy_envelope_invalid',
  );
}

export function parseOptionalConcurrent(raw: number | null | undefined, owner: 'follower' | 'leader'): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= CONCURRENT_MAX) return raw;
  throw new CopyError(`${owner} concurrency cap must be an integer of at least 1`, 'trade.copy_envelope_invalid');
}

export function parseOptionalDrawdown(raw: string | null | undefined, owner: 'follower' | 'leader'): Amount | undefined {
  const presentRaw = present(raw);
  if (!presentRaw) return undefined;
  let amount: Amount;
  try {
    amount = parseAmount(presentRaw);
  } catch {
    throw new CopyError(`${owner} drawdown limit must be a valid decimal amount`, 'trade.copy_envelope_invalid');
  }
  if (amount <= 0n) {
    throw new CopyError(`${owner} drawdown limit must be strictly positive`, 'trade.copy_envelope_invalid');
  }
  return amount;
}

/**
 * Copy places a spot limit. Any supplied leverage is a request this path
 * cannot perform. Blank means the caller did not ask for leverage.
 */
export function assertLeverageUnsupported(raw: string | number | null | undefined): void {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      throw new CopyError('maxLeverage must be a finite number', 'trade.copy_envelope_invalid');
    }
  } else if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new CopyError('maxLeverage must be a number or a decimal string', 'trade.copy_envelope_invalid');
  }
  if (present(raw) === undefined) return;
  throw new CopyError('Copy places spot limit orders only — leverage is unsupported', 'trade.copy_leverage_unsupported');
}

/**
 * Refuse when |basis points| is above the cap. Equal to the cap passes.
 * A missing leader price, or a zero leader price (basis points unset), refuses
 * rather than treating the divergence as zero.
 */
export function assertCopySlippage(input: {
  capBps: number | null | undefined;
  followerPrice: Amount;
  leaderPrice: Amount | null | undefined;
}): void {
  if (input.capBps === undefined || input.capBps === null) return;
  if (input.leaderPrice === undefined || input.leaderPrice === null) {
    throw new CopyError('Slippage cannot be evaluated: leaderFillPrice is missing', 'trade.copy_limit_unevaluable');
  }
  const divergence = mirrorDivergence(input.followerPrice, input.leaderPrice);
  if (divergence.basisPoints == null) {
    throw new CopyError(`Slippage cannot be evaluated: ${divergence.code ?? 'leaderFillPrice'} is missing`, 'trade.copy_limit_unevaluable');
  }
  const magnitude = divergence.basisPoints < 0n ? -divergence.basisPoints : divergence.basisPoints;
  if (magnitude > BigInt(input.capBps)) {
    throw new CopyError(
      `Mirror divergence ${magnitude.toString()} bps exceeds slippage cap ${input.capBps}`,
      'trade.copy_slippage_exceeded',
    );
  }
}

/** `openCount` includes unreadable orders. The new mirror is allowed only when the count is below the cap. */
export function assertCopyConcurrency(openCount: number, cap: number | null | undefined): void {
  if (cap === undefined || cap === null) return;
  if (!Number.isInteger(openCount) || openCount < 0) {
    throw new CopyError('Concurrency cannot be evaluated: orderState is missing', 'trade.copy_limit_unevaluable');
  }
  if (openCount >= cap) {
    throw new CopyError(`Open mirrored orders ${openCount} are not below the concurrency cap ${cap}`, 'trade.copy_concurrency_exceeded');
  }
}

/**
 * High-water mark. The first reading sets the peak to the current figure
 * (drawdown 0). A later reading stops when peak − current is at or above
 * the cap, and does not move the peak on that stop.
 */
export function drawdownDecision(peak: Amount | null, current: Amount, cap: Amount): { readonly peak: Amount; readonly stop: boolean } {
  const next = peak === null || current > peak ? current : peak;
  const drop = sub(next, current);
  if (drop >= cap) {
    return { peak: peak ?? current, stop: true };
  }
  return { peak: next, stop: false };
}

export function formatPeak(peak: Amount | null | undefined): string | null {
  return peak === undefined || peak === null ? null : formatAmount(peak);
}
