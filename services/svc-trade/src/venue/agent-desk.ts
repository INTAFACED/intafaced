import { randomUUID } from 'node:crypto';
import { formatAmount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import { isTestVenue, type UserVenue } from '@intafaced/venue-contracts';
import { AgentAccountError } from './agent-account.js';
import type { AgentAccountStore } from './agent-account-store.js';
import type { AgentConnectionRecord, AgentConnectionStore } from './agent-connection-store.js';
import type { AgentDeskAuditRecord, AgentDeskAuditStore } from './agent-desk-store.js';
import type { AgentKeyCallReader, AgentKeyReader } from './agent-key-read-client.js';

/**
 * The founder's desk over every person's outside assistant connections (J-agents-21 #15; AG-outside-04, AG-control-02).
 *
 * The list: each connection (one of a person's own `agent` API keys bound to one of their agent accounts) with its
 * person, the account's cap, the account's balance as the venue reports it, the key's state as identity holds it, and the
 * key's last call from identity's call log. A value that could not be read reads unknown, never a guess.
 *
 * Quarantine: the connection ends here, so svc-trade places nothing more for the key, and one audit row names the
 * operator and their reason. The console revokes the key itself at identity first (`ops.apiKeyOps.revoke`, which keeps
 * its own row of actor and reason), so the key's next call is refused at the door. A key is quarantined once: the same
 * call again reads back the first row and ends nothing new. Money: nothing moves; the funds stay on the person's own
 * venue sub-account under their own wallet, and the person's own Revoke and Close still work.
 */

/** How many connections and audit rows one read shows; more is said, never cut silently. */
export const AGENT_DESK_READ_LIMIT = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9:_-]{8,200}$/;

export interface AgentDeskDeps {
  readonly connections: AgentConnectionStore;
  readonly accounts: AgentAccountStore;
  readonly audit: AgentDeskAuditStore;
  readonly keys: AgentKeyReader;
  readonly calls: AgentKeyCallReader;
  /** The person's venue, for the agent account's balance as the venue reports it; `null` when the door is off. */
  readonly venue: (() => Promise<UserVenue>) | null;
  readonly now: () => Date;
}

export type AgentDeskKnown<T> = { readonly known: true; readonly value: T } | { readonly known: false };

export interface AgentDeskQuarantineView {
  readonly operatorId: string;
  readonly reason: string;
  readonly at: string;
  readonly requestId: string;
}

export interface AgentDeskConnectionRow {
  readonly keyId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly connectedAt: string;
  readonly endedAt: string | null;
  /** The agent account's cap and asset, as the person set them. */
  readonly asset: string | null;
  readonly cap: string | null;
  readonly accountStatus: string | null;
  /** The agent account's total in its asset, as the venue reports it. */
  readonly balance: AgentDeskKnown<string>;
  /** `live`, `revoked` (or past its end date), `unknown` when identity could not be asked. */
  readonly keyState: 'live' | 'revoked' | 'unknown';
  /** The key's newest call, as the edge logged it. `null`: no call yet. */
  readonly lastAction: AgentDeskKnown<{
    readonly at: string;
    readonly method: string;
    readonly path: string;
    readonly status: number;
  } | null>;
  readonly quarantine: AgentDeskQuarantineView | null;
}

export interface AgentDeskConnections {
  readonly rows: readonly AgentDeskConnectionRow[];
  readonly limit: number;
  readonly more: boolean;
  /** Whether the balances are the TEST venue's. */
  readonly test: boolean | null;
}

export interface AgentDeskAuditRow extends AgentDeskQuarantineView {
  readonly id: string;
  readonly action: 'quarantine';
  readonly keyId: string;
  readonly userId: string;
  readonly accountId: string;
}

const quarantineView = (r: AgentDeskAuditRecord): AgentDeskQuarantineView => ({
  operatorId: r.operatorId,
  reason: r.reason,
  at: r.at.toISOString(),
  requestId: r.requestId,
});

const auditRow = (r: AgentDeskAuditRecord): AgentDeskAuditRow => ({
  id: r.id,
  action: r.action,
  keyId: r.keyId,
  userId: r.userId,
  accountId: r.accountId,
  ...quarantineView(r),
});

export class AgentDesk {
  constructor(private readonly deps: AgentDeskDeps) {}

  /** Every connection, newest first, each with its person, cap, balance, key state, last action and quarantine. */
  async connections(): Promise<AgentDeskConnections> {
    const all = await this.deps.connections.listAll(AGENT_DESK_READ_LIMIT + 1);
    const page = all.slice(0, AGENT_DESK_READ_LIMIT);
    const quarantines = await this.deps.audit.quarantines([...new Set(page.map((c) => c.keyId))]);
    const venue = this.deps.venue ? await this.deps.venue().catch(() => null) : null;
    const rows = await Promise.all(page.map((c) => this.row(c, venue, quarantines.get(c.keyId) ?? null)));
    return { rows, limit: AGENT_DESK_READ_LIMIT, more: all.length > AGENT_DESK_READ_LIMIT, test: venue ? isTestVenue(venue.venue) : null };
  }

  private async row(c: AgentConnectionRecord, venue: UserVenue | null, q: AgentDeskAuditRecord | null): Promise<AgentDeskConnectionRow> {
    const [account, key, calls] = await Promise.all([
      this.deps.accounts.find(c.userId, c.accountId),
      this.deps.keys.read(c.userId, c.keyId).catch(() => null),
      this.deps.calls.calls(c.userId, c.keyId, 1).catch(() => null),
    ]);
    let balance: AgentDeskKnown<string> = { known: false };
    if (account && account.subAccount !== null && venue && venue.venue.id === account.venueId) {
      const read = await venue
        .balances({ venueId: account.venueId, owner: account.owner, subAccount: account.subAccount })
        .catch(() => null);
      if (read) {
        const held = read.value.find((b) => b.asset === account.asset);
        balance = { known: true, value: held ? formatAmount(held.total) : '0' };
      }
    }
    const newest = calls?.state === 'found' ? (calls.calls[0] ?? null) : null;
    return {
      keyId: c.keyId,
      userId: c.userId,
      accountId: c.accountId,
      connectedAt: c.createdAt.toISOString(),
      endedAt: c.endedAt ? c.endedAt.toISOString() : null,
      asset: account?.asset ?? null,
      cap: account ? formatAmount(account.cap) : null,
      accountStatus: account?.status ?? null,
      balance,
      keyState: key === null ? 'unknown' : key.state === 'found' && !key.revoked ? 'live' : 'revoked',
      lastAction:
        calls === null
          ? { known: false }
          : { known: true, value: newest && { at: newest.at, method: newest.method, path: newest.path, status: newest.status } },
      quarantine: q ? quarantineView(q) : null,
    };
  }

  /**
   * Quarantine one connection: its audit row naming the operator and the reason, then the connection ends. Safe to
   * repeat: a key already quarantined reads back its first row, and the end is written again only if it is not ended.
   */
  async quarantine(
    operator: Principal,
    input: { keyId: string; reason: string; requestId: string },
  ): Promise<{ readonly quarantine: AgentDeskAuditRow; readonly endedAt: string; readonly replayed: boolean }> {
    const keyId = input.keyId.trim().toLowerCase();
    const reason = input.reason.trim();
    const requestId = input.requestId.trim();
    if (!UUID_RE.test(keyId) || !REQUEST_ID_RE.test(requestId)) {
      throw new AgentAccountError('agents.desk_request_invalid', 'keyId must be a UUID and requestId 8 to 200 plain characters', 400);
    }
    if (reason.length < 3 || reason.length > 500) {
      throw new AgentAccountError('agents.desk_reason_required', 'a reason of 3 to 500 characters is required to quarantine', 400);
    }
    const c = await this.deps.connections.latest(keyId);
    if (!c) throw new AgentAccountError('agents.key_not_connected', `API key ${keyId} trades no agent account`, 404);
    const { row, created } = await this.deps.audit.quarantineOnce({
      id: randomUUID(),
      action: 'quarantine',
      keyId,
      userId: c.userId,
      accountId: c.accountId,
      operatorId: operator.userId,
      reason,
      requestId,
      at: this.deps.now(),
    });
    const ended = c.endedAt ?? (await this.deps.connections.end(keyId, this.deps.now()))?.endedAt;
    if (!ended) throw new Error(`the connection of key ${keyId} did not end`);
    return { quarantine: auditRow(row), endedAt: ended.toISOString(), replayed: !created };
  }

  /** The desk's audit log, newest first. */
  async audit(): Promise<{ readonly rows: readonly AgentDeskAuditRow[]; readonly limit: number }> {
    return { rows: (await this.deps.audit.list(AGENT_DESK_READ_LIMIT)).map(auditRow), limit: AGENT_DESK_READ_LIMIT };
  }
}
