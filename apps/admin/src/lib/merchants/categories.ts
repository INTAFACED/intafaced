import 'server-only';
import {
  categoryPolicyEventSchema,
  categoryPolicyViewSchema,
  type CategoryPolicyEvent,
  type CategoryPolicyView,
} from '@intafaced/contracts/business-category';
import { parseWith, payCall, type PayCallContext, type PayCallResult } from './pay-call';

/** The business category table (`founderAdmin.categoryPolicy.list`) and its latest edits, read fresh on every page load. */
export function loadCategoryPolicy(ctx: PayCallContext): Promise<PayCallResult<CategoryPolicyView>> {
  return payCall(ctx, 'founderAdmin.categoryPolicy.list', 'GET', {}, parseWith(categoryPolicyViewSchema));
}

export function loadCategoryHistory(ctx: PayCallContext): Promise<PayCallResult<CategoryPolicyEvent[]>> {
  return payCall(ctx, 'founderAdmin.categoryPolicy.history', 'GET', { limit: 50 }, (raw) => {
    if (!Array.isArray(raw)) return null;
    const events = raw.map((e) => categoryPolicyEventSchema.safeParse(e));
    return events.every((e) => e.success) ? events.map((e) => e.data!) : null;
  });
}
