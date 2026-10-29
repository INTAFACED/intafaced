import type {
  Campaign,
  CampaignAction,
  CampaignCalendar,
  CampaignDefinitionInput,
  CampaignGate,
  CampaignState,
} from '@intafaced/contracts/campaigns-catalogue';
import type { Part } from '@/lib/desk/part';

/**
 * The campaign builder (CM-campaign-types-01 and -02, CM-eligibility-rules-01 and -03, CM-campaign-admin-03; J-campaigns-16).
 * Pure, so the server loaders, the route and the screens share one reading of a draft.
 *
 * svc-campaigns holds every campaign and its revision. The console keeps nothing: a draft resumes at the first builder
 * tab whose fields are still blank, read from the stored draft itself, so leaving and coming back lands where the
 * founder stopped on any device.
 */

export interface CampaignsDeskView {
  readonly asOf: string;
  readonly campaigns: Part<readonly Campaign[]>;
  readonly calendar: Part<CampaignCalendar>;
}

export interface CampaignDetailView {
  readonly asOf: string;
  /** Null data when the list was read and has no campaign with this id. */
  readonly campaign: Part<Campaign | null>;
  /** The activation gate's answer for the stored revision: every blank by name. Stores nothing. */
  readonly gate: Part<CampaignGate> | null;
  /** The platform time zone (owner value CAMPAIGNS_PLATFORM_TIME_ZONE) from the calendar read; null while blank or unread. */
  readonly platformTimeZone: string | null;
}

export type CampaignDeskReply =
  | { readonly ok: true; readonly what: string; readonly campaign: Campaign }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };

export const BUILDER_STEPS = ['basics', 'who', 'rules', 'earning', 'time'] as const;
export type BuilderStep = (typeof BUILDER_STEPS)[number];

export const STEP_LABEL: Record<BuilderStep, string> = {
  basics: 'Name and type',
  who: 'Who can take part',
  rules: 'Rules',
  earning: 'Earning rules',
  time: 'Budget and time',
};

/** Tabs whose backend is not built yet: shown with their blocker, never hidden, and never a step a draft resumes at. */
export const PARKED_STEPS: Partial<Record<BuilderStep, { slice: string; what: string }>> = {
  earning: {
    slice: 'CM-rewards-hub-05',
    what: 'Earning rules (a trigger from the catalogue, a condition and an incentive in the formula grammar) are not built in svc-campaigns yet.',
  },
};

export const STATE_LABEL: Record<CampaignState, string> = {
  draft: 'Draft',
  pending_approval: 'Waiting for approval',
  approved: 'Approved',
  scheduled: 'Scheduled',
  active: 'Active',
  paused: 'Paused',
  ended: 'Ended',
  closed: 'Closed',
  archived: 'Archived',
};

/** The gate's field names, as a founder reads them in the "Still missing" list. */
export const GATE_FIELD_LABEL: Record<string, string> = {
  type: 'Campaign type (waits for an owner decision)',
  budget: 'Budget',
  participation: 'Rules: who can take part',
  restrictedRegions: 'Region list',
  timeFrame: 'Time frame',
  timeZone: 'Time zone',
  reward: 'Reward (the per person limit)',
  claimWindow: 'Claim window',
  holdPeriod: 'Risk-review hold',
  lockPeriod: 'Lock period',
  bonusExpiry: 'Bonus expiry',
  bonusScope: 'Where the bonus applies',
};

/** One sentence per blank, as "Ask to activate" names it with its code. */
export const BLANK_SENTENCE: Record<string, string> = {
  'owner.decision': 'This campaign type waits for an owner decision',
  'campaigns.budget_unset': 'The budget is not set',
  'campaigns.rules_unset': 'Who can take part is not set',
  'campaigns.region_list_unset': 'The region list is not set',
  'campaigns.time_frame_unset': 'The time frame is not set',
  'campaigns.timezone_unset': 'The time zone is not set',
  'campaigns.reward_unset': 'The per person limit (the reward) is not set',
  'campaigns.budget_asset_mismatch': 'The budget and the reward are in different assets',
  'campaigns.claim_window_unset': 'The claim window is not set',
  'campaigns.hold_period_unset': 'The risk-review hold is not set',
  'campaigns.lock_period_unset': 'The lock period is not set',
  'campaigns.bonus_expiry_unset': 'The bonus expiry is not set',
  'campaigns.bonus_scope_unset': 'Where the bonus applies is not set',
};

export const blankSentence = (m: CampaignGate['missing'][number]) =>
  `${BLANK_SENTENCE[m.code] ?? `${GATE_FIELD_LABEL[m.field] ?? m.field} is not set`} (${m.code})`;

/**
 * The builder's own sentence for refusals a founder meets in this room. svc-campaigns names who may not approve as one
 * rule; the builder says which of the two the founder is.
 */
export function refusalSentence(code: string | null, campaign: Campaign | null, me: string | null): string | null {
  switch (code) {
    case 'campaigns.second_person_required': {
      const change = campaign?.pendingChange;
      if (change && me && change.submittedBy === me) return 'You asked for this, so another founder must approve it.';
      if (change && me && change.createdBy === me) return 'You wrote this revision, so another founder must approve it.';
      if (campaign && me && campaign.submittedBy === me) return 'You asked for this, so another founder must approve it.';
      if (campaign && me && campaign.createdBy === me) return 'You wrote this draft, so another founder must approve it.';
      return 'This revision was approved by another founder, or you wrote or asked for it: another founder must approve it.';
    }
    case 'campaign.archive_active':
      return 'An active campaign cannot be archived. A scheduled or paused one counts as active, because customers can still see it: end it first.';
    case 'campaign.not_draft':
      return 'A campaign that waits for its first approval, or has ended, is not edited.';
    case 'campaign.type_locked':
      return 'A live campaign keeps its type. Start a new campaign for another type.';
    case 'campaigns.budget_below_drawn':
      return 'The budget cannot drop below what rewards already draw from it.';
    default:
      return null;
  }
}

/** States past approval whose definition is changed by a new revision beside the live one (ENGINE LC-5). */
export const REVISABLE_STATES: readonly CampaignState[] = ['approved', 'scheduled', 'active', 'paused'];

/** Whether the builder may save a tab: a draft is edited in place, a live campaign through a new revision. */
export const isEditable = (c: Campaign) => c.state === 'draft' || REVISABLE_STATES.includes(c.state);

/** The revision an edit or a move of the definition is read at: the open change's, else the campaign's. */
export const latestRevision = (c: Campaign) => c.pendingChange?.revision ?? c.revision;

/** What a tab's save lays its fields over: the open change, else the stored definition. */
export const baseDefinition = (c: Campaign): CampaignDefinitionInput => c.pendingChange?.definition ?? definitionOf(c);

/** The campaign as the builder edits it: an open change's definition over the live row, so its fields show the change. */
export function editedView(c: Campaign): Campaign {
  const d = c.pendingChange?.definition;
  if (!d) return c;
  const amount = (raw: unknown) => (typeof raw === 'string' ? raw : '');
  return {
    ...c,
    name: d.name,
    rules: d.rules ?? '',
    startsAt: d.startsAt ?? null,
    endsAt: d.endsAt ?? null,
    timeZoneBlank: d.timeZone === null,
    windows: { weekdays: d.weekdays ?? null, hours: d.hours ?? null },
    participation: d.participation ?? null,
    budget: d.budget ? { asset: d.budget.asset, limit: amount(d.budget.limit), left: c.budget?.left ?? amount(d.budget.limit) } : null,
    reward: d.reward ? { asset: d.reward.asset, amount: amount(d.reward.amount) } : null,
  };
}

/** Where a draft resumes: the first tab with a blank the founder fills there, else the last. Parked tabs are skipped. */
export function resumeStep(c: Campaign): BuilderStep {
  if (!c.name.trim()) return 'basics';
  if (!c.participation || (c.participation.regionScope === 'listed' && !c.participation.restrictedRegions?.length)) return 'who';
  return 'time';
}

/** The stored definition, as the update door takes it back, so a tab changes only its own fields. */
export function definitionOf(c: Campaign): CampaignDefinitionInput {
  return {
    name: c.name,
    type: c.type,
    rules: c.rules,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    // Left blank by the builder: still blank. Otherwise absent, which reads the platform zone, so a save while the
    // platform zone is unset does not turn a campaign that reads it into one with a blank zone of its own.
    timeZone: c.timeZoneBlank ? null : undefined,
    weekdays: c.windows.weekdays,
    hours: c.windows.hours,
    participation: c.participation,
    budget: c.budget ? { asset: c.budget.asset, limit: c.budget.limit } : null,
    reward: c.reward ? { asset: c.reward.asset, amount: c.reward.amount } : null,
    tasks: c.tasks,
  };
}

/**
 * Every move, offered in every state: svc-campaigns decides, and refuses one that does not apply by name. "Approve" by a
 * second founder approves the revision and takes it live (scheduled until its start).
 */
export const MOVES: readonly { action: CampaignAction | 'approve_live'; label: string }[] = [
  { action: 'approve_live', label: 'Approve and take live' },
  { action: 'pause', label: 'Pause' },
  { action: 'resume', label: 'Resume' },
  { action: 'end', label: 'End now' },
  { action: 'archive', label: 'Archive' },
];

/** The overview's figures, each counted from the rows the service listed: never a figure of the console's own. */
export function overviewOf(rows: readonly Campaign[]): { label: string; count: number }[] {
  const count = (states: readonly CampaignState[]) => rows.filter((r) => states.includes(r.state)).length;
  return [
    { label: 'Campaigns', count: rows.length },
    { label: 'Drafts', count: count(['draft']) },
    { label: 'Waiting for approval', count: count(['pending_approval']) },
    { label: 'Approved, not live yet', count: count(['approved']) },
    { label: 'Live or scheduled', count: count(['scheduled', 'active', 'paused']) },
    { label: 'Ended', count: count(['ended', 'closed']) },
  ];
}

const REGION = /^[A-Z]{2}$/;

/** A typed region list ("DE, FR us") as ISO alpha-2 codes; null names the first entry that is not one. */
export function parseRegions(raw: string): { ok: true; regions: string[] } | { ok: false; bad: string } {
  const regions: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    if (!part) continue;
    const code = part.toUpperCase();
    if (!REGION.test(code)) return { ok: false, bad: part };
    if (!regions.includes(code)) regions.push(code);
  }
  return { ok: true, regions };
}
