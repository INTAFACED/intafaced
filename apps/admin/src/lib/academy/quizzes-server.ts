import 'server-only';
import {
  academyAdminCourseQuizSchema,
  academySaveCourseQuizInputSchema,
  academySetCourseQuizStateInputSchema,
} from '@intafaced/contracts/academy-course-quizzes';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { AcademyAdminCourseQuiz, QuizDeskReply, QuizView } from './quizzes-model';

/**
 * A quiz item as the signed-in founder (AC-quizzes-01). svc-academy keeps the revision, records the founder from their own
 * token on every save, publish and take-down, and never sends an access code back. No money moves.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. The quiz editor needs the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

const readQuiz = parseWith(academyAdminCourseQuizSchema);

export async function loadQuiz(ctx: FounderCallContext, itemId: string): Promise<QuizView> {
  const quiz = await founderCall(ctx, 'academy', 'admin.courseQuiz', 'GET', { itemId }, readQuiz);
  return { quiz: partFrom(quiz, (d) => d, ACADEMY), asOf: new Date().toISOString() };
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
    why: 'Each question needs a prompt, whole points from 1, two to twenty choices with different ids and one of them as the answer. A pass mark and limits are whole numbers; an access code is 4 to 64 characters.',
  },
  setState: {
    schema: academySetCourseQuizStateInputSchema,
    procedure: 'admin.setCourseQuizState',
    what: 'quiz state changed',
    why: 'Publish or take back to draft, and say why in up to 500 characters.',
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
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) return { why: spec.why };
  const what =
    op === 'setState' ? ((parsed.data as { state: string }).state === 'published' ? 'quiz published' : 'quiz back to draft') : spec.what;
  return reply(await founderCall(ctx, 'academy', spec.procedure, 'POST', parsed.data, readQuiz), what);
}
