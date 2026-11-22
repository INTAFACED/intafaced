import 'server-only';
import { categoryPolicyEventSchema, type CategoryPolicyEvent, type CategoryPolicyView } from '@intafaced/contracts/business-category';
import { type PayCallContext, type PayCallResult, payRecordCall, payRecordRead } from './pay-call';
import {
  PAY_FOUNDER_ADMIN_CATEGORY_POLICY_LIST,
  PAY_FOUNDER_ADMIN_CATEGORY_POLICY_HISTORY,
} from '@intafaced/contracts/pay-founder-admin-procedures';

/** The business category table (`founderAdmin.categoryPolicy.list`) and its latest edits, read fresh on every page load. */
export function loadCategoryPolicy(ctx: PayCallContext): Promise<PayCallResult<CategoryPolicyView>> {
  return payRecordCall(ctx, PAY_FOUNDER_ADMIN_CATEGORY_POLICY_LIST, {});
}

export function loadCategoryHistory(ctx: PayCallContext): Promise<PayCallResult<CategoryPolicyEvent[]>> {
  return payRecordRead(ctx, PAY_FOUNDER_ADMIN_CATEGORY_POLICY_HISTORY, { limit: 50 }, (raw) => {
    if (!Array.isArray(raw)) return null;
    const events = raw.map((e) => categoryPolicyEventSchema.safeParse(e));
    return events.every((e) => e.success) ? events.map((e) => e.data!) : null;
  });
}
