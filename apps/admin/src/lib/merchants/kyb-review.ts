import 'server-only';
import { kybDocumentReviewViewSchema, type KybDocumentReviewView } from '@intafaced/contracts/kyb-documents';
import { type PayCallContext, type PayCallResult, payRecordRead } from './pay-call';
import { PAY_KYB_DOCUMENTS_REVIEW_VIEW } from '@intafaced/contracts/pay-kyb-procedures';

/**
 * The Verification tab's read: a merchant's current business application and each document its type asks for, with
 * who gave each verdict (`kyb.documents.reviewView`, admin:compliance on a second-factor sign-in). Nothing is cached.
 */
export function loadKybReview(ctx: PayCallContext, merchantId: string): Promise<PayCallResult<KybDocumentReviewView>> {
  return payRecordRead(ctx, PAY_KYB_DOCUMENTS_REVIEW_VIEW, { merchantId }, (raw) => {
    const parsed = kybDocumentReviewViewSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  });
}
