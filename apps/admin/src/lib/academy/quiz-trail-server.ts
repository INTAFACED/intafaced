import 'server-only';
import {
  ACADEMY_CURVE_FILE_MAX_CHARS,
  academyAdminCourseQuizSchema,
  academyCourseQuizAnalyticsSchema,
  academyCourseQuizAnswersSchema,
  academyCourseQuizInputSchema,
  academyCurveCourseQuizInputSchema,
  academyCurveCourseQuizResultSchema,
  academyCourseQuizAttemptsSchema,
  academyFixCourseQuizKeyInputSchema,
  academyOverrideCourseQuizScoreInputSchema,
  academyRescoreCourseQuizInputSchema,
  academyRescoreCourseQuizResultSchema,
} from '@intafaced/contracts/academy-course-quizzes';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { QuizTrailReply, QuizTrailView } from './quiz-trail-model';

/**
 * A quiz's attempts and score changes as the signed-in founder (AC-quizzes-04). svc-academy keeps every change as an
 * event with the founder from their own token and a reason, shows learners under aliases, and never edits an attempt.
 * No money moves.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. Score changes need the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

const readQuiz = parseWith(academyAdminCourseQuizSchema);
const readAttempts = parseWith(academyCourseQuizAttemptsSchema);
const readRescore = parseWith(academyRescoreCourseQuizResultSchema);
const readAnalytics = parseWith(academyCourseQuizAnalyticsSchema);
const readCurve = parseWith(academyCurveCourseQuizResultSchema);
const readAnswers = parseWith(academyCourseQuizAnswersSchema);

export async function loadQuizTrail(ctx: FounderCallContext, itemId: string): Promise<QuizTrailView> {
  const [quiz, attempts, analytics] = await Promise.all([
    founderCall(ctx, 'academy', 'admin.courseQuiz', 'GET', { itemId }, readQuiz),
    founderCall(ctx, 'academy', 'admin.courseQuizAttempts', 'GET', { itemId }, readAttempts),
    founderCall(ctx, 'academy', 'admin.courseQuizAnalytics', 'GET', { itemId }, readAnalytics),
  ]);
  return {
    quiz: partFrom(quiz, (d) => d, ACADEMY),
    attempts: partFrom(attempts, (d) => d, ACADEMY),
    analytics: partFrom(analytics, (d) => d, ACADEMY),
    asOf: new Date().toISOString(),
  };
}

function refused(result: FounderCallResult<unknown>): { status: number; reply: QuizTrailReply } {
  const out = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return out(null, 502, true);
    case 'refused':
      return out(result.refusal.code, result.refusal.status);
    case 'forbidden':
      return out(result.refusal.code ?? 'operator.denied', 403);
    case 'not_built':
      return out('not_built', 501);
    case 'unavailable':
      return out(null, 503, result.uncertain);
    case 'invalid':
      return out(null, 502, true);
  }
}

/** What the founder sent, checked as svc-academy checks it, so a form mistake is named before anything is sent. */
const OPS = {
  fixKey: {
    schema: academyFixCourseQuizKeyInputSchema,
    procedure: 'admin.fixCourseQuizKey',
    what: 'key fixed as a new revision; attempts keep their score until you rescore',
    why: 'A key fix sends every question as it is with only its key changed, the revision you read, and a reason up to 500 characters.',
  },
  rescore: {
    schema: academyRescoreCourseQuizInputSchema,
    procedure: 'admin.rescoreCourseQuiz',
    what: 'attempts rescored',
    why: 'Say why you rescore, in up to 500 characters.',
  },
  override: {
    schema: academyOverrideCourseQuizScoreInputSchema,
    procedure: 'admin.overrideCourseQuizScore',
    what: 'score changed',
    why: 'Choose a question, whole points from 0 to its points, and a reason up to 500 characters; a comment runs to 2,000.',
  },
  curve: {
    schema: academyCurveCourseQuizInputSchema,
    procedure: 'admin.curveCourseQuiz',
    what: 'curve file read',
    why: `Choose a CSV curve file of up to ${ACADEMY_CURVE_FILE_MAX_CHARS} characters and say why, in up to 500 characters.`,
  },
  answers: {
    schema: academyCourseQuizInputSchema,
    procedure: 'admin.courseQuizAnswers',
    what: 'answers by learner read',
    why: 'Which quiz?',
  },
} as const;

export type QuizTrailOp = keyof typeof OPS;
export const isQuizTrailOp = (op: unknown): op is QuizTrailOp => typeof op === 'string' && Object.hasOwn(OPS, op);

export async function changeQuizTrail(
  ctx: FounderCallContext,
  op: QuizTrailOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: QuizTrailReply } | { why: string }> {
  const spec = OPS[op];
  const { op: _op, ...input } = body;
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) return { why: spec.why };
  const itemId = parsed.data.itemId;
  if (op === 'curve' || op === 'answers') {
    if (op === 'answers') {
      const read = await founderCall(ctx, 'academy', spec.procedure, 'GET', parsed.data, readAnswers);
      if (read.kind !== 'ok' || !read.data) return refused(read);
      return { status: 200, reply: { ok: true, what: spec.what, view: await loadQuizTrail(ctx, itemId), answers: read.data } };
    }
    const result = await founderCall(ctx, 'academy', spec.procedure, 'POST', parsed.data, readCurve);
    if (result.kind !== 'ok' || !result.data) return refused(result);
    const c = result.data;
    const what = c.repeated
      ? 'this curve file was applied before, so nothing changed'
      : c.dryRun
        ? `dry run: ${c.rows.length} would change, ${c.rejected.length} refused; nothing applied`
        : `curve applied to ${c.rows.length} attempt${c.rows.length === 1 ? '' : 's'}`;
    return { status: 200, reply: { ok: true, what, view: await loadQuizTrail(ctx, itemId), curve: c } };
  }
  // Each change answers with half the page; only the other half is read again.
  const quizPart = async () =>
    partFrom(await founderCall(ctx, 'academy', 'admin.courseQuiz', 'GET', { itemId }, readQuiz), (d) => d, ACADEMY);
  const attemptsPart = async () =>
    partFrom(await founderCall(ctx, 'academy', 'admin.courseQuizAttempts', 'GET', { itemId }, readAttempts), (d) => d, ACADEMY);
  const analyticsPart = async () =>
    partFrom(await founderCall(ctx, 'academy', 'admin.courseQuizAnalytics', 'GET', { itemId }, readAnalytics), (d) => d, ACADEMY);
  const asOf = () => new Date().toISOString();
  if (op === 'rescore') {
    const result = await founderCall(ctx, 'academy', spec.procedure, 'POST', parsed.data, readRescore);
    if (result.kind !== 'ok' || !result.data) return refused(result);
    const n = result.data.rescored.length;
    return {
      status: 200,
      reply: {
        ok: true,
        what: n === 0 ? 'rescore run: no attempt changed' : `${n} attempt${n === 1 ? '' : 's'} rescored`,
        view: {
          quiz: await quizPart(),
          attempts: { kind: 'ok', data: result.data.attempts },
          analytics: await analyticsPart(),
          asOf: asOf(),
        },
        rescored: result.data.rescored,
      },
    };
  }
  if (op === 'fixKey') {
    const result = await founderCall(ctx, 'academy', spec.procedure, 'POST', parsed.data, readQuiz);
    if (result.kind !== 'ok' || !result.data) return refused(result);
    return {
      status: 200,
      reply: {
        ok: true,
        what: spec.what,
        view: { quiz: { kind: 'ok', data: result.data }, attempts: await attemptsPart(), analytics: await analyticsPart(), asOf: asOf() },
      },
    };
  }
  const result = await founderCall(ctx, 'academy', spec.procedure, 'POST', parsed.data, readAttempts);
  if (result.kind !== 'ok' || !result.data) return refused(result);
  return {
    status: 200,
    reply: {
      ok: true,
      what: spec.what,
      view: { quiz: await quizPart(), attempts: { kind: 'ok', data: result.data }, analytics: await analyticsPart(), asOf: asOf() },
    },
  };
}
