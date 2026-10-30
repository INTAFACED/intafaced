import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, requireScope, type Principal } from '@intafaced/auth';
import { LEDGER_PAGE_MAX, presentLedgerLine, type LedgerPages } from './ledger-history.js';
import { StatementError, type StatementExports, type StatementRequest } from './statement-export.js';
import { privateRead, privateWrite } from '../route-inventory.js';

/**
 * The person's ledger history and statement export over REST (J-cex-spot-07 #5 and #6):
 *
 * - `GET /api/v1/ledger?limit=&code=&cursor=`: one page of balance changes, newest first, with the ledger's references.
 * - `POST /api/v1/statements` `{from, to, requestKey}`: the statement job for that key (created once, built once).
 * - `GET /api/v1/statements/:id`: the job. `GET /api/v1/statements/:id/file`: its CSV, with the file's SHA-256 (`?as=json`:
 *   `{filename, sha256, csv}`, for a browser client that reads JSON only).
 *
 * Unmounted (no ledger or no store wired), each answers 503 with a typed code, never an empty list.
 */
export interface StatementRestDeps {
  readonly ledger: LedgerPages;
  readonly exports: StatementExports;
}

const ASSET = /^[A-Z0-9]{1,16}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;

export function attachStatementRoutes(
  app: FastifyInstance,
  deps: StatementRestDeps | undefined,
  requirePrincipal: (req: FastifyRequest, reply: FastifyReply) => Principal | null,
): void {
  const unmounted = (reply: FastifyReply, what: string) =>
    reply.code(503).send({ code: 'ExchangeNotAvailable', message: `${what} is not mounted`, intafacedCode: 'trade.statements_unmounted' });
  const bad = (reply: FastifyReply, message: string, intafacedCode: string) =>
    reply.code(400).send({ code: 'BadRequest', message, intafacedCode });

  function refused(reply: FastifyReply, err: unknown) {
    if (err instanceof AuthError) return reply.code(403).send({ code: 'PermissionDenied', message: err.message, intafacedCode: err.code });
    if (err instanceof StatementError) {
      const code =
        err.status === 404
          ? 'OrderNotFound'
          : err.status === 409
            ? 'InvalidOrder'
            : err.status === 429
              ? 'RateLimitExceeded'
              : 'BadRequest';
      return reply.code(err.status).send({ code, message: err.message, intafacedCode: err.code });
    }
    return null;
  }

  app.get<{ Querystring: { limit?: string; code?: string; cursor?: string } }>('/api/v1/ledger', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps) return unmounted(reply, 'ledger history');
    const raw = req.query.limit;
    const limit = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_PAGE_MAX) {
      return bad(reply, `ledger limit must be 1 to ${LEDGER_PAGE_MAX}; refuse to invent one`, 'trade.ledger_limit_unset');
    }
    const code = req.query.code;
    if (code !== undefined && code !== '' && !ASSET.test(code)) return bad(reply, 'code must be an asset code', 'trade.invalid_filter');
    const cursor = req.query.cursor;
    if (cursor !== undefined && cursor !== '' && !CURSOR.test(cursor)) {
      return bad(reply, 'cursor must be the nextCursor of the previous page', 'trade.invalid_cursor');
    }
    try {
      requireScope(principal, 'trade:read');
      const page = await deps.ledger.page({
        userId: principal.userId,
        limit,
        ...(code ? { assetId: code } : {}),
        ...(cursor ? { cursor } : {}),
      });
      return reply.code(200).send({ entries: page.entries.map(presentLedgerLine), nextCursor: page.nextCursor });
    } catch (err) {
      const sent = refused(reply, err);
      if (sent) return sent;
      // A cursor the ledger did not issue is the caller's to fix, not an outage.
      if ((err as { code?: unknown }).code === 'ledger.history_cursor_invalid') {
        return bad(reply, 'cursor is not one the ledger issued; start again without it', 'trade.invalid_cursor');
      }
      throw err;
    }
  });

  app.post<{ Body: StatementRequest }>('/api/v1/statements', privateWrite, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps) return unmounted(reply, 'statement export');
    try {
      const body = (req.body ?? {}) as StatementRequest;
      const job = await deps.exports.request(principal, { from: body.from, to: body.to, requestKey: body.requestKey });
      return reply.code(200).send(job);
    } catch (err) {
      const sent = refused(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/api/v1/statements/:id', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps) return unmounted(reply, 'statement export');
    try {
      return reply.code(200).send(await deps.exports.get(principal, req.params.id));
    } catch (err) {
      const sent = refused(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { as?: string } }>('/api/v1/statements/:id/file', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps) return unmounted(reply, 'statement export');
    const as = req.query.as;
    if (as !== undefined && as !== 'json') return bad(reply, 'as must be json, or absent for the CSV itself', 'trade.invalid_filter');
    try {
      const file = await deps.exports.file(principal, req.params.id);
      // A browser client that reads JSON only takes the same bytes wrapped, and saves them itself.
      if (as === 'json')
        return reply
          .code(200)
          .header('cache-control', 'private, no-store')
          .send({ filename: file.filename, sha256: file.sha256, csv: file.csv });
      return (
        reply
          .code(200)
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${file.filename}"`)
          .header('x-intafaced-sha256', file.sha256)
          // A statement is personal: no shared cache keeps a copy.
          .header('cache-control', 'private, no-store')
          .send(file.csv)
      );
    } catch (err) {
      const sent = refused(reply, err);
      if (sent) return sent;
      throw err;
    }
  });
}
