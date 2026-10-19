/**
 * Live HTTP door hitches paperRunAlgoParent. Paper stays paper — no children,
 * no submit, no ledger. Family twap/vwap/pov/sniper/trailing extras refuse
 * rather than dual-implement slice. oms-slice.ts stays the live twap|vwap|pov
 * door. Mill files and router.ts are not recut. Never withdrawHold.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { refuseLiveOmsPaper, type OmsPaperUnsupportedRefuse } from './oms-paper-refuse.js';
import { paperRunAlgoParent, type OmsPaperResult, type PaperGate } from './oms-paper.js';
import type { ApprovedAlgoParentStore } from './oms-start.js';
import { authorizeOmsWriteRequest, type OmsWriteS2s } from './oms-write-hmac.js';

export type OmsPaperDoorBody = {
  readonly parentClientOrderId?: string;
  readonly kind?: string | null;
  readonly paper?: boolean | PaperGate;
  readonly parentStore?: ApprovedAlgoParentStore;
};

export type OmsPaperDoorDeps = {
  readonly edgeContext: (req: { headers: FastifyRequest['headers']; id: string }) => {
    principal?: { userId?: string; scopes?: readonly string[] } | null;
  };
  readonly internalSecret?: string | null;
  readonly s2s?: OmsWriteS2s;
  readonly parentStore?: ApprovedAlgoParentStore;
  readonly paper?: PaperGate;
};

/** Pure door — tests call this. Hitch mill; stores stay unwired unless passed.
 * The body cannot open the server paper gate or shadow the server parent store.
 */
export function handleOmsPaperDoor(body: OmsPaperDoorBody, deps: OmsPaperDoorDeps = { edgeContext: () => ({}) }): OmsPaperResult {
  return paperRunAlgoParent({
    parentClientOrderId: body.parentClientOrderId,
    parentStore: deps.parentStore,
    paper: deps.paper,
  });
}

export function handleOmsPaperExtraDoor(body: OmsPaperDoorBody): OmsPaperUnsupportedRefuse | { readonly ok: true } {
  const extra = refuseLiveOmsPaper({
    kind: body.kind,
    paper: body.paper === true,
  });
  if (extra) return extra;
  return { ok: true };
}

export function registerOmsPaperDoor(app: FastifyInstance, deps: OmsPaperDoorDeps): void {
  app.post('/execution/oms/paper', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsPaperDoorBody;
    return reply.send(handleOmsPaperDoor(body, deps));
  });

  app.post('/execution/oms/paper-extra', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsPaperDoorBody;
    return reply.send(handleOmsPaperExtraDoor(body));
  });
}
