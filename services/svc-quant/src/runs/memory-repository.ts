import { randomUUID } from 'node:crypto';
import { QUANT_RUN_IMMUTABLE, QUANT_RUN_NOT_FOUND, QuantError } from '../errors.js';
import { idempotencyConflict } from '../studio/keys.js';
import { decodeListCursor, encodeListCursor } from '../studio/keys.js';
import { assertResultFits, assertRunResultCap } from './limit.js';
import type { BeginRun, ClaimInput, FinishRun, RunRepository } from './repository.js';
import type { ClaimRow, RunCounts, RunKind, StoredRun } from './types.js';

interface MemoryRun extends StoredRun {
  readonly scopeKey: string;
}

function scopeKey(userId: string | null): string {
  return userId ?? 'anonymous';
}

function durationOf(started: string, finished: string | null): number | null {
  if (!finished) return null;
  return Date.parse(finished) - Date.parse(started);
}

function cloneRun(row: MemoryRun): StoredRun {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    strategyId: row.strategyId,
    strategyVersion: row.strategyVersion,
    started: row.started,
    finished: row.finished,
    outcome: row.outcome,
    detail: row.detail ? structuredClone(row.detail) : null,
    response: row.response === undefined ? null : structuredClone(row.response),
    idempotencyKey: row.idempotencyKey,
  };
}

/**
 * In-memory port for tests and for the router when no database is injected.
 * Production index.ts passes the Postgres repository. A finished row cannot
 * be finished again.
 */
export function createMemoryRunRepository(cap: number | null | undefined): RunRepository {
  const limit = assertRunResultCap(cap);
  const rows = new Map<string, MemoryRun>();
  const labels = new Map<string, string>();
  const byKey = new Map<string, string>();
  const claims = new Map<string, ClaimRow>();
  const claimsByRun = new Map<string, string>();
  const claimsByKey = new Map<string, string>();

  function keyOf(userId: string | null, idempotencyKey: string): string {
    return `${scopeKey(userId)}\0${idempotencyKey}`;
  }

  function findKey(userId: string | null, idempotencyKey: string): MemoryRun | undefined {
    const id = byKey.get(keyOf(userId, idempotencyKey));
    return id ? rows.get(id) : undefined;
  }

  return {
    async replay(userId, idempotencyKey) {
      const row = findKey(userId, idempotencyKey);
      return row ? cloneRun(row) : null;
    },

    async begin(input: BeginRun) {
      const existing = findKey(input.userId, input.idempotencyKey);
      if (existing) return cloneRun(existing);
      const row: MemoryRun = {
        id: `run_${randomUUID()}`,
        userId: input.userId,
        scopeKey: scopeKey(input.userId),
        kind: input.kind,
        strategyId: input.strategyId,
        strategyVersion: input.strategyVersion,
        started: new Date().toISOString(),
        finished: null,
        outcome: null,
        detail: null,
        response: null,
        idempotencyKey: input.idempotencyKey,
      };
      rows.set(row.id, row);
      byKey.set(keyOf(input.userId, input.idempotencyKey), row.id);
      return cloneRun(row);
    },

    async finish(input: FinishRun) {
      const row = rows.get(input.id);
      if (!row || row.scopeKey !== scopeKey(input.userId)) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
      if (row.finished || row.outcome) throw new QuantError(QUANT_RUN_IMMUTABLE, 'run cannot be rewritten');
      assertResultFits(input.stored, limit);
      const next: MemoryRun = {
        ...row,
        finished: new Date().toISOString(),
        outcome: input.outcome,
        detail: input.stored.detail ? structuredClone(input.stored.detail) : null,
        response: input.stored.response === undefined ? null : structuredClone(input.stored.response),
      };
      rows.set(row.id, next);
      return cloneRun(next);
    },

    async get(input) {
      const row = rows.get(input.id);
      if (!row || row.userId !== input.userId) return null;
      return cloneRun(row);
    },

    async list(input) {
      const cursor = input.cursor ? decodeListCursor(input.cursor) : null;
      const matched = [...rows.values()]
        .filter((row) => (input.from ? row.started >= input.from : true))
        .filter((row) => (input.to ? row.started < input.to : true))
        .filter((row) => (input.kind ? row.kind === input.kind : true))
        .filter((row) => (input.userId ? row.userId === input.userId : true))
        .filter((row) => (cursor ? row.started > cursor.createdAt || (row.started === cursor.createdAt && row.id > cursor.id) : true))
        .sort((a, b) => (a.started === b.started ? (a.id < b.id ? -1 : 1) : a.started < b.started ? -1 : 1));
      const page = matched.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        runs: page.map((row) => ({
          id: row.id,
          kind: row.kind,
          userId: row.userId,
          started: row.started,
          duration: durationOf(row.started, row.finished),
          outcome: row.outcome,
        })),
        nextCursor: matched.length > input.limit && last ? encodeListCursor(last.started, last.id) : null,
      };
    },

    async history(input) {
      const cursor = input.cursor ? decodeListCursor(input.cursor) : null;
      const matched = [...rows.values()]
        .filter((row) => row.userId === input.userId && row.kind === input.kind && row.idempotencyKey.startsWith(input.keyPrefix))
        .filter((row) => !input.strategyId || row.strategyId === input.strategyId)
        .filter((row) => (cursor ? row.started < cursor.createdAt || (row.started === cursor.createdAt && row.id < cursor.id) : true))
        .sort((a, b) => (a.started === b.started ? (a.id < b.id ? 1 : -1) : a.started < b.started ? 1 : -1));
      const page = matched.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        runs: page.map((row) => ({
          id: row.id,
          strategyId: row.strategyId,
          strategyVersion: row.strategyVersion,
          started: row.started,
          finished: row.finished,
          outcome: row.outcome,
          label: labels.get(row.id) ?? null,
        })),
        nextCursor: matched.length > input.limit && last ? encodeListCursor(last.started, last.id) : null,
      };
    },

    async variantCount(input) {
      return [...rows.values()].filter((row) => {
        if (row.userId !== input.userId || row.kind !== 'backtest' || row.outcome !== 'ok') return false;
        if (row.strategyId !== input.strategyId || !row.idempotencyKey.startsWith(input.keyPrefix)) return false;
        const response = row.response as { symbol?: unknown; coverage?: { barSize?: unknown } } | null;
        return response?.symbol === input.symbol && response.coverage?.barSize === input.barSize;
      }).length;
    },

    async setLabel(input) {
      const row = rows.get(input.runId);
      if (!row || row.userId !== input.userId) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
      labels.set(input.runId, input.label);
      return { label: input.label };
    },

    async okKinds(input) {
      const ok = [...rows.values()].filter((row) => row.userId === input.userId && row.finished && row.outcome === 'ok');
      return { backtest: ok.some((row) => row.kind === 'backtest'), sandbox: ok.some((row) => row.kind === 'sandbox') };
    },

    async counts(input): Promise<RunCounts> {
      const matched = [...rows.values()].filter((row) => row.started >= input.from && row.started < input.to);
      const byOutcome = new Map<string, number>();
      let backtest = 0;
      let sandbox = 0;
      for (const row of matched) {
        if (row.kind === 'backtest') backtest += 1;
        if (row.kind === 'sandbox') sandbox += 1;
        const outcome = row.outcome ?? '';
        byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
      }
      return {
        byKind: { backtest, sandbox },
        byOutcome: [...byOutcome.entries()].map(([outcome, count]) => ({ outcome, count })),
        asOf: new Date().toISOString(),
      };
    },

    async claimOnce(input: ClaimInput) {
      const existingRun = claimsByRun.get(input.runId);
      if (existingRun) {
        const claim = claims.get(existingRun);
        if (!claim || claim.userId !== input.userId) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
        return structuredClone(claim);
      }
      const existingKey = claimsByKey.get(`${input.userId}\0${input.idempotencyKey}`);
      if (existingKey) {
        const claim = claims.get(existingKey);
        if (!claim) idempotencyConflict('claim');
        if (claim.runId !== input.runId) idempotencyConflict('claim');
        return structuredClone(claim);
      }
      const row: ClaimRow = {
        id: input.id,
        runId: input.runId,
        userId: input.userId,
        pnl: input.pnl,
        environment: input.environment,
        kind: input.kind,
        claimLabel: input.claimLabel,
        live: false,
        simulated: true,
        createdAt: new Date().toISOString(),
      };
      claims.set(row.id, row);
      claimsByRun.set(row.runId, row.id);
      claimsByKey.set(`${input.userId}\0${input.idempotencyKey}`, row.id);
      return structuredClone(row);
    },
  };
}

export function isRunKind(value: string | null | undefined): value is RunKind {
  return value === 'backtest' || value === 'sandbox';
}
