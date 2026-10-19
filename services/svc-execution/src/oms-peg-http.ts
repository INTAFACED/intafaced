/**
 * Live HTTP door: OMS peg/midpoint that is not matching peg refuses by field.
 * PX-S03 invariant 12: never map to a plain limit without preview+consent.
 * router.ts is not recut. Matching engine/peg.ts already installs peg — do not dual-implement.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { refuseLiveOmsPeg, type OmsPegRefusal } from './oms-peg-refuse.js';
import { authorizeOmsWriteRequest, type OmsWriteS2s } from './oms-write-hmac.js';

export type OmsPegDoorBody = {
  readonly peg?: boolean;
  readonly midpoint?: boolean;
  readonly relative?: boolean;
  readonly pegOffset?: string | null;
  readonly pegType?: string | null;
  readonly kind?: string | null;
};

export type OmsPegDoorDeps = {
  readonly edgeContext: (req: { headers: FastifyRequest['headers']; id: string }) => {
    principal?: { userId?: string; scopes?: readonly string[] } | null;
  };
  readonly internalSecret?: string | null;
  readonly s2s?: OmsWriteS2s;
};

const ALWAYS_REFUSE: OmsPegRefusal = {
  ok: false,
  reason: 'peg_unsupported',
  field: 'peg',
  detail: 'live OMS peg is not matching peg — refusing by field rather than mapping to a plain limit without preview+consent',
};

/** Pure door — tests call this. Any peg/midpoint on OMS refuses by field. */
export function handleOmsPegDoor(body: OmsPegDoorBody): OmsPegRefusal {
  return refuseLiveOmsPeg(body) ?? ALWAYS_REFUSE;
}

export function registerOmsPegDoor(app: FastifyInstance, deps: OmsPegDoorDeps): void {
  app.post('/execution/oms/peg', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsPegDoorBody;
    return reply.send(handleOmsPegDoor(body));
  });
}
