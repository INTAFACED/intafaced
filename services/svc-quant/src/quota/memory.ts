import { QUANT_IDEMPOTENCY_CONFLICT, QuantError } from '../errors.js';
import type { AccountCounts } from './counts.js';
import { DEFAULT_PLAN_PORT, planProfileOf, type PlanPort, type PlanProfiles } from './plans.js';
import { judgeNeeds, type AppliedProfile, type QuotaGate, type QuotaLimitRow, type QuotaRepository, type QuotaResource } from './quota.js';

/**
 * In-memory quota store for unit tests. Production passes Postgres, where the count and the write share one
 * transaction; the race at the limit is proven there (quota.pg.test.ts), not here.
 */
export function createMemoryQuota(options: {
  plans: PlanProfiles | null;
  planPort?: PlanPort;
  now?: () => Date;
  /** What an account holds; tests that read usage pass it. Omitted, every count reads zero. */
  counts?: (accountId: string) => Promise<AccountCounts>;
}): {
  repository: QuotaRepository;
  gate: QuotaGate;
} {
  const now = options.now ?? (() => new Date());
  const limits = new Map<string, Map<QuotaResource, QuotaLimitRow>>();
  const assignments = new Map<string, string>();
  const writes = new Map<string, { action: string; request: string; response: unknown }>();

  async function applied(accountId: string): Promise<AppliedProfile | null> {
    const own = assignments.get(accountId);
    if (own) return { name: own, source: 'assigned', plan: null };
    const mapped = await planProfileOf(options.plans, options.planPort ?? DEFAULT_PLAN_PORT, accountId);
    return mapped ? { name: mapped.profile, source: 'plan', plan: mapped.plan } : null;
  }

  function replay<T>(key: string, action: string, request: string): T | null {
    const prior = writes.get(key);
    if (!prior) return null;
    if (prior.action !== action || prior.request !== request) {
      throw new QuantError(QUANT_IDEMPOTENCY_CONFLICT, 'idempotencyKey was used for a different quota write');
    }
    return prior.response as T;
  }

  const repository: QuotaRepository = {
    async applied(accountId) {
      return applied(accountId);
    },
    async counts(accountId) {
      if (options.counts) return options.counts(accountId);
      return { strategies: 0n, mostVersions: 0n, runs: 0n, running: 0n, paperRuns: 0n, storage: 0n };
    },
    async limits(profile) {
      return [...(limits.get(profile)?.values() ?? [])];
    },
    async set(input) {
      const request = JSON.stringify([input.profile, input.resource, input.limit?.toString() ?? null]);
      const prior = replay<Awaited<ReturnType<QuotaRepository['set']>>>(input.idempotencyKey, 'set', request);
      if (prior) return prior;
      const setAt = now().toISOString();
      const rows = limits.get(input.profile) ?? new Map<QuotaResource, QuotaLimitRow>();
      rows.set(input.resource, { resource: input.resource, limit: input.limit, setAt });
      limits.set(input.profile, rows);
      const response = { profile: input.profile, resource: input.resource, limit: input.limit, setAt };
      writes.set(input.idempotencyKey, { action: 'set', request, response });
      return response;
    },
    async assign(input) {
      const request = JSON.stringify([input.accountId, input.profile]);
      const prior = replay<Awaited<ReturnType<QuotaRepository['assign']>>>(input.idempotencyKey, 'assign', request);
      if (prior) return prior;
      assignments.set(input.accountId, input.profile);
      const response = { accountId: input.accountId, profile: input.profile, assignedAt: now().toISOString() };
      writes.set(input.idempotencyKey, { action: 'assign', request, response });
      return response;
    },
  };

  const gate: QuotaGate = {
    async lock() {
      return undefined;
    },
    async check(_db, accountId, needs) {
      const profile = await applied(accountId);
      const rows = profile ? limits.get(profile.name) : undefined;
      judgeNeeds(profile, (resource) => rows?.get(resource)?.limit ?? null, needs);
    },
  };

  return { repository, gate };
}
