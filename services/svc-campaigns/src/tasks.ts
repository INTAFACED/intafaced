import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import {
  REWARD_STATUS_OF,
  type CampaignTasks,
  type KycGate,
  type MyRewards,
  type PayoutRecordList,
  type PotFunding,
  type RedemptionAttempt,
  type RewardLock,
  type RewardRecord,
  type TaskClaimResult,
  type TaskProgress,
  EARNING_TRIGGERS,
  type EarningRule,
  type EarningTrigger,
} from '@intafaced/contracts/campaigns-catalogue';
import type { CampaignParticipant } from '@intafaced/contracts';
import { CampaignsError } from './codes.js';
import { effectiveState, outsideWindow } from './campaigns.js';
import type { ParticipantSource } from './participants.js';
import type { PayoutSaga } from './payouts.js';
import type { MarketNames } from './markets.js';
import { NO_STREAK, streakOf } from './streaks.js';
import { evaluateFormula, parseFormula, readsNames } from './formula.js';

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
 * - A campaign with a risk-review hold (`holdSeconds` above 0) writes the claimed intent `held` until the hold ends; it
 *   keeps its place in the budget and nothing is posted. `releaseHolds` releases each one once when its hold has ended:
 *   to `qualified` and the saga, or `withheld` when the account is not active then. An unread account stays held.
 * - A campaign that gives its reward locked or as a bonus (`tasks.lock`) stores that form and the lock's length on the
 *   intent before anything posts; the saga then posts the lock into the reward's own campaigns pot, never the customer's
 *   balance. A locked reward counts its unlock step's fills while it is locked (one row per fill). `settleLocks` decides
 *   each one once, by a conditional update that writes the outcome first: unlock when the step is done, forfeit when the
 *   lock ends without it, and a bonus forfeits when it expires. A forfeited reward is never given again: a claim after
 *   it returns the same forfeited record.
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
  hold_until: Date | null;
  form: RewardRecord['form'];
  lock_seconds: number | null;
  lock_tx_id: string | null;
  locked_at: Date | null;
  lock_until: Date | null;
  settle: 'unlock' | 'forfeit' | null;
};

/** What a locked row shows: its campaign's lock terms and how many unlock-step fills counted so far. */
type LockView = { lock: RewardLock | null; done: number };

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
  /** The fill's quote amount, fee and quantity, which an earning rule's formula may read. */
  quoteAmount?: string;
  feeAmount?: string;
  qty?: string;
}

/**
 * One event an earning rule may answer (CM-rewards-hub-05): its trigger, its own id (the business key of what it earns),
 * whose it is, when, the asset its amounts are in (null when unknown), and the names its formula reads.
 */
export interface EarningEvent {
  trigger: EarningTrigger;
  eventId: string;
  userId: string;
  at: string;
  asset: string | null;
  values: Readonly<Record<string, string>>;
}

/** The period an earning intent is keyed by: the rule's name and the event's id, so an event earns once per rule. */
export const earningPeriodOf = (ruleName: string, eventId: string) => `earn:${encodeURIComponent(ruleName)}:${eventId}`;

const iso = (d: Date) => d.toISOString();
const decimalOf = (raw: string) => (raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw);
const DECIMAL = /^(0|[1-9]\d{0,19})(\.\d{1,18})?$/;
const ASSET = /^[A-Z0-9]{2,12}$/;
const TIER_RANK: Record<CampaignParticipant['kycTier'], number> = { none: 0, basic: 1, full: 2, institutional: 3 };
const GATE_RANK: Record<KycGate, number> = { none: 0, basic: 1, full: 2 };
export const PERIOD_ONCE = 'once';
/** How many rewards My Rewards lists, newest first. */
export const MY_REWARDS_LIMIT = 200;
/** Seconds after a lock ends that a fill made inside it may still arrive and count, before the reward forfeits. */
export const LOCK_FILL_GRACE_SECONDS = 60;

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

type LockTerms = { form: RewardRecord['form']; seconds: number | null };

/** How this campaign gives its reward and for how long a lock lasts. Blank seconds refuse; nothing is written then. */
export function lockTermsOf(tasks: CampaignTasks): LockTerms {
  const lock = tasks.lock ?? null;
  if (!lock) return { form: 'paid', seconds: null };
  if (lock.kind === 'locked') {
    if (lock.seconds === null) throw new CampaignsError('campaigns.lock_period_unset', 'This campaign has no lock period set');
    return { form: 'locked', seconds: lock.seconds };
  }
  if (lock.expirySeconds === null) throw new CampaignsError('campaigns.bonus_expiry_unset', 'This campaign has no bonus expiry set');
  if (lock.appliesTo.length === 0) throw new CampaignsError('campaigns.bonus_scope_unset', 'This bonus names no product it applies to');
  return { form: 'bonus', seconds: lock.expirySeconds };
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
    // Resolved at most once per fill, for the campaign steps and the lock steps alike.
    let symbol: Promise<string | null> | null = null;
    const symbolOf = (needed: boolean) => (needed && this.markets ? (symbol ??= this.markets.symbolOf(fill.marketId)) : null);
    const match = { side: fill.side, symbol: await symbolOf(live.some((row) => row.tasks!.steps.some((s) => s.market))) };
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
    const earned = await this.onEarningEvent(
      {
        trigger: 'trade.fill.settled',
        eventId: fill.fillId,
        userId: fill.userId,
        at: fill.ts,
        asset: null,
        values: { amount: fill.quoteAmount ?? '0', fee: fill.feeAmount ?? '0', qty: fill.qty ?? '0' },
      },
      // A fill's amounts are in its market's quote asset, named only when a rule reads them.
      async () => {
        const name = await symbolOf(true);
        return name ? (name.split('/')[1] ?? null) : null;
      },
    );
    return moved + earned + (await this.countLockFill(fill, at, symbolOf));
  }

  /**
   * An event against every running campaign the account joined before it that has an earning rule for its trigger
   * (CM-rewards-hub-05). Each rule whose condition holds gives one reward intent, keyed by the rule and the event, so the
   * same event delivered twice earns once. The incentive is the formula's answer, in the campaign's reward asset; a
   * formula that reads the event's amounts earns only when the event is in that asset (otherwise the units would not
   * match). What is written never goes past the budget limit less what the campaign's intents hold, nor past the per
   * person limit (the campaign's reward amount) less what the account already holds from it; with no room, nothing is
   * written. Then the saga posts it under its own key. A paused campaign earns nothing new (ENGINE T-4). With the ledger
   * not connected nothing is written: the event comes again only by redelivery, so it is logged by the caller.
   */
  async onEarningEvent(event: EarningEvent, assetOf: () => Promise<string | null> = async () => event.asset): Promise<number> {
    const at = new Date(event.at);
    if (Number.isNaN(at.getTime()) || !this.saga) return 0;
    const rows = await this.sql<(TaskCampaignRow & { account_id: string; earning: EarningRule[] })[]>`
      SELECT c.id, c.type, c.state, c.starts_at, c.ends_at, c.weekdays, c.hours_from, c.hours_to, c.budget_asset,
        c.budget_limit::text AS budget_limit, c.reward_asset, c.reward_amount::text AS reward_amount, c.tasks, c.earning,
        p.account_id
      FROM campaigns.participations p JOIN campaigns.campaigns c ON c.id = p.campaign_id
      WHERE lower(p.account_id) = lower(${event.userId}) AND c.earning <> '[]'::jsonb
        AND p.created_at <= ${at} AND c.state IN ('scheduled', 'active')`;
    const timeZone = this.timeZone();
    const live = rows.filter(
      (row) =>
        effectiveState(row as never, at) === 'active' &&
        (!(row.weekdays || (row.hours_from && row.hours_to)) || (timeZone !== null && outsideWindow(row, at, timeZone) === null)),
    );
    const names = EARNING_TRIGGERS[event.trigger].names;
    const values: Record<string, bigint> = {};
    for (const name of names) values[name] = parseAmount(event.values[name] ?? '0');
    let asset: Promise<string | null> | null = null;
    let earned = 0;
    for (const row of live) {
      for (const rule of row.earning.filter((r) => r.trigger === event.trigger)) {
        if (rule.minAmount !== null && values.amount! < parseAmount(rule.minAmount)) continue;
        const formula = parseFormula(rule.formula, names);
        if (readsNames(formula) && (await (asset ??= assetOf())) !== row.reward_asset) continue;
        const amount = evaluateFormula(formula, values);
        if (amount <= 0n) continue;
        const key = rewardKeyOf(row.id, row.account_id, earningPeriodOf(rule.name, event.eventId));
        if (await this.writeEarning(row, key, earningPeriodOf(rule.name, event.eventId), amount)) {
          earned += 1;
          await this.saga.attempt(key);
        }
      }
    }
    return earned;
  }

  /** Writes one earning intent under a lock on the campaign, cut to the room the budget and the per person limit leave. */
  private async writeEarning(row: TaskCampaignRow & { account_id: string }, key: string, period: string, amount: bigint): Promise<boolean> {
    return transaction(this.sql, async (tx) => {
      const [locked] = await tx<
        { budget_limit: string | null; budget_asset: string | null; reward_asset: string | null; reward_amount: string | null }[]
      >`
        SELECT budget_limit::text AS budget_limit, budget_asset, reward_asset, reward_amount::text AS reward_amount
        FROM campaigns.campaigns WHERE id = ${row.id} FOR UPDATE`;
      if (!locked?.budget_limit || !locked.reward_asset || locked.reward_amount === null) return false;
      if (locked.budget_asset !== locked.reward_asset) return false;
      const [held] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.reward_intents WHERE reward_key = ${key}`;
      if (held!.n > 0) return false;
      const [sums] = await tx<{ campaign: string; mine: string }[]>`
        SELECT COALESCE(sum(amount), 0)::text AS campaign,
          COALESCE(sum(amount) FILTER (WHERE account_id = ${row.account_id}), 0)::text AS mine
        FROM campaigns.reward_intents WHERE campaign_id = ${row.id} AND state NOT IN ('failed', 'forfeited', 'withheld')`;
      const budgetRoom = parseAmount(locked.budget_limit) - parseAmount(sums!.campaign);
      const personRoom = parseAmount(locked.reward_amount) - parseAmount(sums!.mine);
      const pay = [amount, budgetRoom, personRoom].reduce((a, b) => (b < a ? b : a));
      if (pay <= 0n) return false;
      await tx`
        INSERT INTO campaigns.reward_intents (reward_key, campaign_id, account_id, period, asset, amount, state, reason, form)
        VALUES (${key}, ${row.id}, ${row.account_id}, ${period}, ${locked.reward_asset}, ${formatAmount(pay)}, 'qualified',
          NULL, 'paid')`;
      await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome, reason) VALUES (${key}, 'qualified', NULL)`;
      await tx`
        INSERT INTO campaigns.audit_log (actor, action, target, detail)
        VALUES (${row.account_id}, ${'campaign.earning.qualify'}, ${row.id}, ${tx.json({ rewardKey: key, amount: formatAmount(pay), worked: formatAmount(amount) })})`;
      return true;
    });
  }

  /** A fill made while a locked reward of this account is locked counts once toward its unlock step. */
  private async countLockFill(fill: FillEvent, at: Date, symbolOf: (needed: boolean) => Promise<string | null> | null): Promise<number> {
    const locked = await this.sql<{ reward_key: string; tasks: CampaignTasks | null }[]>`
      SELECT i.reward_key, c.tasks FROM campaigns.reward_intents i JOIN campaigns.campaigns c ON c.id = i.campaign_id
      WHERE lower(i.account_id) = lower(${fill.userId}) AND i.state = 'locked' AND i.form = 'locked'
        AND i.locked_at <= ${at} AND i.lock_until > ${at}`;
    const steps = locked.flatMap((r) => (r.tasks?.lock?.kind === 'locked' ? [{ key: r.reward_key, step: r.tasks.lock.step }] : []));
    if (steps.length === 0) return 0;
    const match = { side: fill.side, symbol: await symbolOf(steps.some((l) => l.step.market)) };
    let counted = 0;
    for (const { key, step } of steps) {
      if (!stepMatches(step, match)) continue;
      const added = await this.sql`
        INSERT INTO campaigns.lock_progress (reward_key, event_id, occurred_at) VALUES (${key}, ${fill.fillId}, ${at})
        ON CONFLICT DO NOTHING`;
      counted += added.count;
    }
    return counted;
  }

  /**
   * Decides every locked reward and bonus that is due (the reconciler calls it each pass): a locked reward whose unlock
   * step is done unlocks; one whose lock ended without it forfeits; a bonus forfeits once it expires. The outcome is
   * written first, by one conditional update from `locked`, so of two passes at once one decides; then
   * the saga posts it under its own key. A crash after the decision leaves a `settling` row the reconciler posts.
   * Returns how many it decided.
   */
  async settleLocks(limit = 100): Promise<number> {
    if (!this.saga) return 0;
    const now = this.now();
    // A fill made inside the lock can arrive after it ends: a locked reward forfeits only once that grace has passed too.
    const forfeitBy = new Date(now.getTime() - LOCK_FILL_GRACE_SECONDS * 1000);
    const due = await this.sql<{ reward_key: string; met: boolean }[]>`
      SELECT reward_key, met FROM (
        SELECT i.reward_key, i.form, i.lock_until,
          i.form = 'locked' AND c.tasks->'lock'->>'kind' = 'locked' AND (
            SELECT count(*) FROM campaigns.lock_progress p WHERE p.reward_key = i.reward_key
          ) >= (c.tasks->'lock'->'step'->>'count')::int AS met
        FROM campaigns.reward_intents i JOIN campaigns.campaigns c ON c.id = i.campaign_id
        WHERE i.state = 'locked'
      ) d
      WHERE met OR (form = 'bonus' AND lock_until <= ${now}) OR lock_until <= ${forfeitBy}
      ORDER BY lock_until, reward_key LIMIT ${limit}`;
    let decided = 0;
    for (const row of due) {
      const settle = row.met ? 'unlock' : 'forfeit';
      const changed = await this.sql`
        UPDATE campaigns.reward_intents SET state = 'settling', settle = ${settle}, updated_at = now()
        WHERE reward_key = ${row.reward_key} AND state = 'locked'`;
      if (changed.count === 0) continue;
      await this.saga.settle(row.reward_key);
      decided += 1;
    }
    return decided;
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
    // Stored before holds existed, or blank: never read as "no hold".
    const holdSeconds = tasks.holdSeconds ?? null;
    if (holdSeconds === null) throw new CampaignsError('campaigns.hold_period_unset', 'This campaign has no hold period set');
    const terms = lockTermsOf(tasks);
    const now = this.now();
    // Withheld when its hold ended: it was claimed inside the window and served its hold, so neither applies again.
    const served = existing?.state === 'withheld' && existing.hold_until !== null;
    const closes = new Date(completion.completed_at.getTime() + tasks.claimWindowSeconds * 1000);
    if (!served && now >= closes) {
      await this.write(row, input.accountId, key, 'forfeited', 'campaigns.claim_expired', null, terms);
      throw new CampaignsError('campaigns.claim_expired', 'The claim window closed; this reward is forfeited');
    }
    // Identity is read before any write, and nothing it answers is stored.
    const who = await this.participants.read(input.accountId);
    if (!who) throw new CampaignsError('campaigns.participant_unread', 'Your account could not be checked for this claim');
    if (!meetsGate(tasks.kycGate, who.kycTier)) {
      throw new CampaignsError('campaigns.kyc_required', `This reward needs ${tasks.kycGate} verification before it can be claimed`);
    }
    if (who.status !== 'active') {
      const made = await this.write(row, input.accountId, key, 'withheld', `account.${who.status}`, null, terms);
      return { reward: await this.record(made.intent), created: made.created };
    }
    if (holdSeconds > 0 && !served) {
      const held = await this.write(row, input.accountId, key, 'held', null, new Date(now.getTime() + holdSeconds * 1000), terms);
      return { reward: await this.record(held.intent), created: held.created };
    }
    const made = await this.write(row, input.accountId, key, 'qualified', null, null, terms);
    if (made.created) await this.saga.attempt(key);
    return { reward: await this.record((await this.intent(key))!), created: made.created };
  }

  /**
   * Releases every held reward whose hold has ended (the reconciler calls it each pass). Each is moved once, by a
   * conditional update in one transaction with its log line: to `qualified`, then posted by the saga under its own key,
   * or to `withheld` when the account is not active (a later claim, once it is active, pays it without a second hold or
   * a window check). An account identity cannot read now stays held, behind the others, for the next pass.
   * A crash after the release and before the post leaves a `qualified` row the reconciler posts. Returns how many it
   * released to the saga.
   */
  async releaseHolds(limit = 100): Promise<number> {
    if (!this.saga) return 0;
    const now = this.now();
    // Oldest look first: a reward whose account could not be read goes to the back, so it never blocks the others.
    const due = await this.sql<{ reward_key: string; account_id: string }[]>`
      SELECT reward_key, account_id FROM campaigns.reward_intents
      WHERE state = 'held' AND hold_until <= ${now} ORDER BY updated_at, reward_key LIMIT ${limit}`;
    let released = 0;
    for (const { reward_key: key, account_id: accountId } of due) {
      const who = await this.participants.read(accountId);
      if (!who) {
        await this.sql`UPDATE campaigns.reward_intents SET updated_at = now() WHERE reward_key = ${key} AND state = 'held'`;
        continue;
      }
      const next = who.status === 'active' ? 'qualified' : 'withheld';
      const reason = next === 'withheld' ? `account.${who.status}` : null;
      const moved = await transaction(this.sql, async (tx) => {
        const changed = await tx`
          UPDATE campaigns.reward_intents SET state = ${next}, reason = ${reason}, updated_at = now()
          WHERE reward_key = ${key} AND state = 'held' AND hold_until <= ${now}`;
        if (changed.count === 0) return false;
        await tx`
          INSERT INTO campaigns.redemption_attempts (reward_key, outcome, reason)
          VALUES (${key}, ${next === 'qualified' ? 'released' : 'withheld'}, ${reason})`;
        return true;
      });
      if (moved && next === 'qualified') {
        await this.saga.attempt(key);
        released += 1;
      }
    }
    return released;
  }

  /**
   * Every reward of one account, newest first, with its campaign's name and plain status, and the totals by status and
   * asset summed from those rows (CM-rewards-hub-01). The account is the caller's principal, never a field.
   */
  async myRewards(input: { accountId: string }): Promise<MyRewards> {
    const [rows, groups] = await Promise.all([
      this.sql<(IntentRow & { campaign_name: string })[]>`
        SELECT i.*, i.amount::text AS amount, c.name AS campaign_name
        FROM campaigns.reward_intents i JOIN campaigns.campaigns c ON c.id = i.campaign_id
        WHERE i.account_id = ${input.accountId}
        ORDER BY i.created_at DESC, i.reward_key LIMIT ${MY_REWARDS_LIMIT}`,
      // The totals count every reward, not only the listed ones.
      this.sql<{ state: RewardRecord['state']; asset: string; amount: string; n: number }[]>`
        SELECT state, asset, sum(amount)::text AS amount, count(*)::int AS n FROM campaigns.reward_intents
        WHERE account_id = ${input.accountId} GROUP BY state, asset`,
    ]);
    const [attempts, locks] = await Promise.all([this.attemptsOf(rows.map((r) => r.reward_key)), this.locksOf(rows)]);
    const rewards = rows.map((r) => ({
      ...this.toRecord(r, attempts.get(r.reward_key) ?? [], locks.get(r.reward_key)),
      campaignName: r.campaign_name,
      status: REWARD_STATUS_OF[r.state],
    }));
    const sums = new Map<string, { status: MyRewards['totals'][number]['status']; asset: string; units: bigint; count: number }>();
    for (const g of groups) {
      const status = REWARD_STATUS_OF[g.state];
      const k = `${status}:${g.asset}`;
      const line = sums.get(k) ?? { status, asset: g.asset, units: 0n, count: 0 };
      line.units += parseAmount(g.amount);
      line.count += g.n;
      sums.set(k, line);
    }
    const totals = [...sums.values()].map((l) => ({ status: l.status, asset: l.asset, amount: formatAmount(l.units), count: l.count }));
    return { rewards, totals, more: totals.reduce((n, l) => n + l.count, 0) > rewards.length };
  }

  /**
   * Writes the intent under a lock on the campaign. A `qualified` or `held` one must fit the budget limit less what the
   * campaign's other intents hold (`campaigns.budget_exhausted`). Two claims at once: one row, by the unique key.
   */
  private async write(
    row: TaskCampaignRow,
    accountId: string,
    key: string,
    state: 'held' | 'qualified' | 'forfeited' | 'withheld',
    reason: string | null,
    holdUntil: Date | null,
    terms: LockTerms,
  ): Promise<{ intent: IntentRow; created: boolean }> {
    return transaction(this.sql, async (tx) => {
      const [locked] = await tx<{ budget_limit: string | null }[]>`
        SELECT budget_limit::text AS budget_limit FROM campaigns.campaigns WHERE id = ${row.id} FOR UPDATE`;
      const [first] = await tx<
        IntentRow[]
      >`SELECT *, amount::text AS amount FROM campaigns.reward_intents WHERE reward_key = ${key} FOR UPDATE`;
      // Only a withheld reward moves on, and only to another state: the account became active, or the window closed.
      if (first && (first.state !== 'withheld' || state === 'withheld')) return { intent: first, created: false };
      if (state === 'qualified' || state === 'held') {
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
            UPDATE campaigns.reward_intents SET state = ${state}, reason = ${reason}, hold_until = ${holdUntil}, updated_at = now()
            WHERE reward_key = ${key} RETURNING *, amount::text AS amount`
        : await tx<IntentRow[]>`
            INSERT INTO campaigns.reward_intents (reward_key, campaign_id, account_id, period, asset, amount, state, reason,
              hold_until, form, lock_seconds)
            VALUES (${key}, ${row.id}, ${accountId}, ${PERIOD_ONCE}, ${row.reward_asset!}, ${row.reward_amount!}, ${state}, ${reason},
              ${holdUntil}, ${terms.form}, ${terms.seconds})
            RETURNING *, amount::text AS amount`;
      await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome, reason) VALUES (${key}, ${state}, ${reason})`;
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
    const [attempts, locks] = await Promise.all([this.attemptsOf(rows.map((r) => r.reward_key)), this.locksOf(rows)]);
    return {
      records: rows.map((r) => ({
        ...this.toRecord(r, attempts.get(r.reward_key) ?? [], locks.get(r.reward_key)),
        accountId: r.account_id,
      })),
    };
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

  /** The lock terms and unlock-step count of each locked reward among these rows. */
  private async locksOf(rows: readonly IntentRow[]): Promise<Map<string, LockView>> {
    const out = new Map<string, LockView>();
    const keys = rows.filter((r) => r.lock_tx_id).map((r) => r.reward_key);
    if (keys.length === 0) return out;
    const found = await this.sql<{ reward_key: string; tasks: CampaignTasks | null; done: number }[]>`
      SELECT i.reward_key, c.tasks,
        (SELECT count(*)::int FROM campaigns.lock_progress p WHERE p.reward_key = i.reward_key) AS done
      FROM campaigns.reward_intents i JOIN campaigns.campaigns c ON c.id = i.campaign_id
      WHERE i.reward_key IN ${this.sql(keys)}`;
    for (const f of found) out.set(f.reward_key, { lock: f.tasks?.lock ?? null, done: f.done });
    return out;
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
    const [attempts, locks] = await Promise.all([this.attemptsOf([row.reward_key]), this.locksOf([row])]);
    return this.toRecord(row, attempts.get(row.reward_key) ?? [], locks.get(row.reward_key));
  }

  private toRecord(row: IntentRow, attempts: RedemptionAttempt[], lockView?: LockView): RewardRecord {
    const window = this.rollbackWindowSeconds;
    const terms = lockView?.lock ?? null;
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
      holdUntil: row.hold_until ? iso(row.hold_until) : null,
      form: row.form,
      lock:
        row.lock_tx_id && row.lock_until
          ? {
              txId: row.lock_tx_id,
              until: iso(row.lock_until),
              condition:
                terms?.kind === 'locked'
                  ? { title: terms.step.title, done: Math.min(lockView?.done ?? 0, terms.step.count), target: terms.step.count }
                  : null,
              appliesTo: terms?.kind === 'bonus' ? terms.appliesTo : [],
              outcome: row.settle,
            }
          : null,
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
