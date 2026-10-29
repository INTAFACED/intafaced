import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, type Principal } from '@intafaced/auth';
import { ConvertHistoryError } from './convert-history.js';
import { privateRead } from '../route-inventory.js';

export function attachConvertExportRoute(
  app: FastifyInstance,
  convertExport: ((principal: Principal, query: { from?: string; to?: string }) => Promise<string>) | undefined,
  requirePrincipal: (req: FastifyRequest, reply: FastifyReply) => Principal | null,
): void {
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/v1/convert/export', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!convertExport) {
      return reply.code(503).send({
        code: 'ExchangeNotAvailable',
        message: 'convert history is not mounted',
        intafacedCode: 'trade.convert_history_unmounted',
      });
    }
    try {
      const csv = await convertExport(principal, { from: req.query.from, to: req.query.to });
      return reply.code(200).header('content-type', 'text/csv; charset=utf-8').send(csv);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(403).send({ code: 'PermissionDenied', message: err.message, intafacedCode: err.code });
      }
      if (err instanceof ConvertHistoryError) {
        return reply.code(400).send({ code: 'BadRequest', message: err.message, intafacedCode: err.code });
      }
      throw err;
    }
  });
}
