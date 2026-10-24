import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type {
  CampaignTasks,
  KycGate,
  PayoutRecordList,
  PotFunding,
  RedemptionAttempt,
  RewardRecord,
  TaskClaimResult,
  TaskProgress,
} from '@intafaced/contracts/campaigns-catalogue';
import type { CampaignParticipant } from '@intafaced/contracts';
import { CampaignsError } from './codes.js';
import { effectiveState, outsideWindow } from './campaigns.js';
import type { ParticipantSource } from './participants.js';
import type { PayoutSaga } from './payouts.js';
import type { MarketNames } from './markets.js';
import { NO_STREAK, streakOf } from './streaks.js';

/**
 * Task campaigns (CM-tasks-quests-01): progress from verified bus events, the claim window, the verification gate and
 * the claim that writes one reward intent (CM-payouts-ledger-02), and the operator reads and the pot funding.
 *
 * - A step completes only from an event svc-trade published (`trade.fill.settled`), never from anything the customer
 *   reports. Each event is counted once per step by its id, so the same event delivered twice changes nothing. Only an
 *   account that had joined when the event happened, and only while the campaign is active, is counted.
 * - The claim window opens when the last step completes and lasts the campaign's `claimWindowSeconds`. A claim after it
 *   writes the intent as `forfeited` and refuses `campaigns.claim_expired`; a claim again returns the same.
 * - The verification gate reads svc-identity's tier per claim and stores nothing about it: below the gate refuses
 *   `campaigns.kyc_required` and writes nothing. A frozen account's intent is `withheld` and never posted.
 * - One claim per (campaign, account, period); this version has one-time tasks, so the period is `once`. The intent is
 *   unique on `task:<campaign>:<account>:once`, holds its terms (asset, amount) and is written under a lock on the
 *   campaign, after checking the budget limit less what the campaign's other intents hold. Then the saga posts it.
 */

type Sql = postgres.Sql;

type TaskCampaignRow = {
  id: string;
  type: string;
  state: string;
  starts_at: Date | null;
  ends_at: Date | null;
  weekdays: number[] | null;
  hours_from: string | null;
  hours_to: string | null;
  budget_asset: string | null;
  budget_limit: string | null;
  reward_asset: string | null;
  reward_amount: string | null;
  tasks: CampaignTasks | null;
  budget_drawn?: string;
};

type IntentRow = {
  reward_key: string;
  campaign_id: string;
  account_id: string;
  asset: string;
  amount: string;
  state: RewardRecord['state'];
  reason: string | null;
  ledger_tx_id: string | null;
  created_at: Date;
  posted_at: Date | null;
};

type AttemptRow = { reward_key: string; outcome: RedemptionAttempt['outcome']; reason: string | null; at: Date };

type FundingRow = {
  reference: string;
  source_module: 'trade';
  asset: string;
  amount: string;
  state: PotFunding['state'];
  reason: string | null;
  requested_by: string;
  approved_by: string | null;
  ledger_tx_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export interface FillEvent {
  fillId: string;
  userId: string;
  marketId: string;
  side: 'buy' | 'sell';
  ts: string;
}

const iso = (d: Date) => d.toISOString();
const decimalOf = (raw: string) => (raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw);
const DECIMAL = /^(0|[1-9]\d{0,19})(\.\d{1,18})?$/;
const ASSET = /^[A-Z0-9]{2,12}$/;
const TIER_RANK: Record<CampaignParticipant['kycTier'], number> = { none: 0, basic: 1, full: 2, institutional: 3 };
const GATE_RANK: Record<KycGate, number> = { none: 0, basic: 1, full: 2 };
export const PERIOD_ONCE = 'once';

export const rewardKeyOf = (campaignId: string, accountId: string, period: string) => `task:${campaignId}:${accountId}:${period}`;

/**
 * Whether one step counts this fill. `symbol` is the listed symbol of the fill's market (`BTC/USDT`), null when it could
 * not be named: then only a step for any market counts it.
 */
export function stepMatches(step: CampaignTasks['steps'][number], fill: Pick<FillEvent, 'side'> & { symbol: string | null }): boolean {
  if (step.event !== 'trade.fill') return false;
  if (step.market && step.market !== fill.symbol) return false;
  if (step.side && step.side !== fill.side) return false;
  return true;
}

type ProgressRow = { step_index: number; occurred_at: Date };

/**
 * Each step's state from its counted events. A plain step is done at `count` events; a streak step at `streakDays`
 * consecutive days in the platform time zone (none while the zone is blank, and a campaign cannot go live then).
 */
export function stepStates(
  tasks: CampaignTasks,
  events: readonly ProgressRow[],
  timeZone: string | null,
  now: Date,
): TaskProgress['steps'] {
  return tasks.steps.map((s, index) => {
    const mine = events.filter((e) => e.step_index === index);
    if (s.streakDays) {
      const run = timeZone
        ? streakOf(
            mine.map((e) => e.occurred_at),
            timeZone,
            now,
          )
        : NO_STREAK;
      const complete = run.best >= s.streakDays;
      return {
        index,
        title: s.title,
        done: complete ? s.streakDays : Math.min(run.days, s.streakDays),
        target: s.streakDays,
        complete,
        streak: {
          days: run.days,
          best: run.best,
          lastRun: run.lastRun,
          lastDay: run.lastDay,
          resetsAt: run.resetsAt ? iso(run.resetsAt) : null,
          reset: !complete && run.lastDay !== null && run.days === 0,
        },
      };
    }
    const n = Math.min(mine.length, s.count);
    return { index, title: s.title, done: n, target: s.count, complete: n >= s.count, streak: null };
  });
}

export function meetsGate(gate: KycGate, tier: CampaignParticipant['kycTier']): boolean {
  return TIER_RANK[tier] >= GATE_RANK[gate];
}

export interface TaskServiceOptions {
  sql: Sql;
  participants: ParticipantSource;
  /** Null while svc-ledger is not configured: a claim refuses `campaigns.reward_saga_unwired` and writes nothing. */
  saga: PayoutSaga | null;
  /** Null while svc-trade is not configured: a step that names a market counts no fill. */
  markets: MarketNames | null;
  /** The owner's platform time zone the campaign windows are read in, or null while blank. */
  timeZone: () => string | null;
  /** Owner value: the rollback window shown on every reward record. Null reads "not set". */
  rollbackWindowSeconds: number | null;
  now?: () => Date;
}

export class TaskService {
  private readonly sql: Sql;
  private readonly participants: ParticipantSource;
  private readonly saga: PayoutSaga | null;
  private readonly markets: MarketNames | null;
  private readonly timeZone: () => string | null;
  private readonly rollbackWindowSeconds: number | null;
  private readonly now: () => Date;

  constructor(options: TaskServiceOptions) {
    this.sql = options.sql;
    this.participants = options.participants;
    this.saga = options.saga;
    this.markets = options.markets;
    this.timeZone = options.timeZone;
    this.rollbackWindowSeconds = options.rollbackWindowSeconds;
    this.now = options.now ?? (() => new Date());
  }

  // ── Events ────────────────────────────────────────────────────────────────

  /**
   * One settled fill. Idempotent: progress rows are keyed by the fill id, and a completion is written once. Returns how
   * many campaigns it moved, for the logs.
   */
  async onFill(fill: FillEvent): Promise<number> {
    const at = new Date(fill.ts);
    if (Number.isNaN(at.getTime())) return 0;
    const rows = await this.sql<(TaskCampaignRow & { account_id: string })[]>`
      SELECT c.id, c.type, c.state, c.starts_at, c.ends_at, c.weekdays, c.hours_from, c.hours_to, c.budget_asset,
        c.budget_limit::text AS budget_limit, c.reward_asset, c.reward_amount::text AS reward_amount, c.tasks, p.account_id
      FROM campaigns.participations p JOIN campaigns.campaigns c ON c.id = p.campaign_id
      WHERE lower(p.account_id) = lower(${fill.userId}) AND c.type = 'task' AND c.tasks IS NOT NULL
        AND p.created_at <= ${at} AND c.state IN ('scheduled', 'active')`;
    // A fill counts only while the campaign runs: live, and inside its weekdays and hours in the platform time zone.
    const timeZone = this.timeZone();
    const live = rows.filter(
      (row) =>
        row.tasks &&
        effectiveState(row as never, at) === 'active' &&
        (!(row.weekdays || (row.hours_from && row.hours_to)) || (timeZone !== null && outsideWindow(row, at, timeZone) === null)),
    );
    // The market is named only when a step needs it; an unreachable market list throws, so the fill comes again.
    const named = live.some((row) => row.tasks!.steps.some((s) => s.market)) && this.markets;
    const match = { side: fill.side, symbol: named ? await named.symbolOf(fill.marketId) : null };
    let moved = 0;
    for (const row of live) {
      const steps = row.tasks!.steps.map((step, index) => ({ step, index })).filter(({ step }) => stepMatches(step, match));
      if (steps.length === 0) continue;
      await transaction(this.sql, async (tx) => {
        for (const { index } of steps) {
          await tx`
            INSERT INTO campaigns.task_progress (campaign_id, account_id, step_index, event_id, occurred_at)
            VALUES (${row.id}, ${row.account_id}, ${index}, ${fill.fillId}, ${at})
            ON CONFLICT DO NOTHING`;
        }
        const events = await tx<ProgressRow[]>`
          SELECT step_index, occurred_at FROM campaigns.task_progress
          WHERE campaign_id = ${row.id} AND account_id = ${row.account_id}`;
        // A late or redelivered fill can close the steps: the claim window opens when they closed here, not earlier.
        const completedAt = new Date(Math.max(at.getTime(), this.now().getTime()));
        if (stepStates(row.tasks!, events, timeZone, at).every((s) => s.complete)) {
          await tx`
            INSERT INTO campaigns.task_completions (campaign_id, account_id, completed_at)
            VALUES (${row.id}, ${row.account_id}, ${completedAt})
            ON CONFLICT DO NOTHING`;
        }
      });
      moved += 1;
    }
    return moved;
  }

  // ── Customer (own account only) ───────────────────────────────────────────

  async progress(input: { campaignId: string; accountId: string }): Promise<TaskProgress> {
    const row = await this.taskCampaign(input.campaignId);
    const tasks = row.tasks!;
    const [[joined], events, [completion], [intent]] = await Promise.all([
      this.sql<{ k: string }[]>`
        SELECT participation_key AS k FROM campaigns.participations
        WHERE campaign_id = ${row.id} AND account_id = ${input.accountId}`,
      this.sql<ProgressRow[]>`
        SELECT step_index, occurred_at FROM campaigns.task_progress
        WHERE campaign_id = ${row.id} AND account_id = ${input.accountId}`,
      this.sql<{ completed_at: Date }[]>`
        SELECT completed_at FROM campaigns.task_completions WHERE campaign_id = ${row.id} AND account_id = ${input.accountId}`,
      this.sql<IntentRow[]>`
        SELECT *, amount::text AS amount FROM campaigns.reward_intents
        WHERE reward_key = ${rewardKeyOf(row.id, input.accountId, PERIOD_ONCE)}`,
    ]);
    const timeZone = this.timeZone();
    // Streak days are read in the platform zone: blank, a streak campaign refuses rather than show 0 days.
    if (!timeZone && tasks.steps.some((s) => s.streakDays)) {
      throw new CampaignsError('campaigns.timezone_unset', 'The platform time zone is not set, so streak days cannot be read');
    }
    const steps = stepStates(tasks, events, timeZone, this.now());
    const closes =
      completion && tasks.claimWindowSeconds ? new Date(completion.completed_at.getTime() + tasks.claimWindowSeconds * 1000) : null;
    return {
      campaignId: row.id,
      joined: Boolean(joined),
      steps,
      completed: steps.filter((s) => s.complete).length,
      total: steps.length,
      completedAt: completion ? iso(completion.completed_at) : null,
      claimClosesAt: closes ? iso(closes) : null,
      kycGate: tasks.kycGate,
      reward: intent ? await this.record(intent) : null,
    };
  }

  /**
   * Claims the caller's reward once. A second claim, or one sent again after a lost reply, returns the first intent as it
   * stands now (`created: false`) and posts nothing new.
   */
  async claim(input: { campaignId: string; accountId: string }): Promise<TaskClaimResult> {
    const key = rewardKeyOf(input.campaignId, input.accountId, PERIOD_ONCE);
    const existing = await this.intent(key);
    // A reward withheld while the account was not active is looked at again on a later claim; any other stands.
    if (existing && existing.state !== 'withheld') return { reward: await this.record(existing), created: false };
    if (!this.saga) throw new CampaignsError('campaigns.reward_saga_unwired', 'Rewards cannot be paid: the ledger is not connected');
    const row = await this.taskCampaign(input.campaignId);
    const tasks = row.tasks!;
    const [[joined], [completion]] = await Promise.all([
      this.sql<{ k: string }[]>`
        SELECT participation_key AS k FROM campaigns.participations
        WHERE campaign_id = ${row.id} AND account_id = ${input.accountId}`,
      this.sql<{ completed_at: Date }[]>`
        SELECT completed_at FROM campaigns.task_completions WHERE campaign_id = ${row.id} AND account_id = ${input.accountId}`,
    ]);
    if (!joined) throw new CampaignsError('campaigns.not_joined', 'Join this campaign before you claim');
    if (!completion) throw new CampaignsError('campaigns.tasks_incomplete', 'Every step must be done before you claim');
    if (!row.reward_asset || row.reward_amount === null)
      throw new CampaignsError('campaigns.reward_unset', 'This campaign has no reward set');
    if (tasks.claimWindowSeconds === null)
      throw new CampaignsError('campaigns.claim_window_unset', 'This campaign has no claim window set');
    const now = this.now();
    const closes = new Date(completion.completed_at.getTime() + tasks.claimWindowSeconds * 1000);
    if (now >= closes) {
      await this.write(row, input.accountId, key, 'forfeited', 'campaigns.claim_expired');
      throw new CampaignsError('campaigns.claim_expired', 'The claim window closed; this reward is forfeited');
    }
    // Identity is read before any write, and nothing it answers is stored.
    const who = await this.participants.read(input.accountId);
    if (!who) throw new CampaignsError('campaigns.participant_unread', 'Your account could not be checked for this claim');
    if (!meetsGate(tasks.kycGate, who.kycTier)) {
      throw new CampaignsError('campaigns.kyc_required', `This reward needs ${tasks.kycGate} verification before it can be claimed`);
    }
    if (who.status !== 'active') {
      const made = await this.write(row, input.accountId, key, 'withheld', `account.${who.status}`);
      return { reward: await this.record(made.intent), created: made.created };
    }
    const made = await this.write(row, input.accountId, key, 'qualified', null);
    if (made.created) await this.saga.attempt(key);
    return { reward: await this.record((await this.intent(key))!), created: made.created };
  }

  /**
   * Writes the intent under a lock on the campaign. A `qualified` one must fit the budget limit less what the campaign's
   * other intents hold (`campaigns.budget_exhausted`). Two claims at once: one row, by the unique key.
   */
  private async write(
    row: TaskCampaignRow,
    accountId: string,
    key: string,
    state: 'qualified' | 'forfeited' | 'withheld',
    reason: string | null,
  ): Promise<{ intent: IntentRow; created: boolean }> {
    return transaction(this.sql, async (tx) => {
      const [locked] = await tx<{ budget_limit: string | null }[]>`
        SELECT budget_limit::text AS budget_limit FROM campaigns.campaigns WHERE id = ${row.id} FOR UPDATE`;
      const [first] = await tx<
        IntentRow[]
      >`SELECT *, amount::text AS amount FROM campaigns.reward_intents WHERE reward_key = ${key} FOR UPDATE`;
      // Only a withheld reward moves on, and only to another state: the account became active, or the window closed.
      if (first && (first.state !== 'withheld' || state === 'withheld')) return { intent: first, created: false };
      if (state === 'qualified') {
        if (row.budget_asset !== row.reward_asset) {
          throw new CampaignsError('campaigns.budget_asset_mismatch', 'The budget and the reward are in different assets');
        }
        const [drawn] = await tx<{ total: string }[]>`
          SELECT COALESCE(sum(amount), 0)::text AS total FROM campaigns.reward_intents
          WHERE campaign_id = ${row.id} AND state NOT IN ('failed', 'forfeited', 'withheld')`;
        const limit = locked?.budget_limit ? parseAmount(locked.budget_limit) : 0n;
        if (parseAmount(drawn!.total) + parseAmount(row.reward_amount!) > limit) {
          throw new CampaignsError('campaigns.budget_exhausted', 'This campaign’s budget has no room for another reward');
        }
      }
      const [made] = first
        ? await tx<IntentRow[]>`
            UPDATE campaigns.reward_intents SET state = ${state}, reason = ${reason}, updated_at = now()
            WHERE reward_key = ${key} RETURNING *, amount::text AS amount`
        : await tx<IntentRow[]>`
            INSERT INTO campaigns.reward_intents (reward_key, campaign_id, account_id, period, asset, amount, state, reason)
            VALUES (${key}, ${row.id}, ${accountId}, ${PERIOD_ONCE}, ${row.reward_asset!}, ${row.reward_amount!}, ${state}, ${reason})
            RETURNING *, amount::text AS amount`;
      const outcome = state === 'qualified' ? 'qualified' : state;
      await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome, reason) VALUES (${key}, ${outcome}, ${reason})`;
      await tx`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES (${accountId}, ${'campaign.task.claim'}, ${row.id}, ${tx.json({ rewardKey: key, state })})`;
      return { intent: made!, created: true };
    });
  }

  // ── Operators (campaigns:ops) ─────────────────────────────────────────────

  /** Every reward record with its account and its attempts, newest first, for founder-ops and finance. */
  async payoutRecords(input: { campaignId?: string }): Promise<PayoutRecordList> {
    const rows = await this.sql<IntentRow[]>`
      SELECT *, amount::text AS amount FROM campaigns.reward_intents
      WHERE ${input.campaignId ?? null}::text IS NULL OR campaign_id = ${input.campaignId ?? null}
      ORDER BY created_at DESC LIMIT 200`;
    const attempts = await this.attemptsOf(rows.map((r) => r.reward_key));
    return { records: rows.map((r) => ({ ...this.toRecord(r, attempts.get(r.reward_key) ?? []), accountId: r.account_id })) };
  }

  /** One operator asks for a sweep of earned fees into the reward pot. The reference is the business key. */
  async requestFunding(input: {
    reference: string;
    sourceModule: 'trade';
    asset: string;
    amount: unknown;
    actor: string;
  }): Promise<PotFunding> {
    if (typeof input.amount === 'number' || typeof input.amount === 'bigint') {
      throw new CampaignsError('campaigns.number_on_wire', 'The amount must be a decimal string, not a number');
    }
    const amount = typeof input.amount === 'string' ? input.amount.trim() : '';
    if (!DECIMAL.test(amount) || !/[1-9]/.test(amount))
      throw new CampaignsError('campaigns.budget_unset', 'The amount must be a positive decimal');
    const asset = input.asset.trim().toUpperCase();
    if (!ASSET.test(asset)) throw new CampaignsError('campaigns.budget_unset', 'The asset is not an asset symbol');
    return transaction(this.sql, async (tx) => {
      const [made] = await tx<FundingRow[]>`
        INSERT INTO campaigns.pot_fundings (reference, source_module, asset, amount, requested_by)
        VALUES (${input.reference}, ${input.sourceModule}, ${asset}, ${amount}, ${input.actor})
        ON CONFLICT (reference) DO NOTHING
        RETURNING *, amount::text AS amount`;
      if (!made) {
        const [first] = await tx<
          FundingRow[]
        >`SELECT *, amount::text AS amount FROM campaigns.pot_fundings WHERE reference = ${input.reference}`;
        // The same request sent again by the same person returns it; anything else is a different request.
        if (
          first &&
          first.requested_by === input.actor &&
          first.source_module === input.sourceModule &&
          first.asset === asset &&
          decimalOf(first.amount) === decimalOf(amount)
        ) {
          return toFunding(first);
        }
        throw new CampaignsError('campaigns.funding_reference_taken', 'Another funding already uses this reference');
      }
      await tx`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES (${input.actor}, ${'campaign.pot.request'}, ${input.reference}, ${tx.json({ asset, amount, sourceModule: input.sourceModule })})`;
      return toFunding(made);
    });
  }

  /** A different operator approves; the approval posts the sweep. Approving again returns the funding as it stands. */
  async approveFunding(input: { reference: string; actor: string }): Promise<PotFunding> {
    if (!this.saga) throw new CampaignsError('campaigns.reward_saga_unwired', 'The pot cannot be funded: the ledger is not connected');
    const approved = await transaction(this.sql, async (tx) => {
      const [row] = await tx<
        FundingRow[]
      >`SELECT *, amount::text AS amount FROM campaigns.pot_fundings WHERE reference = ${input.reference} FOR UPDATE`;
      if (!row) throw new CampaignsError('campaigns.funding_unknown', 'No such funding request');
      if (row.state !== 'requested') {
        if (row.approved_by !== input.actor) {
          throw new CampaignsError('campaigns.second_person_required', 'This funding was approved by someone else');
        }
        return false;
      }
      if (row.requested_by === input.actor) {
        throw new CampaignsError('campaigns.second_person_required', 'A second person approves; the one who asked cannot');
      }
      await tx`
        UPDATE campaigns.pot_fundings SET state = 'posting', approved_by = ${input.actor}, updated_at = now()
        WHERE reference = ${input.reference}`;
      await tx`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES (${input.actor}, ${'campaign.pot.approve'}, ${input.reference}, ${tx.json({ requestedBy: row.requested_by })})`;
      return true;
    });
    if (approved) await this.saga.fund(input.reference);
    const [now] = await this.sql<
      FundingRow[]
    >`SELECT *, amount::text AS amount FROM campaigns.pot_fundings WHERE reference = ${input.reference}`;
    return toFunding(now!);
  }

  async fundings(): Promise<PotFunding[]> {
    const rows = await this.sql<
      FundingRow[]
    >`SELECT *, amount::text AS amount FROM campaigns.pot_fundings ORDER BY created_at DESC LIMIT 200`;
    return rows.map(toFunding);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** A task campaign a customer may see, with steps. Anything else reads `campaign.unknown`, or `campaigns.no_tasks`. */
  private async taskCampaign(id: string): Promise<TaskCampaignRow> {
    const [row] = await this.sql<TaskCampaignRow[]>`
      SELECT id, type, state, starts_at, ends_at, weekdays, hours_from, hours_to, budget_asset,
        budget_limit::text AS budget_limit, reward_asset, reward_amount::text AS reward_amount, tasks
      FROM campaigns.campaigns WHERE id = ${id} AND state IN ('scheduled', 'active', 'paused', 'ended', 'closed')`;
    if (!row) throw new CampaignsError('campaign.unknown', 'No such campaign');
    if (!row.tasks) throw new CampaignsError('campaigns.no_tasks', 'This campaign has no steps to complete');
    return row;
  }

  private async intent(key: string): Promise<IntentRow | null> {
    const [row] = await this.sql<IntentRow[]>`SELECT *, amount::text AS amount FROM campaigns.reward_intents WHERE reward_key = ${key}`;
    return row ?? null;
  }

  private async attemptsOf(keys: string[]): Promise<Map<string, RedemptionAttempt[]>> {
    const out = new Map<string, RedemptionAttempt[]>();
    if (keys.length === 0) return out;
    const rows = await this.sql<AttemptRow[]>`
      SELECT reward_key, outcome, reason, at FROM campaigns.redemption_attempts WHERE reward_key IN ${this.sql(keys)} ORDER BY id`;
    for (const r of rows) {
      const list = out.get(r.reward_key) ?? [];
      list.push({ at: iso(r.at), outcome: r.outcome, reason: r.reason });
      out.set(r.reward_key, list);
    }
    return out;
  }

  private async record(row: IntentRow): Promise<RewardRecord> {
    return this.toRecord(row, (await this.attemptsOf([row.reward_key])).get(row.reward_key) ?? []);
  }

  private toRecord(row: IntentRow, attempts: RedemptionAttempt[]): RewardRecord {
    const window = this.rollbackWindowSeconds;
    return {
      rewardKey: row.reward_key,
      campaignId: row.campaign_id,
      asset: row.asset,
      amount: formatAmount(parseAmount(row.amount)),
      state: row.state,
      reason: row.reason,
      ledgerTxId: row.ledger_tx_id,
      createdAt: iso(row.created_at),
      postedAt: row.posted_at ? iso(row.posted_at) : null,
      rollback: {
        windowSeconds: window,
        closesAt: window && row.posted_at ? iso(new Date(row.posted_at.getTime() + window * 1000)) : null,
        blocker: 'campaigns.reclaim_unavailable',
      },
      attempts,
    };
  }
}

function toFunding(r: FundingRow): PotFunding {
  return {
    reference: r.reference,
    sourceModule: r.source_module,
    asset: r.asset,
    amount: formatAmount(parseAmount(r.amount)),
    state: r.state,
    reason: r.reason,
    requestedBy: r.requested_by,
    approvedBy: r.approved_by,
    ledgerTxId: r.ledger_tx_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
