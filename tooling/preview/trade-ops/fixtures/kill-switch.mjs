/**
 * TEST answers for POST /admin/kill-switches, shaped like services/svc-edge (admin-api.ts, action-approval-consume.ts).
 * All TEST; nothing here is a real halt.
 *
 * The door: only the console's operator token (TEST_OPERATOR_TOKEN) opens it. A founder session token is answered
 * 403 auth.insufficient_scope, as production does (no user session carries admin:write plus MFA).
 *
 * Refusals, in the edge's order, all HTTP 400 with { error, code }:
 *   · edge.invalid_kill_switch        module not 'trade' (only the enforceable modules are armable), reason not 12..500 chars, disabled not boolean
 *   · action_approval.missing         approvalId or operationId blank
 *   · action_approval.consume_failed  the approval is not one identity knows, is not APPROVED, or is for a different command (payload hash)
 * The approval comes from the two-founder flow (propose, then approve by a DIFFERENT TEST founder, in fixtures/approvals.mjs).
 * There is no typed-in second name: a body field naming a confirmer is ignored. On success the approval is consumed
 * (spent once), the state moves, an audit entry is added at the front (newest first) and the answer is
 * { disabledModules, reasons, audit, changed, confirmOperatorId } where confirmOperatorId is the approval's approver.
 */
import { createHash } from 'node:crypto';
import { isOperatorToken, operatorDoorRefusal } from '../base.mjs';

const AUDIT_LIMIT = 200;
/** The edge audits the operator token's own identity, not the two founders (they are on identity's approval row). */
const CONSOLE_ACTOR = 'test-console-operator';

/** Same hash the console proposes with and svc-edge recomputes at consume: sha256 of { actionType, module, disabled, reason }. */
const killHash = (module, disabled, reason) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify({ actionType: 'edge.kill', module, disabled: disabled ? 'true' : 'false', reason }))
    .digest('hex')}`;

export default function routes(state) {
  const refuse = (code, error) => ({ status: 400, body: { error, code } });
  return [
    {
      method: 'POST',
      path: '/admin/kill-switches',
      handle: async ({ body, headers }) => {
        if (!isOperatorToken(headers)) return operatorDoorRefusal(headers);
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
        const known = state.approvals?.get?.(approvalId);
        if (!known || known.actionType !== 'edge.kill' || known.targetId !== 'kill:trade' || known.operationId !== operationId)
          return refuse('action_approval.consume_failed', 'identity refused consumeForEdge (404) approval not found');
        if (known.status !== 'APPROVED' || !known.approverId)
          return refuse('action_approval.consume_failed', `identity refused consumeForEdge (412) the approval is ${known.status}`);
        if (known.payloadHash !== killHash(b.module, b.disabled, b.reason))
          return refuse('action_approval.consume_failed', 'identity refused consumeForEdge (412) the approval is for a different command');
        const approver = known.approverId;
        known.status = 'CONSUMED';

        const ks = state.killSwitch;
        const previous = ks.disabledModules.includes('trade');
        const recorded = `${b.reason} (by ${CONSOLE_ACTOR}; confirmed ${approver})`;
        ks.audit.unshift({
          at: new Date().toISOString(),
          module: 'trade',
          actor: CONSOLE_ACTOR,
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
