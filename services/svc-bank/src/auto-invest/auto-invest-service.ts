import type { Sql } from 'postgres';
import { LedgerError, formatAmount, parseAmount, userAvailable, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { assertAutoInvestBatchLimit } from '../job-batch-limit.js';
import { isDefiniteLedgerRefusal } from '../ledger-outcome.js';
import { assertAutoInvestListLimit } from '../owner-list-limit.js';
import type { EarnService } from '../earn/earn-service.js';
import type { SpaceService } from '../spaces/space-service.js';
import { withMoneySpan } from '../tracing.js';
import type { Cadence } from '../transfers/schedule.js';

/**
 * AUTO-INVEST (§31:805 / bank.auto-invest) — F-plane half.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Rules that move a user's own value on a schedule or a threshold, only through
 * existing ledger recipes. A rule is an instruction, never a balance. §0.6
 * applies without exception.
 *
 *   threshold_sweep  primary available of asset > threshold → excess into an
 *                    earn pool of the SAME asset via `earn.deposit`
 *   dca              scheduled buy of another asset — REQUIRES a convert port
 *                    that supplies a real rate. Absent the port, create and run
 *                    both refuse `bank.auto_invest_rate_unset`. No §8 invent.
 *   card_roundup     spare change after a card capture → same-asset earn pool.
 *                    Fires from the capture hook, not the runner. Cross-asset
 *                    destination refuses `bank.auto_invest_rate_unset`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS NOT HERE
 * ═════════════════════════════════════════════════════════════════════════════
 *
 *   · Sovereign / session-key allowance plane — protocol.smart-accounts (Shehzad).
 *   · Any rate, APR, or convert quote invented in this service.
 *   · A yield number. The destination is an existing earn pool; its APR is
 *     already on that pool. This service does not invent one.
 */

/**
 * Convert counterparty. Production wires `tradeConvertPort` (trade.convert
 * quote+execute over HTTP). Tests inject a double. Absent the port, every DCA
 * path refuses by name rather than inventing a price.
 */
export interface ConvertPort {
  /**
   * Spend `fromAmount` of `fromAsset` to receive some amount of `toAsset`.
   * Must refuse internally when no rate is available — this service does not
   * invent one on the caller's behalf.
   */
  convert(input: {
    userId: string;
    /** The standing instruction (the rule) this spend runs under. */
    instructionId: string;
    fromAsset: string;
    toAsset: string;
    fromAmount: Amount;
    clientConvertId: string;
  }): Promise<{ toAmount: Amount; ledgerTxId: string }>;
}

export type AutoInvestKind = 'threshold_sweep' | 'dca' | 'card_roundup';
export type AutoInvestRuleStatus = 'active' | 'paused' | 'cancelled';
export type AutoInvestRunStatus = 'pending' | 'settled' | 'rejected' | 'skipped';

/**
 * Spare change on a capture: next multiple of `granularity` minus `captured`.
 * Exact multiples produce zero — nothing to sweep, nothing to invent.
 */
export function spareChange(captured: Amount, granularity: Amount): Amount {
  if (granularity <= 0n || captured <= 0n) return 0n;
  const rem = captured % granularity;
  return rem === 0n ? 0n : granularity - rem;
}

/**
 * Did this failure prove that nothing moved? Only then may a run be `rejected`.
 *
 * A typed BankError is raised before any post. A definite ledger refusal
 * (`isDefiniteLedgerRefusal`) proves nothing committed under the key. Anything
 * else (a transport error, a 5xx, an untyped body) can follow a commit whose
 * reply was lost, so the run stays `pending` and the same key is re-driven.
 * A durable `rejected` for a committed post would be a false statement.
 */
function isDefiniteRunRefusal(err: unknown): boolean {
  return err instanceof BankError || isDefiniteLedgerRefusal(err);
}

function runRefusalCode(err: unknown): string {
  if (err instanceof BankError) return err.code;
  if (err instanceof LedgerError) return err.code;
  return 'bank.auto_invest_run_failed';
}

export type RoundUpOutcome =
  | { readonly status: 'none'; readonly amount: Amount }
  | { readonly status: 'skipped'; readonly amount: Amount; readonly reason: string }
  | { readonly status: 'settled'; readonly amount: Amount; readonly positionId: string }
  | { readonly status: 'refused'; readonly amount: Amount; readonly reason: string };

export interface AutoInvestRule {
  id: string;
  userId: string;
  kind: AutoInvestKind;
  assetId: string;
  threshold: Amount | null;
  targetPoolId: string | null;
  buyAssetId: string | null;
  amount: Amount | null;
  cadence: Cadence | null;
  nextRunAt: Date | null;
  status: AutoInvestRuleStatus;
  createdAt: Date;
}

export interface AutoInvestRun {
  id: string;
  ruleId: string;
  clientRunId: string;
  status: AutoInvestRunStatus;
  amount: Amount | null;
  ledgerTxId: string | null;
  positionId: string | null;
  rejectionCode: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

export interface AutoInvestRunReport {
  considered: number;
  settled: number;
  skipped: number;
  rejected: number;
  failures: Array<{ ruleId: string; code: string }>;
}

interface RuleRow {
  id: string;
  user_id: string;
  kind: AutoInvestKind;
  asset_id: string;
  threshold: string | null;
  target_pool_id: string | null;
  buy_asset_id: string | null;
  amount: string | null;
  cadence: Cadence | null;
  next_run_at: Date | null;
  status: AutoInvestRuleStatus;
  created_at: Date;
}

interface RunRow {
  id: string;
  rule_id: string;
  client_run_id: string;
  status: AutoInvestRunStatus;
  amount: string | null;
  ledger_tx_id: string | null;
  position_id: string | null;
  rejection_code: string | null;
  created_at: Date;
  settled_at: Date | null;
}

function toRule(row: RuleRow): AutoInvestRule {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    assetId: row.asset_id,
    threshold: row.threshold === null ? null : parseAmount(row.threshold),
    targetPoolId: row.target_pool_id,
    buyAssetId: row.buy_asset_id,
    amount: row.amount === null ? null : parseAmount(row.amount),
    cadence: row.cadence,
    nextRunAt: row.next_run_at,
    status: row.status,
    createdAt: row.created_at,
  };
}

function toRun(row: RunRow): AutoInvestRun {
  return {
    id: row.id,
    ruleId: row.rule_id,
    clientRunId: row.client_run_id,
    status: row.status,
    amount: row.amount === null ? null : parseAmount(row.amount),
    ledgerTxId: row.ledger_tx_id,
    positionId: row.position_id,
    rejectionCode: row.rejection_code,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

export interface AutoInvestServiceOptions {
  /**
   * Cross-asset convert. Absent = every DCA path refuses
   * `bank.auto_invest_rate_unset`. Never defaulted to a fake rate source.
   */
  convert?: ConvertPort;
  /** Max rules one runner pass claims. Bounds blast radius of a bad pass. */
  batchSize?: number;
  /**
   * Emergency stop for the runner AND the capture hook. Default true.
   * Off → applyRoundUp is a skip (capture still stands); runDue is also
   * gated at HTTP/tRPC so this is the hook's own backstop.
   */
  enabled?: boolean;
}

export class AutoInvestService {
  private readonly convert: ConvertPort | null;
  /** Unset until owner/cron pass it. Omit used to invent 200. */
  private readonly batchSize: number | undefined;
  private readonly enabled: boolean;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly earn: EarnService,
    private readonly spaces: SpaceService,
    options: AutoInvestServiceOptions = {},
  ) {
    this.convert = options.convert ?? null;
    this.batchSize = options.batchSize;
    this.enabled = options.enabled !== false;
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Same-asset threshold sweep into an earn pool.
   *
   * Pool asset must match the watched asset. No rate is consulted — this is a
   * pure ledger move of the user's own value into their own stake pot.
   */
  async createThresholdSweep(input: { userId: string; assetId: string; threshold: Amount; targetPoolId: string }): Promise<AutoInvestRule> {
    if (input.threshold <= 0n) {
      throw new BankError('A threshold sweep needs a positive keep-amount', 'bank.auto_invest_invalid_threshold');
    }
    const pool = await this.earn.pool(input.targetPoolId);
    if (pool.status !== 'open') {
      throw new BankError(`Pool "${pool.name}" is closed`, 'bank.pool_closed');
    }
    if (pool.assetId !== input.assetId) {
      throw new BankError(`Threshold sweep asset ${input.assetId} does not match pool asset ${pool.assetId}`, 'bank.asset_mismatch');
    }
    // Ensure the primary exists so a first run does not invent a space under
    // the runner's feet — and so the user can see the source balance in UI.
    await this.spaces.ensurePrimary(input.userId, input.assetId);

    const rows = await this.sql<RuleRow[]>`
      INSERT INTO bank.auto_invest_rules
        (user_id, kind, asset_id, threshold, target_pool_id, status)
      VALUES (
        ${input.userId}, 'threshold_sweep', ${input.assetId},
        ${formatAmount(input.threshold)}::numeric, ${input.targetPoolId}::uuid, 'active'
      )
      RETURNING id, user_id, kind, asset_id, threshold, target_pool_id, buy_asset_id,
                amount, cadence, next_run_at, status, created_at
    `;
    return toRule(rows[0]!);
  }

  /**
   * DCA schedule — refuse-closed without a convert port.
   *
   * Production injects `tradeConvertPort` (trade.convert quote+execute) when
   * TRADE_URL is a usable http(s) URL. Absent that counterparty, we do not
   * create a dormant schedule that looks live and invents a price later.
   * Named refusal: `bank.auto_invest_rate_unset`.
   */
  async createDca(input: {
    userId: string;
    spendAssetId: string;
    buyAssetId: string;
    amount: Amount;
    cadence: Cadence;
    startsAt: Date;
  }): Promise<AutoInvestRule> {
    if (!this.convert) {
      throw new BankError(
        'Auto-invest DCA needs a convert rate counterparty — rates are not invented here (§8 / bank.auto_invest_rate_unset)',
        'bank.auto_invest_rate_unset',
      );
    }
    if (input.amount <= 0n) {
      throw new BankError('A DCA schedule needs a positive amount', 'bank.below_minimum');
    }
    if (input.spendAssetId === input.buyAssetId) {
      throw new BankError('DCA needs two different assets — same-asset use a threshold sweep or standing order', 'bank.same_space');
    }
    await this.spaces.ensurePrimary(input.userId, input.spendAssetId);

    const rows = await this.sql<RuleRow[]>`
      INSERT INTO bank.auto_invest_rules
        (user_id, kind, asset_id, buy_asset_id, amount, cadence, next_run_at, status)
      VALUES (
        ${input.userId}, 'dca', ${input.spendAssetId}, ${input.buyAssetId},
        ${formatAmount(input.amount)}::numeric, ${input.cadence}, ${input.startsAt}, 'active'
      )
      RETURNING id, user_id, kind, asset_id, threshold, target_pool_id, buy_asset_id,
                amount, cadence, next_run_at, status, created_at
    `;
    return toRule(rows[0]!);
  }

  /**
   * Card round-up — spare change after capture into a same-asset earn pool.
   *
   * `amount` on the row is the granularity (round-to), not a balance.
   * A different `buyAssetId` is the convert half and refuses by name rather
   * than inventing a rate so the instruction can look live.
   */
  async createCardRoundUp(input: {
    userId: string;
    assetId: string;
    granularity: Amount;
    targetPoolId: string;
    buyAssetId?: string;
  }): Promise<AutoInvestRule> {
    if (input.buyAssetId && input.buyAssetId !== input.assetId) {
      throw new BankError(
        'Card round-up into another asset needs a convert rate counterparty — rates are not invented here (§8 / bank.auto_invest_rate_unset)',
        'bank.auto_invest_rate_unset',
      );
    }
    if (input.granularity <= 0n) {
      throw new BankError('A card round-up needs a positive granularity', 'bank.auto_invest_invalid_threshold');
    }
    const pool = await this.earn.pool(input.targetPoolId);
    if (pool.status !== 'open') {
      throw new BankError(`Pool "${pool.name}" is closed`, 'bank.pool_closed');
    }
    if (pool.assetId !== input.assetId) {
      throw new BankError(`Round-up asset ${input.assetId} does not match pool asset ${pool.assetId}`, 'bank.asset_mismatch');
    }
    await this.spaces.ensurePrimary(input.userId, input.assetId);

    try {
      const rows = await this.sql<RuleRow[]>`
        INSERT INTO bank.auto_invest_rules
          (user_id, kind, asset_id, target_pool_id, amount, status)
        VALUES (
          ${input.userId}, 'card_roundup', ${input.assetId},
          ${input.targetPoolId}::uuid, ${formatAmount(input.granularity)}::numeric, 'active'
        )
        RETURNING id, user_id, kind, asset_id, threshold, target_pool_id, buy_asset_id,
                  amount, cadence, next_run_at, status, created_at
      `;
      return toRule(rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BankError(
          'An active card round-up already exists for this asset — pause or cancel it first',
          'bank.auto_invest_roundup_exists',
        );
      }
      throw err;
    }
  }

  /**
   * Capture hook. Capture has already settled; this may not undo it.
   *
   * Kill switch, no rule, and exact-multiple captures are skips. Failures
   * become `refused` with a named code — same posture as cashback.
   */
  async applyRoundUp(input: { userId: string; assetId: string; authorizationId: string; captured: Amount }): Promise<RoundUpOutcome> {
    if (!this.enabled) {
      return { status: 'skipped', amount: 0n, reason: 'bank.auto_invest_disabled' };
    }

    const rows = await this.sql<RuleRow[]>`
      SELECT id, user_id, kind, asset_id, threshold, target_pool_id, buy_asset_id,
             amount, cadence, next_run_at, status, created_at
        FROM bank.auto_invest_rules
       WHERE user_id = ${input.userId}
         AND asset_id = ${input.assetId}
         AND kind = 'card_roundup'
         AND status = 'active'
       ORDER BY created_at ASC
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { status: 'none', amount: 0n };

    const rule = toRule(row);
    const granularity = rule.amount!;
    const spare = spareChange(input.captured, granularity);
    const clientRunId = `roundup:${rule.id}:${input.authorizationId}`;

    if (spare <= 0n) {
      await this.recordSkipped(rule.id, clientRunId, null, 'bank.auto_invest_no_spare');
      return { status: 'skipped', amount: 0n, reason: 'bank.auto_invest_no_spare' };
    }

    return withMoneySpan(
      'bank.auto_invest.card_roundup',
      { operation: 'auto-invest-card-roundup', ruleId: rule.id, userId: rule.userId, assetId: rule.assetId },
      async () => {
        const claimed = await this.sql<Array<{ id: string }>>`
          INSERT INTO bank.auto_invest_runs (rule_id, client_run_id, status, amount)
          VALUES (
            ${rule.id}::uuid, ${clientRunId}, 'pending',
            ${formatAmount(spare)}::numeric
          )
          ON CONFLICT (rule_id, client_run_id) DO NOTHING
          RETURNING id
        `;
        let runId: string;
        if (claimed.length === 0) {
          const existing = await this.sql<Array<{ id: string; status: AutoInvestRunStatus; position_id: string | null }>>`
            SELECT id, status, position_id FROM bank.auto_invest_runs
             WHERE rule_id = ${rule.id}::uuid AND client_run_id = ${clientRunId}
          `;
          const prior = existing[0];
          if (prior?.status === 'settled' && prior.position_id) {
            return { status: 'settled', amount: spare, positionId: prior.position_id };
          }
          // earn.deposit is idempotent on this run id. Retry pending and rejected; do not mint another id.
          if (prior && (prior.status === 'pending' || prior.status === 'rejected')) {
            runId = prior.id;
          } else {
            return { status: 'skipped', amount: spare, reason: 'bank.auto_invest_run_failed' };
          }
        } else {
          runId = claimed[0]!.id;
        }

        const now = new Date();
        try {
          const position = await this.earn.deposit({
            poolId: rule.targetPoolId!,
            userId: rule.userId,
            amount: spare,
            positionId: runId,
            now,
          });
          await this.sql`
            UPDATE bank.auto_invest_runs
               SET status = 'settled',
                   position_id = ${position.id},
                   rejection_code = NULL,
                   settled_at = ${now},
                   amount = ${formatAmount(spare)}::numeric
             WHERE id = ${runId}::uuid
          `;
          return { status: 'settled', amount: spare, positionId: position.id };
        } catch (err) {
          if (!isDefiniteRunRefusal(err)) {
            // Unknown outcome: the deposit may have committed. The run stays
            // `pending`; the same capture re-drives it on the same run id.
            return { status: 'refused', amount: spare, reason: 'bank.ledger_outcome_unknown' };
          }
          const code = runRefusalCode(err);
          await this.sql`
            UPDATE bank.auto_invest_runs
               SET status = 'rejected', rejection_code = ${code}, settled_at = ${now}
             WHERE id = ${runId}::uuid AND status IN ('pending', 'rejected')
          `;
          return { status: 'refused', amount: spare, reason: code };
        }
      },
    );
  }

  async listRules(userId: string, limit?: number): Promise<AutoInvestRule[]> {
    const page = assertAutoInvestListLimit(limit);
    const rows = await this.sql<RuleRow[]>`
      SELECT id, user_id, kind, asset_id, threshold, target_pool_id, buy_asset_id,
             amount, cadence, next_run_at, status, created_at
        FROM bank.auto_invest_rules
       WHERE user_id = ${userId}
       ORDER BY created_at DESC
       LIMIT ${page}
    `;
    return rows.map(toRule);
  }

  async getRule(ruleId: string): Promise<AutoInvestRule> {
    const rows = await this.sql<RuleRow[]>`
      SELECT id, user_id, kind, asset_id, threshold, target_pool_id, buy_asset_id,
             amount, cadence, next_run_at, status, created_at
        FROM bank.auto_invest_rules WHERE id = ${ruleId}
    `;
    const row = rows[0];
    if (!row) throw new BankError(`Auto-invest rule ${ruleId} not found`, 'bank.auto_invest_not_found');
    return toRule(row);
  }

  async cancelRule(ruleId: string): Promise<void> {
    const updated = await this.sql`
      UPDATE bank.auto_invest_rules SET status = 'cancelled', updated_at = now()
       WHERE id = ${ruleId} AND status IN ('active', 'paused')
       RETURNING id
    `;
    if (updated.length === 0) {
      throw new BankError(`Auto-invest rule ${ruleId} is not cancellable`, 'bank.auto_invest_inactive');
    }
  }

  /**
   * Hold a rule without cancelling it. Reversible via `resumeRule`.
   *
   * The status enum has carried `paused` since the table landed; until this
   * path wrote it, cancel was the only stop and the branch that accepted
   * `paused` on cancel was unreachable. Same residual shape as standing-order
   * pause before the transfer pause PR.
   */
  async pauseRule(ruleId: string): Promise<AutoInvestRule> {
    const rows = await this.sql<RuleRow[]>`
      UPDATE bank.auto_invest_rules SET status = 'paused', updated_at = now()
       WHERE id = ${ruleId} AND status = 'active'
       RETURNING id, user_id, kind, asset_id, threshold, target_pool_id, buy_asset_id,
                 amount, cadence, next_run_at, status, created_at
    `;
    if (rows.length === 0) {
      throw new BankError(`Auto-invest rule ${ruleId} is not pausable`, 'bank.auto_invest_inactive');
    }
    return toRule(rows[0]!);
  }

  /**
   * Resume a paused rule. Does not invent a catch-up fire: the next `runDue`
   * pass considers the rule again under normal due rules (threshold every pass;
   * DCA when `next_run_at` is due). Past time while paused is not multi-settled.
   */
  async resumeRule(ruleId: string): Promise<AutoInvestRule> {
    const rows = await this.sql<RuleRow[]>`
      UPDATE bank.auto_invest_rules SET status = 'active', updated_at = now()
       WHERE id = ${ruleId} AND status = 'paused'
       RETURNING id, user_id, kind, asset_id, threshold, target_pool_id, buy_asset_id,
                 amount, cadence, next_run_at, status, created_at
    `;
    if (rows.length === 0) {
      throw new BankError(`Auto-invest rule ${ruleId} is not resumable`, 'bank.auto_invest_inactive');
    }
    return toRule(rows[0]!);
  }

  // ── Runner ─────────────────────────────────────────────────────────────────

  /**
   * Fire every active rule that is due (or every threshold sweep once per pass).
   *
   * Isolation: one rule's throw is recorded; other rules continue. Same shape as
   * standing-order / earn-accrual isolation (#1491).
   */
  async runDue(input: { now?: Date; limit?: number } = {}): Promise<AutoInvestRunReport> {
    const now = input.now ?? new Date();
    const limit = assertAutoInvestBatchLimit(input.limit ?? this.batchSize);
    const report: AutoInvestRunReport = { considered: 0, settled: 0, skipped: 0, rejected: 0, failures: [] };

    const rules = await this.sql<RuleRow[]>`
      SELECT id, user_id, kind, asset_id, threshold, target_pool_id, buy_asset_id,
             amount, cadence, next_run_at, status, created_at
        FROM bank.auto_invest_rules
       WHERE status = 'active'
         AND (
           kind = 'threshold_sweep'
           OR (kind = 'dca' AND next_run_at IS NOT NULL AND next_run_at <= ${now})
         )
       -- A rule stuck on an unknown outcome sorts last: it is not re-driven, so it must not take a batch slot from a due rule.
       ORDER BY EXISTS (
                  SELECT 1 FROM bank.auto_invest_runs r
                   WHERE r.rule_id = bank.auto_invest_rules.id AND r.status = 'pending'
                ) ASC,
                created_at ASC
       LIMIT ${limit}
    `;

    for (const row of rules) {
      report.considered += 1;
      const rule = toRule(row);
      try {
        const outcome = await this.driveRule(rule, now);
        if (outcome === 'settled') report.settled += 1;
        else if (outcome === 'skipped') report.skipped += 1;
        else if (outcome === 'rejected') report.rejected += 1;
      } catch (err) {
        const code = err instanceof BankError ? err.code : 'bank.auto_invest_run_failed';
        report.failures.push({ ruleId: rule.id, code });
      }
    }

    return report;
  }

  private async driveRule(rule: AutoInvestRule, now: Date): Promise<'settled' | 'skipped' | 'rejected' | 'pending'> {
    if (rule.kind === 'threshold_sweep') {
      return this.driveThresholdSweep(rule, now);
    }
    if (rule.kind === 'dca') {
      return this.driveDca(rule, now);
    }
    throw new BankError('Card round-ups fire on capture, not on the runner', 'bank.auto_invest_run_failed');
  }

  private async driveThresholdSweep(rule: AutoInvestRule, now: Date): Promise<'settled' | 'skipped' | 'rejected' | 'pending'> {
    return withMoneySpan(
      'bank.auto_invest.threshold_sweep',
      { operation: 'auto-invest-threshold-sweep', ruleId: rule.id, userId: rule.userId, assetId: rule.assetId },
      async () => {
        // One run id per attempt; re-drive uses the same client_run_id only if
        // the caller supplies it — the scheduled runner uses a fresh id so a
        // later excess after a successful sweep can move again.
        const clientRunId = `sweep:${rule.id}:${now.toISOString()}`;
        const threshold = rule.threshold!;
        const poolId = rule.targetPoolId!;

        const bal = (await this.ledger.balance(userAvailable(rule.userId, rule.assetId))).amount;
        if (bal <= threshold) {
          await this.recordSkipped(rule.id, clientRunId, null, 'bank.auto_invest_below_threshold');
          return 'skipped';
        }
        const excess = bal - threshold;

        const claimed = await this.sql<Array<{ id: string }>>`
          INSERT INTO bank.auto_invest_runs (rule_id, client_run_id, status, amount)
          VALUES (
            ${rule.id}::uuid, ${clientRunId}, 'pending',
            ${formatAmount(excess)}::numeric
          )
          ON CONFLICT (rule_id, client_run_id) DO NOTHING
          RETURNING id
        `;
        if (claimed.length === 0) {
          const existing = await this.sql<Array<{ status: AutoInvestRunStatus }>>`
            SELECT status FROM bank.auto_invest_runs
             WHERE rule_id = ${rule.id}::uuid AND client_run_id = ${clientRunId}
          `;
          const status = existing[0]?.status;
          // The key is taken. Settled only if that row already settled — a
          // pending, rejected, or skipped row did not deposit this excess.
          if (status === 'settled') return 'settled';
          if (status === 'rejected') return 'rejected';
          if (status === 'pending') return 'pending';
          return 'skipped';
        }
        const runId = claimed[0]!.id;
        const positionId = runId; // earn deposit idempotency key = run id

        try {
          const position = await this.earn.deposit({
            poolId,
            userId: rule.userId,
            amount: excess,
            positionId,
            now,
          });
          await this.sql`
            UPDATE bank.auto_invest_runs
               SET status = 'settled',
                   position_id = ${position.id},
                   settled_at = ${now},
                   amount = ${formatAmount(excess)}::numeric
             WHERE id = ${runId}::uuid
          `;
          return 'settled';
        } catch (err) {
          // Unknown outcome: leave the run `pending` and surface the failure.
          if (!isDefiniteRunRefusal(err)) throw err;
          const code = runRefusalCode(err);
          await this.sql`
            UPDATE bank.auto_invest_runs
               SET status = 'rejected', rejection_code = ${code}, settled_at = ${now}
             WHERE id = ${runId}::uuid AND status = 'pending'
          `;
          return 'rejected';
        }
      },
    );
  }

  private async driveDca(rule: AutoInvestRule, now: Date): Promise<'settled' | 'skipped' | 'rejected' | 'pending'> {
    if (!this.convert) {
      // Defence in depth: create already refuses, but a rule from a previous
      // deploy that lost its convert port must not invent a rate on fire.
      throw new BankError(
        'Auto-invest DCA needs a convert rate counterparty — rates are not invented here (§8 / bank.auto_invest_rate_unset)',
        'bank.auto_invest_rate_unset',
      );
    }
    // Production convert is `tradeConvertPort`. Tests inject a double.
    const clientRunId = `dca:${rule.id}:${rule.nextRunAt?.toISOString() ?? now.toISOString()}`;
    const amount = rule.amount!;
    const buyAssetId = rule.buyAssetId!;

    const claimed = await this.sql<Array<{ id: string }>>`
      INSERT INTO bank.auto_invest_runs (rule_id, client_run_id, status, amount)
      VALUES (
        ${rule.id}::uuid, ${clientRunId}, 'pending',
        ${formatAmount(amount)}::numeric
      )
      ON CONFLICT (rule_id, client_run_id) DO NOTHING
      RETURNING id
    `;
    if (claimed.length === 0) {
      const existing = await this.sql<Array<{ status: AutoInvestRunStatus }>>`
        SELECT status FROM bank.auto_invest_runs
         WHERE rule_id = ${rule.id}::uuid AND client_run_id = ${clientRunId}
      `;
      const status = existing[0]?.status;
      // The key is taken. Settled only if that row already settled — a
      // pending or rejected row did not convert this buy.
      if (status === 'settled') return 'settled';
      if (status === 'rejected') return 'rejected';
      if (status === 'pending') return 'pending';
      return 'skipped';
    }
    const runId = claimed[0]!.id;

    try {
      const result = await this.convert.convert({
        userId: rule.userId,
        instructionId: rule.id,
        fromAsset: rule.assetId,
        toAsset: buyAssetId,
        fromAmount: amount,
        clientConvertId: clientRunId,
      });
      await this.sql`
        UPDATE bank.auto_invest_runs
           SET status = 'settled',
               ledger_tx_id = ${result.ledgerTxId},
               amount = ${formatAmount(result.toAmount)}::numeric,
               settled_at = ${now}
         WHERE id = ${runId}::uuid
      `;
      // Advance next_run_at by one cadence step (simple daily/weekly/monthly).
      const next = advanceCadence(rule.nextRunAt ?? now, rule.cadence!);
      await this.sql`
        UPDATE bank.auto_invest_rules SET next_run_at = ${next}, updated_at = now()
         WHERE id = ${rule.id}::uuid
      `;
      return 'settled';
    } catch (err) {
      // Unknown outcome: leave the run `pending` and surface the failure.
      if (!isDefiniteRunRefusal(err)) throw err;
      const code = runRefusalCode(err);
      await this.sql`
        UPDATE bank.auto_invest_runs
           SET status = 'rejected', rejection_code = ${code}, settled_at = ${now}
         WHERE id = ${runId}::uuid AND status = 'pending'
      `;
      return 'rejected';
    }
  }

  private async recordSkipped(ruleId: string, clientRunId: string, amount: Amount | null, reason: string): Promise<void> {
    await this.sql`
      INSERT INTO bank.auto_invest_runs (rule_id, client_run_id, status, amount, rejection_code, settled_at)
      VALUES (
        ${ruleId}::uuid, ${clientRunId}, 'skipped',
        ${amount === null ? null : formatAmount(amount)}::numeric,
        ${reason}, now()
      )
      ON CONFLICT (rule_id, client_run_id) DO NOTHING
    `;
  }

  async runsOf(ruleId: string): Promise<AutoInvestRun[]> {
    const rows = await this.sql<RunRow[]>`
      SELECT id, rule_id, client_run_id, status, amount, ledger_tx_id, position_id,
             rejection_code, created_at, settled_at
        FROM bank.auto_invest_runs
       WHERE rule_id = ${ruleId}
       ORDER BY created_at DESC
    `;
    return rows.map(toRun);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function advanceCadence(from: Date, cadence: Cadence): Date {
  const DAY_MS = 24 * 60 * 60 * 1000;
  switch (cadence) {
    case 'daily':
      return new Date(from.getTime() + DAY_MS);
    case 'weekly':
      return new Date(from.getTime() + 7 * DAY_MS);
    case 'monthly': {
      const year = from.getUTCFullYear();
      const month = from.getUTCMonth() + 1;
      const day = from.getUTCDate();
      const targetYear = year + Math.floor(month / 12);
      const targetMonth = month % 12;
      const daysInMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
      return new Date(
        Date.UTC(
          targetYear,
          targetMonth,
          Math.min(day, daysInMonth),
          from.getUTCHours(),
          from.getUTCMinutes(),
          from.getUTCSeconds(),
          from.getUTCMilliseconds(),
        ),
      );
    }
  }
}
