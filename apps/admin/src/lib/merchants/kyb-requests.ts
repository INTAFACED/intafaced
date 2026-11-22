import 'server-only';
import { kybRequestsViewSchema, type KybRequestsView } from '@intafaced/contracts/kyb-information-requests';
import { type PayCallContext, type PayCallResult, payRecordRead } from './pay-call';
import { PAY_KYB_REQUESTS_REVIEW_LIST } from '@intafaced/contracts/pay-kyb-procedures';

/**
 * The Verification tab's second read: what compliance asked the merchant for, each request's due date, the merchant's
 * answer and who closed it (`kyb.requests.reviewList`, admin:compliance on a second-factor sign-in). Nothing is cached.
 */
export function loadKybRequests(ctx: PayCallContext, merchantId: string): Promise<PayCallResult<KybRequestsView>> {
  return payRecordRead(ctx, PAY_KYB_REQUESTS_REVIEW_LIST, { merchantId }, (raw) => {
    const parsed = kybRequestsViewSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  });
}
