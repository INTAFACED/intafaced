import 'server-only';
import {
  academyCourseItemRulesSchema,
  academyGrantCourseExtensionInputSchema,
  academySetCourseItemPrerequisitesInputSchema,
} from '@intafaced/contracts/academy-course-item-rules';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { AcademyCourseItemRules, ItemRulesDeskReply, ItemRulesView } from './item-rules-model';

/**
 * A course's prerequisites and learners' own due dates as the signed-in founder (AC-release-access-02). svc-academy
 * records the founder from their own token with the reason on every change, and refuses a cycle by name. No money moves.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. Prerequisites and due dates need the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

const readRules = parseWith(academyCourseItemRulesSchema);

export async function loadItemRules(ctx: FounderCallContext, courseId: string): Promise<ItemRulesView> {
  const rules = partFrom(await founderCall(ctx, 'academy', 'admin.courseItemRules', 'GET', { courseId }, readRules), (d) => d, ACADEMY);
  return { rules, asOf: new Date().toISOString() };
}

function reply(result: FounderCallResult<AcademyCourseItemRules | null>, what: string): { status: number; reply: ItemRulesDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return result.data ? { status: 200, reply: { ok: true, what, rules: result.data } } : refused(null, 502, true);
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
  setPrerequisites: {
    schema: academySetCourseItemPrerequisitesInputSchema,
    procedure: 'admin.setCourseItemPrerequisites',
    what: 'prerequisites saved',
    why: 'Choose up to 20 other assignments or quizzes of this course, and say why in up to 500 characters.',
  },
  grantExtension: {
    schema: academyGrantCourseExtensionInputSchema,
    procedure: 'admin.grantCourseExtension',
    what: 'due date moved for the learner',
    why: 'Choose an assignment, give the learner’s account id and a new due date and time, and say why in up to 500 characters.',
  },
} as const;

export type ItemRulesOp = keyof typeof OPS;
export const isItemRulesOp = (op: unknown): op is ItemRulesOp => typeof op === 'string' && Object.hasOwn(OPS, op);

export async function changeItemRules(
  ctx: FounderCallContext,
  op: ItemRulesOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: ItemRulesDeskReply } | { why: string }> {
  const spec = OPS[op];
  const { op: _op, ...input } = body;
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) return { why: spec.why };
  return reply(await founderCall(ctx, 'academy', spec.procedure, 'POST', parsed.data, readRules), spec.what);
}
