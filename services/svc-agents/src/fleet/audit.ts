import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { isCopyKey, render, type CopyKey } from '../copy.js';
import { assertSessionLogPageLimit, assertUserLogPageLimit } from '../errors.js';
import type { RefusalCode } from './guardrails.js';

/**
 * THE AUDIT LOG (§8.2 Agentic Law).
 *
 *   "Every action → agent_actions table + user-visible log"
 *
 * Two properties, and they are not the same property:
 *
 *   **Append-only.** Enforced by a trigger in the migration. There is no update
 *   or delete path in this module — not because nobody wrote one, but because
 *   the database would reject it if they did.
 *
 *   **Tamper-evident.** Each row carries `hash = SHA-256(prev_hash ‖ canonical
 *   row)`, chained per session, exactly as svc-ledger chains transactions. The
 *   trigger stops the service from rewriting the log; the chain makes a rewrite
 *   by anyone with direct database access *detectable*. `verifyChain` is the
 *   check, and it is a test assertion as well as an operator tool.
 *
 * An agent action that cannot be explained afterwards is worse than one that
 * did not happen — so refusals are appended with the same ceremony as
 * successes, and a refusal without a machine code is rejected by a CHECK
 * constraint rather than merely discouraged.
 */

export type ActionKind = 'session_open' | 'session_close' | 'completion' | 'embedding' | 'tool_call' | 'usage_settlement';
export type ActionStatus = 'executed' | 'refused' | 'failed';

export interface AuditEntry {
  readonly sessionId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly kind: ActionKind;
  readonly status: ActionStatus;
  readonly tool?: string | null;
  readonly task?: string | null;
  readonly providerId?: string | null;
  readonly model?: string | null;
  readonly inputTokens?: bigint;
  readonly outputTokens?: bigint;
  readonly cost?: Amount;
  readonly refusalCode?: RefusalCode | null;
  /** i18n key — never rendered prose (§14 DoD 4, Doctrine §0.7). */
  readonly userMessageKey: CopyKey;
  readonly userMessageParams?: Readonly<Record<string, string | number>>;
  readonly inputDigest?: string | null;
  readonly outputDigest?: string | null;
}

export interface AuditedAction {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly sequence: number;
  readonly kind: ActionKind;
  readonly status: ActionStatus;
  readonly tool: string | null;
  readonly task: string | null;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
  readonly cost: Amount;
  readonly refusalCode: string | null;
  readonly userMessageKey: string;
  readonly userMessageParams: Record<string, string | number>;
  readonly inputDigest: string | null;
  readonly outputDigest: string | null;
  readonly prevHash: string | null;
  readonly hash: string;
  readonly occurredAt: Date;
}

interface ActionRow {
  id: string;
  session_id: string;
  user_id: string;
  agent_id: string;
  sequence: number;
  kind: ActionKind;
  status: ActionStatus;
  tool: string | null;
  task: string | null;
  provider_id: string | null;
  model: string | null;
  input_tokens: string;
  output_tokens: string;
  cost: string;
  refusal_code: string | null;
  user_message_key: string;
  user_message_params: Record<string, string | number>;
  input_digest: string | null;
  output_digest: string | null;
  prev_hash: string | null;
  hash: string;
  occurred_at: Date;
}

export class AuditLog {
  constructor(private readonly sql: Sql) {}

  /**
   * Append one action.
   *
   * MUST be called inside a transaction that already holds the session row —
   * `sequence` and `prev_hash` are both read-then-written, and two concurrent
   * actions on one session would otherwise race to the same sequence number.
   * The unique index on `(session_id, sequence)` catches the race; the lock
   * means the loser waits instead of failing, which is the difference between
   * a queued action and a lost one.
   */
  async append(tx: Sql, entry: AuditEntry): Promise<AuditedAction> {
    // Re-entrant within a transaction, so callers that already locked the
    // session pay nothing and callers that did not are made safe.
    await tx`SELECT id FROM agents.agent_sessions WHERE id = ${entry.sessionId} FOR UPDATE`;

    const tip = await tx<Array<{ sequence: number; hash: string }>>`
      SELECT sequence, hash FROM agents.agent_actions
       WHERE session_id = ${entry.sessionId}
       ORDER BY sequence DESC
       LIMIT 1
    `;

    const sequence = tip[0] ? tip[0].sequence + 1 : 0;
    const prevHash = tip[0]?.hash ?? null;
    const occurredAt = new Date();

    const normalised = {
      sessionId: entry.sessionId,
      userId: entry.userId,
      agentId: entry.agentId,
      sequence,
      kind: entry.kind,
      status: entry.status,
      tool: entry.tool ?? null,
      task: entry.task ?? null,
      providerId: entry.providerId ?? null,
      model: entry.model ?? null,
      inputTokens: entry.inputTokens ?? 0n,
      outputTokens: entry.outputTokens ?? 0n,
      cost: entry.cost ?? 0n,
      refusalCode: entry.refusalCode ?? null,
      userMessageKey: entry.userMessageKey,
      userMessageParams: entry.userMessageParams ?? {},
      inputDigest: entry.inputDigest ?? null,
      outputDigest: entry.outputDigest ?? null,
      occurredAt,
    };

    const hash = hashAction(normalised, prevHash);

    const rows = await tx<ActionRow[]>`
      INSERT INTO agents.agent_actions (
        session_id, user_id, agent_id, sequence, kind, status,
        tool, task, provider_id, model,
        input_tokens, output_tokens, cost,
        refusal_code, user_message_key, user_message_params,
        input_digest, output_digest, prev_hash, hash, occurred_at
      ) VALUES (
        ${normalised.sessionId}, ${normalised.userId}, ${normalised.agentId}, ${sequence},
        ${normalised.kind}, ${normalised.status},
        ${normalised.tool}, ${normalised.task}, ${normalised.providerId}, ${normalised.model},
        ${normalised.inputTokens.toString()}::bigint, ${normalised.outputTokens.toString()}::bigint,
        ${formatAmount(normalised.cost)}::numeric,
        ${normalised.refusalCode}, ${normalised.userMessageKey},
        ${tx.json(normalised.userMessageParams as never)},
        ${normalised.inputDigest}, ${normalised.outputDigest}, ${prevHash}, ${hash}, ${occurredAt}
      )
      RETURNING *
    `;

    return toAction(rows[0]!);
  }

  async byId(id: string): Promise<AuditedAction | null> {
    const rows = await this.sql<ActionRow[]>`
      SELECT * FROM agents.agent_actions WHERE id = ${id} LIMIT 1
    `;
    return rows[0] ? toAction(rows[0]) : null;
  }

  /** Paged session log, sequence ASC. Blank limit refuses. Never invent 100. */
  async forSession(sessionId: string, limit: number): Promise<AuditedAction[]> {
    const page = assertSessionLogPageLimit(limit);
    const rows = await this.sql<ActionRow[]>`
      SELECT * FROM agents.agent_actions WHERE session_id = ${sessionId} ORDER BY sequence ASC
      LIMIT ${page}
    `;
    return rows.map(toAction);
  }

  /**
   * The session's actions after sequence `after` (null: from the first, the open at sequence 0), sequence ASC: a cursor
   * read (AG-sessions-04). Blank limit refuses.
   */
  async forSessionAfter(sessionId: string, after: number | null, limit: number): Promise<AuditedAction[]> {
    const page = assertSessionLogPageLimit(limit);
    const rows = await this.sql<ActionRow[]>`
      SELECT * FROM agents.agent_actions
       WHERE session_id = ${sessionId} AND sequence > ${after ?? -1}
       ORDER BY sequence ASC
       LIMIT ${page}
    `;
    return rows.map(toAction);
  }

  /**
   * Full session chain, sequence ASC. Hash-chain work set for verifyChain —
   * not a list page. Paging here would hide breaks.
   */
  async forSessionChain(sessionId: string): Promise<AuditedAction[]> {
    const rows = await this.sql<ActionRow[]>`
      SELECT * FROM agents.agent_actions WHERE session_id = ${sessionId} ORDER BY sequence ASC
    `;
    return rows.map(toAction);
  }

  /**
   * THE USER-VISIBLE LOG (§8.2).
   *
   * Returns keys and parameters, not sentences. The surface renders them from
   * its own i18n catalogue, which is what keeps a hundred locales a translation
   * problem rather than a refactor (§9 i18n) — and what keeps this service from
   * ever being the thing that put a vendor's name on a screen.
   */
  async forUser(userId: string, limit: number): Promise<AuditedAction[]> {
    const page = assertUserLogPageLimit(limit);
    const rows = await this.sql<ActionRow[]>`
      SELECT * FROM agents.agent_actions
       WHERE user_id = ${userId}
       ORDER BY occurred_at DESC, sequence DESC
       LIMIT ${page}
    `;
    return rows.map(toAction);
  }

  /**
   * Recompute the chain for a session.
   *
   * Returns the first index that disagrees, or `ok`. This is what makes the log
   * evidence rather than a claim: the trigger prevents the service from
   * rewriting a row, and this detects a rewrite made around the service.
   */
  async verifyChain(sessionId: string): Promise<{ ok: true } | { ok: false; brokenAtSequence: number; reason: string }> {
    const actions = await this.forSessionChain(sessionId);

    let previous: string | null = null;
    for (const [index, action] of actions.entries()) {
      if (action.sequence !== index) {
        return { ok: false, brokenAtSequence: action.sequence, reason: 'sequence is not dense — an action is missing' };
      }
      if (action.prevHash !== previous) {
        return { ok: false, brokenAtSequence: action.sequence, reason: 'prev_hash does not match the preceding action' };
      }

      const expected = hashAction(
        {
          sessionId: action.sessionId,
          userId: action.userId,
          agentId: action.agentId,
          sequence: action.sequence,
          kind: action.kind,
          status: action.status,
          tool: action.tool,
          task: action.task,
          providerId: action.providerId,
          model: action.model,
          inputTokens: action.inputTokens,
          outputTokens: action.outputTokens,
          cost: action.cost,
          refusalCode: action.refusalCode,
          userMessageKey: action.userMessageKey,
          userMessageParams: action.userMessageParams,
          inputDigest: action.inputDigest,
          outputDigest: action.outputDigest,
          occurredAt: action.occurredAt,
        },
        previous,
      );

      if (expected !== action.hash) {
        return { ok: false, brokenAtSequence: action.sequence, reason: 'row contents do not match its recorded hash' };
      }

      previous = action.hash;
    }

    return { ok: true };
  }
}

interface HashableAction {
  sessionId: string;
  userId: string;
  agentId: string;
  sequence: number;
  kind: string;
  status: string;
  tool: string | null;
  task: string | null;
  providerId: string | null;
  model: string | null;
  inputTokens: bigint;
  outputTokens: bigint;
  cost: Amount;
  refusalCode: string | null;
  userMessageKey: string;
  userMessageParams: Record<string, string | number>;
  inputDigest: string | null;
  outputDigest: string | null;
  occurredAt: Date;
}

/**
 * `SHA-256(prev_hash ‖ canonical(action))`.
 *
 * The canonical form is a fixed-order array, not `JSON.stringify` of an object:
 * object key order is an implementation detail of whatever built the value, and
 * a hash that depends on it would break the chain on a refactor that changed
 * nothing. Amounts and token counts are stringified, so bigint precision
 * survives serialisation intact.
 */
export function hashAction(action: HashableAction, prevHash: string | null): string {
  const canonical = JSON.stringify([
    action.sessionId,
    action.userId,
    action.agentId,
    action.sequence,
    action.kind,
    action.status,
    action.tool,
    action.task,
    action.providerId,
    action.model,
    action.inputTokens.toString(),
    action.outputTokens.toString(),
    formatAmount(action.cost),
    action.refusalCode,
    action.userMessageKey,
    // Params are sorted so two logically identical rows hash identically.
    Object.entries(action.userMessageParams)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, String(v)]),
    action.inputDigest,
    action.outputDigest,
    action.occurredAt.toISOString(),
  ]);

  return createHash('sha256')
    .update(`${prevHash ?? ''} ${canonical}`)
    .digest('hex');
}

function toAction(row: ActionRow): AuditedAction {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    agentId: row.agent_id,
    sequence: Number(row.sequence),
    kind: row.kind,
    status: row.status,
    tool: row.tool,
    task: row.task,
    providerId: row.provider_id,
    model: row.model,
    inputTokens: BigInt(row.input_tokens),
    outputTokens: BigInt(row.output_tokens),
    cost: parseAmount(row.cost),
    refusalCode: row.refusal_code,
    userMessageKey: row.user_message_key,
    userMessageParams: row.user_message_params ?? {},
    inputDigest: row.input_digest,
    outputDigest: row.output_digest,
    prevHash: row.prev_hash,
    hash: row.hash,
    occurredAt: row.occurred_at,
  };
}

/**
 * Render one log line for an operator reading the table directly.
 *
 * Not a wire format. The API returns the key and the parameters; this exists so
 * a developer looking at `agent_actions` in psql can see what the user saw
 * without having to hold the catalogue in their head.
 */
export function describe(action: AuditedAction): string {
  return isCopyKey(action.userMessageKey) ? render(action.userMessageKey, action.userMessageParams) : action.userMessageKey;
}
