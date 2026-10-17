/**
 * TEST answers for POST /admin/kill-switches, shaped like services/svc-edge (admin-api.ts, dual-control.ts,
 * action-approval-consume.ts). All TEST; nothing here is a real halt.
 *
 * Refusals, in the edge's order, all HTTP 400 with { error, code }:
 *   · edge.invalid_kill_switch        module not 'trade' (only the enforceable modules are armable), reason not 12..500 chars, disabled not boolean
 *   · action_approval.missing         approvalId or operationId blank
 *   · action_approval.consume_failed  the approval is not one this TEST edge knows
 *   · missing_operator                the confirming operator is blank or the same as the signed-in operator
 * Approvals: an id found in state.approvals (if another fixture fills it) is used with its approver; an id that
 * starts with "test-" is accepted as a TEST approval whose approver is the typed confirmOperatorId; anything else is refused.
 * On success the state moves, an audit entry is added at the front (newest first) and the answer is
 * { disabledModules, reasons, audit, changed, confirmOperatorId }.
 */
import { NITRO } from '../base.mjs';

const AUDIT_LIMIT = 200;

export default function routes(state) {
  const refuse = (code, error) => ({ status: 400, body: { error, code } });
  return [
    {
      method: 'POST',
      path: '/admin/kill-switches',
      handle: async ({ body }) => {
        const b = body && typeof body === 'object' ? body : {};
        if (typeof b.module !== 'string' || b.module !== 'trade')
          return refuse(
            'edge.invalid_kill_switch',
            `"${String(b.module)}" cannot be halted at this edge: this TEST edge arms only the trade module`,
          );
        if (typeof b.disabled !== 'boolean') return refuse('edge.invalid_kill_switch', 'Expected boolean, received ' + typeof b.disabled);
        if (typeof b.reason !== 'string' || b.reason.length < 12)
          return refuse('edge.invalid_kill_switch', 'String must contain at least 12 character(s)');
        if (b.reason.length > 500) return refuse('edge.invalid_kill_switch', 'String must contain at most 500 character(s)');
        if (b.approvalId != null && String(b.approvalId).length > 128)
          return refuse('edge.invalid_kill_switch', 'String must contain at most 128 character(s)');
        if (b.operationId != null && String(b.operationId).length > 128)
          return refuse('edge.invalid_kill_switch', 'String must contain at most 128 character(s)');
        const approvalId = String(b.approvalId ?? '').trim();
        const operationId = String(b.operationId ?? '').trim();
        if (!approvalId || !operationId)
          return refuse('action_approval.missing', 'approvalId and operationId are required; a typed-in second name is not approval');
        const typedConfirm = typeof b.confirmOperatorId === 'string' ? b.confirmOperatorId.trim() : '';
        const known = state.approvals?.get?.(approvalId);
        let approver;
        if (known) approver = known.approverId ?? known.requesterId ?? null;
        else if (approvalId.startsWith('test-')) approver = typedConfirm || null;
        else return refuse('action_approval.consume_failed', 'identity refused consumeForEdge (404) approval not found');
        if (!approver)
          return refuse('missing_operator', 'confirming operator identity is required; the edge does not invent a second caller');
        if (approver === NITRO)
          return refuse('missing_operator', 'confirming operator must be a distinct identity; the edge does not invent a second caller');

        const ks = state.killSwitch;
        const previous = ks.disabledModules.includes('trade');
        const recorded = `${b.reason} (by ${NITRO}; confirmed ${approver})`;
        ks.audit.unshift({
          at: new Date().toISOString(),
          module: 'trade',
          actor: NITRO,
          confirmOperatorId: approver,
          reason: b.reason,
          previous,
          next: b.disabled,
          changed: previous !== b.disabled,
        });
        if (ks.audit.length > AUDIT_LIMIT) ks.audit.pop();
        if (b.disabled) {
          if (!previous) ks.disabledModules.push('trade');
          ks.reasons.trade = recorded;
        } else {
          ks.disabledModules = ks.disabledModules.filter((m) => m !== 'trade');
          delete ks.reasons.trade;
        }
        return {
          status: 200,
          body: {
            disabledModules: ks.disabledModules,
            reasons: ks.reasons,
            audit: ks.audit,
            changed: previous !== b.disabled,
            confirmOperatorId: approver,
          },
        };
      },
    },
  ];
}
