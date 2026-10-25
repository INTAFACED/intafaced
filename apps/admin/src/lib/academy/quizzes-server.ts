import 'server-only';
import {
  academyAdminCourseQuizSchema,
  academyCourseQuizReviewsSchema,
  academySaveCourseQuizInputSchema,
  academyScoreCourseQuizEssaysInputSchema,
  academySetCourseQuizStateInputSchema,
} from '@intafaced/contracts/academy-course-quizzes';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { AcademyAdminCourseQuiz, QuizDeskReply, QuizView } from './quizzes-model';

/**
 * A quiz item as the signed-in founder (AC-quizzes-01, 02). svc-academy keeps the revision, records the founder from their
 * own token on every save, publish, take-down and essay score, and never sends an access code back. Attempts waiting for
 * an essay score come under per-quiz aliases, never the account. No money moves.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. The quiz editor needs the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

const readQuiz = parseWith(academyAdminCourseQuizSchema);
const readReviews = parseWith(academyCourseQuizReviewsSchema);

export async function loadQuiz(ctx: FounderCallContext, itemId: string): Promise<QuizView> {
  const quiz = partFrom(await founderCall(ctx, 'academy', 'admin.courseQuiz', 'GET', { itemId }, readQuiz), (d) => d, ACADEMY);
  // Only a quiz that read has a queue; a survey or a quiz with no essay answers an empty one.
  const reviews =
    quiz.kind === 'ok'
      ? partFrom(await founderCall(ctx, 'academy', 'admin.courseQuizReviews', 'GET', { itemId }, readReviews), (d) => d, ACADEMY)
      : null;
  return { quiz, reviews, asOf: new Date().toISOString() };
}

function reply(result: FounderCallResult<AcademyAdminCourseQuiz | null>, what: string): { status: number; reply: QuizDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return result.data ? { status: 200, reply: { ok: true, what, quiz: result.data } } : refused(null, 502, true);
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

/** What the founder sent, checked as svc-academy checks it, so a form mistake is named before anything is sent. */
const OPS = {
  save: {
    schema: academySaveCourseQuizInputSchema,
    procedure: 'admin.saveCourseQuiz',
    what: 'quiz saved as a draft',
    why: 'Each question needs a prompt and whole points from 1. A choice question needs two to twenty choices, and in a graded quiz its answer; a multi-select with partial credit needs points that split evenly across its correct choices; a numeric question needs a decimal answer and a tolerance from 0. A pass mark and limits are whole numbers; an access code is 4 to 64 characters; results after the last attempt need an attempt limit; only a survey is anonymous.',
  },
  setState: {
    schema: academySetCourseQuizStateInputSchema,
    procedure: 'admin.setCourseQuizState',
    what: 'quiz state changed',
    why: 'Publish or take back to draft, and say why in up to 500 characters.',
  },
  scoreEssays: {
    schema: academyScoreCourseQuizEssaysInputSchema,
    procedure: 'admin.scoreCourseQuizEssays',
    what: 'essays scored',
    why: 'Score every essay of the attempt in whole points, from 0 to its question’s points. A blank score is not sent.',
  },
} as const;

export type QuizOp = keyof typeof OPS;
export const isQuizOp = (op: unknown): op is QuizOp => typeof op === 'string' && Object.hasOwn(OPS, op);

export async function changeQuiz(
  ctx: FounderCallContext,
  op: QuizOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: QuizDeskReply } | { why: string }> {
  const spec = OPS[op];
  const { op: _op, ...input } = body;
  if (op === 'scoreEssays') {
    // svc-academy scores the attempt only when it is on the quiz named; the quiz is read back so the editor shows it as it is now.
    const parsed = OPS.scoreEssays.schema.safeParse(input);
    if (!parsed.success) return { why: spec.why };
    const scored = await founderCall(ctx, 'academy', spec.procedure, 'POST', parsed.data, readReviews);
    if (scored.kind !== 'ok') return reply(scored as FounderCallResult<null>, spec.what);
    return reply(await founderCall(ctx, 'academy', 'admin.courseQuiz', 'GET', { itemId: parsed.data.itemId }, readQuiz), spec.what);
  }
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) return { why: spec.why };
  const what =
    op === 'setState' ? ((parsed.data as { state: string }).state === 'published' ? 'quiz published' : 'quiz back to draft') : spec.what;
  return reply(await founderCall(ctx, 'academy', spec.procedure, 'POST', parsed.data, readQuiz), what);
}
