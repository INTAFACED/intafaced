import 'server-only';
import { academyCourseGradebookSchema, academySaveGradingPolicyInputSchema } from '@intafaced/contracts/academy-course-gradebook';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { AcademyCourseGradebook, GradebookDeskReply, GradebookView } from './gradebook-model';

/**
 * A course's grading policy and gradebook as the signed-in founder (AC-assignments-04). svc-academy records the founder
 * from their own token with the reason on every save, refuses weights that do not add up to exactly 1, and works every
 * figure out from stored grades. No money moves.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. The gradebook needs the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

const readGradebook = parseWith(academyCourseGradebookSchema);

export async function loadGradebook(ctx: FounderCallContext, courseId: string): Promise<GradebookView> {
  const gradebook = partFrom(
    await founderCall(ctx, 'academy', 'admin.courseGradebook', 'GET', { courseId }, readGradebook),
    (d) => d,
    ACADEMY,
  );
  return { gradebook, asOf: new Date().toISOString() };
}

function reply(result: FounderCallResult<AcademyCourseGradebook | null>, what: string): { status: number; reply: GradebookDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return result.data ? { status: 200, reply: { ok: true, what, gradebook: result.data } } : refused(null, 502, true);
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

const WHY =
  'Each type needs a name, a weight from 0.0001 to 1 with up to four places, a whole number of lowest scores to drop and at least one item. Say why in up to 500 characters.';

export const isGradebookOp = (op: unknown): op is 'savePolicy' => op === 'savePolicy';

export async function changeGradebook(
  ctx: FounderCallContext,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: GradebookDeskReply } | { why: string }> {
  const { op: _op, ...input } = body;
  const parsed = academySaveGradingPolicyInputSchema.safeParse(input);
  if (!parsed.success) return { why: WHY };
  return reply(await founderCall(ctx, 'academy', 'admin.saveGradingPolicy', 'POST', parsed.data, readGradebook), 'grading policy saved');
}
