/**
 * Read-only account-closure check. Bank answers for its own rows and for
 * ledger balances. Identity never reads the book.
 *
 * A failed read is 503. An empty blocker list means this service successfully
 * saw nothing open. It does not mean the other services are clear.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyServiceRequest, type ServiceAuthMode, type ServiceVerifier } from '@intafaced/contracts';
import { add, formatAmount, isZero, type LedgerClient } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SUB_ACCOUNTS = 100;

export type ClosureBlocker = { code: string; count: number };
export type ClosureBalance = { assetId: string; amount: string };

export type ClosureCheckBody = {
  userId: string;
  subAccountIds: string[];
  /** `sub_accounts` answers for the listed sub-accounts only, leaving the main account out. */
  scope: 'account' | 'sub_accounts';
};

type Owner = { ownerType: 'user' | 'subaccount'; ownerId: string };

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
  // A sub-account-only question with no sub-account named must not read as "nothing open".
  if (scope === 'sub_accounts' && subAccountIds.length === 0) return null;
  return { userId: row.userId.toLowerCase(), subAccountIds, scope };
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
    ...(input.scope === 'sub_accounts' ? [] : [{ ownerType: 'user' as const, ownerId: input.userId }]),
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

  // user_id values whose rows count: the main account unless the question is about sub-accounts only.
  const ids = input.scope === 'sub_accounts' ? subs : [input.userId, ...subs];
  const count = (table: string, statuses: string[]) =>
    nOf(
      sql<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM ${sql(`bank.${table}`)} WHERE status IN ${sql(statuses)} AND user_id = ANY(${ids}::text[])`,
    );
  const loans = await count('loans', ['pending', 'active', 'margin_call', 'liquidating']);
  const cards = await count('cards', ['active', 'frozen']);
  const schedules = await count('scheduled_transfers', ['active', 'paused']);
  const onramps = await count('ramp_onramps', ['pending']);
  const offramps = await count('ramp_offramps', ['pending']);
  const customerRamps = await count('customer_onramps', ['pending_payment']);
  const earn = await count('earn_positions', ['pending', 'active']);
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
  deps: { sql: Sql; ledger: Pick<LedgerClient, 'balances'>; secret: string; s2s?: { verifier: ServiceVerifier; mode: ServiceAuthMode } },
): void {
  app.post('/internal/closure-check', async (req, reply) => {
    const caller = callerOf(req, deps.secret, deps.s2s);
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
