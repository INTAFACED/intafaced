/**
 * Live HTTP doors hitch UNIT_ONLY care-desk mill helpers (claim / assign / pass /
 * shift / fill-confirm / fill-assign / manual-fill / abandon).
 * Unset discretion cap refuses. Manual fill is HMAC as svc-execution and
 * uses mill ledger qty/price strings — never a sidecar. Mill files are not recut.
 * router.ts is not recut. Never submit to matching. Never withdrawHold.
 * Do not invent stores, operators, or ledger posts.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { refuseUnsetDiscretionCap, type OmsDiscretionRefusal } from './oms-discretion-refuse.js';
import { claimLiveAlgoParent, type OmsClaimResult } from './oms-claim.js';
import { assignOrphanedChildFill, type OmsAssignResult } from './oms-assign.js';
import { passLiveAlgoParent, type OmsPassResult } from './oms-pass.js';
import { shiftLiveAlgoParent, type OmsShiftResult } from './oms-shift.js';
import { confirmChildFill, type OmsFillConfirmResult } from './oms-fill-confirm.js';
import { assignChildFill, type OmsAssignFillResult } from './oms-fill-assign.js';
import { recordManualChildFill, type OmsManualFillResult } from './oms-manual-fill.js';
import { abandonStagedParent, type OmsAbandonResult } from './oms-abandon.js';
import { authorizeOmsWriteRequest, type OmsWriteS2s } from './oms-write-hmac.js';

export type OmsCareDoorBody = {
  readonly discretionCap?: string | null;
  readonly action?: string;
  readonly parentClientOrderId?: string;
  readonly operatorId?: string;
  readonly clientOrderId?: string;
  readonly confirmerId?: string;
  readonly targetOperatorId?: string;
  readonly incomingOperatorId?: string;
  readonly expireAt?: string;
  readonly accountTag?: string;
  readonly amount?: string;
  readonly price?: string;
  readonly side?: string;
  readonly parentCap?: string;
};

export type OmsCareActionRefusal = {
  readonly ok: false;
  readonly reason: 'action_required';
  readonly detail: string;
};

export type OmsCareDoorResult =
  | OmsDiscretionRefusal
  | OmsCareActionRefusal
  | OmsClaimResult
  | OmsAssignResult
  | OmsPassResult
  | OmsShiftResult
  | OmsFillConfirmResult
  | OmsAssignFillResult
  | OmsManualFillResult
  | OmsAbandonResult;

export type OmsCareDoorDeps = {
  readonly edgeContext: (req: { headers: FastifyRequest['headers']; id: string }) => {
    principal?: { userId?: string; scopes?: readonly string[] } | null;
  };
  readonly internalSecret?: string | null;
  readonly s2s?: OmsWriteS2s;
};

function millManualFill(body: OmsCareDoorBody): OmsManualFillResult {
  return recordManualChildFill({
    parentClientOrderId: body.parentClientOrderId,
    clientOrderId: body.clientOrderId,
    amount: body.amount,
    price: body.price,
    side: body.side === 'buy' || body.side === 'sell' ? body.side : undefined,
    parentCap: body.parentCap,
    confirmerId: body.confirmerId,
  });
}

/** Pure door — dedicated discretion check. Never invents a desk limit. */
export function handleOmsCareDiscretionDoor(body: OmsCareDoorBody) {
  return refuseUnsetDiscretionCap(body.discretionCap);
}

/** Pure door — tests call this. Discretion refuse first, then mill hitch. A missing or unknown action refuses. Stores stay unwired. */
export function handleOmsCareDoor(body: OmsCareDoorBody): OmsCareDoorResult {
  const cap = refuseUnsetDiscretionCap(body.discretionCap);
  if (!cap.ok) return cap;
  const action = body.action?.trim().toLowerCase() ?? '';
  if (action === 'claim') return claimLiveAlgoParent(body);
  if (action === 'assign') return assignOrphanedChildFill(body);
  if (action === 'pass') return passLiveAlgoParent(body);
  if (action === 'shift') return shiftLiveAlgoParent(body);
  if (action === 'fill-confirm' || action === 'fill_confirm') return confirmChildFill(body);
  if (action === 'fill-assign' || action === 'fill_assign') return assignChildFill(body);
  if (action === 'manual-fill' || action === 'manual_fill') return millManualFill(body);
  if (action === 'abandon') return abandonStagedParent(body);
  return {
    ok: false,
    reason: 'action_required',
    detail: 'care action is missing or unknown — refusing rather than reporting success',
  };
}

export function registerOmsCareDoor(app: FastifyInstance, deps: OmsCareDoorDeps): void {
  app.post('/execution/oms/care', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsCareDoorBody;
    return reply.send(handleOmsCareDoor(body));
  });

  app.post('/execution/oms/care-manual-fill', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsCareDoorBody;
    const cap = refuseUnsetDiscretionCap(body.discretionCap);
    if (!cap.ok) return reply.send(cap);
    return reply.send(millManualFill(body));
  });
}
