import { QUANT_QUOTA_RESOURCES, type QuantQuotaResource } from '@intafaced/contracts';
import type { Sql, TransactionSql } from 'postgres';
import type { AccountCounts } from './counts.js';
import { QUANT_QUOTA_EXCEEDED, QUANT_QUOTA_PROFILE_UNSET, QUANT_QUOTA_UNSET, QuantError } from '../errors.js';

/**
 * Quotas by plan (AL-limits-01). A quota profile is a named row of limits, one per resource. Every limit is an owner
 * value: a blank one refuses `quant.quota_unset` naming the resource, `0` is a deliberate value that refuses every
 * create. A profile is a name, not a price: plan tiers, pricing and billing are not here.
 *
 * The order of this list is also the order the counters are locked in, so two writes never wait on each other.
 */
export const QUOTA_RESOURCES = QUANT_QUOTA_RESOURCES;
export type QuotaResource = QuantQuotaResource;

/** What each resource counts, in the words a refusal names it with. */
export const QUOTA_RESOURCE_NAMES: Record<QuotaResource, string> = {
  strategies: 'saved strategies',
  versions: 'versions per strategy',
  concurrent_runs: 'concurrent runs',
  paper_runs: 'paper runs',
  runs: 'stored runs',
  log_lines: 'stored log lines',
  storage: 'source and result storage in bytes',
  collaborators: 'collaborators per strategy',
  notifications: 'notifications per day',
};

export function isQuotaResource(value: string): value is QuotaResource {
  return (QUOTA_RESOURCES as readonly string[]).includes(value);
}

export type Db = Sql | TransactionSql;

/** One resource a write adds to: what the account holds now (counted after the lock) and how much this write adds. */
export interface QuotaNeed {
  readonly resource: QuotaResource;
  readonly used: bigint;
  readonly adding: bigint;
}

/** Which profile applies to an account: an operator's assignment of it, or the profile its plan maps to. */
export interface AppliedProfile {
  readonly name: string;
  readonly source: 'assigned' | 'plan';
  /** The plan id the profile came from; null when an operator assigned the account. */
  readonly plan: string | null;
}

/** A profile's stored limit for one resource; null is blank ("not set"). */
export interface QuotaLimitRow {
  readonly resource: QuotaResource;
  readonly limit: bigint | null;
  readonly setAt: string;
}

/**
 * The check every counted write makes inside its own transaction (Postgres) or synchronously (memory): lock the
 * account's counters, count from the stored rows, then `check`. The count and the write are one transaction, so a
 * count can't drift from the data and two writes racing at the limit can't both pass.
 */
export interface QuotaGate {
  lock(db: Db | null, accountId: string, resources: readonly QuotaResource[]): Promise<void>;
  check(db: Db | null, accountId: string, needs: readonly QuotaNeed[]): Promise<void>;
}

/** The operator's writes and the reads behind `quota.get`. */
export interface QuotaRepository {
  applied(accountId: string): Promise<AppliedProfile | null>;
  /** What the account holds now, counted from its stored rows. */
  counts(accountId: string): Promise<AccountCounts>;
  limits(profile: string): Promise<readonly QuotaLimitRow[]>;
  set(input: {
    readonly profile: string;
    readonly resource: QuotaResource;
    readonly limit: bigint | null;
    readonly reason: string;
    readonly actor: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly profile: string; readonly resource: QuotaResource; readonly limit: bigint | null; readonly setAt: string }>;
  assign(input: {
    readonly accountId: string;
    readonly profile: string;
    readonly reason: string;
    readonly actor: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly accountId: string; readonly profile: string; readonly assignedAt: string }>;
}

/**
 * Refuses the first need over its limit, in resource order. Blank profile: `quant.quota_profile_unset`. Blank limit:
 * `quant.quota_unset`. Over: `quant.quota_exceeded`, naming the resource, its current count and the limit, in the form
 * the screen reads ("<resource>: <used> used of <limit> allowed").
 */
export function judgeNeeds(
  profile: AppliedProfile | null,
  limitOf: (resource: QuotaResource) => bigint | null,
  needs: readonly QuotaNeed[],
): void {
  if (needs.length === 0) return;
  if (!profile)
    throw new QuantError(
      QUANT_QUOTA_PROFILE_UNSET,
      'no quota profile applies to this account: its plan maps to no profile, or the plan table is not set',
    );
  const ordered = [...needs].sort((a, b) => QUOTA_RESOURCES.indexOf(a.resource) - QUOTA_RESOURCES.indexOf(b.resource));
  for (const need of ordered) {
    const limit = limitOf(need.resource);
    if (limit === null) {
      throw new QuantError(QUANT_QUOTA_UNSET, `${need.resource}: the limit for ${QUOTA_RESOURCE_NAMES[need.resource]} is not set`);
    }
    if (need.used + need.adding > limit) {
      throw new QuantError(QUANT_QUOTA_EXCEEDED, `${need.resource}: ${need.used} used of ${limit} allowed`);
    }
  }
}

/** A limit as the operator sends it: a whole number as a decimal string, or blank for "not set". */
export function parseLimit(raw: string | null | undefined): bigint | null {
  const text = raw?.trim() ?? '';
  if (!text) return null;
  if (!/^\d{1,18}$/.test(text)) throw new QuantError('quant.params_invalid', 'limit — a whole number of at most 18 digits, or blank');
  return BigInt(text);
}

/** The TEST profile the local and CI stack seeds, and only a profile whose name says TEST. */
export interface QuotaSeed {
  readonly profile: string;
  readonly limits: Readonly<Partial<Record<QuotaResource, string>>>;
}

export function parseQuotaSeed(raw: string | undefined): QuotaSeed | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('QUANT_TEST_QUOTA_SEED is not JSON');
  }
  const rec = parsed as { profile?: unknown; limits?: unknown };
  if (typeof rec.profile !== 'string' || !/^TEST\b/.test(rec.profile)) {
    throw new Error('QUANT_TEST_QUOTA_SEED seeds only a profile whose name starts with TEST');
  }
  if (!rec.limits || typeof rec.limits !== 'object') throw new Error('QUANT_TEST_QUOTA_SEED needs limits');
  const limits: Partial<Record<QuotaResource, string>> = {};
  for (const [resource, value] of Object.entries(rec.limits as Record<string, unknown>)) {
    if (!isQuotaResource(resource)) throw new Error(`QUANT_TEST_QUOTA_SEED names an unknown resource ${resource}`);
    if (typeof value !== 'string' || !/^\d{1,18}$/.test(value)) throw new Error(`QUANT_TEST_QUOTA_SEED ${resource} is not a whole number`);
    limits[resource] = value;
  }
  return { profile: rec.profile, limits };
}
