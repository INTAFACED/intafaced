import type { RiskRepository, StoredRisk } from './repository.js';
import { BLANK_CAPS } from './repository.js';

/** The in-memory store unit tests use. */
export function createMemoryRiskRepository(now: () => number = () => Date.now()): RiskRepository {
  const rows = new Map<string, StoredRisk>();
  const keyOf = (accountId: string, strategyId: string) => `${accountId}:${strategyId}`;
  const prior = (key: string): StoredRisk =>
    rows.get(key) ?? { caps: BLANK_CAPS, floorPolicy: null, tradingVersion: null, updatedAt: new Date(now()).toISOString() };
  return {
    async get({ accountId, strategyId }) {
      return rows.get(keyOf(accountId, strategyId)) ?? null;
    },
    async saveCaps({ accountId, strategyId, caps, floorPolicy }) {
      const key = keyOf(accountId, strategyId);
      const row = { ...prior(key), caps: { ...caps }, floorPolicy, updatedAt: new Date(now()).toISOString() };
      rows.set(key, row);
      return row;
    },
    async setTrading({ accountId, strategyId, version }) {
      const key = keyOf(accountId, strategyId);
      const row = { ...prior(key), tradingVersion: version, updatedAt: new Date(now()).toISOString() };
      rows.set(key, row);
      return row;
    },
  };
}
