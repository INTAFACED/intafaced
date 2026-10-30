import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
import {
  BONUS_APPLIES_TO,
  CAMPAIGN_TYPES,
  CUSTOMER_CAMPAIGN_STATES,
  PARKED_CAMPAIGN_TYPES,
  type Campaign,
  type CampaignAction,
  type CampaignCalendar,
  type CampaignCatalogue,
  type CampaignDefinitionInput,
  type CampaignEligibility,
  type CampaignGate,
  type CampaignJoinResult,
  type CampaignReviewResult,
  type CampaignState,
  type CampaignTasks,
  type CampaignType,
  type CampaignView,
  type CampaignVoucher,
  VOUCHER_LIST_LIMIT,
  type MyCampaigns,
  type Participation,
  type ParticipationRules,
  type RewardLock,
  EARNING_TRIGGERS,
  type EarningRule,
  type EarningTrigger,
  type RuleGroup,
  type RuleLibraryEntry,
  type RuleTestResult,
} from '@intafaced/contracts/campaigns-catalogue';
import type { CampaignParticipant } from '@intafaced/contracts';
import { formatAmount, parseAmount as parseAmount18 } from '@intafaced/ledger-client';
import { CampaignsError } from './codes.js';
import { parseWindowTime } from './drops.js';
import type { ParticipantSource } from './participants.js';
import { parseFormula } from './formula.js';
import { checkRule, evaluateRule, tryRule, type RuleLimits } from './rules.js';

/**
 * The campaign object, its type catalogue and lifecycle (CM-campaign-types-01, ENGINE LC-1 to LC-4, LC-6), with the time
 * frame, weekday and hour windows and the budget limit of CM-eligibility-rules-03 (LC-3, BU-1, BU-5).
 *
 * - Types are a closed list. Gift cards and the points programme are listed and parked: submitting or activating one
 *   refuses `owner.decision` until the owner answers.
 * - States: draft, pending_approval, approved, scheduled, active, paused, ended, closed, archived. A scheduled campaign is
 *   active from its start time, and an active or paused one ended from its end time; reads and moves both use that
 *   effective state, and a move writes it.
 * - The activation gate is one function (`gateOf`) called by the moves, never by a screen: a blank budget, rule set, time
 *   frame, platform time zone or reward each refuses by its own code, and a parked type `owner.decision`.
 * - One person submits, a different person approves that revision (`campaigns.second_person_required`, and a CHECK in
 *   the database), and activation needs the approval (`campaigns.approval_required`). Whoever wrote the draft does not
 *   approve it either. Each draft edit is a new revision, so a stale edit or move refuses `campaign.revision_conflict`.
 *   Past approval an edit is a change at revision n+1 beside the live row (`campaign_changes`, ENGINE LC-5), approved
 *   the same way; joins and rewards keep the revision they were made under, and `campaign_revisions` keeps each one.
 * - Customer reads show times in the platform time zone: while it is blank they refuse `campaigns.timezone_unset`.
 * - A budget is a limit, never a balance. What is left is the limit less the reward intents that reserve or spent it
 *   (`campaigns.campaign_rows`, every intent not failed, forfeited or withheld; CM-payouts-ledger-02). Joining writes one
 *   participation under `campaign:join:<campaign>:<account>` and moves nothing.
 * - A task campaign (CM-tasks-quests-01) carries its steps, claim window and verification gate; its progress, claims and
 *   rewards are `tasks.ts` and `payouts.ts`. A task campaign with steps and a blank claim window cannot go live.
 * - Who can take part (CM-eligibility-rules-01): every signed-in account, less the excluded account kinds and, for a
 *   `listed` campaign, the restricted regions. Identity is read per check (`ParticipantSource`), only for a campaign
 *   that has rules, and never copied. Under rules, an account that is not active, of an excluded kind, or from a
 *   restricted region (or with no region recorded) is refused with one generic reason per rule; identity not answering
 *   is `unread`, never eligible. A campaign without rules leaves account freezes to svc-identity and the edge. Market makers and staff have
 *   no mark in identity, so excluding them refuses `campaigns.eligibility_unwired`. A refused customer may ask for one
 *   review per campaign (`campaign:review:<campaign>:<account>`); the operator queue that answers it is J-campaigns-16.
 * - Every operator move and every join writes an audit row.
 */

type Sql = postgres.Sql;

type CampaignRow = {
  id: string;
  name: string;
  type: CampaignType;
  state: CampaignState;
  revision: number;
  rules: string;
  starts_at: Date | null;
  ends_at: Date | null;
  weekdays: number[] | null;
  hours_from: string | null;
  hours_to: string | null;
  participation: ParticipationRules | null;
  budget_asset: string | null;
  budget_limit: string | null;
  reward_asset: string | null;
  reward_amount: string | null;
  tasks: CampaignTasks | null;
  /** True while the founder has not picked the campaign's time zone; false reads the platform zone. */
  time_zone_blank: boolean;
  earning: EarningRule[];
  /** What the campaign's reward intents reserve or spent, from `campaigns.campaign_rows`; absent on a RETURNING row. */
  budget_drawn?: string;
  created_by: string;
  submitted_by: string | null;
  approved_by: string | null;
  approved_revision: number | null;
  created_at: Date;
  updated_at: Date;
};

/** An open change of a live campaign (ENGINE LC-5): revision n+1, beside the live row until it is approved. */
type ChangeRow = {
  campaign_id: string;
  revision: number;
  definition: CampaignDefinitionInput;
  state: 'draft' | 'pending_approval';
  created_by: string;
  submitted_by: string | null;
  created_at: Date;
  updated_at: Date;
};

type RuleRow = { name: string; revision: number; tree: RuleGroup; created_by: string; created_at: Date };

const toRuleEntry = (r: RuleRow): RuleLibraryEntry => ({
  name: r.name,
  revision: r.revision,
  tree: r.tree,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
});

/** States in which a campaign is past approval and still changed by a new revision rather than edited in place. */
const REVISABLE: readonly CampaignState[] = ['approved', 'scheduled', 'active', 'paused'];

type ParticipationRow = { participation_key: string; campaign_id: string; revision: number; created_at: Date };
type VoucherRow = {
  id: string;
  campaign_id: string;
  code: string;
  issue_key: string;
  revision: number;
  face_asset: string;
  face_amount: string;
  state: CampaignVoucher['state'];
  issued_by: string;
  created_at: Date;
};

const toVoucher = (v: VoucherRow): CampaignVoucher => ({
  id: v.id,
  campaignId: v.campaign_id,
  code: v.code,
  revision: v.revision,
  face: { asset: v.face_asset, amount: decimalOf(v.face_amount) },
  state: v.state,
  issuedBy: v.issued_by,
  issuedAt: v.created_at.toISOString(),
});

type ReviewRow = { review_key: string; campaign_id: string; created_at: Date };

const DECIMAL = /^(0|[1-9]\d{0,19})(\.\d{1,18})?$/;
const ASSET = /^[A-Z0-9]{2,12}$/;

/** A numeric column as Postgres returns it, normalised (`1000.000000000000000000` reads `1000`). */
const decimalOf = (raw: string) => (raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw);

/** An operator amount: a number refuses `campaigns.number_on_wire`; blank is absent; anything else must be a positive decimal. */
function parseAmount(raw: unknown, unset: 'campaigns.budget_unset' | 'campaigns.reward_unset', what: string): string | null {
  if (typeof raw === 'number' || typeof raw === 'bigint') {
    throw new CampaignsError('campaigns.number_on_wire', `${what} must be a decimal string, not a number`);
  }
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!DECIMAL.test(value) || !/[1-9]/.test(value)) throw new CampaignsError(unset, `${what} must be a positive decimal`);
  return value;
}

function parseAsset(raw: string, unset: 'campaigns.budget_unset' | 'campaigns.reward_unset', what: string): string | null {
  const value = raw.trim().toUpperCase();
  if (!value) return null;
  if (!ASSET.test(value)) throw new CampaignsError(unset, `${what} asset is not an asset symbol`);
  return value;
}

/** The platform time zone owner value: blank is null; a name the runtime does not know refuses at boot. */
export function parseTimeZone(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
  } catch {
    throw new Error(`CAMPAIGNS_PLATFORM_TIME_ZONE is not a known time zone: ${value}`);
  }
  return value;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The weekday (Monday 1) and HH:MM of an instant in a time zone. */
/**
 * Whether a moment falls outside the campaign's weekdays or daily hours, read in the platform time zone. `to` is
 * exclusive; 24:00 runs to midnight. A window does not cross midnight.
 */
export function outsideWindow(
  row: Pick<CampaignRow, 'weekdays' | 'hours_from' | 'hours_to'>,
  at: Date,
  timeZone: string,
): 'day' | 'hour' | null {
  const clock = zonedClock(at, timeZone);
  if (row.weekdays && !row.weekdays.includes(clock.weekday)) return 'day';
  if (row.hours_from && row.hours_to && (clock.hhmm < row.hours_from || clock.hhmm >= row.hours_to)) return 'hour';
  return null;
}

export function zonedClock(at: Date, timeZone: string): { weekday: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { weekday: WEEKDAY[part('weekday')]!, hhmm: `${part('hour')}:${part('minute')}` };
}

/** The state a row is in at `now`: a scheduled campaign starts at its start time, a running one ends at its end time. */
export function effectiveState(row: Pick<CampaignRow, 'state' | 'starts_at' | 'ends_at'>, now: Date): CampaignState {
  let state = row.state;
  if (state === 'scheduled' && row.starts_at && row.starts_at <= now) state = 'active';
  if ((state === 'scheduled' || state === 'active' || state === 'paused') && row.ends_at && row.ends_at <= now) state = 'ended';
  return state;
}

const isParked = (type: CampaignType) => (PARKED_CAMPAIGN_TYPES as readonly string[]).includes(type);

/**
 * The activation gate (ENGINE LC-3): every blank by name, in order. Called by `submit` and `activate`, never a screen.
 * A `listed` campaign with a blank region list refuses `campaigns.region_list_unset`: the list is a compliance value.
 */
export function gateOf(row: CampaignRow, timeZone: string | null): CampaignGate['missing'] {
  const missing: CampaignGate['missing'] = [];
  if (isParked(row.type)) missing.push({ code: 'owner.decision', field: 'type' });
  if (!row.budget_asset || row.budget_limit === null) missing.push({ code: 'campaigns.budget_unset', field: 'budget' });
  if (!row.participation) missing.push({ code: 'campaigns.rules_unset', field: 'participation' });
  else if (row.participation.regionScope === 'listed' && !row.participation.restrictedRegions?.length) {
    missing.push({ code: 'campaigns.region_list_unset', field: 'restrictedRegions' });
  }
  if (!row.starts_at || !row.ends_at) missing.push({ code: 'campaigns.time_frame_unset', field: 'timeFrame' });
  if (!timeZone || row.time_zone_blank) missing.push({ code: 'campaigns.timezone_unset', field: 'timeZone' });
  if (!row.reward_asset || row.reward_amount === null) missing.push({ code: 'campaigns.reward_unset', field: 'reward' });
  if (row.budget_asset && row.reward_asset && row.budget_asset !== row.reward_asset) {
    missing.push({ code: 'campaigns.budget_asset_mismatch', field: 'budget' });
  }
  if (row.tasks && row.tasks.claimWindowSeconds === null) {
    missing.push({ code: 'campaigns.claim_window_unset', field: 'claimWindow' });
  }
  // Stored before holds existed, or blank: a task campaign names its hold, 0 when it pays at once.
  if (row.tasks && (row.tasks.holdSeconds ?? null) === null) {
    missing.push({ code: 'campaigns.hold_period_unset', field: 'holdPeriod' });
  }
  const lock = row.tasks?.lock ?? null;
  if (lock?.kind === 'locked' && lock.seconds === null) missing.push({ code: 'campaigns.lock_period_unset', field: 'lockPeriod' });
  if (lock?.kind === 'bonus' && lock.expirySeconds === null) missing.push({ code: 'campaigns.bonus_expiry_unset', field: 'bonusExpiry' });
  if (lock?.kind === 'bonus' && lock.appliesTo.length === 0) missing.push({ code: 'campaigns.bonus_scope_unset', field: 'bonusScope' });
  return missing;
}

function refuseGate(missing: CampaignGate['missing']): void {
  const first = missing[0];
  if (!first) return;
  const names = missing.map((m) => m.field).join(', ');
  const message =
    first.code === 'owner.decision'
      ? 'This campaign type waits for an owner decision'
      : `The campaign cannot go live until these are set: ${names}`;
  throw new CampaignsError(first.code, message);
}

const iso = (d: Date) => d.toISOString();

/** The budget limit and what is left of it once the campaign's reward intents are counted. Never below zero. */
function budgetOf(r: CampaignRow): Campaign['budget'] {
  if (!r.budget_asset || r.budget_limit === null) return null;
  const limit = decimalOf(r.budget_limit);
  const drawn = r.budget_drawn ? parseAmount18(r.budget_drawn) : 0n;
  const rest = parseAmount18(r.budget_limit) - drawn;
  return { asset: r.budget_asset, limit, left: formatAmount(rest > 0n ? rest : 0n) };
}

function toCampaign(r: CampaignRow, timeZone: string | null, now: Date, change: ChangeRow | null = null): Campaign {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    state: effectiveState(r, now),
    revision: r.revision,
    rules: r.rules,
    startsAt: r.starts_at ? iso(r.starts_at) : null,
    endsAt: r.ends_at ? iso(r.ends_at) : null,
    timeZone: r.time_zone_blank ? null : timeZone,
    timeZoneBlank: r.time_zone_blank,
    windows: {
      weekdays: r.weekdays,
      hours: r.hours_from && r.hours_to ? { from: r.hours_from, to: r.hours_to } : null,
    },
    participation: r.participation,
    budget: budgetOf(r),
    reward: r.reward_asset && r.reward_amount !== null ? { asset: r.reward_asset, amount: decimalOf(r.reward_amount) } : null,
    tasks: r.tasks,
    earning: r.earning,
    createdBy: r.created_by,
    submittedBy: r.submitted_by,
    approvedBy: r.approved_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    pendingChange: change
      ? {
          revision: change.revision,
          state: change.state,
          createdBy: change.created_by,
          submittedBy: change.submitted_by,
          definition: change.definition,
          updatedAt: iso(change.updated_at),
        }
      : null,
  };
}

/** A parsed definition as the update door takes it, so a stored change reads back through the same parser. */
function inputOf(d: Definition): CampaignDefinitionInput {
  return {
    name: d.name,
    type: d.type,
    rules: d.rules,
    startsAt: d.startsAt ? iso(d.startsAt) : null,
    endsAt: d.endsAt ? iso(d.endsAt) : null,
    weekdays: d.weekdays,
    hours: d.hoursFrom && d.hoursTo ? { from: d.hoursFrom, to: d.hoursTo } : null,
    participation: d.participation,
    budget: d.budgetAsset && d.budgetLimit ? { asset: d.budgetAsset, limit: d.budgetLimit } : null,
    reward: d.rewardAsset && d.rewardAmount ? { asset: d.rewardAsset, amount: d.rewardAmount } : null,
    tasks: d.tasks,
    ...(d.earning.length > 0 ? { earning: d.earning } : {}),
    // Blank stays blank; otherwise left out, which reads the platform zone.
    ...(d.timeZoneBlank ? { timeZone: null } : {}),
  };
}

/** The live row with a definition laid over it: what the gate reads for a change before it goes live. */
function rowWith(r: CampaignRow, d: Definition): CampaignRow {
  return {
    ...r,
    name: d.name,
    type: d.type,
    rules: d.rules,
    starts_at: d.startsAt,
    ends_at: d.endsAt,
    weekdays: d.weekdays,
    hours_from: d.hoursFrom,
    hours_to: d.hoursTo,
    participation: d.participation,
    budget_asset: d.budgetAsset,
    budget_limit: d.budgetLimit,
    reward_asset: d.rewardAsset,
    reward_amount: d.rewardAmount,
    tasks: d.tasks,
    time_zone_blank: d.timeZoneBlank,
    earning: d.earning,
  };
}

/** The live row's own definition, for the revision history. */
function inputOfRow(r: CampaignRow): CampaignDefinitionInput {
  return inputOf({
    name: r.name,
    type: r.type,
    rules: r.rules,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    weekdays: r.weekdays,
    hoursFrom: r.hours_from,
    hoursTo: r.hours_to,
    participation: r.participation,
    budgetAsset: r.budget_asset,
    budgetLimit: r.budget_limit === null ? null : decimalOf(r.budget_limit),
    rewardAsset: r.reward_asset,
    rewardAmount: r.reward_amount === null ? null : decimalOf(r.reward_amount),
    tasks: r.tasks,
    timeZoneBlank: r.time_zone_blank,
    earning: r.earning,
  });
}

function toParticipation(r: ParticipationRow): Participation {
  return { campaignId: r.campaign_id, participationKey: r.participation_key, revision: r.revision, joinedAt: iso(r.created_at) };
}

const CUSTOMER_STATES = CUSTOMER_CAMPAIGN_STATES as readonly CampaignState[];

/** A row a customer may see, or null. Only rows that went through approval and activation, with the gate's fields set. */
function toView(
  r: CampaignRow,
  timeZone: string,
  now: Date,
  mine: Participation | null,
  eligibility: CampaignEligibility | null = null,
): CampaignView | null {
  const c = toCampaign(r, timeZone, now);
  if (!(CUSTOMER_STATES as readonly string[]).includes(c.state)) return null;
  if (!c.startsAt || !c.endsAt || !c.budget || !c.participation) return null;
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    state: c.state as CampaignView['state'],
    rules: c.rules,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    timeZone,
    windows: c.windows,
    participation: c.participation,
    budget: c.budget,
    reward: c.reward,
    tasks: c.tasks,
    mine,
    eligibility,
  };
}

/** A campaign a customer can still join or ask about: running, paused or about to start. */
const isOpen = (state: CampaignState) => state === 'active' || state === 'paused' || state === 'scheduled';

/** Whether a campaign's rules need identity's answer at all. A campaign open to every signed-in account does not. */
export const needsParticipant = (rules: ParticipationRules) =>
  rules.exclusions.length > 0 || rules.regionScope === 'listed' || Boolean(rules.rule);

/**
 * The caller's answer for one rule set (ENGINE EL-1 to EL-3, EL-6). Null participant is `unread`. A frozen or closed
 * account, or one of an excluded kind, is `not_eligible`; a `listed` campaign refuses a restricted region, and an account
 * with no region recorded, as `region_blocked` (a compliance list never passes on a blank).
 */
export function eligibilityOf(rules: ParticipationRules, who: CampaignParticipant | null): CampaignEligibility['state'] {
  if (!needsParticipant(rules)) return 'eligible';
  if (!who) return 'unread';
  if (who.status !== 'active') return 'not_eligible';
  if (rules.exclusions.includes('business') && who.accountType === 'business') return 'not_eligible';
  if (rules.exclusions.includes('institution') && who.kycTier === 'institutional') return 'not_eligible';
  if (rules.regionScope === 'listed' && (!who.region || (rules.restrictedRegions ?? []).includes(who.region))) {
    return 'region_blocked';
  }
  // A library rule (CM-eligibility-rules-02) the account does not meet leaves it out like an exclusion does.
  if (rules.rule && !evaluateRule(rules.rule.tree, who).passes) return 'not_eligible';
  return 'eligible';
}

const ELIGIBILITY_REFUSAL = {
  not_eligible: ['campaigns.not_eligible', 'This campaign’s rules leave out your account'],
  region_blocked: ['campaigns.region_blocked', 'This campaign is not open in your region'],
  unread: ['campaigns.participant_unread', 'Your account could not be checked against this campaign’s rules'],
} as const;

export const participationKeyOf = (campaignId: string, accountId: string) => `campaign:join:${campaignId}:${accountId}`;
export const voucherKeyOf = (campaignId: string, code: string) => `voucher:issue:${campaignId}:${code}`;
export const reviewKeyOf = (campaignId: string, accountId: string) => `campaign:review:${campaignId}:${accountId}`;

/** What each move needs and where it goes. `activate` lands on scheduled or active by the start time. */
const MOVES: Record<CampaignAction, { from: readonly CampaignState[]; to: CampaignState }> = {
  submit: { from: ['draft'], to: 'pending_approval' },
  approve: { from: ['pending_approval'], to: 'approved' },
  activate: { from: ['approved'], to: 'active' },
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  end: { from: ['scheduled', 'active', 'paused'], to: 'ended' },
  close: { from: ['ended'], to: 'closed' },
  archive: { from: ['draft', 'pending_approval', 'approved', 'ended', 'closed'], to: 'archived' },
};

type Definition = {
  name: string;
  type: CampaignType;
  rules: string;
  startsAt: Date | null;
  endsAt: Date | null;
  weekdays: number[] | null;
  hoursFrom: string | null;
  hoursTo: string | null;
  participation: ParticipationRules | null;
  budgetAsset: string | null;
  budgetLimit: string | null;
  rewardAsset: string | null;
  rewardAmount: string | null;
  tasks: CampaignTasks | null;
  timeZoneBlank: boolean;
  earning: EarningRule[];
};

/**
 * The campaign's time zone. Absent: the platform zone (every caller before the builder). Null or blank: not picked yet,
 * which the gate names `campaigns.timezone_unset`. A name: in this version windows are read in the platform zone only,
 * so any other zone refuses `campaigns.timezone_not_platform`, and with the platform zone blank none can be picked.
 */
function parseCampaignZone(raw: string | null | undefined, platform: string | null): boolean {
  if (raw === undefined) return false;
  const value = raw?.trim() ?? '';
  if (!value) return true;
  if (!platform)
    throw new CampaignsError('campaigns.timezone_unset', 'The platform time zone is not set, so no campaign time zone can be picked');
  if (value !== platform) {
    throw new CampaignsError('campaigns.timezone_not_platform', `Campaigns run in the platform time zone, ${platform}, in this version`);
  }
  return false;
}

/** An operator definition, read field by field. Blanks stay blank for the gate to name; a malformed value refuses now. */
export function parseDefinition(input: CampaignDefinitionInput, platformZone: string | null): Definition {
  const type = input.type.trim();
  if (!(CAMPAIGN_TYPES as readonly string[]).includes(type)) {
    throw new CampaignsError('campaign.type_unknown', `Unknown campaign type: ${type || 'blank'}`);
  }
  const startsAt = input.startsAt?.trim() ? parseWindowTime(input.startsAt, 'The campaign start') : null;
  const endsAt = input.endsAt?.trim() ? parseWindowTime(input.endsAt, 'The campaign end') : null;
  if (startsAt && endsAt && endsAt <= startsAt) {
    throw new CampaignsError('campaigns.window_invalid', 'The campaign must end after it starts');
  }
  const weekdays = input.weekdays ? [...new Set(input.weekdays)].sort((a, b) => a - b) : null;
  const hours = input.hours ?? null;
  if (hours && hours.to <= hours.from) throw new CampaignsError('campaigns.window_invalid', 'The hour window must end after it starts');
  const participation = input.participation ? parseParticipation(input.participation) : null;
  const budgetAsset = input.budget ? parseAsset(input.budget.asset, 'campaigns.budget_unset', 'The budget') : null;
  const budgetLimit = input.budget ? parseAmount(input.budget.limit, 'campaigns.budget_unset', 'The budget limit') : null;
  const rewardAsset = input.reward ? parseAsset(input.reward.asset, 'campaigns.reward_unset', 'The reward') : null;
  const rewardAmount = input.reward ? parseAmount(input.reward.amount, 'campaigns.reward_unset', 'The reward amount') : null;
  const tasks = input.tasks ? parseTasks(type as CampaignType, input.tasks) : null;
  const longest = Math.max(0, ...(tasks?.steps ?? []).map((s) => s.streakDays ?? 0));
  if (longest > 0 && (weekdays || hours)) {
    throw new CampaignsError('campaigns.tasks_invalid', 'A streak runs every day: a streak campaign has no weekday or hour windows');
  }
  if (longest > 0 && startsAt && endsAt && endsAt.getTime() - startsAt.getTime() < longest * 86_400_000) {
    throw new CampaignsError('campaigns.tasks_invalid', `The time frame is shorter than the ${longest}-day streak`);
  }
  return {
    name: input.name.trim(),
    type: type as CampaignType,
    rules: input.rules?.trim() ?? '',
    startsAt,
    endsAt,
    weekdays,
    hoursFrom: hours?.from ?? null,
    hoursTo: hours?.to ?? null,
    participation,
    budgetAsset: budgetAsset && budgetLimit ? budgetAsset : null,
    budgetLimit: budgetAsset && budgetLimit ? budgetLimit : null,
    rewardAsset: rewardAsset && rewardAmount ? rewardAsset : null,
    rewardAmount: rewardAsset && rewardAmount ? rewardAmount : null,
    tasks,
    timeZoneBlank: parseCampaignZone(input.timeZone, platformZone),
    earning: parseEarning(input.earning ?? []),
  };
}

/**
 * Earning rules (CM-rewards-hub-05): a trigger from the closed catalogue, one name per rule, and a formula in the
 * grammar, read against the names that trigger has. Stored as written, trimmed.
 */
function parseEarning(rules: readonly EarningRule[]): EarningRule[] {
  const seen = new Set<string>();
  return rules.map((r) => {
    const trigger = EARNING_TRIGGERS[r.trigger as EarningTrigger];
    if (!trigger) throw new CampaignsError('campaigns.trigger_unknown', `"${r.trigger}" is not a trigger in the catalogue`);
    const name = r.name.trim();
    if (seen.has(name.toLowerCase())) throw new CampaignsError('campaigns.earning_rule_name_taken', `Two earning rules are named ${name}`);
    seen.add(name.toLowerCase());
    parseFormula(r.formula, trigger.names);
    return { name, trigger: r.trigger, minAmount: r.minAmount ?? null, formula: r.formula.trim() };
  });
}

/** How the reward is given, stored the same way every time: a bonus's products in the closed list's order, once each. */
function lockOf(lock: RewardLock | null): RewardLock | null {
  if (!lock) return null;
  if (lock.kind === 'bonus') {
    return { kind: 'bonus', expirySeconds: lock.expirySeconds, appliesTo: BONUS_APPLIES_TO.filter((p) => lock.appliesTo.includes(p)) };
  }
  const s = lock.step;
  return {
    kind: 'locked',
    seconds: lock.seconds,
    step: { title: s.title.trim(), event: s.event, market: s.market ?? null, side: s.side ?? null, count: s.count, streakDays: null },
  };
}

/** Steps belong to a `task` campaign only, and each step's market is stored as listed (`BTC/USDT`). */
function parseTasks(type: CampaignType, input: CampaignTasks): CampaignTasks {
  if (type !== 'task') throw new CampaignsError('campaigns.tasks_invalid', 'Only a task campaign has steps');
  if (input.steps.some((s) => s.streakDays && s.count !== 1)) {
    throw new CampaignsError('campaigns.tasks_invalid', 'A streak step counts one event a day: its count is 1');
  }
  return {
    steps: input.steps.map((s) => ({
      title: s.title.trim(),
      event: s.event,
      market: s.market ?? null,
      side: s.side ?? null,
      count: s.count,
      streakDays: s.streakDays ?? null,
    })),
    claimWindowSeconds: input.claimWindowSeconds,
    holdSeconds: input.holdSeconds ?? null,
    lock: lockOf(input.lock ?? null),
    kycGate: input.kycGate,
  };
}

/**
 * Who can take part, normalised so the same rules store the same way. Identity holds no market-maker or staff mark, so
 * excluding them refuses `campaigns.eligibility_unwired`. A region list belongs to a `listed` campaign only (a
 * `platform` one drops it); an empty one is blank, for the gate to name.
 */
function parseParticipation(input: ParticipationRules): ParticipationRules {
  const unwired = input.exclusions.filter((e) => e === 'market_maker' || e === 'staff');
  if (unwired.length > 0) {
    throw new CampaignsError(
      'campaigns.eligibility_unwired',
      `Identity holds no ${unwired.join(' or ')} mark yet, so a campaign cannot exclude them`,
    );
  }
  const regions = [...new Set(input.restrictedRegions ?? [])].sort();
  return {
    exclusions: [...new Set(input.exclusions)].sort(),
    regionScope: input.regionScope,
    restrictedRegions: input.regionScope === 'listed' && regions.length > 0 ? regions : null,
    // Only a campaign with a rule stores the key, so rules without one store as they always did.
    ...(input.rule ? { rule: input.rule } : {}),
  };
}

/** Whether a stored draft holds exactly this definition (a create sent again after a lost reply). */
function sameDefinition(r: CampaignRow, d: Definition): boolean {
  const at = (x: Date | null) => (x ? x.getTime() : null);
  const amount = (x: string | null) => (x === null ? null : decimalOf(x));
  return (
    r.name === d.name &&
    r.type === d.type &&
    r.rules === d.rules &&
    at(r.starts_at) === at(d.startsAt) &&
    at(r.ends_at) === at(d.endsAt) &&
    JSON.stringify(r.weekdays) === JSON.stringify(d.weekdays) &&
    r.hours_from === d.hoursFrom &&
    r.hours_to === d.hoursTo &&
    canonical(r.participation) === canonical(d.participation) &&
    r.budget_asset === d.budgetAsset &&
    amount(r.budget_limit) === amount(d.budgetLimit) &&
    r.reward_asset === d.rewardAsset &&
    amount(r.reward_amount) === amount(d.rewardAmount) &&
    canonical(r.tasks) === canonical(d.tasks) &&
    canonical(r.earning) === canonical(d.earning) &&
    r.time_zone_blank === d.timeZoneBlank
  );
}

/** jsonb keeps its own key order, so stored and parsed objects are compared with their keys sorted. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === '23505';

export interface CampaignServiceOptions {
  sql: Sql;
  /** The owner's platform time zone, or null while blank. */
  timeZone: () => string | null;
  /** svc-identity's participant read, per check. Null answers read `unread`. */
  participants: ParticipantSource;
  /** The owner's rule depth and size limits (CM-eligibility-rules-02); blank refuses every rule. */
  ruleLimits?: () => RuleLimits;
  now?: () => Date;
}

export class CampaignService {
  private readonly sql: Sql;
  private readonly now: () => Date;
  private readonly timeZone: () => string | null;
  private readonly participants: ParticipantSource;
  private readonly ruleLimits: () => RuleLimits;

  constructor(options: CampaignServiceOptions) {
    this.sql = options.sql;
    this.ruleLimits = options.ruleLimits ?? (() => ({ depth: null, size: null }));
    this.participants = options.participants;
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone;
  }

  // ── Operator (campaigns:ops) ────────────────────────────────────────────────

  /**
   * A new draft. The business name is the key: the same creator sending the same name again while it is still their
   * draft gets that draft back (a lost reply); anyone else, or a name in use past draft, refuses `campaign.name_taken`.
   */
  async create(input: { definition: CampaignDefinitionInput; actor: string }): Promise<Campaign> {
    const d = parseDefinition(input.definition, this.timeZone());
    const id = `cmp_${randomUUID()}`;
    try {
      return await transaction(this.sql, async (tx) => {
        await this.checkCampaignRule(tx, d);
        const [row] = await tx<CampaignRow[]>`
          INSERT INTO campaigns.campaigns (id, name, type, rules, starts_at, ends_at, weekdays, hours_from, hours_to,
            participation, budget_asset, budget_limit, reward_asset, reward_amount, tasks, time_zone_blank, earning, created_by)
          VALUES (${id}, ${d.name}, ${d.type}, ${d.rules}, ${d.startsAt}, ${d.endsAt}, ${d.weekdays}, ${d.hoursFrom},
            ${d.hoursTo}, ${d.participation ? tx.json(d.participation) : null}, ${d.budgetAsset}, ${d.budgetLimit},
            ${d.rewardAsset}, ${d.rewardAmount}, ${d.tasks ? tx.json(d.tasks as unknown as postgres.JSONValue) : null}, ${d.timeZoneBlank}, ${tx.json(d.earning as unknown as postgres.JSONValue)}, ${input.actor})
          RETURNING *`;
        await audit(tx, input.actor, 'campaign.create', id, { name: d.name, type: d.type });
        return toCampaign(row!, this.timeZone(), this.now());
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [same] = await this.sql<CampaignRow[]>`
        SELECT * FROM campaigns.campaign_rows WHERE lower(name) = lower(${d.name}) AND state <> 'archived'`;
      if (same && same.created_by === input.actor && same.state === 'draft' && sameDefinition(same, d)) {
        return toCampaign(same, this.timeZone(), this.now());
      }
      throw new CampaignsError('campaign.name_taken', 'Another campaign already uses this name');
    }
  }

  /**
   * Replaces a draft's definition, as a new revision. Past approval (approved, scheduled, active or paused) the live row
   * stays as it is and the edit is a change at revision n+1 that a second person approves (ENGINE LC-5); its type stays,
   * and its budget never drops below what its rewards already draw. Anywhere else refuses `campaign.not_draft`.
   */
  async update(input: { id: string; revision: number; definition: CampaignDefinitionInput; actor: string }): Promise<Campaign> {
    const d = parseDefinition(input.definition, this.timeZone());
    try {
      return await transaction(this.sql, async (tx) => {
        const [row] = await tx<CampaignRow[]>`SELECT * FROM campaigns.campaigns WHERE id = ${input.id} FOR UPDATE`;
        if (!row) throw new CampaignsError('campaign.unknown', 'No such campaign');
        const state = effectiveState(row, this.now());
        if (REVISABLE.includes(state)) return await this.change(tx, row, d, input);
        if (row.revision !== input.revision) {
          throw new CampaignsError('campaign.revision_conflict', `The campaign is at revision ${row.revision}, not ${input.revision}`);
        }
        if (row.state !== 'draft') {
          throw new CampaignsError('campaign.not_draft', `A campaign that is ${state} is not edited`);
        }
        await this.checkCampaignRule(tx, d);
        const [out] = await tx<CampaignRow[]>`
          UPDATE campaigns.campaigns SET name = ${d.name}, type = ${d.type}, rules = ${d.rules}, starts_at = ${d.startsAt},
            ends_at = ${d.endsAt}, weekdays = ${d.weekdays}, hours_from = ${d.hoursFrom}, hours_to = ${d.hoursTo},
            participation = ${d.participation ? tx.json(d.participation) : null}, budget_asset = ${d.budgetAsset},
            budget_limit = ${d.budgetLimit}, reward_asset = ${d.rewardAsset}, reward_amount = ${d.rewardAmount},
            tasks = ${d.tasks ? tx.json(d.tasks as unknown as postgres.JSONValue) : null}, time_zone_blank = ${d.timeZoneBlank},
            earning = ${tx.json(d.earning as unknown as postgres.JSONValue)},
            revision = revision + 1, updated_at = now()
          WHERE id = ${input.id}
          RETURNING *, (SELECT budget_drawn FROM campaigns.campaign_rows WHERE id = ${input.id}) AS budget_drawn`;
        await audit(tx, input.actor, 'campaign.update', input.id, { name: d.name, type: d.type });
        return toCampaign(out!, this.timeZone(), this.now());
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new CampaignsError('campaign.name_taken', 'Another campaign already uses this name');
      throw err;
    }
  }

  /** Writes the open change of a live campaign at the next revision; an edit sent for approval goes back to draft. */
  private async change(
    tx: Sql,
    row: CampaignRow,
    d: Definition,
    input: { id: string; revision: number; actor: string },
  ): Promise<Campaign> {
    const [open] = await tx<ChangeRow[]>`SELECT * FROM campaigns.campaign_changes WHERE campaign_id = ${row.id} FOR UPDATE`;
    const expected = open ? open.revision : row.revision;
    if (input.revision !== expected) {
      throw new CampaignsError('campaign.revision_conflict', `The campaign's latest revision is ${expected}, not ${input.revision}`);
    }
    if (d.type !== row.type) throw new CampaignsError('campaign.type_locked', 'A live campaign keeps its type');
    await this.checkCampaignRule(tx, d);
    await this.checkChange(tx, row, d);
    const definition = tx.json(inputOf(d) as unknown as postgres.JSONValue);
    const [out] = await tx<ChangeRow[]>`
      INSERT INTO campaigns.campaign_changes (campaign_id, revision, definition, state, created_by)
      VALUES (${row.id}, ${expected + 1}, ${definition}, 'draft', ${input.actor})
      ON CONFLICT (campaign_id) DO UPDATE SET revision = EXCLUDED.revision, definition = EXCLUDED.definition, state = 'draft',
        created_by = EXCLUDED.created_by, submitted_by = NULL, updated_at = now()
      RETURNING *`;
    await audit(tx, input.actor, 'campaign.change', row.id, { revision: out!.revision, live: row.revision });
    const [read] = await tx<CampaignRow[]>`SELECT * FROM campaigns.campaign_rows WHERE id = ${row.id}`;
    return toCampaign(read!, this.timeZone(), this.now(), out!);
  }

  /**
   * What a change must still meet when it is written and again when it goes live, since rewards draw and names are taken
   * in between: its budget is not below what the campaign's rewards already draw, and no other campaign has its name.
   */
  private async checkChange(tx: Sql, row: CampaignRow, d: Definition): Promise<void> {
    const [drawn] = await tx<{ budget_drawn: string }[]>`SELECT budget_drawn FROM campaigns.campaign_rows WHERE id = ${row.id}`;
    if (d.budgetLimit && parseAmount18(d.budgetLimit) < parseAmount18(drawn?.budget_drawn ?? '0')) {
      throw new CampaignsError('campaigns.budget_below_drawn', `Rewards already draw ${decimalOf(drawn!.budget_drawn)} of this budget`);
    }
    const [other] = await tx<{ id: string }[]>`
      SELECT id FROM campaigns.campaigns WHERE lower(name) = lower(${d.name}) AND state <> 'archived' AND id <> ${row.id}`;
    if (other) throw new CampaignsError('campaign.name_taken', 'Another campaign already uses this name');
  }

  /**
   * A move of an open change: `submit` asks for approval of it (the gate reads the change), `approve` by a second person
   * puts it live as the campaign's revision and keeps the revision it replaced in the history. Nothing else moves a change.
   */
  private async moveChange(tx: Sql, row: CampaignRow, open: ChangeRow, action: CampaignAction, actor: string): Promise<Campaign> {
    const timeZone = this.timeZone();
    const now = this.now();
    const d = parseDefinition(open.definition, timeZone);
    const merged = rowWith(row, d);
    const read = async (change: ChangeRow | null) => {
      const [r] = await tx<CampaignRow[]>`SELECT * FROM campaigns.campaign_rows WHERE id = ${row.id}`;
      return toCampaign(r!, timeZone, now, change);
    };
    if (action === 'submit') {
      if (open.state === 'pending_approval') return read(open);
      refuseGate(gateOf(merged, timeZone));
      if (d.endsAt && d.endsAt <= now) throw new CampaignsError('campaign.invalid_transition', 'The campaign’s end time has passed');
      const [out] = await tx<ChangeRow[]>`
        UPDATE campaigns.campaign_changes SET state = 'pending_approval', submitted_by = ${actor}, updated_at = now()
        WHERE campaign_id = ${row.id} RETURNING *`;
      await audit(tx, actor, 'campaign.change.submit', row.id, { revision: open.revision });
      return read(out!);
    }
    if (action !== 'approve') {
      throw new CampaignsError(
        'campaign.invalid_transition',
        `Revision ${open.revision} is a change waiting to go live: it cannot ${action}`,
      );
    }
    if (open.state !== 'pending_approval') {
      throw new CampaignsError('campaign.invalid_transition', `Revision ${open.revision} has not been sent for approval`);
    }
    // The campaign's creator never approves it (a CHECK on the live row), so a change the other founder wrote is rewritten
    // by the creator and approved by the other.
    if (actor === open.created_by || actor === open.submitted_by || actor === row.created_by) {
      throw new CampaignsError('campaigns.second_person_required', 'A second person approves; the one who wrote or asked for it cannot');
    }
    // The campaign may have ended, been archived or passed its end time since the change was asked for: only a running one
    // takes it, so an approval never brings an ended campaign back.
    const state = effectiveState(row, now);
    if (!REVISABLE.includes(state)) {
      throw new CampaignsError('campaign.invalid_transition', `A campaign that is ${state} takes no change`);
    }
    refuseGate(gateOf(merged, timeZone));
    if (d.endsAt && d.endsAt <= now) throw new CampaignsError('campaign.invalid_transition', 'The campaign’s end time has passed');
    await this.checkChange(tx, row, d);
    await tx`
      UPDATE campaigns.campaigns SET name = ${d.name}, rules = ${d.rules}, starts_at = ${d.startsAt}, ends_at = ${d.endsAt},
        weekdays = ${d.weekdays}, hours_from = ${d.hoursFrom}, hours_to = ${d.hoursTo},
        participation = ${d.participation ? tx.json(d.participation) : null}, budget_asset = ${d.budgetAsset},
        budget_limit = ${d.budgetLimit}, reward_asset = ${d.rewardAsset}, reward_amount = ${d.rewardAmount},
        tasks = ${d.tasks ? tx.json(d.tasks as unknown as postgres.JSONValue) : null}, time_zone_blank = ${d.timeZoneBlank},
        earning = ${tx.json(d.earning as unknown as postgres.JSONValue)},
        revision = ${open.revision}, submitted_by = ${open.submitted_by}, approved_by = ${actor},
        approved_revision = ${open.revision}, updated_at = now()
      WHERE id = ${row.id}`;
    await tx`
      INSERT INTO campaigns.campaign_revisions (campaign_id, revision, definition, submitted_by, approved_by)
      VALUES (${row.id}, ${open.revision}, ${tx.json(open.definition as unknown as postgres.JSONValue)}, ${open.submitted_by!}, ${actor})
      ON CONFLICT (campaign_id, revision) DO NOTHING`;
    await tx`DELETE FROM campaigns.campaign_changes WHERE campaign_id = ${row.id}`;
    await audit(tx, actor, 'campaign.change.approve', row.id, { revision: open.revision, replaced: row.revision });
    return read(null);
  }

  /** The gate's answer for one campaign, every blank by name. Stores nothing. */
  async validate(input: { id: string }): Promise<CampaignGate> {
    const [row] = await this.sql<CampaignRow[]>`SELECT * FROM campaigns.campaign_rows WHERE id = ${input.id}`;
    if (!row) throw new CampaignsError('campaign.unknown', 'No such campaign');
    // An open change is what would go live next, so the check reads it.
    const [open] = await this.sql<ChangeRow[]>`SELECT * FROM campaigns.campaign_changes WHERE campaign_id = ${input.id}`;
    const timeZone = this.timeZone();
    return { missing: gateOf(open ? rowWith(row, parseDefinition(open.definition, timeZone)) : row, timeZone) };
  }

  /**
   * One move, keyed by (campaign, action, revision): the same move again returns the stored campaign. A move out of
   * order refuses `campaign.invalid_transition`; a stale revision `campaign.revision_conflict`.
   */
  async transition(input: { id: string; action: CampaignAction; revision: number; actor: string }): Promise<Campaign> {
    const move = MOVES[input.action];
    return transaction(this.sql, async (tx) => {
      const [open] = await tx<ChangeRow[]>`SELECT * FROM campaigns.campaign_changes WHERE campaign_id = ${input.id} FOR UPDATE`;
      if (open && open.revision === input.revision) {
        const [live] = await tx<CampaignRow[]>`SELECT * FROM campaigns.campaigns WHERE id = ${input.id} FOR UPDATE`;
        return this.moveChange(tx, live!, open, input.action, input.actor);
      }
      const row = await this.lock(tx, input.id, input.revision);
      const now = this.now();
      const current = effectiveState(row, now);
      const timeZone = this.timeZone();
      const landed = input.action === 'activate' ? current === 'active' || current === 'scheduled' : current === move.to;
      if (landed && !move.from.includes(current)) {
        // The same approval again is still only the approver's to repeat.
        if (input.action === 'approve' && input.actor !== row.approved_by) {
          throw new CampaignsError('campaigns.second_person_required', 'This revision was approved by someone else');
        }
        return toCampaign(row, timeZone, now);
      }
      // A scheduled or paused campaign is in the catalogue too, and its customers' rewards read it: it is ended first.
      // The same approval again, once its revision is live, returns the campaign as it is.
      if (
        input.action === 'approve' &&
        row.approved_revision === row.revision &&
        row.approved_by === input.actor &&
        current !== 'pending_approval'
      ) {
        return toCampaign(row, timeZone, now, open ?? null);
      }
      if (input.action === 'archive' && (current === 'active' || current === 'scheduled' || current === 'paused')) {
        throw new CampaignsError('campaign.archive_active', 'An active, paused or scheduled campaign cannot be archived; end it first');
      }
      if (input.action === 'activate' && (current === 'draft' || current === 'pending_approval')) {
        refuseGate(gateOf(row, timeZone));
        throw new CampaignsError('campaigns.approval_required', 'A second person approves this revision before it goes live');
      }
      if (!move.from.includes(current)) {
        throw new CampaignsError('campaign.invalid_transition', `A campaign that is ${current} cannot ${input.action}`);
      }
      let to = move.to;
      const set: { submitted_by?: string; approved_by?: string; approved_revision?: number } = {};
      if (input.action === 'submit' || input.action === 'activate' || input.action === 'resume') {
        refuseGate(gateOf(row, timeZone));
        if (row.ends_at && row.ends_at <= now) {
          throw new CampaignsError('campaign.invalid_transition', 'The campaign’s end time has passed');
        }
      }
      if (input.action === 'submit') set.submitted_by = input.actor;
      if (input.action === 'approve') {
        if (row.submitted_by === input.actor || row.created_by === input.actor) {
          throw new CampaignsError(
            'campaigns.second_person_required',
            'A second person approves; the one who wrote or asked for it cannot',
          );
        }
        set.approved_by = input.actor;
        set.approved_revision = row.revision;
      }
      if (input.action === 'activate' && row.starts_at && row.starts_at > now) to = 'scheduled';
      const [out] = await tx<CampaignRow[]>`
        UPDATE campaigns.campaigns SET state = ${to},
          submitted_by = ${set.submitted_by ?? row.submitted_by},
          approved_by = ${set.approved_by ?? row.approved_by},
          approved_revision = ${set.approved_revision ?? row.approved_revision},
          updated_at = now()
        WHERE id = ${input.id}
        RETURNING *, (SELECT budget_drawn FROM campaigns.campaign_rows WHERE id = ${input.id}) AS budget_drawn`;
      if (input.action === 'approve') {
        await tx`
          INSERT INTO campaigns.campaign_revisions (campaign_id, revision, definition, submitted_by, approved_by)
          VALUES (${row.id}, ${row.revision}, ${tx.json(inputOfRow(row) as unknown as postgres.JSONValue)}, ${row.submitted_by!},
            ${input.actor})
          ON CONFLICT (campaign_id, revision) DO NOTHING`;
      }
      await audit(tx, input.actor, `campaign.${input.action}`, input.id, { from: current, to, revision: row.revision });
      return toCampaign(out!, timeZone, now);
    });
  }

  // ── Rule library (CM-eligibility-rules-02, ENGINE EL-4) ─────────────────────────────────────────────────────

  /** Tries a tree on a TEST fixture account. Reads no account and stores nothing. */
  testRule(input: { tree: RuleGroup; fixture: string }): RuleTestResult {
    return tryRule(input.tree, input.fixture, this.ruleLimits());
  }

  /** Saves a tree under a name as that name's next revision. The same tree sent again returns the revision it made. */
  async saveRule(input: { name: string; tree: RuleGroup; actor: string }): Promise<RuleLibraryEntry> {
    checkRule(input.tree, this.ruleLimits());
    const name = input.name.trim();
    return transaction(this.sql, async (tx) => {
      // One writer per name at a time, so two saves never take the same revision.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`campaigns:rule:${name.toLowerCase()}`}))`;
      const [latest] = await tx<RuleRow[]>`
        SELECT * FROM campaigns.rule_library WHERE lower(name) = lower(${name}) ORDER BY revision DESC LIMIT 1`;
      if (latest && canonical(latest.tree) === canonical(input.tree)) return toRuleEntry(latest);
      const [made] = await tx<RuleRow[]>`
        INSERT INTO campaigns.rule_library (name, revision, tree, created_by)
        VALUES (${latest?.name ?? name}, ${(latest?.revision ?? 0) + 1}, ${tx.json(input.tree as unknown as postgres.JSONValue)}, ${input.actor})
        RETURNING *`;
      await audit(tx, input.actor, 'campaign.rule.save', made!.name, { revision: made!.revision });
      return toRuleEntry(made!);
    });
  }

  /** Every name's latest revision, newest first. */
  async listRules(): Promise<RuleLibraryEntry[]> {
    const rows = await this.sql<RuleRow[]>`
      SELECT DISTINCT ON (lower(name)) * FROM campaigns.rule_library ORDER BY lower(name), revision DESC`;
    return rows.map(toRuleEntry).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** A campaign's rule is a copy of one library revision, checked against the library and the limits when it is saved. */
  private async checkCampaignRule(tx: Sql, d: Definition): Promise<void> {
    const rule = d.participation?.rule;
    if (!rule) return;
    checkRule(rule.tree, this.ruleLimits());
    const [entry] = await tx<RuleRow[]>`
      SELECT * FROM campaigns.rule_library WHERE lower(name) = lower(${rule.name}) AND revision = ${rule.revision}`;
    if (!entry || canonical(entry.tree) !== canonical(rule.tree)) {
      throw new CampaignsError(
        'campaigns.rule_unknown',
        `The rule library holds no revision ${rule.revision} of ${rule.name} with this tree`,
      );
    }
  }

  // ── Vouchers (CM-vouchers-coupons-01, CM-campaign-types-01 T-3) ──────────────────────────────────────────────

  /**
   * Issues (publishes) one voucher of a voucher campaign under its live revision, with that revision's reward as its face
   * value. The campaign row is read under a share lock, so an approval of the next revision waits for the issue and the
   * voucher never mixes two revisions. The code is the business key with the campaign: the same issue again returns the
   * stored voucher, whoever sends it and whatever revision is live by then. Moves no value.
   */
  async issueVoucher(input: { campaignId: string; code: string; actor: string }): Promise<CampaignVoucher> {
    const code = input.code.trim().toUpperCase();
    const key = voucherKeyOf(input.campaignId, code);
    return transaction(this.sql, async (tx) => {
      const [row] = await tx<CampaignRow[]>`SELECT * FROM campaigns.campaigns WHERE id = ${input.campaignId} FOR SHARE`;
      if (!row) throw new CampaignsError('campaign.unknown', 'No such campaign');
      const [had] = await tx<VoucherRow[]>`SELECT * FROM campaigns.vouchers WHERE issue_key = ${key}`;
      if (had) return toVoucher(had);
      if (row.type !== 'voucher') throw new CampaignsError('campaigns.not_voucher', 'Only a voucher campaign issues vouchers');
      const now = this.now();
      const state = effectiveState(row, now);
      // An approved campaign that was never activated stays `approved` past its end, so the end time is read as well.
      const ended = row.ends_at !== null && row.ends_at <= now;
      if (ended || !REVISABLE.includes(state)) {
        throw new CampaignsError(
          'campaign.invalid_transition',
          `A campaign that is ${ended ? 'ended' : state} issues no voucher: it must be approved and not ended`,
        );
      }
      if (!row.reward_asset || row.reward_amount === null) {
        throw new CampaignsError('campaigns.reward_unset', 'The live revision has no reward, so a voucher would have no face value');
      }
      // A campaign approved before revisions were recorded has no row for its live revision yet; it is recorded here from the
      // campaign's own approval, as the first approval records it, so the voucher can name it.
      if (row.approved_by && row.submitted_by && row.approved_revision === row.revision) {
        await tx`
          INSERT INTO campaigns.campaign_revisions (campaign_id, revision, definition, submitted_by, approved_by)
          VALUES (${row.id}, ${row.revision}, ${tx.json(inputOfRow(row) as unknown as postgres.JSONValue)}, ${row.submitted_by},
            ${row.approved_by})
          ON CONFLICT (campaign_id, revision) DO NOTHING`;
      }
      const [made] = await tx<VoucherRow[]>`
        INSERT INTO campaigns.vouchers (id, campaign_id, code, issue_key, revision, face_asset, face_amount, issued_by)
        VALUES (${`vch_${randomUUID()}`}, ${row.id}, ${code}, ${key}, ${row.revision}, ${row.reward_asset}, ${row.reward_amount},
          ${input.actor})
        ON CONFLICT (issue_key) DO NOTHING
        RETURNING *`;
      if (!made) {
        const [raced] = await tx<VoucherRow[]>`SELECT * FROM campaigns.vouchers WHERE issue_key = ${key}`;
        return toVoucher(raced!);
      }
      await audit(tx, input.actor, 'campaign.voucher.issue', row.id, { voucher: made.id, code, revision: made.revision });
      return toVoucher(made);
    });
  }

  /** A campaign's newest 500 vouchers, newest first, each with the revision it keeps. */
  async listVouchers(input: { campaignId: string }): Promise<CampaignVoucher[]> {
    const [row] = await this.sql<{ id: string }[]>`SELECT id FROM campaigns.campaigns WHERE id = ${input.campaignId}`;
    if (!row) throw new CampaignsError('campaign.unknown', 'No such campaign');
    const rows = await this.sql<VoucherRow[]>`
      SELECT * FROM campaigns.vouchers WHERE campaign_id = ${input.campaignId} ORDER BY created_at DESC, id DESC LIMIT ${VOUCHER_LIST_LIMIT}`;
    return rows.map(toVoucher);
  }

  /** One campaign as operators see it, at any age; the list is the newest 200. */
  async getForOps(input: { id: string }): Promise<Campaign> {
    const [row] = await this.sql<CampaignRow[]>`SELECT * FROM campaigns.campaign_rows WHERE id = ${input.id}`;
    if (!row) throw new CampaignsError('campaign.unknown', 'No such campaign');
    const [open] = await this.sql<ChangeRow[]>`SELECT * FROM campaigns.campaign_changes WHERE campaign_id = ${input.id}`;
    return toCampaign(row, this.timeZone(), this.now(), open ?? null);
  }

  async listForOps(): Promise<Campaign[]> {
    const rows = await this.sql<CampaignRow[]>`SELECT * FROM campaigns.campaign_rows ORDER BY created_at DESC LIMIT 200`;
    const ids = rows.map((r) => r.id);
    const changes = ids.length
      ? await this.sql<ChangeRow[]>`SELECT * FROM campaigns.campaign_changes WHERE campaign_id IN ${this.sql(ids)}`
      : [];
    const byId = new Map(changes.map((c) => [c.campaign_id, c]));
    const now = this.now();
    return rows.map((r) => toCampaign(r, this.timeZone(), now, byId.get(r.id) ?? null));
  }

  /** The calendar (LC-6): every campaign with a time frame, by start, in the platform time zone. No state of its own. */
  async calendar(): Promise<CampaignCalendar> {
    const rows = await this.sql<CampaignRow[]>`
      SELECT * FROM campaigns.campaign_rows
      WHERE state <> 'archived' AND starts_at IS NOT NULL AND ends_at IS NOT NULL
      ORDER BY starts_at ASC, id ASC LIMIT 500`;
    const now = this.now();
    return {
      timeZone: this.timeZone(),
      entries: rows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        state: effectiveState(r, now),
        startsAt: iso(r.starts_at!),
        endsAt: iso(r.ends_at!),
      })),
    };
  }

  // ── Customer (own account only; the account comes from the principal) ─────

  /** Customer reads and joins show times in the platform time zone: blank refuses by name, never an empty list. */
  private customerZone(): string {
    const timeZone = this.timeZone();
    if (!timeZone) throw new CampaignsError('campaigns.timezone_unset', 'The platform time zone is not set');
    return timeZone;
  }

  /** The type list, parked types with their blocker, and every scheduled, active or paused campaign. */
  async catalogue(accountId: string): Promise<CampaignCatalogue> {
    const now = this.now();
    const timeZone = this.customerZone();
    const [rows, mine] = await Promise.all([
      this.sql<CampaignRow[]>`
        SELECT * FROM campaigns.campaign_rows
        WHERE state IN ('scheduled', 'active', 'paused') AND (ends_at IS NULL OR ends_at > ${now})
        ORDER BY starts_at ASC, id ASC LIMIT 200`,
      this.mine(accountId),
    ]);
    const joined = new Map(mine.map((p) => [p.campaignId, p]));
    return {
      types: CAMPAIGN_TYPES.map((type) => ({ type, blocker: isParked(type) ? ('owner.decision' as const) : null })),
      campaigns: rows.flatMap((r) => toView(r, timeZone, now, joined.get(r.id) ?? null) ?? []),
    };
  }

  /**
   * One campaign a customer may see, with their own participation and their own answer under its rules (and their
   * review request, once filed). Anything else reads `campaign.unknown`.
   */
  async get(input: { id: string; accountId: string }): Promise<CampaignView> {
    const timeZone = this.customerZone();
    const [[row], [mine], [review]] = await Promise.all([
      this.sql<CampaignRow[]>`SELECT * FROM campaigns.campaign_rows WHERE id = ${input.id}`,
      this.sql<ParticipationRow[]>`
        SELECT * FROM campaigns.participations WHERE participation_key = ${participationKeyOf(input.id, input.accountId)}`,
      this.sql<ReviewRow[]>`
        SELECT * FROM campaigns.eligibility_reviews WHERE review_key = ${reviewKeyOf(input.id, input.accountId)}`,
    ]);
    const now = this.now();
    if (!row || !toView(row, timeZone, now, null)) throw new CampaignsError('campaign.unknown', 'No such campaign');
    // Identity is asked only while the answer matters: the caller has not joined and the campaign can still be joined.
    const eligibility =
      mine || !isOpen(effectiveState(row, now))
        ? null
        : {
            state: await this.eligibility(row.participation!, input.accountId),
            review: review ? { requestedAt: iso(review.created_at) } : null,
          };
    return toView(row, timeZone, now, mine ? toParticipation(mine) : null, eligibility)!;
  }

  /**
   * One review request per campaign and account (`campaign:review:<campaign>:<account>`), for a customer the rules
   * refuse, while the campaign can still be joined (`campaign.not_active` once it has ended). Asking again returns the
   * first request. An eligible account has nothing to review (`campaigns.review_not_needed`); an account identity did not
   * answer for is `campaigns.participant_unread`.
   */
  async requestReview(input: { campaignId: string; accountId: string }): Promise<CampaignReviewResult> {
    const key = reviewKeyOf(input.campaignId, input.accountId);
    const timeZone = this.customerZone();
    const [existing] = await this.sql<ReviewRow[]>`SELECT * FROM campaigns.eligibility_reviews WHERE review_key = ${key}`;
    if (existing) return { review: { campaignId: existing.campaign_id, requestedAt: iso(existing.created_at) }, created: false };
    const [row] = await this.sql<CampaignRow[]>`SELECT * FROM campaigns.campaign_rows WHERE id = ${input.campaignId}`;
    const now = this.now();
    if (!row || !toView(row, timeZone, now, null)) throw new CampaignsError('campaign.unknown', 'No such campaign');
    const current = effectiveState(row, now);
    if (!isOpen(current)) throw new CampaignsError('campaign.not_active', `This campaign is ${current}; there is nothing to review`);
    const state = await this.eligibility(row.participation!, input.accountId);
    if (state === 'eligible') throw new CampaignsError('campaigns.review_not_needed', 'Your account can already take part');
    if (state === 'unread') throw new CampaignsError(...ELIGIBILITY_REFUSAL.unread);
    return transaction(this.sql, async (tx) => {
      const [made] = await tx<ReviewRow[]>`
        INSERT INTO campaigns.eligibility_reviews (review_key, campaign_id, account_id, reason)
        VALUES (${key}, ${input.campaignId}, ${input.accountId}, ${state})
        -- No target: the key and (campaign, account) are both unique and name the same review. With only review_key as
        -- the arbiter, two requests at once could meet on the other index first and raise instead (#6337, #6398).
        ON CONFLICT DO NOTHING
        RETURNING *`;
      if (!made) {
        const [first] = await tx<ReviewRow[]>`SELECT * FROM campaigns.eligibility_reviews WHERE review_key = ${key}`;
        return { review: { campaignId: first!.campaign_id, requestedAt: iso(first!.created_at) }, created: false };
      }
      await audit(tx, input.accountId, 'campaign.review_request', input.campaignId, { reviewKey: key, reason: state });
      return { review: { campaignId: made.campaign_id, requestedAt: iso(made.created_at) }, created: true };
    });
  }

  /** The caller's answer under these rules. Identity is read only when the rules need it. */
  private async eligibility(rules: ParticipationRules, accountId: string): Promise<CampaignEligibility['state']> {
    return eligibilityOf(rules, needsParticipant(rules) ? await this.participants.read(accountId) : null);
  }

  /**
   * Joins once. The caller's own participation comes back first, whatever the campaign's state now. Otherwise the
   * campaign must be active (`campaign.not_active`) and inside its weekday and hour windows in the platform time zone
   * (`campaign.outside_window`). Nothing is reserved and nothing moves.
   */
  async join(input: { campaignId: string; accountId: string }): Promise<CampaignJoinResult> {
    const key = participationKeyOf(input.campaignId, input.accountId);
    const timeZone = this.customerZone();
    // Identity is read before the transaction, never while it holds a lock, and only for a first join of an active
    // campaign with rules. The transaction checks the rules it locked are the rules that were read.
    const [[ahead], [joined]] = await Promise.all([
      this.sql<Pick<CampaignRow, 'participation' | 'state' | 'starts_at' | 'ends_at'>[]>`
        SELECT participation, state, starts_at, ends_at FROM campaigns.campaigns WHERE id = ${input.campaignId}`,
      this.sql<ParticipationRow[]>`SELECT * FROM campaigns.participations WHERE participation_key = ${key}`,
    ]);
    if (joined) return { participation: toParticipation(joined), created: false };
    const readRules = ahead?.participation ?? null;
    const answer = readRules && effectiveState(ahead!, this.now()) === 'active' ? await this.eligibility(readRules, input.accountId) : null;
    return transaction(this.sql, async (tx) => {
      const [row] = await tx<CampaignRow[]>`SELECT * FROM campaigns.campaigns WHERE id = ${input.campaignId} FOR SHARE`;
      const now = this.now();
      // The caller's own participation comes back first, even once the campaign has ended or closed.
      const [existing] = await tx<ParticipationRow[]>`SELECT * FROM campaigns.participations WHERE participation_key = ${key}`;
      if (existing) return { participation: toParticipation(existing), created: false };
      if (!row || !toView(row, timeZone, now, null)) throw new CampaignsError('campaign.unknown', 'No such campaign');
      const state = effectiveState(row, now);
      if (state !== 'active') throw new CampaignsError('campaign.not_active', `This campaign is ${state}, not active`);
      if (JSON.stringify(row.participation) !== JSON.stringify(readRules) || answer === null) {
        throw new CampaignsError('campaign.revision_conflict', 'The campaign changed while it was read; try again');
      }
      if (answer !== 'eligible') {
        const [code, message] = ELIGIBILITY_REFUSAL[answer];
        throw new CampaignsError(code, message);
      }
      const outside = outsideWindow(row, now, timeZone);
      if (outside === 'day') throw new CampaignsError('campaign.outside_window', 'This campaign does not run today');
      if (outside === 'hour') throw new CampaignsError('campaign.outside_window', 'This campaign does not run at this hour');
      const [made] = await tx<ParticipationRow[]>`
        INSERT INTO campaigns.participations (participation_key, campaign_id, account_id, revision)
        VALUES (${key}, ${input.campaignId}, ${input.accountId}, ${row.revision})
        ON CONFLICT (participation_key) DO NOTHING
        RETURNING *`;
      if (!made) {
        const [first] = await tx<ParticipationRow[]>`SELECT * FROM campaigns.participations WHERE participation_key = ${key}`;
        return { participation: toParticipation(first!), created: false };
      }
      await audit(tx, input.accountId, 'campaign.join', input.campaignId, { participationKey: key, revision: row.revision });
      return { participation: toParticipation(made), created: true };
    });
  }

  /** The caller's own campaigns, newest join first, each as the customer sees it. */
  async myCampaigns(accountId: string): Promise<MyCampaigns> {
    const rows = await this.sql<(CampaignRow & { p_key: string; p_revision: number; p_created_at: Date })[]>`
      SELECT c.*, p.participation_key AS p_key, p.revision AS p_revision, p.created_at AS p_created_at
      FROM campaigns.participations p JOIN campaigns.campaign_rows c ON c.id = p.campaign_id
      WHERE p.account_id = ${accountId}
      ORDER BY p.created_at DESC LIMIT 200`;
    const now = this.now();
    const timeZone = this.customerZone();
    return {
      campaigns: rows.flatMap((r) => {
        const participation = toParticipation({
          participation_key: r.p_key,
          campaign_id: r.id,
          revision: r.p_revision,
          created_at: r.p_created_at,
        });
        const campaign = toView(r, timeZone, now, participation);
        return campaign ? [{ campaign, participation }] : [];
      }),
    };
  }

  private async mine(accountId: string): Promise<Participation[]> {
    const rows = await this.sql<ParticipationRow[]>`
      SELECT * FROM campaigns.participations WHERE account_id = ${accountId} ORDER BY created_at DESC LIMIT 500`;
    return rows.map(toParticipation);
  }

  private async lock(tx: Sql, id: string, revision: number): Promise<CampaignRow> {
    const [row] = await tx<CampaignRow[]>`SELECT * FROM campaigns.campaigns WHERE id = ${id} FOR UPDATE`;
    if (!row) throw new CampaignsError('campaign.unknown', 'No such campaign');
    if (row.revision !== revision) {
      throw new CampaignsError('campaign.revision_conflict', `The campaign is at revision ${row.revision}, not ${revision}`);
    }
    return row;
  }
}

async function audit(tx: Sql, actor: string, action: string, target: string, detail: Record<string, unknown>): Promise<void> {
  await tx`INSERT INTO campaigns.audit_log (actor, action, target, detail) VALUES (${actor}, ${action}, ${target}, ${tx.json(detail as postgres.JSONValue)})`;
}
