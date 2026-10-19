/**
 * Read-only account-closure check. P2P answers for offers, trades, and disputes.
 * This route does not erase anything. A failed read is 503, never an empty list.
 *
 * Terminal trades are `released` and `cancelled` (state.ts). Anything else is open.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import type { Sql } from 'postgres';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SUB_ACCOUNTS = 100;

export type ClosureBlocker = { code: string; count: number };
export type ClosureCheckBody = { userId: string; subAccountIds: string[] };

/** The verified calling service, or null when the credentials are missing or bad. */
function callerOf(req: FastifyRequest, secret: string, s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode }): string | null {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  try {
    return verifyServiceRequest(req, { verifier: s2s?.verifier, mode: s2s?.mode, legacySecret: secret, bodyBindMode: 'require' }).service;
  } catch {
    return null;
  }
}

export function parseClosureCheckBody(body: unknown): ClosureCheckBody | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const row = body as { userId?: unknown; subAccountIds?: unknown };
  if (typeof row.userId !== 'string' || !UUID.test(row.userId)) return null;
  if (!Array.isArray(row.subAccountIds)) return null;
  if (row.subAccountIds.length > MAX_SUB_ACCOUNTS) return null;
  const subAccountIds: string[] = [];
  for (const id of row.subAccountIds) {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    const lower = id.toLowerCase();
    if (!subAccountIds.includes(lower)) subAccountIds.push(lower);
  }
  return { userId: row.userId.toLowerCase(), subAccountIds };
}

export async function runP2pClosureCheck(sql: Sql, input: ClosureCheckBody): Promise<{ asOf: string; blockers: ClosureBlocker[] }> {
  const ids = [input.userId, ...input.subAccountIds.filter((id) => id !== input.userId)];
  const offers = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM p2p.offers
    WHERE status IN ('active', 'paused') AND maker_id = ANY(${ids}::text[])
  `;
  const trades = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM p2p.p2p_trades
    WHERE status NOT IN ('released', 'cancelled')
      AND (
        maker_id = ANY(${ids}::text[])
        OR taker_id = ANY(${ids}::text[])
        OR buyer_id = ANY(${ids}::text[])
        OR seller_id = ANY(${ids}::text[])
      )
  `;
  const disputes = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM p2p.p2p_disputes d
    JOIN p2p.p2p_trades t ON t.id = d.trade_id
    WHERE d.status = 'open'
      AND (
        d.opened_by = ANY(${ids}::text[])
        OR t.maker_id = ANY(${ids}::text[])
        OR t.taker_id = ANY(${ids}::text[])
        OR t.buyer_id = ANY(${ids}::text[])
        OR t.seller_id = ANY(${ids}::text[])
      )
  `;
  const blockers: ClosureBlocker[] = [];
  const offerN = offers[0]?.n ?? 0;
  const tradeN = trades[0]?.n ?? 0;
  const disputeN = disputes[0]?.n ?? 0;
  if (offerN > 0) blockers.push({ code: 'open_offer', count: offerN });
  if (tradeN > 0) blockers.push({ code: 'open_trade', count: tradeN });
  if (disputeN > 0) blockers.push({ code: 'open_dispute', count: disputeN });
  return { asOf: new Date().toISOString(), blockers };
}

export function registerClosureCheck(
  app: FastifyInstance,
  deps: { sql: Sql; secret: string; s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode } },
): void {
  app.post('/internal/closure-check', async (req, reply) => {
    const caller = callerOf(req, deps.secret, deps.s2s);
    if (caller === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'p2p.unauthenticated' });
    }
    // Only the identity service asks this question; any other signed service is refused.
    if (caller !== 'svc-identity') {
      return reply.code(403).send({ error: 'closure check is for the identity service only', code: 'p2p.closure_check_forbidden' });
    }
    const input = parseClosureCheckBody(req.body);
    if (!input) {
      return reply.code(400).send({ error: 'closure check input is invalid', code: 'p2p.closure_check_input' });
    }
    try {
      return await runP2pClosureCheck(deps.sql, input);
    } catch {
      return reply.code(503).send({ error: 'closure check unavailable', code: 'p2p.closure_check_unavailable' });
    }
  });
}
