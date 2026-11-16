/**
 * The live strategy desk's data, as svc-trade sends it (`admin.quantLive.*`,
 * services/svc-trade/src/quant/live-run/halts.ts; J-algo-dev-11). Plain data and parsers, safe in server and browser
 * code: a body of any other shape is refused, never guessed at.
 */

export type HaltOp = 'halt_all' | 'restore' | 'restore_all';
export type RunState = 'signing' | 'running' | 'unknown' | 'stopped' | 'flat' | 'ended' | 'abandoned';

export const OP_TEXT: Record<HaltOp, string> = {
  halt_all: 'Halt every strategy',
  restore: 'Restore one strategy',
  restore_all: 'Restore every strategy',
};

export const STATE_TEXT: Record<RunState, string> = {
  signing: 'Waiting for the wallet',
  running: 'Running',
  unknown: 'Unknown',
  stopped: 'Stopped',
  flat: 'Flat',
  ended: 'Ended',
  abandoned: 'Never started',
};

export interface Halt {
  readonly id: string;
  readonly userId: string;
  readonly strategyId: string;
  readonly scope: 'one' | 'all';
  readonly reason: string;
  readonly haltedBy: string;
  readonly haltApprover: string | null;
  readonly haltedAt: string;
}

export interface HaltRequest {
  readonly id: string;
  readonly op: HaltOp;
  readonly haltId: string | null;
  readonly userId: string | null;
  readonly strategyId: string | null;
  readonly reason: string;
  readonly status: 'awaiting_second' | 'applied';
  readonly approvalId: string;
  readonly proposedBy: string;
  readonly approverId: string | null;
  readonly confirmedBy: string | null;
  readonly appliedRuns: number | null;
  readonly appliedStrategies: number | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
}

export interface DeskRun {
  readonly runId: string;
  readonly userId: string;
  readonly owner: string;
  readonly subAccount: string;
  readonly strategyId: string;
  readonly strategyName: string;
  readonly strategyVersion: number;
  readonly state: RunState;
  readonly createdAt: string;
  readonly halt: Halt | null;
}

export interface AuditRow {
  readonly id: string;
  readonly kind: string;
  readonly operatorId: string;
  readonly approverId: string | null;
  readonly accountId: string | null;
  readonly objectId: string;
  readonly reason: string | null;
  readonly occurredAt: string;
  readonly detail: Record<string, unknown>;
}

export interface HaltDeskRead {
  readonly runs: readonly DeskRun[];
  readonly halts: readonly Halt[];
  readonly waiting: readonly HaltRequest[];
  readonly audit: readonly AuditRow[];
  readonly counts: { readonly runs: number; readonly live: number; readonly haltedLive: number };
}

const STATES: readonly string[] = Object.keys(STATE_TEXT);
const OPS: readonly string[] = Object.keys(OP_TEXT);
const rec = (raw: unknown): Record<string, unknown> | null =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const intOrNull = (v: unknown): v is number | null => v === null || int(v);

export function parseHalt(raw: unknown): Halt | null {
  const r = rec(raw);
  if (
    !r ||
    !str(r.id) ||
    !str(r.userId) ||
    !str(r.strategyId) ||
    (r.scope !== 'one' && r.scope !== 'all') ||
    !str(r.reason) ||
    !str(r.haltedBy) ||
    !strOrNull(r.haltApprover) ||
    !str(r.haltedAt)
  )
    return null;
  return {
    id: r.id,
    userId: r.userId,
    strategyId: r.strategyId,
    scope: r.scope,
    reason: r.reason,
    haltedBy: r.haltedBy,
    haltApprover: r.haltApprover,
    haltedAt: r.haltedAt,
  };
}

export function parseHaltRequest(raw: unknown): HaltRequest | null {
  const r = rec(raw);
  if (
    !r ||
    !str(r.id) ||
    !str(r.op) ||
    !OPS.includes(r.op) ||
    !strOrNull(r.haltId) ||
    !strOrNull(r.userId) ||
    !strOrNull(r.strategyId) ||
    !str(r.reason) ||
    (r.status !== 'awaiting_second' && r.status !== 'applied') ||
    !str(r.approvalId) ||
    !str(r.proposedBy) ||
    !strOrNull(r.approverId) ||
    !strOrNull(r.confirmedBy) ||
    !intOrNull(r.appliedRuns) ||
    !intOrNull(r.appliedStrategies) ||
    !str(r.requestedAt) ||
    !strOrNull(r.decidedAt)
  )
    return null;
  return {
    id: r.id,
    op: r.op as HaltOp,
    haltId: r.haltId,
    userId: r.userId,
    strategyId: r.strategyId,
    reason: r.reason,
    status: r.status,
    approvalId: r.approvalId,
    proposedBy: r.proposedBy,
    approverId: r.approverId,
    confirmedBy: r.confirmedBy,
    appliedRuns: r.appliedRuns,
    appliedStrategies: r.appliedStrategies,
    requestedAt: r.requestedAt,
    decidedAt: r.decidedAt,
  };
}

function parseRun(raw: unknown): DeskRun | null {
  const r = rec(raw);
  if (
    !r ||
    !str(r.runId) ||
    !str(r.userId) ||
    !str(r.owner) ||
    !str(r.subAccount) ||
    !str(r.strategyId) ||
    !str(r.strategyName) ||
    !int(r.strategyVersion) ||
    !str(r.state) ||
    !STATES.includes(r.state) ||
    !str(r.createdAt)
  )
    return null;
  const halt = r.halt === null ? null : parseHalt(r.halt);
  if (r.halt !== null && halt === null) return null;
  return {
    runId: r.runId,
    userId: r.userId,
    owner: r.owner,
    subAccount: r.subAccount,
    strategyId: r.strategyId,
    strategyName: r.strategyName,
    strategyVersion: r.strategyVersion,
    state: r.state as RunState,
    createdAt: r.createdAt,
    halt,
  };
}

function parseAudit(raw: unknown): AuditRow | null {
  const r = rec(raw);
  if (
    !r ||
    !str(r.id) ||
    !str(r.kind) ||
    !str(r.operatorId) ||
    !strOrNull(r.approverId) ||
    !strOrNull(r.accountId) ||
    !str(r.objectId) ||
    !strOrNull(r.reason) ||
    !str(r.occurredAt)
  )
    return null;
  return {
    id: r.id,
    kind: r.kind,
    operatorId: r.operatorId,
    approverId: r.approverId,
    accountId: r.accountId,
    objectId: r.objectId,
    reason: r.reason,
    occurredAt: r.occurredAt,
    detail: rec(r.detail) ?? {},
  };
}

function all<T>(raw: unknown, parse: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.map(parse);
  return out.some((x) => x === null) ? null : (out as T[]);
}

export function parseHaltDesk(raw: unknown): HaltDeskRead | null {
  const r = rec(raw);
  const c = rec(r?.counts);
  if (!r || !c || !int(c.runs) || !int(c.live) || !int(c.haltedLive)) return null;
  const runs = all(r.runs, parseRun);
  const halts = all(r.halts, parseHalt);
  const waiting = all(r.waiting, parseHaltRequest);
  const audit = all(r.audit, parseAudit);
  if (!runs || !halts || !waiting || !audit) return null;
  return { runs, halts, waiting, audit, counts: { runs: c.runs, live: c.live, haltedLive: c.haltedLive } };
}

/** A reason as svc-trade takes it (3 to 500 characters once trimmed), or null. */
export function checkReason(raw: unknown): string | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  return v.length >= 3 && v.length <= 500 ? v : null;
}

export const AUDIT_TEXT: Record<string, string> = {
  'quant_live.halt': 'Halted one strategy',
  'quant_live.halt_all': 'Halted every strategy',
  'quant_live.restore': 'Restored one strategy',
  'quant_live.restore_all': 'Restored every strategy',
};
