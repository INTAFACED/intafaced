import type { AcademyOutlineItemKind } from '@intafaced/contracts/academy-courses';
import type { Part } from '@/lib/part';

/** What the choice reads from each view: the item's kind from its lesson, and whether each panel's read answered. */
type LessonRead = { readonly lesson: Part<{ readonly item: { readonly kind: AcademyOutlineItemKind } }> };
type AssignmentRead = { readonly assignment: Part<unknown> };
type QuizRead = { readonly quiz: Part<unknown> };

/** The panels an outline item's page shows beside its lesson: an assignment's brief, a quiz's questions, both or neither. */
export interface ItemPanels<A, Q> {
  readonly assignment: A | null;
  readonly quiz: Q | null;
}

const notFound = (part: Part<unknown>, code: string) => part.kind === 'failed' && part.code === code;

/**
 * Which panels an item shows. The item's own kind, read with its lesson, decides: a quiz item shows its quiz, an assignment
 * item its brief, each read as it came back (a failed read is shown, never hidden), and a read for the other kind is not
 * shown at all, so one slow read can never put the wrong panel in the right one's place. When the lesson read failed and
 * the kind is unknown, every read but the not-found answer that every other kind gives is shown.
 */
export function itemPanels<A extends AssignmentRead, Q extends QuizRead>(lesson: LessonRead, assignment: A, quiz: Q): ItemPanels<A, Q> {
  if (lesson.lesson.kind === 'ok') {
    const kind = lesson.lesson.data.item.kind;
    return { assignment: kind === 'assignment' ? assignment : null, quiz: kind === 'quiz' ? quiz : null };
  }
  return {
    assignment: notFound(assignment.assignment, 'academy.assignment_not_found') ? null : assignment,
    quiz: notFound(quiz.quiz, 'academy.quiz_not_found') ? null : quiz,
  };
}
