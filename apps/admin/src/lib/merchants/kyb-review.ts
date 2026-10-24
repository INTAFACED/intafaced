import 'server-only';
import { kybDocumentReviewViewSchema, type KybDocumentReviewView } from '@intafaced/contracts/kyb-documents';
import { payCall, type PayCallContext, type PayCallResult } from './pay-call';

/**
 * The Verification tab's read: a merchant's current business application and each document its type asks for, with
 * who gave each verdict (`kyb.documents.reviewView`, admin:compliance on a second-factor sign-in). Nothing is cached.
 */
export function loadKybReview(ctx: PayCallContext, merchantId: string): Promise<PayCallResult<KybDocumentReviewView>> {
  return payCall(ctx, 'kyb.documents.reviewView', 'GET', { merchantId }, (raw) => {
    const parsed = kybDocumentReviewViewSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  });
}
