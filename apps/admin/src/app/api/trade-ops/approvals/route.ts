import { actOnApproval, proposeRestriction, restrictionPayloadHash } from '@/lib/trade-ops/approvals-calls';
import { validateAct, validateApply } from '@/lib/trade-ops/approvals';
import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { BLOCKERS } from '@/lib/trade-ops/blockers';
import { blocked, ok, refused } from '@/lib/trade-ops/outcome';
import { validateChange } from '@/lib/trade-ops/restrictions';

/**
 * Freezes & approvals BFF. Founder session + CSRF are checked by tradeOpsRoute; every call to identity carries the
 * signed-in operator's own token, so the service (not this file) decides who the requester and approver are.
 *
 *   POST { action: 'hash',    userId, change, reason, expectedVersion }  work out the payload hash of a change (no call)
 *   POST { action: 'propose', userId, change: 'restrict'|'restore', reason, expectedVersion }
 *   POST { action: 'approve', approvalId, expectedPayloadHash, knownRequesterId? }
 *   POST { action: 'reject' | 'revoke', approvalId, knownRequesterId? }
 *   POST { action: 'apply', ... }   BLOCKED (restriction_no_four_eyes): validated, then refused with the typed blocker.
 */
export const dynamic = 'force-dynamic';

export const POST = (req: Request) =>
  tradeOpsRoute(req, async (ctx, body) => {
    const action = body.action;
    if (action === 'hash' || action === 'propose' || action === 'apply') {
      const change = validateChange({ ...body, action: body.change });
      if (!change.ok) return refused(change.code, change.message, 400);
      if (action === 'hash') return ok({ payloadHash: restrictionPayloadHash(change.value) });
      if (action === 'apply') {
        const apply = validateApply(body);
        if (!apply.ok) return refused(apply.code, apply.message, 400);
        return blocked(BLOCKERS.restriction_no_four_eyes);
      }
      return proposeRestriction(ctx, change.value);
    }
    if (action === 'approve' || action === 'reject' || action === 'revoke') {
      const act = validateAct({ ...body, verb: action }, ctx.session.userId);
      if (!act.ok) return refused(act.code, act.message, act.code === 'action_approval.same_person' ? 409 : 400);
      return actOnApproval(ctx, act.value);
    }
    return refused('trade_ops.action_unknown', 'Unknown approvals action.', 400);
  });
