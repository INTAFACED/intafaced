import 'server-only';
import { ACADEMY_CURVE_FILE_MAX_CHARS } from '@intafaced/contracts/academy-course-quizzes';
import {
  ACADEMY_ADMIN_COURSE_QUIZ,
  ACADEMY_ADMIN_COURSE_QUIZ_ANALYTICS,
  ACADEMY_ADMIN_COURSE_QUIZ_ANSWERS,
  ACADEMY_ADMIN_COURSE_QUIZ_ATTEMPTS,
  ACADEMY_ADMIN_CURVE_COURSE_QUIZ,
  ACADEMY_ADMIN_FIX_COURSE_QUIZ_KEY,
  ACADEMY_ADMIN_OVERRIDE_COURSE_QUIZ_SCORE,
  ACADEMY_ADMIN_RESCORE_COURSE_QUIZ,
} from '@intafaced/contracts/academy-admin-procedures';
import { founderRecordCall, type FounderCallContext, type FounderCallResult, partFrom, type PartLabels, explainRefusal } from '@/lib/desk';
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

export async function loadQuizTrail(ctx: FounderCallContext, itemId: string): Promise<QuizTrailView> {
  const [quiz, attempts, analytics] = await Promise.all([
    founderRecordCall(ctx, ACADEMY_ADMIN_COURSE_QUIZ, { itemId }),
    founderRecordCall(ctx, ACADEMY_ADMIN_COURSE_QUIZ_ATTEMPTS, { itemId }),
    founderRecordCall(ctx, ACADEMY_ADMIN_COURSE_QUIZ_ANALYTICS, { itemId }),
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
    record: ACADEMY_ADMIN_FIX_COURSE_QUIZ_KEY,
    what: 'key fixed as a new revision; attempts keep their score until you rescore',
    why: 'A key fix sends every question as it is with only its key changed, the revision you read, and a reason up to 500 characters.',
  },
  rescore: {
    record: ACADEMY_ADMIN_RESCORE_COURSE_QUIZ,
    what: 'attempts rescored',
    why: 'Say why you rescore, in up to 500 characters.',
  },
  override: {
    record: ACADEMY_ADMIN_OVERRIDE_COURSE_QUIZ_SCORE,
    what: 'score changed',
    why: 'Choose a question, whole points from 0 to its points, and a reason up to 500 characters; a comment runs to 2,000.',
  },
  curve: {
    record: ACADEMY_ADMIN_CURVE_COURSE_QUIZ,
    what: 'curve file read',
    why: `Choose a CSV curve file of up to ${ACADEMY_CURVE_FILE_MAX_CHARS} characters and say why, in up to 500 characters.`,
  },
  answers: {
    record: ACADEMY_ADMIN_COURSE_QUIZ_ANSWERS,
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
  const { op: _op, ...input } = body;
  const why = { why: OPS[op].why };
  // Each change answers with half the page; only the other half is read again.
  const quizPart = async (itemId: string) =>
    partFrom(await founderRecordCall(ctx, ACADEMY_ADMIN_COURSE_QUIZ, { itemId }), (d) => d, ACADEMY);
  const attemptsPart = async (itemId: string) =>
    partFrom(await founderRecordCall(ctx, ACADEMY_ADMIN_COURSE_QUIZ_ATTEMPTS, { itemId }), (d) => d, ACADEMY);
  const analyticsPart = async (itemId: string) =>
    partFrom(await founderRecordCall(ctx, ACADEMY_ADMIN_COURSE_QUIZ_ANALYTICS, { itemId }), (d) => d, ACADEMY);
  const asOf = () => new Date().toISOString();
  switch (op) {
    case 'answers': {
      const asked = OPS.answers.record.input.safeParse(input);
      if (!asked.success) return why;
      const read = await founderRecordCall(ctx, OPS.answers.record, asked.data);
      if (read.kind !== 'ok') return refused(read);
      return {
        status: 200,
        reply: { ok: true, what: OPS.answers.what, view: await loadQuizTrail(ctx, asked.data.itemId), answers: read.data },
      };
    }
    case 'curve': {
      const asked = OPS.curve.record.input.safeParse(input);
      if (!asked.success) return why;
      const result = await founderRecordCall(ctx, OPS.curve.record, asked.data);
      if (result.kind !== 'ok') return refused(result);
      const c = result.data;
      const what = c.repeated
        ? 'this curve file was applied before, so nothing changed'
        : c.dryRun
          ? `dry run: ${c.rows.length} would change, ${c.rejected.length} refused; nothing applied`
          : `curve applied to ${c.rows.length} attempt${c.rows.length === 1 ? '' : 's'}`;
      return { status: 200, reply: { ok: true, what, view: await loadQuizTrail(ctx, asked.data.itemId), curve: c } };
    }
    case 'rescore': {
      const asked = OPS.rescore.record.input.safeParse(input);
      if (!asked.success) return why;
      const result = await founderRecordCall(ctx, OPS.rescore.record, asked.data);
      if (result.kind !== 'ok') return refused(result);
      const n = result.data.rescored.length;
      return {
        status: 200,
        reply: {
          ok: true,
          what: n === 0 ? 'rescore run: no attempt changed' : `${n} attempt${n === 1 ? '' : 's'} rescored`,
          view: {
            quiz: await quizPart(asked.data.itemId),
            attempts: { kind: 'ok', data: result.data.attempts },
            analytics: await analyticsPart(asked.data.itemId),
            asOf: asOf(),
          },
          rescored: result.data.rescored,
        },
      };
    }
    case 'fixKey': {
      const asked = OPS.fixKey.record.input.safeParse(input);
      if (!asked.success) return why;
      const result = await founderRecordCall(ctx, OPS.fixKey.record, asked.data);
      if (result.kind !== 'ok') return refused(result);
      const [attempts, analytics] = await Promise.all([attemptsPart(asked.data.itemId), analyticsPart(asked.data.itemId)]);
      return {
        status: 200,
        reply: {
          ok: true,
          what: OPS.fixKey.what,
          view: { quiz: { kind: 'ok' as const, data: result.data }, attempts, analytics, asOf: asOf() },
        },
      };
    }
    case 'override': {
      const asked = OPS.override.record.input.safeParse(input);
      if (!asked.success) return why;
      const result = await founderRecordCall(ctx, OPS.override.record, asked.data);
      if (result.kind !== 'ok') return refused(result);
      const [quiz, analytics] = await Promise.all([quizPart(asked.data.itemId), analyticsPart(asked.data.itemId)]);
      return {
        status: 200,
        reply: {
          ok: true,
          what: OPS.override.what,
          view: { quiz, attempts: { kind: 'ok' as const, data: result.data }, analytics, asOf: asOf() },
        },
      };
    }
  }
}
