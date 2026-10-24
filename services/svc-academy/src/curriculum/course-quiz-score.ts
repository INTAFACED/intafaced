/**
 * AC-quizzes-02 — how one answer to a course quiz question scores, and whether an answer fits its question. Pure.
 *
 * Single choice scores its points for the key. Multi-select scores its points when every correct choice and no wrong one
 * is chosen; with partial credit each correct choice chosen earns an equal whole share, and any wrong choice earns
 * nothing. Numeric compares exact decimals (18 places, as scaled bigint, never a JavaScript number): within the tolerance
 * of the key scores. An essay has no automatic score: staff score it.
 */
import { parseAmount } from '@intafaced/ledger-client';
import { ACADEMY_CHOICE_ID, ACADEMY_QUIZ_DECIMAL } from '@intafaced/contracts';
import type { AcademyCourseQuizAnswer, AcademyCourseQuizQuestion } from '@intafaced/contracts';

/** A decimal string as an integer count of 10^-18, through the canonical decimal parser. Null when it is not one. */
export function scaledDecimal(value: string): bigint | null {
  const text = value.trim();
  return ACADEMY_QUIZ_DECIMAL.test(text) ? parseAmount(text) : null;
}

/** Whether `answer` is a well-formed answer to `question`: a choice id, choice ids, a decimal or text. */
export function answerFits(question: AcademyCourseQuizQuestion, answer: AcademyCourseQuizAnswer): boolean {
  switch (question.kind) {
    case 'single':
      return typeof answer === 'string' && question.choices.some((c) => c.id === answer);
    case 'multi':
      return (
        Array.isArray(answer) &&
        new Set(answer).size === answer.length &&
        answer.every((id) => ACADEMY_CHOICE_ID.test(id) && question.choices.some((c) => c.id === id))
      );
    case 'numeric':
      return typeof answer === 'string' && scaledDecimal(answer) !== null;
    case 'essay':
      return typeof answer === 'string';
  }
}

/** The points one answer earns; null for an essay, which staff score. A missing or unfitting answer earns 0. */
export function scoreQuestion(question: AcademyCourseQuizQuestion, answer: AcademyCourseQuizAnswer | undefined): number | null {
  if (question.kind === 'essay') return null;
  if (answer === undefined || !answerFits(question, answer)) return 0;
  switch (question.kind) {
    case 'single':
      return answer === question.correctChoiceId ? question.points : 0;
    case 'multi': {
      const key = new Set(question.correctChoiceIds ?? []);
      const chosen = answer as string[];
      if (key.size === 0 || chosen.some((id) => !key.has(id))) return 0;
      if (chosen.length === key.size) return question.points;
      return question.partialCredit ? (question.points / key.size) * chosen.length : 0;
    }
    case 'numeric': {
      const given = scaledDecimal(answer as string);
      const key = question.answer === null ? null : scaledDecimal(question.answer);
      const tolerance = scaledDecimal(question.tolerance);
      if (given === null || key === null || tolerance === null) return 0;
      const distance = given > key ? given - key : key - given;
      return distance <= tolerance ? question.points : 0;
    }
  }
}

/** The automatic part of an attempt's score, its maximum, and whether an essay waits for staff. */
export function scoreAttempt(
  questions: readonly AcademyCourseQuizQuestion[],
  answers: Readonly<Record<string, AcademyCourseQuizAnswer>>,
): { autoScore: number; maxScore: number; essays: boolean } {
  let autoScore = 0;
  let maxScore = 0;
  let essays = false;
  for (const question of questions) {
    maxScore += question.points;
    const points = scoreQuestion(question, answers[question.id]);
    if (points === null) essays = true;
    else autoScore += points;
  }
  return { autoScore, maxScore, essays };
}
