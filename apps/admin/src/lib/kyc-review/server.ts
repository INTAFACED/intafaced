import 'server-only';
import {
  kycAppealSchema,
  kycInfoTaskSchema,
  kycReviewAssignmentSchema,
  kycReviewCaseSchema,
  kycReviewListOutputSchema,
  kycReviewNoteSchema,
  type KycAppeal,
  type KycInfoTask,
  type KycReviewAssignment,
  type KycReviewCase,
  type KycReviewList,
  type KycReviewNote,
} from '@intafaced/contracts/identity-kyc-cases';
import { kycCapabilitiesOutputSchema, type KycCapabilitiesOutput } from '@intafaced/contracts/identity-kyc-capabilities';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { readKybCurrent, type KybCurrent } from './business';
import { explainKycReview, type KycReviewRefusal, type KycReviewStep } from './model';

/** Identity's answer to a request for information: the case and its tasks, each exactly the contract's. */
function readTasks(raw: unknown): { caseId: string; tasks: KycInfoTask[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.caseId !== 'string' || !Array.isArray(r.tasks)) return null;
  const tasks: KycInfoTask[] = [];
  for (const t of r.tasks) {
    const parsed = kycInfoTaskSchema.safeParse(t);
    if (!parsed.success) return null;
    tasks.push(parsed.data);
  }
  return { caseId: r.caseId, tasks };
}

/** What the console route returns: identity's answer, or its refusal in words. */
export type KycReviewAnswer<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly refusal: KycReviewRefusal };

function answer<T>(result: FounderCallResult<T>): KycReviewAnswer<T> {
  if (result.kind === 'ok') return { ok: true, data: result.data };
  if (result.kind === 'forbidden' || result.kind === 'refused')
    return { ok: false, refusal: explainKycReview(result.refusal.code, result.refusal.status) };
  if (result.kind === 'not_built')
    return {
      ok: false,
      refusal: {
        code: 'admin.not_built',
        title: 'Identity does not have the review queue',
        body: `${result.procedure} is not on this identity.`,
      },
    };
  if (result.kind === 'invalid')
    return {
      ok: false,
      refusal: {
        code: 'admin.ops_invalid_response',
        title: 'Identity sent an answer this console cannot read',
        body: 'Nothing is shown rather than a guess.',
      },
    };
  return { ok: false, refusal: explainKycReview(null, 503) };
}

/** One page of open cases, as the signed-in person. */
export async function readKycQueue(ctx: FounderCallContext, cursor: string | null): Promise<KycReviewAnswer<KycReviewList>> {
  return answer(
    await founderCall(ctx, 'identity', 'kyc.review.list', 'GET', cursor ? { cursor } : {}, parseWith(kycReviewListOutputSchema)),
  );
}

/** One person's capabilities (what their verification lets them do), as the signed-in reviewer. */
export async function readKycCapabilities(ctx: FounderCallContext, userId: string): Promise<KycReviewAnswer<KycCapabilitiesOutput>> {
  return answer(await founderCall(ctx, 'identity', 'kyc.capabilities.getFor', 'GET', { userId }, parseWith(kycCapabilitiesOutputSchema)));
}

/** A business's verification status as svc-pay holds it (`kyb.current`), read as the signed-in reviewer. */
export async function readBusinessApplication(ctx: FounderCallContext, merchantId: string): Promise<KycReviewAnswer<KybCurrent>> {
  return answer(await founderCall(ctx, 'pay', 'kyb.current', 'GET', { merchantId }, readKybCurrent));
}

/** One case for review, as the signed-in person. */
export async function readKycCase(ctx: FounderCallContext, caseId: string): Promise<KycReviewAnswer<KycReviewCase>> {
  return answer(await founderCall(ctx, 'identity', 'kyc.review.case', 'GET', { caseId }, parseWith(kycReviewCaseSchema)));
}

/** A claim, a release or a note. Identity takes the reviewer from the verified session, never from this console. */
export async function runKycReviewStep(
  ctx: FounderCallContext,
  step: KycReviewStep,
): Promise<KycReviewAnswer<KycReviewAssignment | KycReviewNote | KycAppeal | { caseId: string; tasks: KycInfoTask[] }>> {
  if (step.op === 'rfi')
    return answer(
      await founderCall(ctx, 'identity', 'kyc.review.requestInfo', 'POST', { caseId: step.caseId, items: step.items }, readTasks),
    );
  if (step.op === 'appeal')
    return answer(
      await founderCall(
        ctx,
        'identity',
        'kyc.review.decideAppeal',
        'POST',
        { caseId: step.caseId, decision: step.decision },
        parseWith(kycAppealSchema),
      ),
    );
  if (step.op === 'assign')
    return answer(
      await founderCall(
        ctx,
        'identity',
        'kyc.review.assign',
        'POST',
        { caseId: step.caseId, action: step.action },
        parseWith(kycReviewAssignmentSchema),
      ),
    );
  return answer(
    await founderCall(
      ctx,
      'identity',
      'kyc.review.addNote',
      'POST',
      { caseId: step.caseId, body: step.body },
      parseWith(kycReviewNoteSchema),
    ),
  );
}
