/**
 * Read-only account-closure check. Trade answers for open orders and positions.
 * A failed read is 503, never an empty blocker list.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import type { Sql } from 'postgres';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SUB_ACCOUNTS = 100;

export type ClosureBlocker = { code: string; count: number };

export type ClosureCheckBody = {
  userId: string;
  subAccountIds: string[];
  /** `sub_accounts` answers for the listed sub-accounts only, leaving the main account out. */
  scope: 'account' | 'sub_accounts';
};

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
  const row = body as { userId?: unknown; subAccountIds?: unknown; scope?: unknown };
  if (row.scope !== undefined && row.scope !== 'account' && row.scope !== 'sub_accounts') return null;
  const scope = row.scope === 'sub_accounts' ? 'sub_accounts' : 'account';
  if (typeof row.userId !== 'string' || !UUID.test(row.userId)) return null;
  if (!Array.isArray(row.subAccountIds)) return null;
  if (row.subAccountIds.length > MAX_SUB_ACCOUNTS) return null;
  const subAccountIds: string[] = [];
  for (const id of row.subAccountIds) {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    const lower = id.toLowerCase();
    if (!subAccountIds.includes(lower)) subAccountIds.push(lower);
  }
  // A sub-account-only question naming no real sub-account (none, or only the user's own id) must not read as "nothing open".
  const userId = row.userId.toLowerCase();
  if (scope === 'sub_accounts' && subAccountIds.every((id) => id === userId)) return null;
  return { userId, subAccountIds, scope };
}

export async function runTradeClosureCheck(sql: Sql, input: ClosureCheckBody): Promise<{ asOf: string; blockers: ClosureBlocker[] }> {
  const subs = input.subAccountIds.filter((id) => id !== input.userId);
  const orderRows =
    input.scope === 'sub_accounts'
      ? await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM trade.orders
          WHERE status IN ('pending', 'open', 'recovery_required', 'hold_unknown')
            AND (user_id = ANY(${subs}::uuid[]) OR sub_account_id = ANY(${subs}::uuid[]))
        `
      : subs.length === 0
        ? await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM trade.orders
          WHERE status IN ('pending', 'open', 'recovery_required', 'hold_unknown')
            AND user_id = ${input.userId}::uuid
        `
        : await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM trade.orders
          WHERE status IN ('pending', 'open', 'recovery_required', 'hold_unknown')
            AND (
              user_id = ${input.userId}::uuid
              OR user_id = ANY(${subs}::uuid[])
              OR sub_account_id = ANY(${subs}::uuid[])
            )
        `;
  const positionRows =
    input.scope === 'sub_accounts'
      ? await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM trade.positions
          WHERE status IN ('open', 'closing')
            AND user_id = ANY(${subs}::text[])
        `
      : subs.length === 0
        ? await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM trade.positions
          WHERE status IN ('open', 'closing')
            AND user_id = ${input.userId}
        `
        : await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM trade.positions
          WHERE status IN ('open', 'closing')
            AND (user_id = ${input.userId} OR user_id = ANY(${subs}::text[]))
        `;
  const blockers: ClosureBlocker[] = [];
  const orders = orderRows[0]?.n ?? 0;
  const positions = positionRows[0]?.n ?? 0;
  if (orders > 0) blockers.push({ code: 'open_order', count: orders });
  if (positions > 0) blockers.push({ code: 'open_position', count: positions });
  return { asOf: new Date().toISOString(), blockers };
}

export function registerClosureCheck(
  app: FastifyInstance,
  deps: { sql: Sql; secret: string; s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode } },
): void {
  app.post('/internal/closure-check', async (req, reply) => {
    const caller = callerOf(req, deps.secret, deps.s2s);
    if (caller === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'trade.unauthenticated' });
    }
    // Only the identity service asks this question; any other signed service is refused.
    if (caller !== 'svc-identity') {
      return reply.code(403).send({ error: 'closure check is for the identity service only', code: 'trade.closure_check_forbidden' });
    }
    const input = parseClosureCheckBody(req.body);
    if (!input) {
      return reply.code(400).send({ error: 'closure check input is invalid', code: 'trade.closure_check_input' });
    }
    try {
      return await runTradeClosureCheck(deps.sql, input);
    } catch {
      return reply.code(503).send({ error: 'closure check unavailable', code: 'trade.closure_check_unavailable' });
    }
  });
}
