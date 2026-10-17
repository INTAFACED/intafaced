/** Statuses a screening case is allowed to store. Unknown is not one of them. */
export const SCREENING_CASE_STATUSES = ['clear', 'review', 'refuse', 'unavailable'] as const;
export type ScreeningCaseStatus = (typeof SCREENING_CASE_STATUSES)[number];

export interface ScreeningFactor {
  readonly code: string;
}

export interface ScreeningAnswer {
  readonly category: string;
  readonly factors?: readonly ScreeningFactor[];
}

export interface ScreeningDecision {
  readonly status: ScreeningCaseStatus;
  readonly factors: readonly ScreeningFactor[];
}

const FACTOR_CODE = /^[a-z0-9_]{1,64}$/;
const STATUS = new Set<string>(SCREENING_CASE_STATUSES);

function factor(code: string): ScreeningFactor {
  if (!FACTOR_CODE.test(code)) return { code: 'unknown' };
  return { code };
}

/**
 * Map one screener answer onto a case. A missing answer, an unknown category,
 * or a category outside the four stored statuses is unavailable, never clear.
 */
export function screeningCaseFromAnswer(answer: ScreeningAnswer | null | undefined): ScreeningDecision {
  if (answer == null) return { status: 'unavailable', factors: [factor('no_result')] };
  if (!STATUS.has(answer.category)) return { status: 'unavailable', factors: [factor('unknown')] };
  const status = answer.category as ScreeningCaseStatus;
  const provided = (answer.factors ?? []).filter((item) => FACTOR_CODE.test(item.code)).map((item) => factor(item.code));
  return { status, factors: provided.length > 0 ? provided : [factor(`provider_${status}`)] };
}

/**
 * A blank list is not a supplier. It cannot confirm clear, review, or refuse.
 * The case stays unavailable until a counsel-grade list exists.
 */
export function applyListPosture(decision: ScreeningDecision, posture: 'blank' | 'named'): ScreeningDecision {
  if (posture === 'named') return decision;
  const factors = decision.factors.filter((item) => item.code !== 'provider_clear').map((item) => factor(item.code));
  if (!factors.some((item) => item.code === 'blank_list')) factors.push(factor('blank_list'));
  return { status: 'unavailable', factors };
}
