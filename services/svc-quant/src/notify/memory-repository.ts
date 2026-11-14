import { randomUUID } from 'node:crypto';
import type { NotifyRepository, StoredAlert, StoredNotifySettings } from './repository.js';

/** The in-memory store unit tests use. */
export function createMemoryNotifyRepository(now: () => number = () => Date.now()): NotifyRepository {
  const settings = new Map<string, StoredNotifySettings>();
  const alerts: StoredAlert[] = [];
  const marks = new Set<string>();
  return {
    async settings({ accountId, strategyId }) {
      return settings.get(`${accountId}:${strategyId}`) ?? null;
    },
    async saveSettings({ accountId, strategyId, channels }) {
      const row = { channels: [...channels], updatedAt: new Date(now()).toISOString() };
      settings.set(`${accountId}:${strategyId}`, row);
      return row;
    },
    async createAlert(input) {
      const prior = alerts.find((row) => row.accountId === input.accountId && row.key === input.key);
      if (prior) return prior;
      const row: StoredAlert = { ...input, id: randomUUID(), createdAt: new Date(now()).toISOString() };
      alerts.push(row);
      return row;
    },
    async alerts({ accountId, strategyId, limit }) {
      return alerts.filter((row) => row.accountId === accountId && row.strategyId === strategyId).slice(0, limit);
    },
    async sweepAlerts({ after, limit }) {
      const sorted = [...alerts].sort((a, b) => a.id.localeCompare(b.id));
      return sorted.filter((row) => after === null || row.id > after).slice(0, limit);
    },
    async announced({ alertId, runId }) {
      const prefix = `${alertId}\0${runId}\0`;
      return new Set([...marks].filter((key) => key.startsWith(prefix)).map((key) => Number(key.slice(prefix.length))));
    },
    async markAnnounced({ alertId, runId, seq }) {
      marks.add(`${alertId}\0${runId}\0${seq}`);
    },
  };
}
