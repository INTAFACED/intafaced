import { bigint, boolean, index, integer, jsonb, pgSchema, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { amount, createdAt, tstz, updatedAt } from '@intafaced/db';

/**
 * THE AGENT FLEET RUNTIME (§8.2).
 *
 * Five tables, and the split between them is the whole design:
 *
 *   · `agent_definitions` — what an agent is allowed to do (the guardrail).
 *   · `agent_sessions`    — one run, with the guardrail SNAPSHOTTED onto it.
 *   · `agent_actions`     — what it actually did. Append-only. The Agentic Law.
 *   · `usage_windows`     — the billing period, and whether it has been settled.
 *   · `usage_records`     — exact token counts, priced at the rate in force.
 *
 * No balances here (Doctrine §0.6). `usage_windows.charged_amount` records what
 * a settlement posted to the ledger; it is written once, when the window seals,
 * and never updated. The money itself lives in svc-ledger, and the two are
 * reconcilable because the ledger transaction's idempotency key is derived from
 * the same `(session_id, window_id)` pair that identifies the row.
 */
export const agents = pgSchema('agents');

export const sessionStatusEnum = agents.enum('session_status', ['open', 'closed']);

/**
 * What kind of thing happened. Deliberately includes the boundaries
 * (`session_open`, `session_close`) and the money event (`usage_settlement`):
 * §8.2 says *every* action reaches this table, and a session whose opening is
 * not in its own log has a gap exactly where the guardrail was bound.
 */
export const actionKindEnum = agents.enum('action_kind', [
  'session_open',
  'session_close',
  'completion',
  'embedding',
  'tool_call',
  'usage_settlement',
]);

/**
 * `refused` is a first-class outcome, not an error.
 *
 * A guardrail refusal is the runtime working correctly, and it is the row an
 * operator most wants to find later — "the agent tried to do X and was stopped"
 * is the sentence the audit log exists to be able to produce. `failed` is
 * reserved for the engine or a tool breaking, which is a different
 * investigation entirely.
 */
export const actionStatusEnum = agents.enum('action_status', ['executed', 'refused', 'failed']);

/**
 * An agent's declared toolset and limits (§8.2 "defined toolset + guardrail
 * schema"). One row per agent; `version` bumps on every change.
 *
 * Shape is validated by `guardrailSchema` before insert, so the column stays
 * jsonb: the set of tools grows every time a module ships an API, and a column
 * per limit would mean a migration per capability.
 */
export const agentDefinitions = agents.table(
  'agent_definitions',
  {
    /** Natural key — 'navigator', 'support'. Agents are named, not numbered. */
    agentId: text('agent_id').primaryKey(),
    version: integer('version').notNull().default(1),
    guardrail: jsonb('guardrail').notNull(),
    /** Stored display name. Null when unpublished — never composed from the id. */
    name: text('name'),
    /** Stored purpose. Null when unpublished — never composed from tools or copy. */
    purpose: text('purpose'),
    /** Per-agent kill-switch. The module-wide one lives in packages/config flags. */
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('agent_definitions_enabled_idx').on(t.enabled)],
);

/**
 * One agent run for one user.
 *
 * `guardrail` here is a COPY of the definition's guardrail at open time, not a
 * reference to it. Same reasoning as `stakes.multiplier_bps` in svc-token:
 * widening an agent's powers must not retroactively legitimise what a running
 * session already did under narrower terms, and narrowing them must not
 * invalidate a log that was lawful when it was written.
 */
export const agentSessions = agents.table(
  'agent_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    agentId: text('agent_id').notNull(),
    guardrail: jsonb('guardrail').notNull(),
    guardrailVersion: integer('guardrail_version').notNull(),
    status: sessionStatusEnum('status').notNull().default('open'),
    /**
     * Whether this session bills. §8.2's premium tiers: an included-allowance
     * session records usage identically and simply never settles it, so the
     * question "what would this have cost" stays answerable for every session.
     */
    metered: boolean('metered').notNull().default(true),
    openedAt: tstz('opened_at').notNull().defaultNow(),
    closedAt: tstz('closed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    /** The user-visible session list. */
    index('agent_sessions_user_idx').on(t.userId, t.openedAt),
    index('agent_sessions_status_idx').on(t.status),
  ],
);

/**
 * THE AUDIT TABLE (§8.2 Agentic Law: "Every action → agent_actions table +
 * user-visible log").
 *
 * Append-only, enforced by a trigger in the migration rather than by
 * convention. An UPDATE or DELETE here raises — the point of an audit log is
 * that the system which wrote it cannot later disagree with it, and a log the
 * service can rewrite is a log that proves nothing.
 *
 * The rows also form a per-session hash chain (`prev_hash` → `hash`), the same
 * construction svc-ledger uses. The trigger stops the service from rewriting
 * history; the chain makes a rewrite by anyone with database access detectable
 * after the fact. Neither alone is enough.
 *
 * Content is stored as DIGESTS, not text. §10 keeps PII out of general stores,
 * and a prompt is exactly the kind of thing a user did not consent to have
 * retained. A digest still proves what was sent — replay the input, hash it,
 * compare — without this table becoming a transcript archive.
 */
export const agentActions = agents.table(
  'agent_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id),
    /** Denormalised so the user-visible log is one index scan, not a join. */
    userId: text('user_id').notNull(),
    agentId: text('agent_id').notNull(),
    /** Monotonic within a session. Gaps are visible; reordering is not possible. */
    sequence: integer('sequence').notNull(),
    kind: actionKindEnum('kind').notNull(),
    status: actionStatusEnum('status').notNull(),

    /** Set for tool calls. */
    tool: text('tool'),
    /** Set for engine calls — the ROUTING task, never a vendor model id. */
    task: text('task'),
    providerId: text('provider_id'),
    /** The routing-table alias. The concrete upstream id stays in the adapter. */
    model: text('model'),

    inputTokens: bigint('input_tokens', { mode: 'bigint' }).notNull().default(0n),
    outputTokens: bigint('output_tokens', { mode: 'bigint' }).notNull().default(0n),
    /** Derived cost of this action, for display. The BILL is the window's. */
    cost: amount('cost').notNull().default('0'),

    /** Machine code from `guardrails.ts`. Null unless `status = 'refused'`. */
    refusalCode: text('refusal_code'),

    /**
     * The user-visible log line, as an i18n KEY plus parameters (§14 DoD 4).
     *
     * Not prose. Storing rendered English would freeze one locale into the
     * audit trail and would be the one place a vendor's error text could reach
     * a user's screen unnoticed (Doctrine §0.7). The catalogue is `copy.ts`.
     */
    userMessageKey: text('user_message_key').notNull(),
    userMessageParams: jsonb('user_message_params').notNull().default({}),

    inputDigest: text('input_digest'),
    outputDigest: text('output_digest'),

    /** Per-session hash chain. Null on the first action of a session. */
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),

    occurredAt: tstz('occurred_at').notNull().defaultNow(),
  },
  (t) => [
    /** The chain's ordering, and the anti-reordering constraint. */
    uniqueIndex('agent_actions_session_sequence_idx').on(t.sessionId, t.sequence),
    /** "Show me everything this agent has done for me" — the user-visible log. */
    index('agent_actions_user_time_idx').on(t.userId, t.occurredAt),
    /** The compliance query: every refusal, across the fleet. */
    index('agent_actions_status_idx').on(t.status, t.occurredAt),
  ],
);

/**
 * Place-tool idempotency (PTX-M28-R05).
 *
 * Conversational repeat and transport retry reuse `(session, key)`. The first
 * successful `trade.order` / `trade.place` wins; a second `act` with the same
 * key returns that outcome and does not call `execute` again. Result JSON is
 * the tool outcome (order id / refuse payload), never a prompt.
 */
export const agentPlaceIntents = agents.table(
  'agent_place_intents',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id),
    idempotencyKey: text('idempotency_key').notNull(),
    tool: text('tool').notNull(),
    actionId: uuid('action_id')
      .notNull()
      .references(() => agentActions.id),
    resultJson: text('result_json').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.idempotencyKey] })],
);

/**
 * A billing period for one session.
 *
 * The row exists before any usage lands in it, and `sealed_at` is what makes
 * settlement idempotent in the only way that actually holds: a sealed window
 * accepts no further usage, so re-running settlement cannot find new tokens to
 * bill, and late usage is refused rather than silently appearing in a window
 * whose bill has already been posted.
 */
export const usageWindows = agents.table(
  'usage_windows',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => agentSessions.id),
    /** Derived from the clock by `windowIdFor` — identical on every replica. */
    windowId: text('window_id').notNull(),
    openedAt: tstz('opened_at').notNull().defaultNow(),
    sealedAt: tstz('sealed_at'),
    /** What settlement posted. Written once, at seal. Never a running total. */
    chargedAmount: amount('charged_amount'),
    /** Asset that amount was posted in. Null on windows sealed before this column. */
    chargedAsset: text('charged_asset'),
    /** The business idempotency key handed to `feeCharge`. */
    chargeKey: text('charge_key'),
    /** svc-ledger's transaction id — the other half of the reconciliation. */
    chargeTxId: text('charge_tx_id'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.windowId] }),
    /** The settlement sweep: windows that are open and old enough to close. */
    index('usage_windows_unsealed_idx').on(t.sealedAt),
  ],
);

/**
 * One metered call.
 *
 * Token counts only — no money. Cost is computed once per window at settlement
 * (`metering/pricing.ts` explains why rounding per call would drift), so this
 * table stores the exact integers the provider reported plus the RATE that was
 * in force. Carrying the rate is what stops a mid-window price change
 * re-pricing calls that already happened.
 */
export const usageRecords = agents.table(
  'usage_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    windowId: text('window_id').notNull(),
    /**
     * The caller's id for this completion. Unique per session, and THE reason a
     * retried completion cannot bill twice: the second insert conflicts and is
     * discarded before the tokens are ever counted.
     */
    requestId: text('request_id').notNull(),
    task: text('task').notNull(),
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'bigint' }).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'bigint' }).notNull(),
    /** Rate snapshot, per million tokens, in the fee asset. */
    inputPricePerMillion: amount('input_price_per_million').notNull(),
    outputPricePerMillion: amount('output_price_per_million').notNull(),
    recordedAt: tstz('recorded_at').notNull().defaultNow(),
  },
  (t) => [
    /** THE anti-double-bill constraint. */
    uniqueIndex('usage_records_request_idx').on(t.sessionId, t.requestId),
    /** Settlement's read: every record in one window, grouped by rate. */
    index('usage_records_window_idx').on(t.sessionId, t.windowId),
  ],
);

export const schema = { agentDefinitions, agentSessions, agentActions, usageWindows, usageRecords };
