import type { Sql } from 'postgres';
import { API_KEY_CALL_LIMIT_MAX } from '@intafaced/contracts/api-keys';
import type { Principal } from '@intafaced/auth';
import { AgentAccountError, assertPerson } from './agent-account.js';
import type { AgentConnectionStore } from './agent-connection-store.js';
import type { AgentKeyCallReader } from './agent-key-read-client.js';

/**
 * The assistant connection's Activity (J-agents-21 #11): one row per call made with the connection's agent key, refused
 * ones included, each with its time, tool, outcome and order id, and an export holding the same rows.
 *
 * Every call: identity's call log of the key (DV-keys-06), which the edge writes for every call it answers for an API key,
 * whichever service answered it or whether the edge refused it itself. svc-trade reads it through identity's door
 * (`AGENT_KEY_CALLS_PATH`), never its table. The order: the one route an agent key trades through is svc-trade's own, so
 * svc-trade records, by the edge's request id, the order each call named and the refusal code it answered
 * (`trade.user_venue_agent_order_calls`). Joined by request id. Nothing moves; nothing here is a balance. The log is
 * append-only: a call is recorded once, and never changed.
 */

/** What svc-trade answered one call of the assistant's order route. */
export interface AgentOrderCallRecord {
  /** The edge's `x-request-id` for the call: the same id identity's call log keys it by. */
  readonly requestId: string;
  readonly keyId: string;
  readonly userId: string;
  /** The assistant's own id for the order, when the call named a valid one. */
  readonly clientOrderId: string | null;
  /** The venue's id for the order, once the venue answered with it. */
  readonly venueOrderId: string | null;
  /** The refusal code svc-trade answered; `null` when the call was answered without a refusal. */
  readonly code: string | null;
  readonly at: Date;
}

export interface AgentOrderCallStore {
  /** Record one call; a second record under the same request id writes nothing. */
  record(r: AgentOrderCallRecord): Promise<void>;
  /** The key's records by request id, for the person's own key only. */
  byRequest(userId: string, keyId: string, requestIds: readonly string[]): Promise<ReadonlyMap<string, AgentOrderCallRecord>>;
}

export class InMemoryAgentOrderCallStore implements AgentOrderCallStore {
  readonly rows: AgentOrderCallRecord[] = [];

  async record(r: AgentOrderCallRecord) {
    if (!this.rows.some((x) => x.requestId === r.requestId)) this.rows.push(r);
  }

  async byRequest(userId: string, keyId: string, requestIds: readonly string[]) {
    const wanted = new Set(requestIds);
    return new Map(
      this.rows.filter((r) => r.userId === userId && r.keyId === keyId && wanted.has(r.requestId)).map((r) => [r.requestId, r]),
    );
  }
}

interface Row {
  request_id: string;
  key_id: string;
  user_id: string;
  client_order_id: string | null;
  venue_order_id: string | null;
  code: string | null;
  called_at: Date;
}

export class SqlAgentOrderCallStore implements AgentOrderCallStore {
  constructor(private readonly sql: Sql) {}

  async record(r: AgentOrderCallRecord) {
    await this.sql`
      INSERT INTO trade.user_venue_agent_order_calls (request_id, key_id, user_id, client_order_id, venue_order_id, code, called_at)
      VALUES (${r.requestId}, ${r.keyId}, ${r.userId}, ${r.clientOrderId}, ${r.venueOrderId}, ${r.code}, ${r.at})
      ON CONFLICT (request_id) DO NOTHING`;
  }

  async byRequest(userId: string, keyId: string, requestIds: readonly string[]) {
    if (requestIds.length === 0) return new Map<string, AgentOrderCallRecord>();
    const rows = await this.sql<Row[]>`
      SELECT request_id, key_id, user_id, client_order_id, venue_order_id, code, called_at
      FROM trade.user_venue_agent_order_calls
      WHERE user_id = ${userId} AND key_id = ${keyId} AND request_id = ANY(${requestIds as string[]})`;
    return new Map(
      rows.map((r) => [
        r.request_id,
        {
          requestId: r.request_id,
          keyId: r.key_id,
          userId: r.user_id,
          clientOrderId: r.client_order_id,
          venueOrderId: r.venue_order_id,
          code: r.code,
          at: r.called_at,
        },
      ]),
    );
  }
}

/** The assistant's order route, as the edge logs its path, and the tool name it goes by (packages/assistant-mcp). */
const TOOLS: Readonly<Record<string, string>> = { 'POST /api/v1/venue/agent/orders': 'place_order' };

export type AgentActivityOutcome = 'accepted' | 'refused' | 'failed';

export interface AgentActivityRow {
  readonly at: Date;
  /** The tool the call used (`place_order`), or the route it called (`GET /api/v1/venue/balances`). */
  readonly tool: string;
  readonly outcome: AgentActivityOutcome;
  /** The status the edge answered the call with. */
  readonly status: number;
  /** The refusal code svc-trade answered, when svc-trade answered the call and refused it. */
  readonly code: string | null;
  /** The assistant's id for the order the call named, and the venue's, when the call named an order. */
  readonly order: { readonly clientOrderId: string; readonly venueOrderId: string | null } | null;
  readonly requestId: string;
}

export interface AgentActivityView {
  readonly keyId: string;
  readonly accountId: string;
  readonly asOf: Date;
  /** Newest first, at most `limit`. */
  readonly rows: readonly AgentActivityRow[];
}

export const outcomeOf = (status: number): AgentActivityOutcome => (status < 400 ? 'accepted' : status < 500 ? 'refused' : 'failed');

const OUTCOME_WORD: Readonly<Record<AgentActivityOutcome, string>> = { accepted: 'Accepted', refused: 'Refused', failed: 'Failed' };

/** A cell a spreadsheet would run as a formula is read as text. */
const csvCell = (raw: string): string => {
  const value = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
};

/** The export: a header, then one line per row, in the order shown. */
export function activityCsv(rows: readonly AgentActivityRow[]): string {
  const lines = [['Time', 'Tool', 'Outcome', 'Status', 'Code', 'Order id', 'Venue order id', 'Request id'].join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.at.toISOString(),
        r.tool,
        OUTCOME_WORD[r.outcome],
        String(r.status),
        r.code ?? '',
        r.order?.clientOrderId ?? '',
        r.order?.venueOrderId ?? '',
        r.requestId,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export interface AgentActivityDeps {
  readonly connections: AgentConnectionStore;
  readonly calls: AgentKeyCallReader;
  readonly log: AgentOrderCallStore;
  readonly now: () => Date;
}

export class AgentActivity {
  constructor(private readonly deps: AgentActivityDeps) {}

  /** Record what svc-trade answered one call of the assistant's order route. Never throws: the log never gates a call. */
  async record(r: AgentOrderCallRecord): Promise<boolean> {
    try {
      await this.deps.log.record(r);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The person's own connection's Activity: the person's session only (never the assistant's key). A key the person
   * never connected is not found, the same as anyone else's.
   */
  async list(principal: Principal, keyIdRaw: string, limitRaw?: unknown): Promise<AgentActivityView> {
    assertPerson(principal);
    const keyId = keyIdRaw.trim().toLowerCase();
    const connection = /^[0-9a-f-]{36}$/.test(keyId) ? await this.deps.connections.latest(keyId) : null;
    if (!connection || connection.userId !== principal.userId) {
      throw new AgentAccountError('agents.key_not_connected', `no assistant connection for key ${keyIdRaw} on this login`, 404);
    }
    const limit = limitRaw === undefined || limitRaw === '' ? API_KEY_CALL_LIMIT_MAX : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > API_KEY_CALL_LIMIT_MAX) {
      throw new AgentAccountError(
        'agents.account_request_invalid',
        `limit must be a whole number from 1 to ${API_KEY_CALL_LIMIT_MAX}`,
        400,
      );
    }
    const log = await this.deps.calls.calls(principal.userId, keyId, limit);
    if (log === null) {
      throw new AgentAccountError('agents.activity_read_unavailable', "the key's call log could not be read just now; try again", 503);
    }
    if (log.state === 'none') {
      throw new AgentAccountError('agents.key_not_connected', `no assistant connection for key ${keyIdRaw} on this login`, 404);
    }
    const ours = await this.deps.log.byRequest(
      principal.userId,
      keyId,
      log.calls.map((c) => c.requestId),
    );
    const rows = log.calls.map((c): AgentActivityRow => {
      const mine = ours.get(c.requestId);
      return {
        at: new Date(c.at),
        tool: TOOLS[`${c.method} ${c.path}`] ?? `${c.method} ${c.path}`,
        outcome: outcomeOf(c.status),
        status: c.status,
        code: mine?.code ?? null,
        order: mine?.clientOrderId ? { clientOrderId: mine.clientOrderId, venueOrderId: mine.venueOrderId } : null,
        requestId: c.requestId,
      };
    });
    return { keyId, accountId: connection.accountId, asOf: new Date(log.asOf), rows };
  }
}
