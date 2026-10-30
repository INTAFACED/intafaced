import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, recipes, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import {
  affiliateLegAfterUsageFeeCharge,
  fireAffiliateAccrue,
  NoopAffiliateAccrue,
  type AffiliateAccruePort,
} from '../affiliate-accrue.js';
import { fireAffiliatePayout, NoopAffiliatePayout, type AffiliatePayoutPort } from '../affiliate-payout.js';
import { AgentError } from '../errors.js';
import type { ModelPrice } from '../gateway/routing.js';
import type { TokenUsage } from '../providers/provider.js';
import { withMoneySpan } from '../tracing.js';
import { windowCost, windowIdFor, type UsageGroup } from './pricing.js';

/**
 * METERING (§8.2: "token/cost metering per user → premium agent tiers billed
 * via ledger").
 *
 * This is a money path, so the two questions that matter are *is it exact* and
 * *is it idempotent*. They are answered in different places, deliberately.
 *
 * ── Exact ───────────────────────────────────────────────────────────────────
 *
 * `usage_records` stores integer token counts and the RATE that was in force —
 * never a cost. Costs are computed once per (window, rate) at settlement, in
 * `pricing.ts`, in scaled bigint. Nothing in this service multiplies a price by
 * a `number`, and no intermediate cost is ever rounded and then summed.
 *
 * ── Idempotent, in three independent layers ─────────────────────────────────
 *
 *   1. **The retried completion.** `usage_records` is unique on
 *      `(session_id, request_id)`. A caller that retries a completion after a
 *      timeout inserts the same request id, the insert is discarded, and the
 *      tokens are counted once. This is the layer that actually does the work.
 *
 *   2. **The seal.** Settlement seals the window *before* it touches the
 *      ledger, in its own transaction. A sealed window rejects further usage
 *      (trigger in the migration), so the amount is frozen the instant it is
 *      computed and cannot grow underneath a retry.
 *
 *   3. **The ledger key.** `feeCharge` is posted under
 *      `agent.usage:<sessionId>:<window>`. Re-posting returns the original
 *      transaction rather than a second charge.
 *
 * The order matters and is the whole design: seal → post → record the tx id.
 * Posting first would leave a window that a concurrent completion could still
 * grow, so a resumed settlement would compute a larger amount than the one the
 * ledger already accepted under that key — and the difference would be invisible
 * on both sides. Sealing first means a crash anywhere after it resumes to the
 * *same* amount, and the ledger's idempotency does the rest.
 */

export interface UsageMeterOptions {
  /** Asset metered usage is billed in. */
  readonly assetId: string;
  /** Window length in minutes. Must divide 1440. */
  readonly windowMinutes: number;
  /** Ledger `module` for the charge. Always 'agents' in production. */
  readonly module?: string;
  /** Identity accrue after feeCharge. Default noop when IDENTITY_URL is unset. */
  readonly affiliateAccrue?: AffiliateAccruePort;
  /** Identity payout after accrue. Default noop when IDENTITY_URL is unset. */
  readonly affiliatePayout?: AffiliatePayoutPort;
}

export interface RecordUsageInput {
  readonly sessionId: string;
  readonly requestId: string;
  readonly task: string;
  readonly providerId: string;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly price: ModelPrice;
  readonly at?: Date;
}

export interface RecordedUsage {
  readonly windowId: string;
  /** False when this request had already been metered — a retry. */
  readonly recorded: boolean;
}

export interface SettlementResult {
  readonly sessionId: string;
  readonly windowId: string;
  readonly chargeKey: string;
  readonly amount: Amount;
  /** Null when nothing was billable, or when the ledger post is still pending. */
  readonly chargeTxId: string | null;
  /** False when the window was already settled — the retry path. */
  readonly settled: boolean;
}

/** One usage window as a person's Usage page shows it. */
export interface UsageWindowView {
  readonly sessionId: string;
  readonly windowId: string;
  readonly state: 'open' | 'unpaid' | 'settled';
  /** Null while the window is open: its amount is fixed only when it seals. */
  readonly amount: Amount | null;
  readonly assetId: string;
  readonly chargeKey: string | null;
  readonly openedAt: Date;
}

/** One agent's sealed usage on one UTC day for one task (or the tasks one window ran as), summed exactly. */
export interface UsageDayView {
  readonly agentId: string;
  readonly day: string;
  readonly task: string;
  readonly amount: Amount;
  readonly windows: number;
  readonly assetId: string;
}

interface WindowRow {
  session_id: string;
  window_id: string;
  sealed_at: Date | null;
  charged_amount: string | null;
  charge_key: string | null;
  charge_tx_id: string | null;
}

/** The ledger charge key §8.2's metering is keyed on. */
export function chargeKeyFor(sessionId: string, windowId: string): string {
  return `agent.usage:${sessionId}:${windowId}`;
}

/** Sentinel for a settled window that had nothing to bill. */
const NO_CHARGE = 'none';

export class UsageMeter {
  private readonly assetId: string;
  private readonly windowMinutes: number;
  private readonly module: string;
  private readonly affiliateAccrue: AffiliateAccruePort;
  private readonly affiliatePayout: AffiliatePayoutPort;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    options: UsageMeterOptions,
  ) {
    this.assetId = options.assetId;
    this.windowMinutes = options.windowMinutes;
    this.module = options.module ?? 'agents';
    this.affiliateAccrue = options.affiliateAccrue ?? new NoopAffiliateAccrue();
    this.affiliatePayout = options.affiliatePayout ?? new NoopAffiliatePayout();
  }

  windowFor(at: Date = new Date()): string {
    return windowIdFor(at, this.windowMinutes);
  }

  /**
   * Record one call's usage.
   *
   * Takes a transaction so it commits with the audit row that describes the
   * same call: a usage record without its action, or an action without its
   * usage, would be a discrepancy nobody could resolve afterwards.
   */
  async record(tx: Sql, input: RecordUsageInput): Promise<RecordedUsage> {
    const at = input.at ?? new Date();
    const windowId = this.windowFor(at);

    await tx`
      INSERT INTO agents.usage_windows (session_id, window_id)
      VALUES (${input.sessionId}, ${windowId})
      ON CONFLICT (session_id, window_id) DO NOTHING
    `;

    let rows: Array<{ id: string }>;
    try {
      rows = await tx<Array<{ id: string }>>`
        INSERT INTO agents.usage_records (
          session_id, window_id, request_id, task, provider_id, model,
          input_tokens, output_tokens, input_price_per_million, output_price_per_million, recorded_at
        ) VALUES (
          ${input.sessionId}, ${windowId}, ${input.requestId}, ${input.task}, ${input.providerId}, ${input.model},
          ${BigInt(input.usage.inputTokens).toString()}::bigint, ${BigInt(input.usage.outputTokens).toString()}::bigint,
          ${formatAmount(input.price.inputPerMillion)}::numeric,
          ${formatAmount(input.price.outputPerMillion)}::numeric,
          ${at}
        )
        ON CONFLICT (session_id, request_id) DO NOTHING
        RETURNING id
      `;
    } catch (err) {
      // The seal trigger. Surfacing it as a typed error matters: "your usage
      // period has already been settled" is a caller problem with a defined
      // response, not a database fault to be retried into the same wall.
      if (isRestrictViolation(err)) {
        throw new AgentError(
          `Usage window ${windowId} for session ${input.sessionId} is already settled`,
          'agents.window_sealed',
          'agents.error.window_sealed',
        );
      }
      throw err;
    }

    return { windowId, recorded: rows.length > 0 };
  }

  /**
   * Commit a claim on `(session, request id)` before the provider is called.
   *
   * `hasRequest` alone loses the race: both callers read no usage row, both
   * invoke the model, and the loser's insert is discarded at cost 0. The
   * unique insert is the claim. False means the other call already owns it.
   */
  async claimRequest(sessionId: string, requestId: string): Promise<boolean> {
    const rows = await this.sql<Array<{ request_id: string }>>`
      INSERT INTO agents.think_claims (session_id, request_id)
      VALUES (${sessionId}, ${requestId})
      ON CONFLICT (session_id, request_id) DO NOTHING
      RETURNING request_id
    `;
    return rows.length > 0;
  }

  /** Drop a claim when the provider never returned a completion. */
  async releaseClaim(sessionId: string, requestId: string): Promise<void> {
    await this.sql`
      DELETE FROM agents.think_claims
       WHERE session_id = ${sessionId} AND request_id = ${requestId}
    `;
  }

  /**
   * True when this session already recorded a usage row for `requestId`.
   *
   * The anti-double-bill key is unique on `(session_id, request_id)`. A second
   * `think` with the same id must not re-enter the engine free of charge —
   * callers that lost a response open a new request id (or read the audit log).
   */
  async hasRequest(sessionId: string, requestId: string): Promise<boolean> {
    const rows = await this.sql<Array<{ n: string }>>`
      SELECT 1::text AS n FROM agents.usage_records
       WHERE session_id = ${sessionId} AND request_id = ${requestId}
       LIMIT 1
    `;
    return rows.length > 0;
  }

  /** Exact token totals per rate for one window. */
  async groupsFor(sql: Sql, sessionId: string, windowId: string): Promise<UsageGroup[]> {
    const rows = await sql<Array<{ input_tokens: string; output_tokens: string; in_price: string; out_price: string }>>`
      SELECT SUM(input_tokens)::text  AS input_tokens,
             SUM(output_tokens)::text AS output_tokens,
             input_price_per_million  AS in_price,
             output_price_per_million AS out_price
        FROM agents.usage_records
       WHERE session_id = ${sessionId} AND window_id = ${windowId}
       GROUP BY input_price_per_million, output_price_per_million
       ORDER BY input_price_per_million, output_price_per_million
    `;

    return rows.map((r) => ({
      inputTokens: BigInt(r.input_tokens ?? '0'),
      outputTokens: BigInt(r.output_tokens ?? '0'),
      price: { inputPerMillion: parseAmount(r.in_price), outputPerMillion: parseAmount(r.out_price) },
    }));
  }

  /** What a window would cost if settled now. Read-only; bills nothing. */
  async pendingCost(sessionId: string, windowId: string): Promise<Amount> {
    return windowCost(await this.groupsFor(this.sql, sessionId, windowId));
  }

  /**
   * Total metered cost accrued by a session so far, across all its windows.
   *
   * Feeds the spend guardrail. Computed from the same token counts and rates
   * settlement uses, so "what have I been charged" and "what does my limit see"
   * cannot disagree.
   */
  async sessionSpend(sessionId: string, db: Sql = this.sql): Promise<Amount> {
    const rows = await db<Array<{ input_tokens: string; output_tokens: string; in_price: string; out_price: string }>>`
      SELECT SUM(input_tokens)::text  AS input_tokens,
             SUM(output_tokens)::text AS output_tokens,
             input_price_per_million  AS in_price,
             output_price_per_million AS out_price
        FROM agents.usage_records
       WHERE session_id = ${sessionId}
       GROUP BY input_price_per_million, output_price_per_million
    `;

    return windowCost(
      rows.map((r) => ({
        inputTokens: BigInt(r.input_tokens ?? '0'),
        outputTokens: BigInt(r.output_tokens ?? '0'),
        price: { inputPerMillion: parseAmount(r.in_price), outputPerMillion: parseAmount(r.out_price) },
      })),
    );
  }

  /**
   * Settle a window: seal it, then bill it.
   *
   * Returns `settled: false` when the window was already fully settled, and
   * posts nothing in that case. A caller may invoke this as many times as it
   * likes; the user is charged once.
   */
  async settle(input: { sessionId: string; userId: string; windowId: string }): Promise<SettlementResult> {
    return withMoneySpan(
      'agents.usage.settle',
      {
        operation: 'settle',
        userId: input.userId,
        sessionId: input.sessionId,
        windowId: input.windowId,
        assetId: this.assetId,
        chargeKey: chargeKeyFor(input.sessionId, input.windowId),
      },
      async (span) => {
        const result = await this.settleInner(input);
        span.setAttribute('intafaced.amount', formatAmount(result.amount));
        span.setAttribute('intafaced.already_settled', !result.settled);
        return result;
      },
    );
  }

  private async settleInner(input: { sessionId: string; userId: string; windowId: string }): Promise<SettlementResult> {
    const chargeKey = chargeKeyFor(input.sessionId, input.windowId);

    // ── Step 1 · seal ───────────────────────────────────────────────────────
    // Freezes the amount under FOR UPDATE. usage_records_reject_sealed takes
    // that same lock before it trusts sealed_at, and holds it until the insert
    // commits. A seal therefore cannot commit over a usage row that has already
    // passed the check, and an insert that acquires the lock after this commit
    // reads the sealed row and is refused.
    const sealed = await transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<WindowRow[]>`
          SELECT session_id, window_id, sealed_at, charged_amount, charge_key, charge_tx_id
            FROM agents.usage_windows
           WHERE session_id = ${input.sessionId} AND window_id = ${input.windowId}
           FOR UPDATE
        `;

        const row = rows[0];
        if (!row) {
          throw new AgentError(
            `No usage window ${input.windowId} for session ${input.sessionId}`,
            'agents.window_not_found',
            'agents.error.window_sealed',
          );
        }

        if (row.sealed_at) {
          return {
            amount: parseAmount(row.charged_amount ?? '0'),
            chargeTxId: row.charge_tx_id,
            freshlySealed: false,
          };
        }

        const amount = windowCost(await this.groupsFor(tx, input.sessionId, input.windowId));

        // A window with nothing billable is sealed and closed here and now: the
        // ledger rejects a zero-amount entry by design, and posting nothing
        // while leaving the window open would let it be "settled" twice.
        const txId = amount > 0n ? null : NO_CHARGE;

        await tx`
          UPDATE agents.usage_windows
             SET sealed_at = now(),
                 charged_amount = ${formatAmount(amount)}::numeric,
                 charged_asset = ${this.assetId},
                 charge_key = ${chargeKey},
                 charge_tx_id = ${txId}
           WHERE session_id = ${input.sessionId} AND window_id = ${input.windowId}
        `;

        return { amount, chargeTxId: txId, freshlySealed: true };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );

    // Already fully settled, or nothing to bill: no ledger interaction at all.
    if (sealed.chargeTxId !== null) {
      return {
        sessionId: input.sessionId,
        windowId: input.windowId,
        chargeKey,
        amount: sealed.amount,
        chargeTxId: sealed.chargeTxId === NO_CHARGE ? null : sealed.chargeTxId,
        settled: sealed.freshlySealed,
      };
    }

    // ── Step 2 · charge ─────────────────────────────────────────────────────
    // Sealed but unbilled — either this call sealed it, or a previous attempt
    // died between sealing and posting. Both resume to the same amount, and the
    // ledger key makes the post itself idempotent.
    const ledgerTx = await this.ledger.post(
      recipes.feeCharge({
        chargeId: chargeKey,
        userId: input.userId,
        module: this.module,
        mode: 'asset',
        assetId: this.assetId,
        amount: sealed.amount,
        reason: 'agents.usage.metered',
      }),
    );

    await this.notifyAgentsAffiliateAccrue(chargeKey, input.userId, sealed.amount);
    await this.notifyAgentsAffiliatePayout(chargeKey, input.userId, sealed.amount);

    // ── Step 3 · record the ledger id ───────────────────────────────────────
    // Two settles of one unpaid window at once (a run's retry beside a close or the sweep) both post, and the ledger
    // key keeps that one charge; only the call that records its id reports a settlement, so it is logged once.
    const recorded = await this.sql`
      UPDATE agents.usage_windows
         SET charge_tx_id = ${ledgerTx.id}
       WHERE session_id = ${input.sessionId} AND window_id = ${input.windowId} AND charge_tx_id IS NULL
      RETURNING window_id
    `;

    return {
      sessionId: input.sessionId,
      windowId: input.windowId,
      chargeKey,
      amount: sealed.amount,
      chargeTxId: ledgerTx.id,
      settled: recorded.length > 0,
    };
  }

  /** Best-effort; never throws. feeCharge already posted. */
  private async notifyAgentsAffiliateAccrue(feeEventId: string, userId: string, feeAmount: Amount): Promise<void> {
    await fireAffiliateAccrue(
      this.affiliateAccrue,
      affiliateLegAfterUsageFeeCharge({
        feeEventId,
        userId,
        feeAmount,
        feeAsset: this.assetId,
      }),
    );
  }

  /** Best-effort payout after accrue; never throws. feeCharge already posted. */
  private async notifyAgentsAffiliatePayout(feeEventId: string, userId: string, feeAmount: Amount): Promise<void> {
    await fireAffiliatePayout(
      this.affiliatePayout,
      affiliateLegAfterUsageFeeCharge({
        feeEventId,
        userId,
        feeAmount,
        feeAsset: this.assetId,
      }),
    );
  }

  /** Whether this window of the session is sealed: it then refuses any further usage. */
  /** A person's sealed windows the ledger has not paid, across their sessions, smallest first. */
  async unpaidWindows(userId: string): Promise<Array<{ sessionId: string; windowId: string; amount: Amount }>> {
    const rows = await this.sql<Array<{ session_id: string; window_id: string; charged_amount: string }>>`
      SELECT w.session_id::text, w.window_id, w.charged_amount::text
        FROM agents.usage_windows w
        JOIN agents.agent_sessions s ON s.id = w.session_id
       WHERE s.user_id = ${userId} AND ${unpaidWindow(this.sql)}
       ORDER BY w.charged_amount, w.sealed_at, w.window_id
    `;
    return rows.map((r) => ({ sessionId: r.session_id, windowId: r.window_id, amount: parseAmount(r.charged_amount) }));
  }

  /**
   * The usage windows of one agent's sessions of a person's, newest first: open, unpaid (sealed, and retried on its
   * charge key before each run) or settled. A sealed window carries the amount and asset it was sealed at.
   */
  async windowsOf(userId: string, agentId: string, limit: number): Promise<UsageWindowView[]> {
    const rows = await this.sql<
      Array<{
        session_id: string;
        window_id: string;
        sealed: boolean;
        unpaid: boolean;
        charged_amount: string | null;
        charged_asset: string | null;
        charge_key: string | null;
        opened_at: Date;
      }>
    >`
      SELECT w.session_id::text, w.window_id, w.sealed_at IS NOT NULL AS sealed, ${unpaidWindow(this.sql)} AS unpaid,
             w.charged_amount::text, w.charged_asset, w.charge_key, w.opened_at
        FROM agents.usage_windows w
        JOIN agents.agent_sessions s ON s.id = w.session_id
       WHERE s.user_id = ${userId} AND s.agent_id = ${agentId}
       ORDER BY w.opened_at DESC, w.window_id DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      sessionId: r.session_id,
      windowId: r.window_id,
      state: !r.sealed ? 'open' : r.unpaid ? 'unpaid' : 'settled',
      amount: r.sealed && r.charged_amount !== null ? parseAmount(r.charged_amount) : null,
      assetId: r.charged_asset ?? this.assetId,
      chargeKey: r.charge_key,
      openedAt: r.opened_at,
    }));
  }

  /**
   * The sealed usage of these agents' sessions, one row per agent, UTC day and task: the exact sum of the windows'
   * sealed amounts, so an agent's rows add up to its sealed windows. A window lies in one day (its id starts with it);
   * its task is every task its usage ran as. Open windows have no amount yet and are left out.
   */
  async usageByDay(userId: string, agentIds: readonly string[]): Promise<UsageDayView[]> {
    if (agentIds.length === 0) return [];
    const rows = await this.sql<Array<{ agent_id: string; day: string; task: string; amount: string; windows: number; asset: string }>>`
      SELECT s.agent_id, left(w.window_id, 10) AS day, coalesce(t.tasks, '') AS task,
             sum(w.charged_amount)::text AS amount, count(*)::int AS windows, coalesce(w.charged_asset, ${this.assetId}) AS asset
        FROM agents.usage_windows w
        JOIN agents.agent_sessions s ON s.id = w.session_id
        LEFT JOIN LATERAL (
          SELECT string_agg(DISTINCT r.task, ', ' ORDER BY r.task) AS tasks
            FROM agents.usage_records r
           WHERE r.session_id = w.session_id AND r.window_id = w.window_id
        ) t ON true
       WHERE s.user_id = ${userId} AND s.agent_id = ANY(${agentIds as string[]}) AND w.sealed_at IS NOT NULL
       GROUP BY 1, 2, 3, 6 -- agent, day, task, asset: one bound fee asset stands in for a window sealed without one
       ORDER BY day DESC, s.agent_id, task
    `;
    return rows.map((r) => ({
      agentId: r.agent_id,
      day: r.day,
      task: r.task,
      amount: parseAmount(r.amount),
      windows: r.windows,
      assetId: r.asset,
    }));
  }

  async isSealed(sessionId: string, windowId: string): Promise<boolean> {
    const rows = await this.sql<Array<{ sealed: boolean }>>`
      SELECT sealed_at IS NOT NULL AS sealed FROM agents.usage_windows WHERE session_id = ${sessionId} AND window_id = ${windowId}
    `;
    return rows[0]?.sealed ?? false;
  }

  /**
   * Every window of a session that still needs settle work.
   *
   * Includes:
   *   · unsealed windows (normal path), and
   *   · sealed windows whose ledger post never landed (`charge_tx_id IS NULL`
   *     with a positive amount still pending).
   *
   * A crash between seal and post used to drop the window forever from
   * `settleSession` / `session.close`, because only `sealed_at IS NULL` was
   * selected. Zero-amount windows seal with a sentinel charge id and are not
   * returned here (nothing left to bill).
   */
  async openWindows(sessionId: string): Promise<string[]> {
    const rows = await this.sql<Array<{ window_id: string }>>`
      SELECT w.window_id FROM agents.usage_windows w
       WHERE w.session_id = ${sessionId}
         AND (w.sealed_at IS NULL OR ${unpaidWindow(this.sql)})
       ORDER BY w.window_id ASC
    `;
    return rows.map((r) => r.window_id);
  }
}

/**
 * A window that is sealed but unpaid: its amount is fixed and the ledger has not taken it (a zero window is closed at
 * seal with no charge). The one definition the retry, the Usage page and session settlement share.
 */
function unpaidWindow(sql: Sql) {
  return sql`(w.sealed_at IS NOT NULL AND w.charge_tx_id IS NULL AND w.charged_amount > 0)`;
}

function isRestrictViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23001';
}
