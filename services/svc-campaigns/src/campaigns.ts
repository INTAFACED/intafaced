import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
import {
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
  type CampaignType,
  type CampaignView,
  type MyCampaigns,
  type Participation,
  type ParticipationRules,
} from '@intafaced/contracts/campaigns-catalogue';
import type { CampaignParticipant } from '@intafaced/contracts';
import { CampaignsError } from './codes.js';
import { parseWindowTime } from './drops.js';
import type { ParticipantSource } from './participants.js';

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
 *   approve it either. In this version only a draft is edited, and each edit is a new revision, so a stale edit or move
 *   refuses `campaign.revision_conflict`; edits after launch come with the campaign builder (J-campaigns-16).
 * - Customer reads show times in the platform time zone: while it is blank they refuse `campaigns.timezone_unset`.
 * - A budget is a limit, never a balance. Nothing here reserves or spends; the reservation counters come with the reward
 *   saga (CM-payouts-ledger-02), so all of a budget is left. Joining
 *   writes one participation under `campaign:join:<campaign>:<account>` and moves nothing.
 * - Who can take part (CM-eligibility-rules-01): every signed-in account, less the excluded account kinds and, for a
 *   `listed` campaign, the restricted regions. Identity is read per check (`ParticipantSource`) and never copied. An
 *   account that is not active, of an excluded kind, or from a restricted region (or with no region recorded) is refused
 *   with one generic reason per rule; identity not answering is `unread`, never eligible. Market makers and staff have
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
  created_by: string;
  submitted_by: string | null;
  approved_by: string | null;
  approved_revision: number | null;
  created_at: Date;
  updated_at: Date;
};

type ParticipationRow = { participation_key: string; campaign_id: string; revision: number; created_at: Date };
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
  if (!timeZone) missing.push({ code: 'campaigns.timezone_unset', field: 'timeZone' });
  if (!row.reward_asset || row.reward_amount === null) missing.push({ code: 'campaigns.reward_unset', field: 'reward' });
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

/** The budget limit. Nothing in this version reserves or spends against it (the reward saga does), so all of it is left. */
function budgetOf(r: CampaignRow): Campaign['budget'] {
  if (!r.budget_asset || r.budget_limit === null) return null;
  const limit = decimalOf(r.budget_limit);
  return { asset: r.budget_asset, limit, left: limit };
}

function toCampaign(r: CampaignRow, timeZone: string | null, now: Date): Campaign {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    state: effectiveState(r, now),
    revision: r.revision,
    rules: r.rules,
    startsAt: r.starts_at ? iso(r.starts_at) : null,
    endsAt: r.ends_at ? iso(r.ends_at) : null,
    timeZone,
    windows: {
      weekdays: r.weekdays,
      hours: r.hours_from && r.hours_to ? { from: r.hours_from, to: r.hours_to } : null,
    },
    participation: r.participation,
    budget: budgetOf(r),
    reward: r.reward_asset && r.reward_amount !== null ? { asset: r.reward_asset, amount: decimalOf(r.reward_amount) } : null,
    createdBy: r.created_by,
    submittedBy: r.submitted_by,
    approvedBy: r.approved_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
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
    mine,
    eligibility,
  };
}

/** Whether a campaign's rules need identity's answer at all. A campaign open to every signed-in account does not. */
export const needsParticipant = (rules: ParticipationRules) => rules.exclusions.length > 0 || rules.regionScope === 'listed';

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
  return 'eligible';
}

const ELIGIBILITY_REFUSAL = {
  not_eligible: ['campaigns.not_eligible', 'This campaign’s rules leave out your account'],
  region_blocked: ['campaigns.region_blocked', 'This campaign is not open in your region'],
  unread: ['campaigns.participant_unread', 'Your account could not be checked against this campaign’s rules'],
} as const;

export const participationKeyOf = (campaignId: string, accountId: string) => `campaign:join:${campaignId}:${accountId}`;
export const reviewKeyOf = (campaignId: string, accountId: string) => `campaign:review:${campaignId}:${accountId}`;

/** What each move needs and where it goes. `activate` lands on scheduled or active by the start time. */
const MOVES: Record<CampaignAction, { from: readonly CampaignState[]; to: CampaignState }> = {
  submit: { from: ['draft'], to: 'pending_approval' },
  approve: { from: ['pending_approval'], to: 'approved' },
  activate: { from: ['approved'], to: 'active' },
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  end: { from: ['active', 'paused'], to: 'ended' },
  close: { from: ['ended'], to: 'closed' },
  archive: { from: ['draft', 'pending_approval', 'approved', 'scheduled', 'paused', 'ended', 'closed'], to: 'archived' },
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
};

/** An operator definition, read field by field. Blanks stay blank for the gate to name; a malformed value refuses now. */
export function parseDefinition(input: CampaignDefinitionInput): Definition {
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
  const regions = [...new Set((input.restrictedRegions ?? []).map((r) => r.toUpperCase()))].sort();
  return {
    exclusions: [...new Set(input.exclusions)].sort(),
    regionScope: input.regionScope,
    restrictedRegions: input.regionScope === 'listed' && regions.length > 0 ? regions : null,
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
    JSON.stringify(r.participation) === JSON.stringify(d.participation) &&
    r.budget_asset === d.budgetAsset &&
    amount(r.budget_limit) === amount(d.budgetLimit) &&
    r.reward_asset === d.rewardAsset &&
    amount(r.reward_amount) === amount(d.rewardAmount)
  );
}

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === '23505';

export interface CampaignServiceOptions {
  sql: Sql;
  /** The owner's platform time zone, or null while blank. */
  timeZone: () => string | null;
  /** svc-identity's participant read, per check. Null answers read `unread`. */
  participants: ParticipantSource;
  now?: () => Date;
}

export class CampaignService {
  private readonly sql: Sql;
  private readonly now: () => Date;
  private readonly timeZone: () => string | null;
  private readonly participants: ParticipantSource;

  constructor(options: CampaignServiceOptions) {
    this.sql = options.sql;
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
    const d = parseDefinition(input.definition);
    const id = `cmp_${randomUUID()}`;
    try {
      return await transaction(this.sql, async (tx) => {
        const [row] = await tx<CampaignRow[]>`
          INSERT INTO campaigns.campaigns (id, name, type, rules, starts_at, ends_at, weekdays, hours_from, hours_to,
            participation, budget_asset, budget_limit, reward_asset, reward_amount, created_by)
          VALUES (${id}, ${d.name}, ${d.type}, ${d.rules}, ${d.startsAt}, ${d.endsAt}, ${d.weekdays}, ${d.hoursFrom},
            ${d.hoursTo}, ${d.participation ? tx.json(d.participation) : null}, ${d.budgetAsset}, ${d.budgetLimit},
            ${d.rewardAsset}, ${d.rewardAmount}, ${input.actor})
          RETURNING *`;
        await audit(tx, input.actor, 'campaign.create', id, { name: d.name, type: d.type });
        return toCampaign(row!, this.timeZone(), this.now());
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [same] = await this.sql<CampaignRow[]>`
        SELECT * FROM campaigns.campaigns WHERE lower(name) = lower(${d.name}) AND state <> 'archived'`;
      if (same && same.created_by === input.actor && same.state === 'draft' && sameDefinition(same, d)) {
        return toCampaign(same, this.timeZone(), this.now());
      }
      throw new CampaignsError('campaign.name_taken', 'Another campaign already uses this name');
    }
  }

  /** Replaces a draft's definition. Past draft a definition does not change in this version (`campaign.not_draft`). */
  async update(input: { id: string; revision: number; definition: CampaignDefinitionInput; actor: string }): Promise<Campaign> {
    const d = parseDefinition(input.definition);
    try {
      return await transaction(this.sql, async (tx) => {
        const row = await this.lock(tx, input.id, input.revision);
        if (row.state !== 'draft') {
          throw new CampaignsError('campaign.not_draft', 'Only a draft is edited; a live campaign is changed by a new revision');
        }
        const [out] = await tx<CampaignRow[]>`
          UPDATE campaigns.campaigns SET name = ${d.name}, type = ${d.type}, rules = ${d.rules}, starts_at = ${d.startsAt},
            ends_at = ${d.endsAt}, weekdays = ${d.weekdays}, hours_from = ${d.hoursFrom}, hours_to = ${d.hoursTo},
            participation = ${d.participation ? tx.json(d.participation) : null}, budget_asset = ${d.budgetAsset},
            budget_limit = ${d.budgetLimit}, reward_asset = ${d.rewardAsset}, reward_amount = ${d.rewardAmount},
            revision = revision + 1, updated_at = now()
          WHERE id = ${input.id} RETURNING *`;
        await audit(tx, input.actor, 'campaign.update', input.id, { name: d.name, type: d.type });
        return toCampaign(out!, this.timeZone(), this.now());
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new CampaignsError('campaign.name_taken', 'Another campaign already uses this name');
      throw err;
    }
  }

  /** The gate's answer for one campaign, every blank by name. Stores nothing. */
  async validate(input: { id: string }): Promise<CampaignGate> {
    const [row] = await this.sql<CampaignRow[]>`SELECT * FROM campaigns.campaigns WHERE id = ${input.id}`;
    if (!row) throw new CampaignsError('campaign.unknown', 'No such campaign');
    return { missing: gateOf(row, this.timeZone()) };
  }

  /**
   * One move, keyed by (campaign, action, revision): the same move again returns the stored campaign. A move out of
   * order refuses `campaign.invalid_transition`; a stale revision `campaign.revision_conflict`.
   */
  async transition(input: { id: string; action: CampaignAction; revision: number; actor: string }): Promise<Campaign> {
    const move = MOVES[input.action];
    return transaction(this.sql, async (tx) => {
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
      if (input.action === 'archive' && current === 'active') {
        throw new CampaignsError('campaign.archive_active', 'An active campaign cannot be archived; pause or end it first');
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
        WHERE id = ${input.id} RETURNING *`;
      await audit(tx, input.actor, `campaign.${input.action}`, input.id, { from: current, to, revision: row.revision });
      return toCampaign(out!, timeZone, now);
    });
  }

  async listForOps(): Promise<Campaign[]> {
    const rows = await this.sql<CampaignRow[]>`SELECT * FROM campaigns.campaigns ORDER BY created_at DESC LIMIT 200`;
    const now = this.now();
    return rows.map((r) => toCampaign(r, this.timeZone(), now));
  }

  /** The calendar (LC-6): every campaign with a time frame, by start, in the platform time zone. No state of its own. */
  async calendar(): Promise<CampaignCalendar> {
    const rows = await this.sql<CampaignRow[]>`
      SELECT * FROM campaigns.campaigns
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
        SELECT * FROM campaigns.campaigns
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
      this.sql<CampaignRow[]>`SELECT * FROM campaigns.campaigns WHERE id = ${input.id}`,
      this.sql<ParticipationRow[]>`
        SELECT * FROM campaigns.participations WHERE participation_key = ${participationKeyOf(input.id, input.accountId)}`,
      this.sql<ReviewRow[]>`
        SELECT * FROM campaigns.eligibility_reviews WHERE review_key = ${reviewKeyOf(input.id, input.accountId)}`,
    ]);
    const now = this.now();
    if (!row || !toView(row, timeZone, now, null)) throw new CampaignsError('campaign.unknown', 'No such campaign');
    const state = await this.eligibility(row.participation!, input.accountId);
    const eligibility = { state, review: review ? { requestedAt: iso(review.created_at) } : null };
    return toView(row, timeZone, now, mine ? toParticipation(mine) : null, eligibility)!;
  }

  /**
   * One review request per campaign and account (`campaign:review:<campaign>:<account>`), for a customer the rules
   * refuse. Asking again returns the first request. An eligible account has nothing to review
   * (`campaigns.review_not_needed`); an account identity did not answer for is `campaigns.participant_unread`.
   */
  async requestReview(input: { campaignId: string; accountId: string }): Promise<CampaignReviewResult> {
    const key = reviewKeyOf(input.campaignId, input.accountId);
    const timeZone = this.customerZone();
    const [existing] = await this.sql<ReviewRow[]>`SELECT * FROM campaigns.eligibility_reviews WHERE review_key = ${key}`;
    if (existing) return { review: { campaignId: existing.campaign_id, requestedAt: iso(existing.created_at) }, created: false };
    const [row] = await this.sql<CampaignRow[]>`SELECT * FROM campaigns.campaigns WHERE id = ${input.campaignId}`;
    if (!row || !toView(row, timeZone, this.now(), null)) throw new CampaignsError('campaign.unknown', 'No such campaign');
    const state = await this.eligibility(row.participation!, input.accountId);
    if (state === 'eligible') throw new CampaignsError('campaigns.review_not_needed', 'Your account can already take part');
    if (state === 'unread') throw new CampaignsError(...ELIGIBILITY_REFUSAL.unread);
    return transaction(this.sql, async (tx) => {
      const [made] = await tx<ReviewRow[]>`
        INSERT INTO campaigns.eligibility_reviews (review_key, campaign_id, account_id, reason)
        VALUES (${key}, ${input.campaignId}, ${input.accountId}, ${state})
        ON CONFLICT (review_key) DO NOTHING
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
    // Rules do not change past draft, so identity is read once, before the transaction, never while it holds a lock.
    const [ruled] = await this.sql<Pick<CampaignRow, 'participation'>[]>`
      SELECT participation FROM campaigns.campaigns WHERE id = ${input.campaignId}`;
    const answer = ruled?.participation ? await this.eligibility(ruled.participation, input.accountId) : 'eligible';
    return transaction(this.sql, async (tx) => {
      const [row] = await tx<CampaignRow[]>`SELECT * FROM campaigns.campaigns WHERE id = ${input.campaignId} FOR SHARE`;
      const now = this.now();
      // The caller's own participation comes back first, even once the campaign has ended or closed.
      const [existing] = await tx<ParticipationRow[]>`SELECT * FROM campaigns.participations WHERE participation_key = ${key}`;
      if (existing) return { participation: toParticipation(existing), created: false };
      if (!row || !toView(row, timeZone, now, null)) throw new CampaignsError('campaign.unknown', 'No such campaign');
      const state = effectiveState(row, now);
      if (state !== 'active') throw new CampaignsError('campaign.not_active', `This campaign is ${state}, not active`);
      if (answer !== 'eligible') {
        const [code, message] = ELIGIBILITY_REFUSAL[answer];
        throw new CampaignsError(code, message);
      }
      const clock = zonedClock(now, timeZone);
      if (row.weekdays && !row.weekdays.includes(clock.weekday)) {
        throw new CampaignsError('campaign.outside_window', 'This campaign does not run today');
      }
      // `to` is exclusive; 24:00 runs to midnight. A window does not cross midnight.
      if (row.hours_from && row.hours_to && (clock.hhmm < row.hours_from || clock.hhmm >= row.hours_to)) {
        throw new CampaignsError('campaign.outside_window', 'This campaign does not run at this hour');
      }
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
      FROM campaigns.participations p JOIN campaigns.campaigns c ON c.id = p.campaign_id
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
