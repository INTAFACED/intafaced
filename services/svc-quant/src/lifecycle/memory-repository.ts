import type { LifecycleRepository, OwnerCriterionRow, RecordPromotion } from './repository.js';

interface Stored extends RecordPromotion {
  readonly at: string;
}

/** The in-memory lifecycle store, for tests. */
export function createMemoryLifecycleRepository(now: () => Date = () => new Date()): LifecycleRepository {
  const criteria = new Map<string, OwnerCriterionRow>();
  const audit = new Map<string, OwnerCriterionRow>();
  const promotions: Stored[] = [];
  const sameVersion = (row: Stored, input: { accountId: string; strategyId: string; strategyVersion: number }) =>
    row.accountId === input.accountId && row.strategyId === input.strategyId && row.strategyVersion === input.strategyVersion;
  return {
    async criteria() {
      return [...criteria.values()];
    },
    async setCriterion(input) {
      const prior = audit.get(input.idempotencyKey);
      if (prior) return prior;
      const row: OwnerCriterionRow = {
        name: input.name,
        value: input.toBoot ? null : input.value,
        setAt: now().toISOString(),
        toBoot: input.toBoot,
      };
      if (input.toBoot) criteria.delete(input.name);
      else criteria.set(input.name, { name: row.name, value: row.value, setAt: row.setAt });
      audit.set(input.idempotencyKey, row);
      return row;
    },
    async of(input) {
      const mine = promotions.filter((row) => sameVersion(row, input));
      return {
        stages: mine.flatMap((row) => (row.stage ? [row.stage] : [])),
        decisions: mine.map((row) => row.decision),
      };
    },
    async replay(accountId, key) {
      return promotions.find((row) => row.accountId === accountId && row.key === key)?.response ?? null;
    },
    async record(input) {
      const prior = promotions.find((row) => row.key === input.key);
      if (prior) return prior.response;
      if (input.stage && promotions.some((row) => sameVersion(row, input) && row.stage?.to === input.stage!.to)) return null;
      promotions.push({ ...input, at: now().toISOString() });
      return input.response;
    },
  };
}
