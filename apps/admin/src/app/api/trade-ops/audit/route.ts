import { readRestrictionHistory } from '@/lib/trade-ops/approvals-calls';
import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { BLOCKERS } from '@/lib/trade-ops/blockers';
import { auditRowsFromKillSwitch, auditRowsFromRestrictions } from '@/lib/trade-ops/audit-rows';
import { readKillSwitchSnapshot } from '@/lib/trade-ops/reads';
import { blocked, ok, refused } from '@/lib/trade-ops/outcome';
import { historyRows, validateLimit, validateUserId } from '@/lib/trade-ops/restrictions';

/**
 * Audit BFF (reads only).
 *   POST { action: 'restriction_history', userId, limit? }  restriction history of one account, as audit rows
 *   POST { action: 'kill_switch' }                           the kill-switch audit tail, as audit rows
 *   POST { action: 'combined' }                              BLOCKED (audit_feed_missing): there is no combined feed
 */
export const dynamic = 'force-dynamic';

export const POST = (req: Request) =>
  tradeOpsRoute(req, async (ctx, body) => {
    if (body.action === 'combined') return blocked(BLOCKERS.audit_feed_missing);
    if (body.action === 'kill_switch') {
      const snap = await readKillSwitchSnapshot(ctx);
      return snap.kind === 'ok' ? ok(auditRowsFromKillSwitch(snap.data.audit), snap.asOf) : snap;
    }
    if (body.action === 'restriction_history') {
      const user = validateUserId(body.userId);
      if (!user.ok) return refused(user.code, user.message, 400);
      const limit = validateLimit(body.limit ?? 100);
      if (!limit.ok) return refused(limit.code, limit.message, 400);
      const history = await readRestrictionHistory(ctx, user.value, limit.value);
      return history.kind === 'ok' ? ok(auditRowsFromRestrictions(historyRows(history.data)), history.asOf) : history;
    }
    return refused('trade_ops.action_unknown', 'Unknown audit action.', 400);
  });
