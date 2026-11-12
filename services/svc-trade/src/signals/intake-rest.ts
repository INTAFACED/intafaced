/**
 * The chart alert intake (CB-bots-api-signal-01): `POST /api/v1/signals/webhook/:webhookId`, public, authenticated only
 * by the webhook's own token in the body; and `POST /api/v1/signals/notify/:webhookId`, a notification URL's alerts. Every
 * outcome is a JSON reply with a typed code; see signal-desk.ts `ingest` and `ingestNote`.
 */
import type { FastifyInstance } from 'fastify';
import { publicWrite } from '../route-inventory.js';
import { SIGNAL_INTAKE_PATH, SIGNAL_NOTIFY_PATH, type SignalDesk } from './signal-desk.js';

export function registerSignalIntake(app: FastifyInstance, desk: SignalDesk): void {
  app.post<{ Params: { webhookId: string } }>(`${SIGNAL_INTAKE_PATH}/:webhookId`, publicWrite, async (req, reply) => {
    const out = await desk.ingest(req.params.webhookId, req.body);
    return reply.code(out.status).send(out.body);
  });
  // A notification URL's alerts (CB-bots-api-signal-03): its own token, and a notice each, never an order.
  app.post<{ Params: { webhookId: string } }>(`${SIGNAL_NOTIFY_PATH}/:webhookId`, publicWrite, async (req, reply) => {
    const out = await desk.ingestNote(req.params.webhookId, req.body);
    return reply.code(out.status).send(out.body);
  });
}
