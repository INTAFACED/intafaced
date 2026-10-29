import type { Sql } from 'postgres';
import { formatAmount, MoneyError, parseAmount, type Amount } from '@intafaced/ledger-client';
import { OwnAgentRefusal } from './catalog.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The month is the only period an agent's caps are set for; there is no default for any amount. */
export type OwnLimitPeriod = 'month';

/** Wire view. Amounts are decimal strings; `effectivePerSession` is the lower of the person's value and the agent's. */
export type OwnLimitsView = {
  readonly limits: {
    readonly perCall: string;
    readonly perSession: string;
    readonly perPeriod: string;
    readonly period: OwnLimitPeriod;
  } | null;
  readonly agentCap: string | null;
  readonly effectivePerSession: string | null;
};

/** What a hold is checked against, in scaled units. */
export type OwnCaps = {
  readonly perCall: Amount;
  readonly perSession: Amount;
  readonly perPeriod: Amount;
  readonly period: OwnLimitPeriod;
};

interface Row {
  agent_cap: string | null;
  per_call: string | null;
  per_session: string | null;
  per_period: string | null;
  period: OwnLimitPeriod | null;
}

/** Blank refuses as unset; anything else that is not a decimal amount at or above zero refuses as invalid. */
function parseLimit(value: string | null | undefined): Amount {
  const text = value?.trim() ?? '';
  if (!text) throw new OwnAgentRefusal('agents.spend.cap_unset');
  try {
    const amount = parseAmount(text);
    if (amount < 0n) throw new OwnAgentRefusal('agents.own.cap_invalid');
    return amount;
  } catch (err) {
    if (err instanceof MoneyError) throw new OwnAgentRefusal('agents.own.cap_invalid');
    throw err;
  }
}

const min = (a: Amount, b: Amount): Amount => (a < b ? a : b);

async function readRow(sql: Sql, ownerId: string, agentId: string): Promise<Row | null> {
  if (!UUID_RE.test(agentId)) return null;
  const rows = await sql<Row[]>`
    SELECT a.per_session_cap::text AS agent_cap,
           l.per_call::text, l.per_session::text, l.per_period::text, l.period
      FROM agents.own_agents a
      LEFT JOIN agents.own_agent_limits l ON l.agent_id = a.id AND l.owner_id = a.owner_id
     WHERE a.owner_id = ${ownerId} AND a.id = ${agentId}
  `;
  return rows[0] ?? null;
}

/**
 * The caps a run of this agent is held against, or null when any of them is unset: the agent's own cap per session,
 * or the person's caps for it. Per session is the lower of the two; per call never exceeds per session. Read on the
 * caller's transaction, so a hold checks the caps as they stand under its lock.
 */
export async function readOwnCaps(sql: Sql, ownerId: string, agentId: string): Promise<OwnCaps | null> {
  const row = await readRow(sql, ownerId, agentId);
  if (!row || row.agent_cap === null || row.per_call === null || row.per_session === null || row.per_period === null || !row.period) {
    return null;
  }
  const perSession = min(parseAmount(row.per_session), parseAmount(row.agent_cap));
  return { perCall: min(parseAmount(row.per_call), perSession), perSession, perPeriod: parseAmount(row.per_period), period: row.period };
}

/**
 * The caps a person sets for one of their own agents (AG-spend-01). Only the owner reads or writes them; another
 * person's agent reads as not found. A cap is a ceiling on holds, not a balance: nothing here moves value.
 */
export class OwnLimitsStore {
  constructor(private readonly sql: Sql) {}

  async get(ownerId: string, agentId: string): Promise<OwnLimitsView> {
    const row = await readRow(this.sql, ownerId, agentId);
    if (!row) throw new OwnAgentRefusal('agents.own.not_found');
    return view(row);
  }

  /**
   * Stores all three caps at once, or none. Saving the same values again writes the same row. A per-call or
   * per-session value above the agent's own cap is refused rather than lowered, as is a per-call value above the
   * per-session one (it could never apply), and an agent with no cap of its own takes no limits until it has one.
   */
  async set(
    ownerId: string,
    agentId: string,
    input: { perCall: string | null; perSession: string | null; perPeriod: string | null },
  ): Promise<OwnLimitsView> {
    const perCall = parseLimit(input.perCall);
    const perSession = parseLimit(input.perSession);
    const perPeriod = parseLimit(input.perPeriod);
    return this.sql.begin(async (tx) => {
      if (!UUID_RE.test(agentId)) throw new OwnAgentRefusal('agents.own.not_found');
      const agents = await tx<Array<{ agent_cap: string | null }>>`
        SELECT per_session_cap::text AS agent_cap FROM agents.own_agents WHERE owner_id = ${ownerId} AND id = ${agentId} FOR UPDATE
      `;
      const agent = agents[0];
      if (!agent) throw new OwnAgentRefusal('agents.own.not_found');
      if (agent.agent_cap === null) throw new OwnAgentRefusal('agents.spend.cap_unset');
      const agentCap = parseAmount(agent.agent_cap);
      if (perSession > agentCap || perCall > agentCap) {
        throw new OwnAgentRefusal('agents.spend.above_agent_cap', { cap: formatAmount(agentCap) });
      }
      if (perCall > perSession) throw new OwnAgentRefusal('agents.spend.per_call_above_session');
      await tx`
        INSERT INTO agents.own_agent_limits (agent_id, owner_id, per_call, per_session, per_period, period)
        VALUES (${agentId}, ${ownerId}, ${formatAmount(perCall)}::numeric, ${formatAmount(perSession)}::numeric,
                ${formatAmount(perPeriod)}::numeric, 'month')
        ON CONFLICT (agent_id) DO UPDATE
           SET per_call = EXCLUDED.per_call,
               per_session = EXCLUDED.per_session,
               per_period = EXCLUDED.per_period,
               updated_at = now()
      `;
      const row = await readRow(tx as unknown as Sql, ownerId, agentId);
      return view(row!);
    });
  }
}

function view(row: Row): OwnLimitsView {
  const agentCap = row.agent_cap === null ? null : parseAmount(row.agent_cap);
  const limits =
    row.per_call !== null && row.per_session !== null && row.per_period !== null && row.period
      ? {
          perCall: formatAmount(parseAmount(row.per_call)),
          perSession: formatAmount(parseAmount(row.per_session)),
          perPeriod: formatAmount(parseAmount(row.per_period)),
          period: row.period,
        }
      : null;
  const effective = limits && agentCap !== null ? formatAmount(min(parseAmount(limits.perSession), agentCap)) : null;
  return { limits, agentCap: agentCap === null ? null : formatAmount(agentCap), effectivePerSession: effective };
}
