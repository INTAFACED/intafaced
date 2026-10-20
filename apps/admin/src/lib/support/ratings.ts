/**
 * Satisfaction ratings for the requests solved in a stated window: the strict reader for svc-support's `ratingSummary`
 * and the plain-words figures the card shows.
 *
 * The caller states the window; the service has no default. With no ratings the card shows zero responses and no
 * average or percentage, never a guessed figure. A share is shown only when the service sent one.
 */

export const SCORES = ['1', '2', '3', '4', '5'] as const;
export type ScoreKey = (typeof SCORES)[number];

export interface SupportRatingSummary {
  readonly from: string;
  readonly to: string;
  readonly solved: number;
  readonly responses: number;
  readonly perScore: Readonly<Record<ScoreKey, number>>;
  /** Basis points (10 000 = all of them). Null when no request was solved in the window. */
  readonly ratedShareBasisPoints: number | null;
}

/** The windows the card offers. A window is a view the person picks; it is not a policy value. */
export const WINDOW_DAYS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];
const DAY_MS = 86_400_000;

export function ratingWindow(days: WindowDays, now: Date): { readonly from: string; readonly to: string } {
  return { from: new Date(now.getTime() - days * DAY_MS).toISOString(), to: now.toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function readRatingSummary(raw: unknown): SupportRatingSummary | null {
  if (!isRecord(raw)) return null;
  const { from, to, solved, responses, perScore, ratedShareBasisPoints } = raw;
  if (!instant(from) || !instant(to) || !count(solved) || !count(responses) || !isRecord(perScore)) return null;
  const scores = {} as Record<ScoreKey, number>;
  let total = 0;
  for (const key of SCORES) {
    const n = perScore[key];
    if (!count(n)) return null;
    scores[key] = n;
    total += n;
  }
  if (total !== responses || responses > solved) return null;
  if (ratedShareBasisPoints === null) {
    if (solved !== 0) return null;
  } else if (!count(ratedShareBasisPoints) || ratedShareBasisPoints > 10_000) {
    return null;
  }
  return { from, to, solved, responses, perScore: scores, ratedShareBasisPoints };
}

/** "66.6%" from basis points, cut (never rounded up) to one decimal. Null shows as a dash, not 0%. */
export function formatShare(basisPoints: number | null): string {
  if (basisPoints === null) return '—';
  return `${Math.floor(basisPoints / 10) / 10}%`;
}

/** The average score with one decimal, or null with no responses: an average of nothing is not shown. */
export function averageScore(summary: SupportRatingSummary): string | null {
  if (summary.responses === 0) return null;
  let sum = 0;
  for (const key of SCORES) sum += Number(key) * summary.perScore[key];
  return (Math.floor((sum * 10) / summary.responses) / 10).toFixed(1);
}
