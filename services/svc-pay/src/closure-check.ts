/**
 * Read-only account-closure check for svc-pay (RC-wallet-03). Pay answers for its own tables only: a withdrawal still
 * in flight, a screening case that still needs a person, a deposit the rail took that the book has not booked. It
 * reads no ledger balance (svc-bank reports `balance_remaining`) and moves nothing. Identity asks, and only identity.
 *
 * A failed read is 503. An empty blocker list means this service read its own tables and saw nothing open; it does
 * not mean the other services are clear. The wire shape is the one svc-bank's check answers, so identity parses both
 * the same way.
 */
import type { FastifyInstance } from 'fastify';
import { retainRawBody, verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import type { Sql } from 'postgres';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ClosureBlocker = { code: string; count: number };
export type ClosureCheckBody = { userId: string };

export const CLOSURE_BLOCKER_CODES = ['open_withdrawal_hold', 'open_screening_case', 'open_deposit_hold'] as const;

/** Strict: a user id and nothing else. Anything more is not this contract. */
export function parseClosureCheckBody(body: unknown): ClosureCheckBody | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const row = body as { userId?: unknown };
  if (typeof row.userId !== 'string' || !UUID.test(row.userId)) return null;
  const extra = Object.keys(body).filter((k) => k !== 'userId' && k !== 'subAccountIds');
  if (extra.length > 0) return null;
  return { userId: row.userId.toLowerCase() };
}

const count = (rows: Array<{ n: number }>): number => rows[0]?.n ?? 0;

/**
 * - `open_withdrawal_hold`: a withdrawal of the user's that is neither sent nor failed (`pending`, or `held` with the
 *   funds out of the balance), so closing would strand or race it.
 * - `open_screening_case`: a withdrawal screening case of the user that still needs a person (undecided review or
 *   unavailable), or a release that was granted and not yet spent or expired.
 * - `open_deposit_hold`: a deposit the rail took that is still `pending` (not booked to the ledger).
 */
export async function runPayClosureCheck(sql: Sql, input: ClosureCheckBody): Promise<{ asOf: string; blockers: ClosureBlocker[] }> {
  const userId = input.userId;
  const withdrawals = count(
    await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.withdrawals WHERE user_id = ${userId} AND status IN ('pending', 'held')`,
  );
  const cases = count(
    await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.screening_cases
       WHERE subject_kind = 'withdrawal' AND party_ref = ${userId}
         AND ((decision IS NULL AND status IN ('review', 'unavailable'))
              OR (decision = 'released' AND release_consumed_at IS NULL AND release_expires_at > now()))`,
  );
  const deposits = count(
    await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.deposits WHERE user_id = ${userId} AND status = 'pending'`,
  );
  const blockers: ClosureBlocker[] = [];
  if (withdrawals > 0) blockers.push({ code: 'open_withdrawal_hold', count: withdrawals });
  if (cases > 0) blockers.push({ code: 'open_screening_case', count: cases });
  if (deposits > 0) blockers.push({ code: 'open_deposit_hold', count: deposits });
  return { asOf: new Date().toISOString(), blockers };
}

export interface ClosureCheckRouteDeps {
  readonly internalSecret: string;
  /** Per-service keys (S2S v3). Unset: the shared secret alone, as before. */
  readonly s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  readonly installRawBody?: boolean;
  readonly check: (input: ClosureCheckBody) => Promise<{ asOf: string; blockers: ClosureBlocker[] }>;
}

export function registerClosureCheckRoute(app: FastifyInstance, deps: ClosureCheckRouteDeps): void {
  if (deps.installRawBody !== false) retainRawBody(app);

  app.post('/internal/closure-check', async (req, reply) => {
    const verified = verifyServiceRequest(req, {
      verifier: deps.s2s?.verifier,
      mode: deps.s2s?.mode,
      legacySecret: deps.internalSecret,
      bodyBindMode: 'require',
    });
    if (verified.service === null) {
      return reply.code(401).send({ error: 'pay.unauthenticated', code: 'pay.unauthenticated' });
    }
    // Only the identity service asks this question; any other signed service is refused.
    if (verified.service !== 'svc-identity') {
      return reply.code(403).send({ error: 'closure check is for the identity service only', code: 'pay.closure_check_forbidden' });
    }
    const input = parseClosureCheckBody(req.body);
    if (!input) {
      return reply.code(400).send({ error: 'closure check input is invalid', code: 'pay.closure_check_input' });
    }
    try {
      return await deps.check(input);
    } catch {
      // Never an empty list when a read failed.
      return reply.code(503).send({ error: 'closure check unavailable', code: 'pay.closure_check_unavailable' });
    }
  });
}
