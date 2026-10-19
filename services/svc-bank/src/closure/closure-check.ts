/**
 * Read-only account-closure check. Bank answers for its own rows and for
 * ledger balances. Identity never reads the book.
 *
 * A failed read is 503. An empty blocker list means this service successfully
 * saw nothing open. It does not mean the other services are clear.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { rawBodyOf, verifyServiceHeaders } from '@intafaced/contracts';
import { add, formatAmount, isZero, type LedgerClient } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SUB_ACCOUNTS = 100;

export type ClosureBlocker = { code: string; count: number };
export type ClosureBalance = { assetId: string; amount: string };

export type ClosureCheckBody = {
  userId: string;
  subAccountIds: string[];
};

type Owner = { ownerType: 'user' | 'subaccount'; ownerId: string };

/** The verified calling service, or null when the credentials are missing or bad. */
function callerOf(req: FastifyRequest, secret: string): string | null {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  try {
    return verifyServiceHeaders(req.headers, secret, { rawBody: rawBodyOf(req), mode: 'require' }).service;
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

function asCount(n: number | string | undefined): number {
  if (typeof n === 'number') return n;
  if (typeof n === 'string' && /^\d+$/.test(n)) return Number(n);
  return 0;
}

function push(blockers: ClosureBlocker[], code: string, count: number): void {
  if (count > 0) blockers.push({ code, count });
}

async function nOf(query: Promise<Array<{ n: number }>>): Promise<number> {
  const rows = await query;
  return asCount(rows[0]?.n);
}

export async function runBankClosureCheck(
  sql: Sql,
  ledger: Pick<LedgerClient, 'balances'>,
  input: ClosureCheckBody,
): Promise<{ asOf: string; blockers: ClosureBlocker[]; balances: ClosureBalance[] }> {
  const subs = input.subAccountIds.filter((id) => id !== input.userId);
  const owners: Owner[] = [
    { ownerType: 'user', ownerId: input.userId },
    ...subs.map((ownerId) => ({ ownerType: 'subaccount' as const, ownerId })),
  ];
  const totals = new Map<string, bigint>();
  for (const owner of owners) {
    const rows = await ledger.balances(owner.ownerType, owner.ownerId);
    for (const row of rows) {
      if (isZero(row.amount)) continue;
      const assetId = row.account.assetId;
      totals.set(assetId, add(totals.get(assetId) ?? 0n, row.amount));
    }
  }
  const balances: ClosureBalance[] = [...totals.entries()]
    .filter(([, amount]) => !isZero(amount))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([assetId, amount]) => ({ assetId, amount: formatAmount(amount) }));

  const both = subs.length > 0;
  const userId = input.userId;
  const loans = await nOf(
    both
      ? sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM bank.loans WHERE status IN ('pending', 'active', 'margin_call', 'liquidating') AND (user_id = ${userId} OR user_id = ANY(${subs}::text[]))`
      : sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM bank.loans WHERE status IN ('pending', 'active', 'margin_call', 'liquidating') AND user_id = ${userId}`,
  );
  const cards = await nOf(
    both
      ? sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM bank.cards WHERE status IN ('active', 'frozen') AND (user_id = ${userId} OR user_id = ANY(${subs}::text[]))`
      : sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bank.cards WHERE status IN ('active', 'frozen') AND user_id = ${userId}`,
  );
  const schedules = await nOf(
    both
      ? sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM bank.scheduled_transfers WHERE status IN ('active', 'paused') AND (user_id = ${userId} OR user_id = ANY(${subs}::text[]))`
      : sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM bank.scheduled_transfers WHERE status IN ('active', 'paused') AND user_id = ${userId}`,
  );
  const onramps = await nOf(
    both
      ? sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM bank.ramp_onramps WHERE status = 'pending' AND (user_id = ${userId} OR user_id = ANY(${subs}::text[]))`
      : sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bank.ramp_onramps WHERE status = 'pending' AND user_id = ${userId}`,
  );
  const offramps = await nOf(
    both
      ? sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM bank.ramp_offramps WHERE status = 'pending' AND (user_id = ${userId} OR user_id = ANY(${subs}::text[]))`
      : sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bank.ramp_offramps WHERE status = 'pending' AND user_id = ${userId}`,
  );
  const customerRamps = await nOf(
    both
      ? sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM bank.customer_onramps WHERE status = 'pending_payment' AND (user_id = ${userId} OR user_id = ANY(${subs}::text[]))`
      : sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bank.customer_onramps WHERE status = 'pending_payment' AND user_id = ${userId}`,
  );
  const earn = await nOf(
    both
      ? sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM bank.earn_positions WHERE status IN ('pending', 'active') AND (user_id = ${userId} OR user_id = ANY(${subs}::text[]))`
      : sql<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM bank.earn_positions WHERE status IN ('pending', 'active') AND user_id = ${userId}`,
  );
  const blockers: ClosureBlocker[] = [];
  if (balances.length > 0) blockers.push({ code: 'balance_remaining', count: balances.length });
  push(blockers, 'open_loan', loans);
  push(blockers, 'active_card', cards);
  push(blockers, 'active_schedule', schedules);
  push(blockers, 'pending_ramp', onramps + offramps + customerRamps);
  push(blockers, 'earn_position', earn);

  return { asOf: new Date().toISOString(), blockers, balances };
}

export function registerClosureCheck(
  app: FastifyInstance,
  deps: { sql: Sql; ledger: Pick<LedgerClient, 'balances'>; secret: string },
): void {
  app.post('/internal/closure-check', async (req, reply) => {
    const caller = callerOf(req, deps.secret);
    if (caller === null) {
      return reply.code(401).send({ error: 'service credentials required', code: 'bank.unauthenticated' });
    }
    // Only the identity service asks this question; any other signed service is refused.
    if (caller !== 'svc-identity') {
      return reply.code(403).send({ error: 'closure check is for the identity service only', code: 'bank.closure_check_forbidden' });
    }
    const input = parseClosureCheckBody(req.body);
    if (!input) {
      return reply.code(400).send({ error: 'closure check input is invalid', code: 'bank.closure_check_input' });
    }
    try {
      return await runBankClosureCheck(deps.sql, deps.ledger, input);
    } catch {
      return reply.code(503).send({ error: 'closure check unavailable', code: 'bank.closure_check_unavailable' });
    }
  });
}
