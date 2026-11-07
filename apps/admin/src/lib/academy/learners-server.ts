import 'server-only';
import { z } from 'zod';
import {
  academyAddLearnerNoteInputSchema,
  academyGrantAccessInputSchema,
  academyGrantLearnerExtensionInputSchema,
  academyLearnerChangeSchema,
  academyLearnerPageSchema,
  academyLearnerProgressSchema,
  academyLearnersSchema,
  academyLearnerTagsSchema,
  academyMarkCompleteForInputSchema,
  academyReinstateAccessInputSchema,
  academyTagLearnersInputSchema,
  academyUntagLearnerInputSchema,
  academyVoidQuizAttemptInputSchema,
} from '@intafaced/contracts/academy-learner-desk';
import { identityLearnerCardResultSchema } from '@intafaced/contracts/identity-learner-card';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';
import type { LearnerDeskReply, LearnersView, LearnerView } from './learners-model';

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
const readChange = parseWith(academyLearnerChangeSchema);
const readAdded = parseWith(z.object({ added: z.number().int() }));

export async function loadLearner(ctx: FounderCallContext, userId: string): Promise<LearnerView> {
  const [card, page, progress] = await Promise.all([
    founderCall(ctx, 'identity', 'learnerCard.lookup', 'GET', { userId }, readCard),
    founderCall(ctx, 'academy', 'admin.learner', 'GET', { userId }, readPage),
    founderCall(ctx, 'academy', 'admin.learnerProgress', 'GET', { userId }, readProgress),
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
  const input = value.includes('@') ? { email: value } : { handle: value.replace(/^@/, '') };
  return partFrom(await founderCall(ctx, 'identity', 'learnerCard.lookup', 'GET', input, readCard), (d) => d.card, IDENTITY);
}

export async function loadLearners(ctx: FounderCallContext, tag: string | null): Promise<LearnersView> {
  const [report, tags] = await Promise.all([
    founderCall(ctx, 'academy', 'admin.learners', 'GET', tag ? { tag } : {}, readReport),
    founderCall(ctx, 'academy', 'admin.learnerTags', 'GET', undefined, readTags),
  ]);
  const handles: Record<string, string> = {};
  if (report.kind === 'ok' && report.data) {
    const cards = await Promise.all(
      report.data.rows
        .slice(0, 50)
        .map((row) => founderCall(ctx, 'identity', 'learnerCard.lookup', 'GET', { userId: row.userId }, readCard)),
    );
    for (const card of cards) if (card.kind === 'ok' && card.data?.card) handles[card.data.card.id] = card.data.card.handle;
  }
  return { tag, report: partFrom(report, (d) => d, ACADEMY), handles, tags: partFrom(tags, (d) => d, ACADEMY) };
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

/** What the operator sent, checked as svc-academy checks it (a blank reason goes through, so svc-academy refuses it by name). */
const OPS = {
  addNote: {
    schema: academyAddLearnerNoteInputSchema,
    procedure: 'admin.addLearnerNote',
    what: 'internal note saved',
    why: 'Write the note.',
    parse: readChange,
  },
  markComplete: {
    schema: academyMarkCompleteForInputSchema,
    procedure: 'admin.markCompleteFor',
    what: 'item marked complete for the learner',
    why: 'Choose an item.',
    parse: readChange,
  },
  voidAttempt: {
    schema: academyVoidQuizAttemptInputSchema,
    procedure: 'admin.voidQuizAttempt',
    what: 'quiz attempt voided',
    why: 'Choose an attempt.',
    parse: readChange,
  },
  extension: {
    schema: academyGrantLearnerExtensionInputSchema,
    procedure: 'admin.grantLearnerExtension',
    what: 'due date moved for this learner',
    why: 'Give a new due date and time.',
    parse: readChange,
  },
  grantAccess: {
    schema: academyGrantAccessInputSchema,
    procedure: 'admin.grantAccess',
    what: 'access granted',
    why: 'Choose a course.',
    parse: readChange,
  },
  reinstate: {
    schema: academyReinstateAccessInputSchema,
    procedure: 'admin.reinstateAccess',
    what: 'access reinstated',
    why: 'Choose the access record.',
    parse: readChange,
  },
  tag: {
    schema: academyTagLearnersInputSchema,
    procedure: 'admin.tagLearners',
    what: 'tag added',
    why: 'A tag is lower-case letters, digits and dashes, up to 40.',
    parse: readAdded,
  },
  untag: {
    schema: academyUntagLearnerInputSchema,
    procedure: 'admin.untagLearner',
    what: 'tag removed',
    why: 'Choose a tag.',
    parse: readChange,
  },
} as const;

export type LearnerOp = keyof typeof OPS;
export const isLearnerOp = (op: unknown): op is LearnerOp => typeof op === 'string' && Object.hasOwn(OPS, op);

export async function changeLearner(
  ctx: FounderCallContext,
  op: LearnerOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: LearnerDeskReply } | { why: string }> {
  const spec = OPS[op];
  const { op: _op, ...input } = body;
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) return { why: spec.why };
  return reply(await founderCall(ctx, 'academy', spec.procedure, 'POST', parsed.data, spec.parse as (raw: unknown) => unknown), spec.what);
}
