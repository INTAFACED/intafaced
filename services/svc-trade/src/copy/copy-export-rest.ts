import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, type Principal } from '@intafaced/auth';
import { CopyError } from './errors.js';
import { privateRead } from '../route-inventory.js';

export function attachCopyExportRoute(
  app: FastifyInstance,
  copyExport: ((principal: Principal, query: { followId?: string; from?: string; to?: string }) => Promise<string>) | undefined,
  requirePrincipal: (req: FastifyRequest, reply: FastifyReply) => Principal | null,
): void {
  app.get<{ Querystring: { followId?: string; from?: string; to?: string } }>('/api/v1/copy/export', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!copyExport) {
      return reply.code(503).send({
        code: 'ExchangeNotAvailable',
        message: 'copy trail export is not mounted',
        intafacedCode: 'trade.copy_unavailable',
      });
    }
    try {
      const csv = await copyExport(principal, {
        followId: req.query.followId,
        from: req.query.from,
        to: req.query.to,
      });
      return reply.code(200).header('content-type', 'text/csv; charset=utf-8').send(csv);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(403).send({ code: 'PermissionDenied', message: err.message, intafacedCode: err.code });
      }
      if (err instanceof CopyError) {
        const status = err.code === 'trade.copy_not_following' ? 404 : 400;
        const code = status === 404 ? 'NotFound' : 'BadRequest';
        return reply.code(status).send({ code, message: err.message, intafacedCode: err.code });
      }
      throw err;
    }
  });
}
