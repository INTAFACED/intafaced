import {
  academyAddLearnerNoteInputSchema,
  academyGrantAccessInputSchema,
  academyGrantLearnerExtensionInputSchema,
  academyMarkCompleteForInputSchema,
  academyReinstateAccessInputSchema,
  academyTagLearnersInputSchema,
  academyUntagLearnerInputSchema,
  academyVoidQuizAttemptInputSchema,
} from '@intafaced/contracts/academy-learner-desk';

/**
 * The learner page's changes (J-academy-14), from the body the console sends to the call svc-academy takes. Pure, so it
 * is tested with the exact bodies the page builds. Every body names the learner (`userId`); a tag goes to svc-academy's
 * many-learner call as a list of one. A blank reason passes here, so svc-academy refuses it by name.
 */
const OPS = {
  addNote: {
    schema: academyAddLearnerNoteInputSchema,
    procedure: 'admin.addLearnerNote',
    what: 'internal note saved',
    why: 'Write the note.',
  },
  markComplete: {
    schema: academyMarkCompleteForInputSchema,
    procedure: 'admin.markCompleteFor',
    what: 'item marked complete for the learner',
    why: 'Choose an item.',
  },
  voidAttempt: {
    schema: academyVoidQuizAttemptInputSchema,
    procedure: 'admin.voidQuizAttempt',
    what: 'quiz attempt voided',
    why: 'Choose an attempt.',
  },
  extension: {
    schema: academyGrantLearnerExtensionInputSchema,
    procedure: 'admin.grantLearnerExtension',
    what: 'due date moved for this learner',
    why: 'Give a new due date and time.',
  },
  grantAccess: { schema: academyGrantAccessInputSchema, procedure: 'admin.grantAccess', what: 'access granted', why: 'Choose a course.' },
  reinstate: {
    schema: academyReinstateAccessInputSchema,
    procedure: 'admin.reinstateAccess',
    what: 'access reinstated',
    why: 'Choose the access record.',
  },
  tag: {
    schema: academyTagLearnersInputSchema,
    procedure: 'admin.tagLearners',
    what: 'tag added',
    why: 'A tag is lower-case letters, digits and dashes, up to 40 characters.',
  },
  untag: { schema: academyUntagLearnerInputSchema, procedure: 'admin.untagLearner', what: 'tag removed', why: 'Choose a tag.' },
} as const;

export type LearnerOp = keyof typeof OPS;
export const isLearnerOp = (op: unknown): op is LearnerOp => typeof op === 'string' && Object.hasOwn(OPS, op);

export function learnerChange(
  op: LearnerOp,
  body: Record<string, unknown>,
): { procedure: string; input: unknown; what: string } | { why: string } {
  const spec = OPS[op];
  const { op: _op, ...rest } = body;
  const sent = op === 'tag' ? (({ userId, ...tag }) => ({ userIds: [userId], ...tag }))(rest) : rest;
  const parsed = spec.schema.safeParse(sent);
  return parsed.success ? { procedure: spec.procedure, input: parsed.data, what: spec.what } : { why: spec.why };
}
