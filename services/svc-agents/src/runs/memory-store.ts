import { formatAmount } from '@intafaced/ledger-client';
import { assertMove } from './machine.js';
import { runKeyOf, type RunEvent, type RunOutcome, type RunStore, type StoredRun } from './store.js';

/**
 * The run store in memory, for router tests that run without a database. It keeps the Postgres store's rules: one run
 * per business key, RS-2 moves only, one event per move, reads bounded to the owner. `runs.db.test.ts` proves the
 * Postgres store itself.
 */
export function createMemoryRunStore(now: () => Date = () => new Date()): RunStore & { readonly runs: Map<string, StoredRun> } {
  const runs = new Map<string, StoredRun>();
  const events = new Map<string, RunEvent[]>();
  let ids = 0;
  const append = (runId: string, state: StoredRun['state'], code: string | null) => {
    const list = events.get(runId) ?? [];
    list.push({ sequence: list.length + 1, state, code, occurredAt: now().toISOString() });
    events.set(runId, list);
  };
  return {
    runs,
    async admit(input) {
      const runKey = runKeyOf(input.sessionId, input.requestId);
      const stored = [...runs.values()].find((run) => run.runKey === runKey);
      if (stored) return { run: stored, admitted: false };
      ids += 1;
      const at = now().toISOString();
      const run: StoredRun = {
        id: `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`,
        runKey,
        userId: input.userId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        agentId: input.agentId,
        task: input.task,
        state: 'admitted',
        reply: null,
        cost: null,
        assetId: null,
        metered: null,
        actionId: null,
        createdAt: at,
        updatedAt: at,
      };
      runs.set(run.id, run);
      append(run.id, 'admitted', null);
      return { run, admitted: true };
    },
    async move(runId, to, outcome: RunOutcome = {}) {
      const current = runs.get(runId);
      if (!current) throw new Error(`agents run ${runId} is not stored`);
      assertMove(current.state, to);
      const next: StoredRun = {
        ...current,
        state: to,
        reply: to === 'completed' ? (outcome.reply ?? '') : null,
        cost: outcome.cost === undefined ? current.cost : formatAmount(outcome.cost),
        assetId: outcome.assetId ?? current.assetId,
        metered: outcome.metered ?? current.metered,
        actionId: outcome.actionId ?? current.actionId,
        updatedAt: now().toISOString(),
      };
      runs.set(runId, next);
      append(runId, to, outcome.code ?? null);
      return next;
    },
    async takeOver(runId, staleBefore) {
      const current = runs.get(runId);
      if (!current || current.state !== 'running' || Date.parse(current.updatedAt) >= staleBefore.getTime()) return null;
      const next = { ...current, updatedAt: now().toISOString() };
      runs.set(runId, next);
      return next;
    },
    async get(runId, userId) {
      const run = runs.get(runId);
      if (!run || run.userId !== userId) return null;
      const codes = (events.get(runId) ?? []).flatMap((event) => (event.state === 'refused' && event.code ? [event.code] : []));
      return { run, refusalCodes: codes };
    },
    async events(runId, userId, after, limit) {
      const run = runs.get(runId);
      if (!run || run.userId !== userId) return null;
      return (events.get(runId) ?? []).filter((event) => event.sequence > after).slice(0, limit);
    },
    async forSession(sessionId) {
      return [...runs.values()].filter((run) => run.sessionId === sessionId);
    },
  };
}
