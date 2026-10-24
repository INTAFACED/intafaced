/**
 * AC-quizzes-02 — how one answer to a course quiz question scores. Pure.
 */
import { describe, expect, it } from 'vitest';
import type { AcademyCourseQuizQuestion } from '@intafaced/contracts';
import { answerFits, scaledDecimal, scoreAttempt, scoreQuestion } from './course-quiz-score.js';

const choices = [
  { id: 'a', text: 'A' },
  { id: 'b', text: 'B' },
  { id: 'c', text: 'C' },
  { id: 'd', text: 'D' },
];
const multi = (partialCredit: boolean): AcademyCourseQuizQuestion => ({
  kind: 'multi',
  id: 'm',
  prompt: 'TEST pick two',
  points: 4,
  choices,
  correctChoiceIds: ['a', 'b'],
  partialCredit,
});
const numeric: AcademyCourseQuizQuestion = { kind: 'numeric', id: 'n', prompt: 'TEST 1/3', points: 3, answer: '0.333', tolerance: '0.001' };
const essay: AcademyCourseQuizQuestion = { kind: 'essay', id: 'e', prompt: 'TEST explain', points: 5 };

describe('course quiz scoring (AC-quizzes-02)', () => {
  it('reads decimals exactly, and refuses what is not one', () => {
    expect(scaledDecimal('0.1')! + scaledDecimal('0.2')!).toBe(scaledDecimal('0.3'));
    expect(scaledDecimal('-1.5')).toBe(-1_500_000_000_000_000_000n);
    for (const bad of ['1e3', '01', '.5', '1.', 'NaN', '']) expect(scaledDecimal(bad)).toBeNull();
  });

  it('multi-select scores all-or-nothing, or a whole share per correct choice with partial credit; a wrong one earns nothing', () => {
    expect(scoreQuestion(multi(false), ['a', 'b'])).toBe(4);
    expect(scoreQuestion(multi(false), ['a'])).toBe(0);
    expect(scoreQuestion(multi(true), ['a'])).toBe(2);
    expect(scoreQuestion(multi(true), ['b', 'a'])).toBe(4);
    expect(scoreQuestion(multi(true), ['a', 'c'])).toBe(0);
    expect(scoreQuestion(multi(true), [])).toBe(0);
    expect(scoreQuestion(multi(true), ['a', 'a'])).toBe(0);
  });

  it('numeric scores inside the tolerance, inclusive, and nothing outside it or for a non-decimal', () => {
    expect(scoreQuestion(numeric, '0.333')).toBe(3);
    expect(scoreQuestion(numeric, '0.334')).toBe(3);
    expect(scoreQuestion(numeric, '0.332')).toBe(3);
    expect(scoreQuestion(numeric, '0.3341')).toBe(0);
    expect(scoreQuestion(numeric, '1/3')).toBe(0);
    expect(answerFits(numeric, '1e-1')).toBe(false);
  });

  it('an essay has no automatic score, and an attempt with one waits for staff', () => {
    expect(scoreQuestion(essay, 'TEST text')).toBeNull();
    expect(scoreAttempt([multi(true), numeric, essay], { m: ['a'], n: '0.333', e: 'TEST' })).toEqual({
      autoScore: 5,
      maxScore: 12,
      essays: true,
    });
    expect(scoreAttempt([numeric], {})).toEqual({ autoScore: 0, maxScore: 3, essays: false });
  });

  it('an answer fits only its own question kind', () => {
    expect(answerFits(multi(false), 'a')).toBe(false);
    expect(answerFits(multi(false), ['z'])).toBe(false);
    expect(answerFits({ kind: 'single', id: 's', prompt: 'p', points: 1, choices, correctChoiceId: 'a' }, ['a'])).toBe(false);
    expect(answerFits(essay, ['a'])).toBe(false);
  });
});
