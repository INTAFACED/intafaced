import 'server-only';
import { kybRequestsViewSchema, type KybRequestsView } from '@intafaced/contracts/kyb-information-requests';
import { payCall, type PayCallContext, type PayCallResult } from './pay-call';

/**
 * The Verification tab's second read: what compliance asked the merchant for, each request's due date, the merchant's
 * answer and who closed it (`kyb.requests.reviewList`, admin:compliance on a second-factor sign-in). Nothing is cached.
 */
export function loadKybRequests(ctx: PayCallContext, merchantId: string): Promise<PayCallResult<KybRequestsView>> {
  return payCall(ctx, 'kyb.requests.reviewList', 'GET', { merchantId }, (raw) => {
    const parsed = kybRequestsViewSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  });
}
