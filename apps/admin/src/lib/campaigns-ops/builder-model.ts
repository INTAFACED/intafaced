import type { Campaign, CampaignCalendar, CampaignDefinitionInput, CampaignGate, CampaignState } from '@intafaced/contracts/campaigns-catalogue';
import type { Part } from '@/lib/desk/part';

/**
 * The campaign builder (CM-campaign-types-01 and -02, CM-eligibility-rules-01 and -03, CM-campaign-admin-03; J-campaigns-16).
 * Pure, so the server loaders, the route and the screens share one reading of a draft.
 *
 * svc-campaigns holds every campaign and its revision. The console keeps nothing: a draft resumes at the first builder
 * step whose fields are still blank, read from the stored draft itself, so leaving and coming back lands where the
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

export const BUILDER_STEPS = ['basics', 'who', 'time', 'money', 'review'] as const;
export type BuilderStep = (typeof BUILDER_STEPS)[number];

export const STEP_LABEL: Record<BuilderStep, string> = {
  basics: '1. Name, type and rules',
  who: '2. Who can take part',
  time: '3. Time frame',
  money: '4. Budget and reward',
  review: '5. Check and go live',
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

/** The gate's field names, as an operator reads them. */
export const GATE_FIELD_LABEL: Record<string, string> = {
  type: 'Campaign type (waits for an owner decision)',
  budget: 'Budget',
  participation: 'Participation rules',
  restrictedRegions: 'Restricted region list',
  timeFrame: 'Time frame',
  timeZone: 'Platform time zone (owner value CAMPAIGNS_PLATFORM_TIME_ZONE)',
  reward: 'Reward',
  claimWindow: 'Claim window',
  holdPeriod: 'Risk-review hold',
  lockPeriod: 'Lock period',
  bonusExpiry: 'Bonus expiry',
  bonusScope: 'Where the bonus applies',
};

/** Where a draft resumes: the first step with a blank the founder fills there, else the check. */
export function resumeStep(c: Campaign): BuilderStep {
  if (!c.rules.trim()) return 'basics';
  if (!c.participation || (c.participation.regionScope === 'listed' && !c.participation.restrictedRegions?.length)) return 'who';
  if (!c.startsAt || !c.endsAt) return 'time';
  if (!c.budget || !c.reward) return 'money';
  return 'review';
}

/** The stored definition, as the update door takes it back, so a step changes only its own fields. */
export function definitionOf(c: Campaign): CampaignDefinitionInput {
  return {
    name: c.name,
    type: c.type,
    rules: c.rules,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    weekdays: c.windows.weekdays,
    hours: c.windows.hours,
    participation: c.participation,
    budget: c.budget ? { asset: c.budget.asset, limit: c.budget.limit } : null,
    reward: c.reward ? { asset: c.reward.asset, amount: c.reward.amount } : null,
    tasks: c.tasks,
  };
}

/** Which moves the desk offers for a state. The service decides; this only hides buttons that cannot apply. */
export function movesFor(state: CampaignState): readonly ('submit' | 'approve' | 'activate' | 'pause' | 'resume' | 'end' | 'archive')[] {
  switch (state) {
    case 'draft':
      return ['submit', 'archive'];
    case 'pending_approval':
      return ['approve', 'archive'];
    case 'approved':
      return ['activate', 'archive'];
    case 'scheduled':
    case 'active':
      return ['pause', 'end', 'archive'];
    case 'paused':
      return ['resume', 'end', 'archive'];
    case 'ended':
    case 'closed':
      return ['archive'];
    case 'archived':
      return [];
  }
}

export const MOVE_LABEL: Record<ReturnType<typeof movesFor>[number], string> = {
  submit: 'Ask for approval',
  approve: 'Approve this revision',
  activate: 'Take it live',
  pause: 'Pause',
  resume: 'Resume',
  end: 'End now',
  archive: 'Archive',
};

/** Counts per state, from the rows the service listed: never a figure of the console's own. */
export function countsByState(rows: readonly Campaign[]): { state: CampaignState; count: number }[] {
  const counts = new Map<CampaignState, number>();
  for (const r of rows) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
  return [...counts].map(([state, count]) => ({ state, count }));
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
