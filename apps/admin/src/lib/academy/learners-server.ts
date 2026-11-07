import 'server-only';
import {
  academyLearnerChangeSchema,
  academyLearnerPageSchema,
  academyLearnerProgressSchema,
  academyLearnersSchema,
  academyLearnerTagsSchema,
} from '@intafaced/contracts/academy-learner-desk';
import { identityLearnerCardResultSchema } from '@intafaced/contracts/identity-learner-card';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';
import type { LearnerDeskReply, LearnersView, LearnerView } from './learners-model';
import { isLearnerOp, learnerChange, type LearnerOp } from './learners-ops';

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
/** `admin.tagLearners` answers how many learners took the tag. */
const readAdded = (raw: unknown): { added: number } | null =>
  raw !== null && typeof raw === 'object' && Number.isInteger((raw as { added?: unknown }).added)
    ? { added: (raw as { added: number }).added }
    : null;

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
  // A handle may be typed with its @; an address has an @ after its first character.
  const input = value.startsWith('@') ? { handle: value.slice(1) } : value.includes('@') ? { email: value } : { handle: value };
  return partFrom(await founderCall(ctx, 'identity', 'learnerCard.lookup', 'GET', input, readCard), (d) => d.card, IDENTITY);
}

/** The learners report. Rows name accounts by id: each learner's page reads identity once, when it is opened. */
export async function loadLearners(ctx: FounderCallContext, tag: string | null): Promise<LearnersView> {
  const [report, tags] = await Promise.all([
    founderCall(ctx, 'academy', 'admin.learners', 'GET', tag ? { tag } : {}, readReport),
    founderCall(ctx, 'academy', 'admin.learnerTags', 'GET', undefined, readTags),
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

export async function changeLearner(
  ctx: FounderCallContext,
  op: LearnerOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: LearnerDeskReply } | { why: string }> {
  const change = learnerChange(op, body);
  if ('why' in change) return change;
  const parse = op === 'tag' ? readAdded : readChange;
  return reply(await founderCall(ctx, 'academy', change.procedure, 'POST', change.input, parse as (raw: unknown) => unknown), change.what);
}

export { isLearnerOp };
