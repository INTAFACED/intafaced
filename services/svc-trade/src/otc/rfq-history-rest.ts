import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, type Principal } from '@intafaced/auth';
import { DeskError } from '../desk/errors.js';
import { privateRead } from '../route-inventory.js';

export function attachRfqExportRoute(
  app: FastifyInstance,
  rfqExport: ((principal: Principal, query: { from?: string; to?: string }) => Promise<string>) | undefined,
  requirePrincipal: (req: FastifyRequest, reply: FastifyReply) => Principal | null,
): void {
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/v1/rfq/export', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!rfqExport) {
      return reply.code(503).send({
        code: 'ExchangeNotAvailable',
        message: 'rfq history is not mounted',
        intafacedCode: 'trade.rfq_history_unmounted',
      });
    }
    try {
      const csv = await rfqExport(principal, { from: req.query.from, to: req.query.to });
      return reply.code(200).header('content-type', 'text/csv; charset=utf-8').send(csv);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(403).send({ code: 'PermissionDenied', message: err.message, intafacedCode: err.code });
      }
      if (err instanceof DeskError) {
        return reply.code(400).send({ code: 'BadRequest', message: err.message, intafacedCode: err.code });
      }
      throw err;
    }
  });
}
