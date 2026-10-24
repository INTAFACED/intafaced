import 'server-only';
import {
  academyGradeSubmissionInputSchema,
  academyGradingQueueSchema,
  academyOpenGradingInputSchema,
} from '@intafaced/contracts/academy-courses';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { AcademyGradingQueue, GradingDeskReply, GradingView } from './grading-model';

/**
 * One assignment's grading queue as the signed-in founder (AC-assignments-02). svc-academy shows learners under aliases,
 * holds the grader lease and records the founder from their own token on every grade. No money moves.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. Grading needs the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

const readQueue = parseWith(academyGradingQueueSchema);

export async function loadGradingQueue(ctx: FounderCallContext, itemId: string): Promise<GradingView> {
  const queue = await founderCall(ctx, 'academy', 'admin.gradingQueue', 'GET', { itemId }, readQueue);
  return { queue: partFrom(queue, (d) => d, ACADEMY), asOf: new Date().toISOString() };
}

function reply(result: FounderCallResult<AcademyGradingQueue | null>, what: string): { status: number; reply: GradingDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return result.data ? { status: 200, reply: { ok: true, what, queue: result.data } } : refused(null, 502, true);
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
  open: {
    schema: academyOpenGradingInputSchema,
    procedure: 'admin.openGrading',
    what: 'hand-in opened for grading',
    why: 'Which hand-in?',
  },
  grade: {
    schema: academyGradeSubmissionInputSchema,
    procedure: 'admin.gradeSubmission',
    what: 'grade saved',
    why: 'A score is a number from 0 with at most two decimals; a comment runs to 5,000 characters and a reason to 500.',
  },
} as const;

export type GradingOp = keyof typeof OPS;
export const isGradingOp = (op: unknown): op is GradingOp => typeof op === 'string' && Object.hasOwn(OPS, op);

export async function changeGrading(
  ctx: FounderCallContext,
  op: GradingOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: GradingDeskReply } | { why: string }> {
  const spec = OPS[op];
  const { op: _op, ...input } = body;
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) return { why: spec.why };
  return reply(await founderCall(ctx, 'academy', spec.procedure, 'POST', parsed.data, readQueue), spec.what);
}
