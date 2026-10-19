/**
 * Live HTTP door: OMS display-qty that is not matching iceberg refuses.
 * Not a sold iceberg product (C03). router.ts is not recut.
 * Matching book.ts already installs iceberg — do not dual-implement.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { refuseLiveOmsIcebergDisplay, type OmsIcebergDisplayRefusal } from './oms-iceberg-display.js';
import { authorizeOmsWriteRequest, type OmsWriteS2s } from './oms-write-hmac.js';

export type OmsDisplayQtyDoorBody = {
  readonly displayQty?: string | null;
  readonly iceberg?: boolean;
  readonly kind?: string | null;
};

export type OmsDisplayQtyDoorDeps = {
  readonly edgeContext: (req: { headers: FastifyRequest['headers']; id: string }) => {
    principal?: { userId?: string; scopes?: readonly string[] } | null;
  };
  readonly internalSecret?: string | null;
  readonly s2s?: OmsWriteS2s;
};

const ALWAYS_REFUSE: OmsIcebergDisplayRefusal = {
  ok: false,
  reason: 'not_matching_iceberg',
  detail: 'live OMS iceberg/display-qty is not matching iceberg — refusing rather than silently full-display',
};

/** Pure door — tests call this. Any iceberg/display-qty on OMS refuses. */
export function handleOmsDisplayQtyDoor(body: OmsDisplayQtyDoorBody): OmsIcebergDisplayRefusal {
  return refuseLiveOmsIcebergDisplay(body) ?? ALWAYS_REFUSE;
}

export function registerOmsDisplayQtyDoor(app: FastifyInstance, deps: OmsDisplayQtyDoorDeps): void {
  app.post('/execution/oms/display-qty', async (req, reply) => {
    const auth = authorizeOmsWriteRequest(req, deps.internalSecret, deps.s2s);
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const body = (req.body ?? {}) as OmsDisplayQtyDoorBody;
    return handleOmsDisplayQtyDoor(body);
  });
}
