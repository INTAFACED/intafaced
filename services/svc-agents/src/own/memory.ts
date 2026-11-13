import type { Sql, TransactionSql } from 'postgres';
import {
  OWN_AGENT_RETENTION_KINDS,
  type OwnAgentMemory,
  type OwnAgentMemoryItem,
  type OwnAgentPrivacy,
  type OwnAgentRetentionKind,
  type OwnAgentRunMemory,
  type OwnAgentShare,
  type OwnAgentShareCheck,
} from '@intafaced/contracts/agents-own';
import { OwnAgentRefusal } from './catalog.js';

/**
 * WHAT A PERSON'S OWN AGENT REMEMBERS, AND WHAT IS KEPT ABOUT THEM (AG-builder-02, AG-guardrails-04; J-agents-09).
 *
 * An item is remembered only when the person asks a run to remember it ("remember that ..."): the run's log shows the
 * `remember` step, and the item names that run as its source. Memory is on for an agent until the person switches it
 * off; while it is off a run writes nothing and says so. An item that looks like an account number, a key, a secret or a
 * balance is refused `agents.memory_item_refused` and never stored. Clearing an item deletes that one row; the run that
 * remembered it keeps its log. Retention periods are the owner's values: a blank one reads "not set" and a write that
 * needs it refuses `agents.retention_unset`; none is invented. Nothing here is a balance and no value moves.
 */

/** The owner's retention periods in whole days, by kind; a kind left out has none stored. */
export type RetentionPeriods = Partial<Readonly<Record<OwnAgentRetentionKind, number>>>;

/** The periods the owner stored, leaving out every blank one. */
export function retentionPeriods(values: Readonly<Record<OwnAgentRetentionKind, number | null | undefined>>): RetentionPeriods {
  const periods: Partial<Record<OwnAgentRetentionKind, number>> = {};
  for (const kind of OWN_AGENT_RETENTION_KINDS) {
    const days = values[kind];
    if (typeof days === 'number') periods[kind] = days;
  }
  return periods;
}

/** The longest item kept, in characters. */
export const MEMORY_ITEM_MAX = 500;

/**
 * The item a question asks the agent to remember, or null when it asks for none: "remember that I prefer limit orders"
 * is "I prefer limit orders". A leading "TEST:" label is not part of it.
 */
export function rememberRequest(ask: string): string | null {
  const match = /^\s*(?:TEST:\s*)?(?:please\s+)?remember\s+(?:that\s+)?([\s\S]+?)\s*[.!]?\s*$/i.exec(ask);
  const text = match?.[1]?.trim();
  return text ? text : null;
}

/**
 * Whether an item may never be remembered: anything that reads as an account or card number (an IBAN, or a run of eight
 * or more digits, spaces and dashes allowed between them), a key, a secret, a password, a seed phrase, a PIN, a private
 * key, or a balance. Deterministic, so the same item is always refused the same way.
 */
export function memoryItemRefused(text: string): boolean {
  const compact = text.replace(/[\s-]/g, '');
  if (/[A-Z]{2}\d{2}[A-Z0-9]{10,30}/i.test(compact)) return true;
  if (/\d{8,}/.test(compact)) return true;
  if (/0x[0-9a-f]{40,}/i.test(compact)) return true;
  return /\b(account\s*(number|no\.?)|iban|card\s*number|cvc|cvv|pin|password|passphrase|secret|seed(\s*phrase)?|private\s*key|api\s*key|mnemonic|balance)\b/i.test(
    text,
  );
}

/** What a run does with a question, before anything is stored: no request, off, refused, or the item to write. */
export type MemoryDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'off' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'remember'; readonly text: string };

export function decideMemory(ask: string, enabled: boolean): MemoryDecision {
  const text = rememberRequest(ask);
  if (text === null) return { kind: 'none' };
  if (!enabled) return { kind: 'off' };
  if (text.length > MEMORY_ITEM_MAX || memoryItemRefused(text)) return { kind: 'refused' };
  return { kind: 'remember', text };
}

/** The run's memory outcome as stored and shown, before the item has an id. The refused text is never kept. */
export function runMemoryOf(decision: MemoryDecision): OwnAgentRunMemory | null {
  switch (decision.kind) {
    case 'none':
      return null;
    case 'off':
      return { outcome: 'off', itemId: null, text: null, code: 'agents.memory_disabled' };
    case 'refused':
      return { outcome: 'refused', itemId: null, text: null, code: 'agents.memory_item_refused' };
    case 'remember':
      return { outcome: 'remembered', itemId: null, text: decision.text, code: null };
  }
}

/** The key of the one item a run may write. */
export const memoryItemKey = (runId: string): string => `agents:memory:${runId}:1`;

type ItemRow = { id: string; text: string; source_run_id: string; created_at: Date };
const itemView = (row: ItemRow): OwnAgentMemoryItem => ({
  id: row.id,
  text: row.text,
  sourceRunId: row.source_run_id,
  createdAt: row.created_at.toISOString(),
});

type ControlRow = {
  memory_enabled: boolean;
  keep_transcripts: boolean;
  share_transcripts: boolean;
  share_memory: boolean;
  shared_at: Date | null;
};
const DEFAULT_CONTROLS: ControlRow = {
  memory_enabled: true,
  keep_transcripts: false,
  share_transcripts: false,
  share_memory: false,
  shared_at: null,
};

type Db = Sql | TransactionSql;

/** The person's memory, data controls and share for one of their own agents. The caller has checked the agent is theirs. */
export class OwnMemoryStore {
  constructor(private readonly sql: Sql) {}

  async controls(ownerId: string, agentId: string, db: Db = this.sql): Promise<ControlRow> {
    const rows = await db<ControlRow[]>`
      SELECT memory_enabled, keep_transcripts, share_transcripts, share_memory, shared_at
        FROM agents.own_agent_data_controls WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
    `;
    return rows[0] ?? DEFAULT_CONTROLS;
  }

  /** Writes a run's item under the run's key, in the run's own transaction; a retried run finds it there. */
  async write(tx: TransactionSql, ownerId: string, agentId: string, runId: string, text: string): Promise<string> {
    const key = memoryItemKey(runId);
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO agents.own_agent_memory (agent_id, owner_id, item_key, text, source_run_id, created_at)
      VALUES (${agentId}, ${ownerId}, ${key}, ${text}, ${runId}, clock_timestamp())
      ON CONFLICT (owner_id, item_key) DO NOTHING
      RETURNING id
    `;
    if (inserted[0]) return inserted[0].id;
    const stored = await tx<{ id: string }[]>`SELECT id FROM agents.own_agent_memory WHERE owner_id = ${ownerId} AND item_key = ${key}`;
    return stored[0]!.id;
  }

  async get(ownerId: string, agentId: string, limit: number): Promise<OwnAgentMemory> {
    const { memory_enabled } = await this.controls(ownerId, agentId);
    const rows = await this.sql<ItemRow[]>`
      SELECT id, text, source_run_id, created_at FROM agents.own_agent_memory
       WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
       ORDER BY created_at DESC, id
       LIMIT ${limit}
    `;
    return { enabled: memory_enabled, items: rows.map(itemView) };
  }

  /** Clears one item: one delete of the person's own row. Another person's item, or one already gone, is not found. */
  async clear(ownerId: string, agentId: string, itemId: string): Promise<void> {
    const deleted = await this.sql`
      DELETE FROM agents.own_agent_memory WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND id = ${itemId} RETURNING id
    `;
    if (deleted.length === 0) throw new OwnAgentRefusal('agents.memory.not_found');
  }

  async setEnabled(ownerId: string, agentId: string, enabled: boolean): Promise<void> {
    await this.sql`
      INSERT INTO agents.own_agent_data_controls (agent_id, owner_id, memory_enabled, updated_at)
      VALUES (${agentId}, ${ownerId}, ${enabled}, now())
      ON CONFLICT (agent_id) DO UPDATE SET memory_enabled = EXCLUDED.memory_enabled, updated_at = now()
    `;
  }

  async privacy(ownerId: string, agentId: string, periods: RetentionPeriods): Promise<OwnAgentPrivacy> {
    const controls = await this.controls(ownerId, agentId);
    return {
      periods: OWN_AGENT_RETENTION_KINDS.map((kind) => ({ kind, days: periods[kind] ?? null })),
      keepTranscripts: controls.keep_transcripts,
      memoryEnabled: controls.memory_enabled,
    };
  }

  /**
   * Keeps or stops keeping transcripts. Keeping them needs the owner's transcript period: blank refuses
   * `agents.retention_unset` and stores nothing. Stopping only tightens, so it never needs one.
   */
  async setKeepTranscripts(ownerId: string, agentId: string, keep: boolean, periods: RetentionPeriods): Promise<void> {
    if (keep && periods.transcripts === undefined) throw new OwnAgentRefusal('agents.retention_unset', { kind: 'transcripts' });
    await this.sql`
      INSERT INTO agents.own_agent_data_controls (agent_id, owner_id, keep_transcripts, updated_at)
      VALUES (${agentId}, ${ownerId}, ${keep}, now())
      ON CONFLICT (agent_id) DO UPDATE SET keep_transcripts = EXCLUDED.keep_transcripts, updated_at = now()
    `;
  }

  async share(ownerId: string, agentId: string): Promise<OwnAgentShare> {
    const controls = await this.controls(ownerId, agentId);
    return {
      shared: controls.shared_at !== null,
      includeTranscripts: controls.share_transcripts,
      includeMemory: controls.share_memory,
      sharedAt: controls.shared_at?.toISOString() ?? null,
    };
  }

  /** What a share would make visible to the agent's co-owners beyond the agent itself, and how many co-owners it has. */
  async shareCheck(ownerId: string, agentId: string, include: { transcripts: boolean; memory: boolean }): Promise<OwnAgentShareCheck> {
    const rows = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM agents.own_agent_co_owners WHERE agent_id = ${agentId}
    `;
    const exposes: OwnAgentShareCheck['exposes'] = [];
    if (include.transcripts) exposes.push('transcripts');
    if (include.memory) exposes.push('memory');
    return { exposes, coOwners: rows[0]?.n ?? 0 };
  }

  /**
   * Shares the agent with its co-owners. A share that exposes private context refuses `agents.privacy.confirm_required`
   * until the person confirms the privacy check; an agent with no co-owner has no one to share with
   * (`agents.share.no_co_owners`). Nothing is stored on a refusal.
   */
  async setShare(
    ownerId: string,
    agentId: string,
    input: { transcripts: boolean; memory: boolean; confirmed: boolean },
  ): Promise<OwnAgentShare> {
    const check = await this.shareCheck(ownerId, agentId, input);
    if (check.exposes.length > 0 && !input.confirmed) throw new OwnAgentRefusal('agents.privacy.confirm_required');
    if (check.coOwners === 0) throw new OwnAgentRefusal('agents.share.no_co_owners');
    await this.sql`
      INSERT INTO agents.own_agent_data_controls (agent_id, owner_id, share_transcripts, share_memory, shared_at, updated_at)
      VALUES (${agentId}, ${ownerId}, ${input.transcripts}, ${input.memory}, now(), now())
      ON CONFLICT (agent_id) DO UPDATE
        SET share_transcripts = EXCLUDED.share_transcripts, share_memory = EXCLUDED.share_memory,
            shared_at = EXCLUDED.shared_at, updated_at = now()
    `;
    return this.share(ownerId, agentId);
  }
}
