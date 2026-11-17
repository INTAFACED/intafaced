import type { Sql } from 'postgres';
import {
  OWN_AGENT_ACCESS_MAX_DAYS,
  OWN_AGENT_SUB_ACCOUNT_PREFIX,
  type OwnAgentAccess,
  type OwnAgentAccountAccess,
  type OwnAgentPolicyAccount,
} from '@intafaced/contracts/agents-own';
import { OwnAgentRefusal } from './catalog.js';

/**
 * WHICH OF THE PERSON'S VENUE SUB-ACCOUNTS THEIR OWN AGENT MAY ACT ON, AND UNTIL WHEN (AG-spend-02, J-agents-08 #2).
 *
 * The person grants their agent access to named sub-accounts of their own venue account, with an end. A grant names the
 * sub-accounts exactly: it replaces what was live before, so "sub-account A only" leaves B with nothing. An action naming
 * a sub-account is refused before anything else is checked when no live access covers it (`agents.access_account_denied`)
 * or when the access covering it has ended (`agents.access_expired`). The main account is not a sub-account: its gate
 * stays the person's allow and deny rules (policy.ts). Access only narrows: it never moves value, and only the person
 * writes it (the routes take the user from the signed principal and refuse an agent's token).
 */

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const DAY_MS = 86_400_000;

/** The end the person set, in whole days from now: blank is refused, never defaulted. */
export function parseAccessEnd(raw: string | null | undefined, now: Date): Date {
  const text = (raw ?? '').trim();
  if (text === '') throw new OwnAgentRefusal('agents.access_expiry_unset');
  if (!/^[0-9]+$/.test(text)) throw new OwnAgentRefusal('agents.access_expiry_invalid', { max: String(OWN_AGENT_ACCESS_MAX_DAYS) });
  const days = Number(text);
  if (days < 1 || days > OWN_AGENT_ACCESS_MAX_DAYS)
    throw new OwnAgentRefusal('agents.access_expiry_invalid', { max: String(OWN_AGENT_ACCESS_MAX_DAYS) });
  return new Date(now.getTime() + days * DAY_MS);
}

export interface AccessGrantInput {
  readonly grantKey: string;
  readonly venueId: string;
  readonly owner: string;
  readonly subAccounts: readonly { readonly subAccount: string; readonly name: string }[];
  readonly endsIn: string | null | undefined;
}

/** The sub-account an action names, or null for the main account. */
export function subAccountOf(account: OwnAgentPolicyAccount): string | null {
  return account === 'main' ? null : account.slice(OWN_AGENT_SUB_ACCOUNT_PREFIX.length);
}

interface Row {
  id: string;
  venue_id: string;
  venue_owner: string;
  sub_account: string;
  name: string;
  granted_at: Date;
  ends_at: Date;
}
const view = (row: Row): OwnAgentAccountAccess => ({
  id: row.id,
  venueId: row.venue_id,
  owner: row.venue_owner,
  subAccount: row.sub_account,
  name: row.name,
  grantedAt: row.granted_at.toISOString(),
  endsAt: row.ends_at.toISOString(),
});

export const accessGrantKey = (agentId: string, grantKey: string) => `agents:access:${agentId}:${grantKey}`;

/**
 * The decision for one action's account against the live access rows: the main account is untouched here; a sub-account
 * needs a row for it whose end is still ahead. Pure.
 */
export function assertAccessAllows(
  rows: readonly Pick<OwnAgentAccountAccess, 'subAccount' | 'endsAt'>[],
  account: OwnAgentPolicyAccount,
  now: Date,
): void {
  const sub = subAccountOf(account);
  if (sub === null) return;
  const row = rows.find((r) => r.subAccount === sub);
  if (!row) throw new OwnAgentRefusal('agents.access_account_denied', { account });
  if (Date.parse(row.endsAt) <= now.getTime()) throw new OwnAgentRefusal('agents.access_expired', { account, endedAt: row.endsAt });
}

/** The person's account access for one agent. Every read and write is the owner's own rows only. */
export class OwnAccessStore {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Grants exactly `subAccounts`, until the end the person set, and ends whatever was live before, in one transaction.
   * A retry with the same grant key returns what that grant made and ends nothing. The caller has already read the agent
   * as the person's own.
   */
  async grant(ownerId: string, agentId: string, input: AccessGrantInput): Promise<OwnAgentAccess> {
    const key = accessGrantKey(agentId, input.grantKey);
    const owner = input.owner.trim().toLowerCase();
    if (!ADDRESS_RE.test(owner)) throw new OwnAgentRefusal('agents.access_request_invalid', { field: 'owner' });
    if (input.venueId.trim() === '') throw new OwnAgentRefusal('agents.access_request_invalid', { field: 'venueId' });
    const subs = input.subAccounts.map((s) => ({ subAccount: s.subAccount.trim().toLowerCase(), name: s.name.trim() }));
    if (subs.length === 0) throw new OwnAgentRefusal('agents.access_none_chosen');
    if (subs.some((s) => !ADDRESS_RE.test(s.subAccount)) || new Set(subs.map((s) => s.subAccount)).size !== subs.length)
      throw new OwnAgentRefusal('agents.access_request_invalid', { field: 'subAccounts' });
    const stored = await this.sql<Row[]>`
      SELECT id, venue_id, venue_owner, sub_account, name, granted_at, ends_at FROM agents.own_agent_account_access
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND grant_key = ${key}
    `;
    if (stored.length) return this.read(ownerId, agentId);
    const now = this.now();
    const endsAt = parseAccessEnd(input.endsIn, now);
    await this.sql.begin(async (tx) => {
      // One grant at a time per agent: the lock on the agent's row orders two grants sent at once.
      await tx`SELECT id FROM agents.own_agents WHERE id = ${agentId} AND owner_id = ${ownerId} FOR UPDATE`;
      const again = await tx<{ id: string }[]>`
        SELECT id FROM agents.own_agent_account_access WHERE owner_id = ${ownerId} AND grant_key = ${key} LIMIT 1
      `;
      if (again.length) return;
      await tx`
        UPDATE agents.own_agent_account_access SET ended_at = ${now}
         WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND ended_at IS NULL
      `;
      for (const s of subs) {
        await tx`
          INSERT INTO agents.own_agent_account_access
            (agent_id, owner_id, grant_key, venue_id, venue_owner, sub_account, name, granted_at, ends_at)
          VALUES (${agentId}, ${ownerId}, ${key}, ${input.venueId.trim()}, ${owner}, ${s.subAccount}, ${s.name}, ${now}, ${endsAt})
        `;
      }
    });
    return this.read(ownerId, agentId);
  }

  /** The access rows still in force or ended only by time (not replaced), newest grant first. */
  async read(ownerId: string, agentId: string): Promise<OwnAgentAccess> {
    const rows = await this.sql<Row[]>`
      SELECT id, venue_id, venue_owner, sub_account, name, granted_at, ends_at FROM agents.own_agent_account_access
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND ended_at IS NULL
       ORDER BY granted_at DESC, name, id
    `;
    return { grants: rows.map(view) };
  }

  /** The gate an action naming an account passes before the rules: refused with its code, or it returns. */
  async assertAllows(ownerId: string, agentId: string, account: OwnAgentPolicyAccount): Promise<void> {
    if (subAccountOf(account) === null) return;
    assertAccessAllows((await this.read(ownerId, agentId)).grants, account, this.now());
  }
}
