import 'server-only';
import { type FounderControlAuditListInput } from '@intafaced/contracts';
import { asList, asTier, type PayCallContext, payRecordRead, payRecordCall } from '@/lib/merchants';
import { one, PAGE_LIMIT, type Query } from './read-model';
import {
  PAY_FOUNDER_ADMIN_CONTROL_TIERS_LIST,
  PAY_FOUNDER_ADMIN_CONTROL_LIMIT_REQUESTS_LIST,
  PAY_FOUNDER_ADMIN_CONTROL_AUDIT_LIST,
} from '@intafaced/contracts/pay-founder-admin-procedures';

/**
 * The control-room reads behind the tiers (F54), limit requests (F58) and activity and audit (F64) pages. Each returns a named
 * outcome and never an invented row. Query values are checked in `control-model.ts` before they reach the service.
 */

export function loadTiers(ctx: PayCallContext) {
  return payRecordRead(ctx, PAY_FOUNDER_ADMIN_CONTROL_TIERS_LIST, {}, (raw) => asList(raw, asTier));
}

const LIMIT_CURSOR = /^[1-9]\d*$/;

export function loadLimitRequests(ctx: PayCallContext, query: Query | undefined) {
  const cursor = one(query, 'cursor');
  return payRecordCall(ctx, PAY_FOUNDER_ADMIN_CONTROL_LIMIT_REQUESTS_LIST, {
    limit: PAGE_LIMIT,
    ...(cursor && LIMIT_CURSOR.test(cursor) ? { cursor } : {}),
  });
}

export function loadControlAudit(ctx: PayCallContext, input: FounderControlAuditListInput) {
  return payRecordCall(ctx, PAY_FOUNDER_ADMIN_CONTROL_AUDIT_LIST, input);
}
