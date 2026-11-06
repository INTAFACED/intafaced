/**
 * What a trader reads about a perpetual's funding (J-derivatives-08; derivatives-market-data-api-009, -010, -011).
 *
 * - `presentFundingRate`: the rate in force and every input it was built from (premium, interest component, cap, the
 *   mark and index the period closed on), when the next one is due, the index as it stands now, and the latest computed
 *   period whatever its outcome. A refused or paused period says why; nothing here turns a missing number into zero.
 * - `annualisedRate`: the period rate times the periods in a 365-day year, exact.
 *
 * Pure: the host reads the snapshot (`FuturesJobsHandle.fundingSnapshot`) and the S2S rate book, and passes them in.
 */
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { FundingRatePeriodRecord } from './funding-rate-computer.js';
import type { FundingRateEntry } from './funding-rate-source.js';
import type { FundingSnapshot } from './futures-jobs.js';

const YEAR_SECONDS = 365 * 86_400;

export interface FundingRateView {
  readonly fundingRate: string;
  readonly fundingTimestamp: number;
  readonly fundingDatetime: string;
  readonly nextFundingTimestamp: number | null;
  /** The mark now (CCXT `markPrice`). */
  readonly markPrice: string | null;
  /** The index now (CCXT `indexPrice`); null when there is none, with the reason in `indexNow`. */
  readonly indexPrice: string | null;
  /** The mark and index the published period closed on: what its rate was built from. Null for an S2S rate. */
  readonly periodMarkPrice: string | null;
  readonly periodIndexPrice: string | null;
  readonly periodId: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly premium: string | null;
  /** The owner's base (interest) component added to the premium. */
  readonly interestComponent: string | null;
  readonly cap: string | null;
  readonly clamped: boolean | null;
  readonly annualisedRate: string | null;
  readonly indexNow: { readonly price: string | null; readonly reason: string | null };
  readonly lastPeriod: {
    readonly periodId: string;
    readonly status: FundingRatePeriodRecord['status'];
    readonly code: string | null;
    readonly periodStart: string | null;
    readonly periodEnd: string | null;
  } | null;
}

/** Rate times the periods in a 365-day year. Null when the period length is unknown or does not divide a year. */
export function annualisedRate(rate: string, periodSeconds: number | null): string | null {
  if (periodSeconds == null || periodSeconds <= 0 || YEAR_SECONDS % periodSeconds !== 0) return null;
  return formatAmount(parseAmount(rate) * BigInt(YEAR_SECONDS / periodSeconds));
}

/** Seconds between a period's start and end, or null when either is missing. */
export function periodLengthSeconds(record: Pick<FundingRatePeriodRecord, 'periodStart' | 'periodEnd'>): number | null {
  if (!record.periodStart || !record.periodEnd) return null;
  const ms = Date.parse(record.periodEnd) - Date.parse(record.periodStart);
  return Number.isFinite(ms) && ms > 0 && ms % 1000 === 0 ? ms / 1000 : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function presentFundingRate(input: {
  readonly snapshot: FundingSnapshot;
  readonly s2s: FundingRateEntry | null;
  readonly liveMark: string | null;
}): FundingRateView | null {
  const { snapshot } = input;
  const last = snapshot.last
    ? {
        periodId: snapshot.last.periodId,
        status: snapshot.last.status,
        code: snapshot.last.code,
        periodStart: snapshot.last.periodStart,
        periodEnd: snapshot.last.periodEnd,
      }
    : null;
  const p = snapshot.published;
  if (p && p.rate != null && p.periodEnd) {
    const endMs = Date.parse(p.periodEnd);
    const length = periodLengthSeconds(p);
    return {
      fundingRate: p.rate,
      fundingTimestamp: endMs,
      fundingDatetime: p.periodEnd,
      // The end of the period open now, on the owner's grid; unknown when the grid is blank.
      nextFundingTimestamp: snapshot.nextBoundaryMs,
      markPrice: input.liveMark,
      indexPrice: snapshot.indexNow.price,
      periodMarkPrice: text(p.inputs.closingMark),
      periodIndexPrice: text(p.inputs.closingIndex),
      periodId: p.periodId,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      premium: p.premium,
      interestComponent: p.baseComponent,
      cap: p.cap,
      clamped: p.clamped,
      annualisedRate: annualisedRate(p.rate, length),
      indexNow: snapshot.indexNow,
      lastPeriod: last,
    };
  }
  const e = input.s2s;
  if (!e) return null;
  return {
    fundingRate: e.rate,
    fundingTimestamp: e.asOfMs,
    fundingDatetime: new Date(e.asOfMs).toISOString(),
    nextFundingTimestamp: null,
    markPrice: input.liveMark,
    indexPrice: null,
    periodMarkPrice: null,
    periodIndexPrice: null,
    periodId: e.periodId,
    periodStart: null,
    periodEnd: e.periodEndIso ?? null,
    premium: null,
    interestComponent: null,
    cap: null,
    clamped: null,
    annualisedRate: null,
    indexNow: snapshot.indexNow,
    lastPeriod: last,
  };
}
