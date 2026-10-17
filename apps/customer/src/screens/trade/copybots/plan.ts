// The TWAP slice plan the customer sees before they start. It repeats the service's own split (svc-trade
// algo/schedule.ts): N = floor(duration / interval), at least 1; equal slices, the last takes the remainder; each
// slice snaps down to the market's lot; what cannot form a lot is dropped and shown as "left out". Exact decimals only.
import { dec, str, type Scaled } from '../../../data/decimal';

export type PlanInput = { totalQty: string; durationMs: number; sliceIntervalMs: number; lotSize: string };
export type PlanFailure = 'qty' | 'schedule' | 'tooLong' | 'belowLot';
export type Plan =
  { ok: true; slices: number; perSlice: string; lastSlice: string; planned: string; leftOut: string } | { ok: false; why: PlanFailure };

export const MIN_DURATION_MS = 60_000;
export const MAX_DURATION_MS = 86_400_000;

export function planSlices(input: PlanInput): Plan {
  const total = dec(input.totalQty);
  const lot = dec(input.lotSize);
  if (total === null || total <= 0n || lot === null || lot <= 0n) return { ok: false, why: 'qty' };
  const { durationMs, sliceIntervalMs } = input;
  if (!Number.isInteger(durationMs) || !Number.isInteger(sliceIntervalMs) || durationMs <= 0 || sliceIntervalMs <= 0) {
    return { ok: false, why: 'schedule' };
  }
  if (sliceIntervalMs > durationMs) return { ok: false, why: 'schedule' };
  if (durationMs > MAX_DURATION_MS) return { ok: false, why: 'tooLong' };
  const n = Math.max(1, Math.floor(durationMs / sliceIntervalMs));
  const count = BigInt(n);
  const base = total / count;
  const last = base + (total % count);
  const snap = (q: Scaled) => q - (q % lot);
  const first = snap(base);
  const end = snap(last);
  const kept = [...Array<Scaled>(n - 1).fill(first), end].filter((q) => q > 0n);
  if (kept.length === 0) return { ok: false, why: 'belowLot' };
  const planned = kept.reduce((sum, q) => sum + q, 0n);
  return { ok: true, slices: kept.length, perSlice: str(first), lastSlice: str(end), planned: str(planned), leftOut: str(total - planned) };
}

/** "10", "1.5" minutes to milliseconds; null for anything that is not a whole number of seconds >= 1. */
export function minutesToMs(minutes: string): number | null {
  const parsed = dec(minutes);
  if (parsed === null || parsed <= 0n) return null;
  const SCALE = 10n ** 18n;
  const ms = (parsed * 60_000n) / SCALE;
  if ((parsed * 60_000n) % SCALE !== 0n) return null;
  return ms > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(ms);
}

export function formatClock(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : '', s && !h ? `${s} s` : ''].filter(Boolean).join(' ') || '0 s';
}
