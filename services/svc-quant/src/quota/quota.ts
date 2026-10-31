import { QUANT_QUOTA_RESOURCES, type QuantQuotaResource, type QuantQuotaUsage } from '@intafaced/contracts';
import { QUANT_QUOTA_EXCEEDED, QUANT_QUOTA_PROFILE_UNSET, QUANT_QUOTA_UNSET, QuantError } from '../errors.js';

/**
 * Quotas by plan (AL-limits-01). A profile is a name with one limit per resource, and an account is attached to one.
 * Every limit is an owner value: blank refuses `quant.quota_unset` by name and never defaults; `0` refuses every create.
 * The count and the write it guards run in one transaction, behind a lock per account and resource, so two writes
 * racing at the limit cannot both pass and a count cannot drift from the rows it counts.
 */
export const QUOTA_RESOURCES = QUANT_QUOTA_RESOURCES;
export type QuotaResource = QuantQuotaResource;

/** Words a refusal uses for each resource. */
export const RESOURCE_WORDS: Record<QuotaResource, string> = {
  strategies: 'saved strategies',
  versions_per_strategy: 'versions of this strategy',
  concurrent_runs: 'runs in progress',
  paper_runs: 'paper runs',
  stored_runs: 'stored runs',
  log_lines: 'stored log lines',
  storage_bytes: 'stored source and results (bytes)',
  collaborators_per_strategy: 'collaborators on this strategy',
  notifications_per_day: 'notifications today',
};

export interface QuotaLimitWrite {
  readonly profile: string;
  readonly resource: QuotaResource;
  /** A whole number as a decimal string, or null for blank. */
  readonly limit: string | null;
  readonly reason: string;
  readonly setBy: string;
  readonly idempotencyKey: string;
}

export interface QuotaAssignWrite {
  readonly accountId: string;
  readonly profile: string;
  readonly reason: string;
  readonly assignedBy: string;
  readonly idempotencyKey: string;
}

/** What one create adds, by resource. Absent means the create does not touch that resource. */
export type QuotaClaim = Partial<Record<QuotaResource, bigint>>;

/** The counts of one account now, by resource (per-strategy resources for the strategy named, if any). */
export type QuotaCounts = Record<QuotaResource, bigint>;

/**
 * The profile in force for an account: its latest assignment, or else the owner's default profile. Neither refuses
 * `quant.quota_profile_unset`.
 */
export function profileOf(assigned: string | null, defaultProfile: string | null): string {
  const profile = assigned ?? defaultProfile;
  if (!profile) {
    throw new QuantError(
      QUANT_QUOTA_PROFILE_UNSET,
      'quota profile — this account has no quota profile and no default profile is published; nothing is assumed',
    );
  }
  return profile;
}

/**
 * Refuses a create that the profile does not allow: a blank limit by name, or a count that would pass the limit with
 * the resource, its limit, the count now and, when the create adds more than one, how much it needs. Checked in the
 * order the claim lists them.
 */
export function checkClaim(profile: string, limits: ReadonlyMap<QuotaResource, bigint | null>, counts: QuotaCounts, claim: QuotaClaim) {
  for (const resource of QUOTA_RESOURCES) {
    const adds = claim[resource];
    if (adds === undefined) continue;
    const limit = limits.has(resource) ? limits.get(resource)! : null;
    if (limit === null) {
      throw new QuantError(
        QUANT_QUOTA_UNSET,
        `${resource} — the limit for ${RESOURCE_WORDS[resource]} in profile ${profile} is not set; nothing is assumed`,
      );
    }
    const used = counts[resource];
    if (used + adds > limit) {
      throw new QuantError(
        QUANT_QUOTA_EXCEEDED,
        `${resource} — ${RESOURCE_WORDS[resource]}: ${used} used of ${limit} allowed by profile ${profile}` +
          (adds > 1n ? ` — this needs ${adds} more` : ''),
      );
    }
  }
}

/** The usage view: each resource with its limit (null when blank) and what is used now. */
export function usageOf(profile: string | null, limits: ReadonlyMap<QuotaResource, bigint | null>, counts: QuotaCounts): QuantQuotaUsage {
  return {
    profile,
    rows: QUOTA_RESOURCES.map((resource) => {
      const limit = limits.get(resource);
      return { resource, limit: limit === undefined || limit === null ? null : String(limit), used: String(counts[resource]) };
    }),
  };
}

/** Whether an error is a quota refusal, so a write refused at the limit can first look for its own replay. */
export const isQuotaRefusal = (err: unknown): boolean =>
  err instanceof QuantError &&
  (err.code === QUANT_QUOTA_EXCEEDED || err.code === QUANT_QUOTA_UNSET || err.code === QUANT_QUOTA_PROFILE_UNSET);

export const zeroCounts = (): QuotaCounts => Object.fromEntries(QUOTA_RESOURCES.map((resource) => [resource, 0n])) as QuotaCounts;
