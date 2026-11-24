import { describe, expect, it } from 'vitest';
import { itemPanels } from './item-panels';
import type { AcademyOutlineItemKind } from '@intafaced/contracts/academy-courses';

const failed = (code: string | null, message = 'svc-academy did not answer.') =>
  ({ kind: 'failed', message, code, notBuilt: false, forbidden: false }) as const;
const ok = <T>(data: T) => ({ kind: 'ok', data }) as const;
const lessonOf = (kind: AcademyOutlineItemKind) => ({ lesson: ok({ item: { kind } }) });
const lessonDown = { lesson: failed(null) };
const assignmentDown = { assignment: failed(null) };
const assignmentNone = { assignment: failed('academy.assignment_not_found', 'x') };
const assignmentOk = { assignment: ok({}) };
const quizOk = { quiz: ok({}) };
const quizDown = { quiz: failed(null) };
const quizNone = { quiz: failed('academy.quiz_not_found', 'x') };

describe('the panels an outline item shows', () => {
  // The past mistake (intafaced#9266): on a quiz item the assignment read timed out, its failure took the brief slot and the
  // quiz editor was never drawn.
  it('shows a quiz item its quiz when the assignment read did not answer', () => {
    expect(itemPanels(lessonOf('quiz'), assignmentDown, quizOk)).toEqual({ assignment: null, quiz: quizOk });
  });

  it('shows an assignment item its brief when the quiz read did not answer', () => {
    expect(itemPanels(lessonOf('assignment'), assignmentOk, quizDown)).toEqual({ assignment: assignmentOk, quiz: null });
  });

  it('shows the matching read failed rather than hiding it', () => {
    expect(itemPanels(lessonOf('quiz'), assignmentNone, quizDown)).toEqual({ assignment: null, quiz: quizDown });
    expect(itemPanels(lessonOf('assignment'), assignmentDown, quizNone)).toEqual({ assignment: assignmentDown, quiz: null });
  });

  it('shows a lesson item neither panel', () => {
    expect(itemPanels(lessonOf('lesson'), assignmentDown, quizDown)).toEqual({ assignment: null, quiz: null });
  });

  it('with the kind unknown, shows every read but the not-found answer', () => {
    expect(itemPanels(lessonDown, assignmentDown, quizOk)).toEqual({ assignment: assignmentDown, quiz: quizOk });
    expect(itemPanels(lessonDown, assignmentNone, quizNone)).toEqual({ assignment: null, quiz: null });
  });
});
