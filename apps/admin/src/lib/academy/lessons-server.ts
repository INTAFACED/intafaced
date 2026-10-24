import 'server-only';
import {
  academyAssistantDraftInputSchema,
  academyDecideDraftInputSchema,
  academyDuplicateItemInputSchema,
  academyImportLessonInputSchema,
  academyImportLessonResultSchema,
  academyLessonSchema,
  academyPublishLessonInputSchema,
  academyRevertLessonInputSchema,
  academySaveLessonInputSchema,
} from '@intafaced/contracts/academy-courses';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { AcademyLesson, LessonDeskReply, LessonView } from './lessons-model';

/**
 * The lesson editor as the signed-in founder. svc-academy keeps every lesson revision and records the founder from their
 * own token on every save, revert, publish and duplicate. No money moves and no learner record is written.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. The lesson editor needs the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

const readLesson = parseWith(academyLessonSchema);
const readImport = parseWith(academyImportLessonResultSchema);

export async function loadLesson(ctx: FounderCallContext, itemId: string): Promise<LessonView> {
  const lesson = await founderCall(ctx, 'academy', 'admin.lesson', 'GET', { itemId }, readLesson);
  return { lesson: partFrom(lesson, (d) => d, ACADEMY), asOf: new Date().toISOString() };
}

function reply(result: FounderCallResult<AcademyLesson | null>, what: string): { status: number; reply: LessonDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return result.data ? { status: 200, reply: { ok: true, what, lesson: result.data } } : refused(null, 502, true);
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
    schema: academySaveLessonInputSchema,
    procedure: 'admin.saveLesson',
    what: 'lesson saved',
    why: 'Each block needs its content: text, an https address with its words, or code with its language. A lesson has 1 to 200 blocks.',
  },
  revert: {
    schema: academyRevertLessonInputSchema,
    procedure: 'admin.revertLesson',
    what: 'reverted',
    why: 'Which lesson, read at which revision, back to which revision?',
  },
  publish: {
    schema: academyPublishLessonInputSchema,
    procedure: 'admin.publishLesson',
    what: 'published to learners',
    why: 'Which revision goes to learners, and why? Say why in up to 500 characters.',
  },
  draft: {
    schema: academyAssistantDraftInputSchema,
    procedure: 'admin.assistantDraft',
    what: 'draft ready to review',
    why: 'Which lesson, read at which revision, and which path: the template or a model?',
  },
  decide: {
    schema: academyDecideDraftInputSchema,
    procedure: 'admin.decideDraft',
    what: 'draft decided',
    why: 'Which draft, and accept or discard?',
  },
  duplicate: {
    schema: academyDuplicateItemInputSchema,
    procedure: 'admin.duplicateItem',
    what: 'duplicated',
    why: 'Which item, read at which course revision?',
  },
} as const;

export type LessonOp = keyof typeof OPS | 'import';
export const isLessonOp = (op: unknown): op is LessonOp => typeof op === 'string' && (op === 'import' || Object.hasOwn(OPS, op));

/** A lesson file: refused by size before it is read, or a report of each bad block with nothing created. */
async function importLesson(ctx: FounderCallContext, body: Record<string, unknown>) {
  const { op: _op, ...input } = body;
  const parsed = academyImportLessonInputSchema.safeParse(input);
  if (!parsed.success) return { why: 'Which lesson, read at which revision, and which file?' };
  const result = await founderCall(ctx, 'academy', 'admin.importLesson', 'POST', parsed.data, readImport);
  if (result.kind === 'ok' && result.data?.outcome === 'invalid')
    return {
      status: 422,
      reply: {
        ok: false as const,
        title: 'The file has problems',
        body: 'svc-academy read the file and found blocks it does not accept. They are listed below.',
        next: 'Fix the file and import it again. Nothing was created.',
        code: 'academy.import_invalid',
        changed: 'no' as const,
        problems: result.data.problems,
      },
    };
  return reply(result.kind === 'ok' ? { ...result, data: result.data?.lesson ?? null } : result, 'imported');
}

export async function changeLesson(
  ctx: FounderCallContext,
  op: LessonOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: LessonDeskReply } | { why: string }> {
  if (op === 'import') return importLesson(ctx, body);
  const spec = OPS[op];
  const { op: _op, ...input } = body;
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) return { why: spec.why };
  return reply(await founderCall(ctx, 'academy', spec.procedure, 'POST', parsed.data, readLesson), spec.what);
}
