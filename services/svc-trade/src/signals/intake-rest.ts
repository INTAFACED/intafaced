/**
 * The chart alert intake (CB-bots-api-signal-01): `POST /api/v1/signals/webhook/:webhookId`, public, authenticated only
 * by the webhook's own token in the body. Every outcome is a JSON reply with a typed code; see signal-desk.ts `ingest`.
 */
import type { FastifyInstance } from 'fastify';
import { publicWrite } from '../route-inventory.js';
import { SIGNAL_INTAKE_PATH, type SignalDesk } from './signal-desk.js';

export function registerSignalIntake(app: FastifyInstance, desk: SignalDesk): void {
  app.post<{ Params: { webhookId: string } }>(`${SIGNAL_INTAKE_PATH}/:webhookId`, publicWrite, async (req, reply) => {
    const out = await desk.ingest(req.params.webhookId, req.body);
    return reply.code(out.status).send(out.body);
  });
}
