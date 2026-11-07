import 'server-only';
import {
  kycReviewAssignmentSchema,
  kycReviewCaseSchema,
  kycReviewListOutputSchema,
  kycReviewNoteSchema,
  type KycReviewAssignment,
  type KycReviewCase,
  type KycReviewList,
  type KycReviewNote,
} from '@intafaced/contracts/identity-kyc-cases';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { explainKycReview, type KycReviewRefusal, type KycReviewStep } from './model';

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

/** One case for review, as the signed-in person. */
export async function readKycCase(ctx: FounderCallContext, caseId: string): Promise<KycReviewAnswer<KycReviewCase>> {
  return answer(await founderCall(ctx, 'identity', 'kyc.review.case', 'GET', { caseId }, parseWith(kycReviewCaseSchema)));
}

/** A claim, a release or a note. Identity takes the reviewer from the verified session, never from this console. */
export async function runKycReviewStep(
  ctx: FounderCallContext,
  step: KycReviewStep,
): Promise<KycReviewAnswer<KycReviewAssignment | KycReviewNote>> {
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
