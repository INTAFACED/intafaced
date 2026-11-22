import {
  ACADEMY_ADMIN_ADD_LEARNER_NOTE,
  ACADEMY_ADMIN_GRANT_ACCESS,
  ACADEMY_ADMIN_GRANT_LEARNER_EXTENSION,
  ACADEMY_ADMIN_MARK_COMPLETE_FOR,
  ACADEMY_ADMIN_REINSTATE_ACCESS,
  ACADEMY_ADMIN_TAG_LEARNERS,
  ACADEMY_ADMIN_UNTAG_LEARNER,
  ACADEMY_ADMIN_VOID_QUIZ_ATTEMPT,
} from '@intafaced/contracts/academy-admin-procedures';

/**
 * The learner page's changes (J-academy-14), from the body the console sends to the call svc-academy takes, by its
 * record. Pure, so it is tested with the exact bodies the page builds. Every body names the learner (`userId`); a tag goes
 * to svc-academy's many-learner call as a list of one. A blank reason passes here, so svc-academy refuses it by name.
 */
const OPS = {
  addNote: { record: ACADEMY_ADMIN_ADD_LEARNER_NOTE, what: 'internal note saved', why: 'Write the note.' },
  markComplete: { record: ACADEMY_ADMIN_MARK_COMPLETE_FOR, what: 'item marked complete for the learner', why: 'Choose an item.' },
  voidAttempt: { record: ACADEMY_ADMIN_VOID_QUIZ_ATTEMPT, what: 'quiz attempt voided', why: 'Choose an attempt.' },
  extension: {
    record: ACADEMY_ADMIN_GRANT_LEARNER_EXTENSION,
    what: 'due date moved for this learner',
    why: 'Give a new due date and time.',
  },
  grantAccess: { record: ACADEMY_ADMIN_GRANT_ACCESS, what: 'access granted', why: 'Choose a course.' },
  reinstate: { record: ACADEMY_ADMIN_REINSTATE_ACCESS, what: 'access reinstated', why: 'Choose the access record.' },
  tag: {
    record: ACADEMY_ADMIN_TAG_LEARNERS,
    what: 'tag added',
    why: 'A tag is lower-case letters, digits and dashes, up to 40 characters.',
  },
  untag: { record: ACADEMY_ADMIN_UNTAG_LEARNER, what: 'tag removed', why: 'Choose a tag.' },
} as const;

export type LearnerOp = keyof typeof OPS;
export type LearnerRecord = (typeof OPS)[LearnerOp]['record'];
export const isLearnerOp = (op: unknown): op is LearnerOp => typeof op === 'string' && Object.hasOwn(OPS, op);

export function learnerChange(
  op: LearnerOp,
  body: Record<string, unknown>,
): { record: LearnerRecord; input: unknown; what: string } | { why: string } {
  const spec = OPS[op];
  const { op: _op, ...rest } = body;
  const sent = op === 'tag' ? (({ userId, ...tag }) => ({ userIds: [userId], ...tag }))(rest) : rest;
  const parsed = spec.record.input.safeParse(sent);
  return parsed.success ? { record: spec.record, input: parsed.data, what: spec.what } : { why: spec.why };
}
