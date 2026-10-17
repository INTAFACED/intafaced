/**
 * Server-side scoring. Integer points only. The returned object has no
 * correct choice and no answer key.
 */

import { AcademyError } from '../errors.js';
import type { AssessmentDefinition } from './catalog.js';

export type AssessmentAnswer = {
  readonly questionId: string;
  readonly choiceId: string;
};

export type AssessmentScore = {
  readonly score: number;
  readonly maxScore: number;
  readonly pass: boolean;
};

export function scoreAssessment(def: AssessmentDefinition, answers: readonly AssessmentAnswer[]): AssessmentScore {
  if (def.passMark === null || !Number.isInteger(def.passMark)) {
    throw new AcademyError(`academy.pass_mark_unset slug=${def.slug}`, 'academy.pass_mark_unset');
  }
  const seen = new Set<string>();
  for (const answer of answers) {
    if (seen.has(answer.questionId)) {
      throw new AcademyError(`duplicate answer for ${answer.questionId}`, 'academy.assessment_invalid');
    }
    seen.add(answer.questionId);
    const question = def.questions.find((row) => row.id === answer.questionId);
    if (!question || !question.choices.some((choice) => choice.id === answer.choiceId)) {
      throw new AcademyError('answer does not match a published question', 'academy.assessment_invalid');
    }
  }
  let score = 0;
  let maxScore = 0;
  for (const question of def.questions) {
    if (!Number.isInteger(question.points) || question.points < 1) {
      throw new AcademyError(`question ${question.id} points are not a positive integer`, 'academy.assessment_invalid');
    }
    maxScore += question.points;
    const answer = answers.find((row) => row.questionId === question.id);
    if (answer && answer.choiceId === question.correctChoiceId) score += question.points;
  }
  return { score, maxScore, pass: score >= def.passMark };
}
