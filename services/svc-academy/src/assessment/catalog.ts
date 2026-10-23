/**
 * Owner-published assessment definitions.
 *
 * Questions, choices, correct answers, pass marks, attempt limits and
 * cooldowns come only from this catalog. Nothing here is authored: the
 * lesson `selfCheck` prompts are study questions, not a scored key, and no
 * pass mark is published beside them. An empty catalog means every `get`
 * refuses `academy.assessment_unpublished`.
 *
 * A null pass mark is a published question set the owner has not scored.
 * `get` and `submit` refuse `academy.pass_mark_unset`. A null attempt limit
 * or cooldown means the owner published none, so none applies.
 */

import { hasCurriculumSlug } from '../curriculum/catalog.js';

export type AssessmentChoice = {
  readonly id: string;
  readonly text: string;
};

export type AssessmentQuestion = {
  readonly id: string;
  readonly prompt: string;
  readonly kind: 'single';
  readonly points: number;
  readonly choices: readonly AssessmentChoice[];
  /** Server-only. `get` must not copy this field. */
  readonly correctChoiceId: string;
};

export type AssessmentDefinition = {
  /** Curriculum lesson this assessment belongs to. */
  readonly slug: string;
  readonly kind: 'quiz';
  readonly questions: readonly AssessmentQuestion[];
  /** Null: questions exist and the pass mark does not. */
  readonly passMark: number | null;
  /** Null: the owner published no attempt limit. */
  readonly attemptLimit: number | null;
  /** Null: the owner published no cooldown. Seconds. */
  readonly cooldownSeconds: number | null;
  /** Null or absent: no time limit. Seconds from Start, held by the server (AC-quizzes-03). */
  readonly timeLimitSeconds?: number | null;
  /** Absent: `score_only`, so a finished attempt never shows the key unless staff chose `answers`. */
  readonly reviewMode?: 'answers' | 'score_only';
};

export type AssessmentPublicQuestion = {
  id: string;
  prompt: string;
  kind: 'single';
  points: number;
  choices: { id: string; text: string }[];
};

export type AssessmentPublic = {
  slug: string;
  kind: 'quiz';
  passMark: number;
  questions: AssessmentPublicQuestion[];
};

export class AssessmentCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssessmentCatalogError';
  }
}

/** No owner-published scored assessment exists in this repo. */
export const ASSESSMENT_CATALOG: readonly AssessmentDefinition[] = [];

export function assessmentBySlug(slug: string, catalog: readonly AssessmentDefinition[] = ASSESSMENT_CATALOG): AssessmentDefinition | null {
  return catalog.find((row) => row.slug === slug) ?? null;
}

export function assertAssessmentCatalog(
  defs: readonly AssessmentDefinition[],
  lesson: (slug: string) => boolean = hasCurriculumSlug,
): void {
  const seen = new Set<string>();
  for (const def of defs) {
    if (!def.slug || seen.has(def.slug)) {
      throw new AssessmentCatalogError(`duplicate or blank assessment slug: ${def.slug || '(blank)'}`);
    }
    seen.add(def.slug);
    if (!lesson(def.slug)) {
      throw new AssessmentCatalogError(`assessment ${def.slug} is not a curriculum lesson`);
    }
    if (def.kind !== 'quiz') {
      throw new AssessmentCatalogError(`assessment ${def.slug} kind is not quiz`);
    }
    if (def.questions.length === 0) {
      throw new AssessmentCatalogError(`assessment ${def.slug} has no questions`);
    }
    if (def.passMark !== null && (!Number.isInteger(def.passMark) || def.passMark < 0)) {
      throw new AssessmentCatalogError(`assessment ${def.slug} pass mark is not a non-negative integer`);
    }
    if (def.attemptLimit !== null && (!Number.isInteger(def.attemptLimit) || def.attemptLimit < 1)) {
      throw new AssessmentCatalogError(`assessment ${def.slug} attempt limit is not a positive integer`);
    }
    const timeLimit = def.timeLimitSeconds ?? null;
    if (timeLimit !== null && (!Number.isInteger(timeLimit) || timeLimit < 1)) {
      throw new AssessmentCatalogError(`assessment ${def.slug} time limit is not a positive integer`);
    }
    if (def.cooldownSeconds !== null && (!Number.isInteger(def.cooldownSeconds) || def.cooldownSeconds < 1)) {
      throw new AssessmentCatalogError(`assessment ${def.slug} cooldown is not a positive integer`);
    }
    const questionIds = new Set<string>();
    for (const question of def.questions) {
      if (!question.id || questionIds.has(question.id)) {
        throw new AssessmentCatalogError(`assessment ${def.slug} has a blank or duplicate question id`);
      }
      questionIds.add(question.id);
      if (question.kind !== 'single' || !question.prompt.trim()) {
        throw new AssessmentCatalogError(`assessment ${def.slug} question ${question.id} is not a single-choice prompt`);
      }
      if (!Number.isInteger(question.points) || question.points < 1) {
        throw new AssessmentCatalogError(`assessment ${def.slug} question ${question.id} points are not a positive integer`);
      }
      if (question.choices.length < 2) {
        throw new AssessmentCatalogError(`assessment ${def.slug} question ${question.id} needs at least two choices`);
      }
      const choiceIds = new Set<string>();
      for (const choice of question.choices) {
        if (!choice.id || choiceIds.has(choice.id) || !choice.text.trim()) {
          throw new AssessmentCatalogError(`assessment ${def.slug} question ${question.id} has a blank choice`);
        }
        choiceIds.add(choice.id);
      }
      if (!choiceIds.has(question.correctChoiceId)) {
        throw new AssessmentCatalogError(`assessment ${def.slug} question ${question.id} correct choice is not one of the choices`);
      }
    }
  }
}

assertAssessmentCatalog(ASSESSMENT_CATALOG);
