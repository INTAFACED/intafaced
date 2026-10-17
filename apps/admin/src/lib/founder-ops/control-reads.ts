import 'server-only';
import { founderControlAuditListSchema, founderLimitRequestListSchema, type FounderControlAuditListInput } from '@intafaced/contracts';
import { asTier } from '@/lib/merchants/control-model';
import { parseWith, payCall, type PayCallContext } from '@/lib/merchants/pay-call';
import { asList } from '@/lib/merchants/registry-model';
import { one, PAGE_LIMIT, type Query } from './read-model';

/**
 * The control-room reads behind the tiers (F54), limit requests (F58) and activity and audit (F64) pages. Each returns a named
 * outcome and never an invented row. Query values are checked in `control-model.ts` before they reach the service.
 */

export function loadTiers(ctx: PayCallContext) {
  return payCall(ctx, 'founderAdmin.control.tiers.list', 'GET', {}, (raw) => asList(raw, asTier));
}

const LIMIT_CURSOR = /^[1-9]\d*$/;

export function loadLimitRequests(ctx: PayCallContext, query: Query | undefined) {
  const cursor = one(query, 'cursor');
  return payCall(
    ctx,
    'founderAdmin.control.limitRequests.list',
    'GET',
    { limit: PAGE_LIMIT, ...(cursor && LIMIT_CURSOR.test(cursor) ? { cursor } : {}) },
    parseWith(founderLimitRequestListSchema),
  );
}

export function loadControlAudit(ctx: PayCallContext, input: FounderControlAuditListInput) {
  return payCall(ctx, 'founderAdmin.control.audit.list', 'GET', input, parseWith(founderControlAuditListSchema));
}
