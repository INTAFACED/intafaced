import 'server-only';
import {
  academyAdminAssignmentSchema,
  academySaveAssignmentInputSchema,
  academyWithdrawAssignmentInputSchema,
} from '@intafaced/contracts/academy-courses';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { AcademyAdminAssignment, AssignmentDeskReply, AssignmentView } from './assignments-model';

/**
 * An assignment's brief as the signed-in founder (AC-assignments-01). svc-academy keeps the revision and records the
 * founder from their own token on every save and withdraw. No money moves and no learner record is written.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. The assignment editor needs the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

const readAssignment = parseWith(academyAdminAssignmentSchema);

export async function loadAssignment(ctx: FounderCallContext, itemId: string): Promise<AssignmentView> {
  const assignment = await founderCall(ctx, 'academy', 'admin.assignment', 'GET', { itemId }, readAssignment);
  return { assignment: partFrom(assignment, (d) => d, ACADEMY), asOf: new Date().toISOString() };
}

function reply(result: FounderCallResult<AcademyAdminAssignment | null>, what: string): { status: number; reply: AssignmentDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return result.data ? { status: 200, reply: { ok: true, what, assignment: result.data } } : refused(null, 502, true);
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
    schema: academySaveAssignmentInputSchema,
    procedure: 'admin.saveAssignment',
    what: 'assignment saved',
    why: 'An assignment needs instructions, points above zero with at most two decimals, and a text answer, a file or both.',
  },
  withdraw: {
    schema: academyWithdrawAssignmentInputSchema,
    procedure: 'admin.withdrawAssignment',
    what: 'assignment withdrawn',
    why: 'Which assignment, and why withdraw it? Say why in up to 500 characters.',
  },
} as const;

export type AssignmentOp = keyof typeof OPS;
export const isAssignmentOp = (op: unknown): op is AssignmentOp => typeof op === 'string' && Object.hasOwn(OPS, op);

export async function changeAssignment(
  ctx: FounderCallContext,
  op: AssignmentOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: AssignmentDeskReply } | { why: string }> {
  const spec = OPS[op];
  const { op: _op, ...input } = body;
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) return { why: spec.why };
  return reply(await founderCall(ctx, 'academy', spec.procedure, 'POST', parsed.data, readAssignment), spec.what);
}
