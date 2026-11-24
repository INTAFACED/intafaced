import 'server-only';
import {
  academyLearnerPageSchema,
  academyLearnerProgressSchema,
  academyLearnersSchema,
  academyLearnerTagsSchema,
} from '@intafaced/contracts/academy-learner-desk';
import { identityLearnerCardResultSchema } from '@intafaced/contracts/identity-learner-card';
import {
  founderAskedCall,
  parseWith,
  type FounderCallContext,
  type FounderCallResult,
  partFrom,
  type PartLabels,
  explainRefusal,
  type RefusalView,
  founderRecordRead,
} from '@/lib/desk';
import type { LearnerDeskReply, LearnersView, LearnerView } from './learners-model';
import { isLearnerOp, learnerChange, type LearnerOp } from './learners-ops';
import {
  ACADEMY_ADMIN_LEARNER,
  ACADEMY_ADMIN_LEARNER_PROGRESS,
  ACADEMY_ADMIN_LEARNERS,
  ACADEMY_ADMIN_ADD_LEARNER_NOTE,
  ACADEMY_ADMIN_MARK_COMPLETE_FOR,
  ACADEMY_ADMIN_VOID_QUIZ_ATTEMPT,
  ACADEMY_ADMIN_GRANT_LEARNER_EXTENSION,
  ACADEMY_ADMIN_GRANT_ACCESS,
  ACADEMY_ADMIN_REINSTATE_ACCESS,
  ACADEMY_ADMIN_UNTAG_LEARNER,
} from '@intafaced/contracts/academy-admin-records';
import { ACADEMY_ADMIN_LEARNER_TAGS, ACADEMY_ADMIN_TAG_LEARNERS } from '@intafaced/contracts/academy-admin-procedures';
import { IDENTITY_LEARNER_CARD_LOOKUP } from '@intafaced/contracts/identity-learner-card-procedures';

/**
 * One learner on the staff desk (J-academy-14), as the signed-in operator. svc-academy records the operator from their own
 * token with the reason on every change, refuses a change from a session that may only read, and refuses a blank reason
 * by name. Identity answers the profile and sign-in statistics from its own sessions. No money moves.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage: 'svc-academy did not accept your session. The learner desk needs the Academy operator permission (admin:read).',
  refusedMessage: (code) => (code ? learnerRefusal(code, 409).body : null),
};
const IDENTITY: PartLabels = {
  service: 'svc-identity',
  forbiddenMessage:
    'Identity did not accept your session for the learner lookup (it needs admin:read on a signed-in session with a second factor).',
};

/** The learner desk's own words for the codes it shares with other desks; the rest come from the shared catalogue. */
const LEARNER_COPY: Record<string, Omit<RefusalView, 'code' | 'changed'>> = {
  'academy.reason_required': {
    title: 'A reason is required',
    body: 'Every change to a learner’s record keeps who made it and why, so a change with no reason is refused.',
    next: 'Say why, then try again. Nothing was changed.',
  },
  'academy.permission_denied': {
    title: 'Not permitted: this session may only read',
    body: 'Your role can read a learner’s record but not change it.',
    next: 'Ask someone with the Academy write permission. Nothing was changed.',
  },
};

function learnerRefusal(code: string | null, status: number, uncertain = false): RefusalView {
  const own = code ? LEARNER_COPY[code] : undefined;
  return own ? { ...own, code, changed: 'no' } : explainRefusal(code, status, uncertain);
}

const readPage = parseWith(academyLearnerPageSchema);
const readProgress = parseWith(academyLearnerProgressSchema);
const readCard = parseWith(identityLearnerCardResultSchema);
const readReport = parseWith(academyLearnersSchema);
const readTags = parseWith(academyLearnerTagsSchema);

export async function loadLearner(ctx: FounderCallContext, userId: string): Promise<LearnerView> {
  const [card, page, progress] = await Promise.all([
    founderRecordRead(ctx, IDENTITY_LEARNER_CARD_LOOKUP, { userId }, readCard),
    founderRecordRead(ctx, ACADEMY_ADMIN_LEARNER, { userId }, readPage),
    founderRecordRead(ctx, ACADEMY_ADMIN_LEARNER_PROGRESS, { userId }, readProgress),
  ]);
  return {
    userId,
    card: partFrom(card, (d) => d.card, IDENTITY),
    page: partFrom(page, (d) => d, ACADEMY),
    progress: partFrom(progress, (d) => d, ACADEMY),
    asOf: new Date().toISOString(),
  };
}

/** The account a whole email or handle names, through identity's exact lookup; null when none does. */
export async function findLearner(ctx: FounderCallContext, term: string) {
  const value = term.trim();
  // A handle may be typed with its @; an address has an @ after its first character.
  const input = value.startsWith('@') ? { handle: value.slice(1) } : value.includes('@') ? { email: value } : { handle: value };
  return partFrom(await founderRecordRead(ctx, IDENTITY_LEARNER_CARD_LOOKUP, input, readCard), (d) => d.card, IDENTITY);
}

/** The learners report. Rows name accounts by id: each learner's page reads identity once, when it is opened. */
export async function loadLearners(ctx: FounderCallContext, tag: string | null): Promise<LearnersView> {
  const [report, tags] = await Promise.all([
    founderRecordRead(ctx, ACADEMY_ADMIN_LEARNERS, tag ? { tag } : {}, readReport),
    founderRecordRead(ctx, ACADEMY_ADMIN_LEARNER_TAGS, undefined, readTags),
  ]);
  return { tag, report: partFrom(report, (d) => d, ACADEMY), tags: partFrom(tags, (d) => d, ACADEMY) };
}

function reply(result: FounderCallResult<unknown>, what: string): { status: number; reply: LearnerDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...learnerRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return result.data ? { status: 200, reply: { ok: true, what } } : refused(null, 502, true);
    case 'refused':
      return refused(result.refusal.code, result.refusal.status);
    case 'forbidden':
      return refused(result.refusal.code ?? 'operator.denied', 403);
    case 'not_built':
      return refused('not_built', 501);
    case 'unavailable':
      return refused(null, 503, result.uncertain);
    case 'invalid':
      return refused(null, 502, true);
  }
}

/** The svc-academy call each learner change is sent as. */
const LEARNER_CALLS = {
  addNote: { record: ACADEMY_ADMIN_ADD_LEARNER_NOTE },
  markComplete: { record: ACADEMY_ADMIN_MARK_COMPLETE_FOR },
  voidAttempt: { record: ACADEMY_ADMIN_VOID_QUIZ_ATTEMPT },
  extension: { record: ACADEMY_ADMIN_GRANT_LEARNER_EXTENSION },
  grantAccess: { record: ACADEMY_ADMIN_GRANT_ACCESS },
  reinstate: { record: ACADEMY_ADMIN_REINSTATE_ACCESS },
  tag: { record: ACADEMY_ADMIN_TAG_LEARNERS },
  untag: { record: ACADEMY_ADMIN_UNTAG_LEARNER },
} as const satisfies Record<LearnerOp, object>;

export async function changeLearner(
  ctx: FounderCallContext,
  op: LearnerOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: LearnerDeskReply } | { why: string }> {
  const change = learnerChange(op, body);
  if ('why' in change) return change;
  const spec = LEARNER_CALLS[op];
  // The record checks the input and parses svc-academy's answer: a change's or, for a tag, how many took it.
  return reply(await founderAskedCall(ctx, spec.record, change.input), change.what);
}

export { isLearnerOp };
