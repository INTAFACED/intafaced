/**
 * The Audit room's one row shape and its filters. Kill-switch entries, restriction history and the approvals
 * this session did all become the same six columns (time, actor, action, target, reason, outcome) plus a
 * request id, so one table and one filter bar serve them. Pure logic: no network, runs in the browser and in tests.
 */
import type { RestrictionHistoryRow } from './restrictions';
import type { ApprovalLogEntry } from './approvals';
import type { KillAuditLike } from './csv';

export interface AuditRow {
  readonly id: string;
  /** ISO 8601 UTC, normalised so text sort is time sort. */
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  /** Machine-readable module or area, for the module filter. */
  readonly module: string;
  readonly reason: string | null;
  readonly outcome: string;
  readonly requestId: string | null;
}

const iso = (t: string): string => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toISOString();
};
const words = (stopped: boolean) => (stopped ? 'stopped' : 'running');

export function auditRowsFromKillSwitch(audit: readonly (KillAuditLike & { readonly changed?: boolean })[]): AuditRow[] {
  return audit.map((a, i) => ({
    id: `ks-${i}-${a.at}-${a.module}`,
    at: iso(a.at),
    actor: a.confirmOperatorId ? `${a.actor} (confirmed by ${a.confirmOperatorId})` : a.actor,
    action: `Kill switch: ${words(a.previous)} to ${words(a.next)}`,
    target: `module ${a.module}`,
    module: a.module,
    reason: a.reason || null,
    outcome: a.changed === false ? 'No change' : 'Changed',
    requestId: null,
  }));
}

export function auditRowsFromRestrictions(rows: readonly RestrictionHistoryRow[]): AuditRow[] {
  return rows.map((r) => ({
    id: r.auditId,
    at: iso(r.at),
    actor: r.actor ?? 'not identified',
    action: r.action === 'restrict' ? 'Restrict trading' : 'Lift trading restriction',
    target: `user ${r.userId}`,
    module: 'trading',
    reason: r.reason,
    outcome: r.code
      ? `${r.outcome === 'conflict' ? 'Conflict' : 'Refused'}: ${r.code}`
      : r.outcome === 'changed'
        ? `Changed (v${r.versionBefore} to v${r.versionAfter})`
        : `No change (v${r.versionAfter})`,
    requestId: r.requestId,
  }));
}

const VERB_WORDS = { propose: 'Propose approval', approve: 'Approve', reject: 'Reject', revoke: 'Revoke' } as const;

/** What this tab did on approvals. Not the service's record: labelled "this session" wherever it is shown. */
export function auditRowsFromApprovalLog(log: readonly ApprovalLogEntry[]): AuditRow[] {
  return log.map((e, i) => ({
    id: `ap-${i}-${e.at}-${e.approvalId ?? ''}`,
    at: iso(e.at),
    actor: e.actorUserId,
    action: VERB_WORDS[e.verb],
    target: [e.approvalId ? `approval ${e.approvalId}` : null, e.targetId].filter(Boolean).join(' · ') || 'approval',
    module: 'approvals',
    reason: e.reason,
    outcome: e.outcome === 'ok' ? `Confirmed: ${e.result}` : e.outcome === 'refused' ? `Refused: ${e.result}` : 'Result unknown',
    requestId: null,
  }));
}

export type TimeWindow = 'all' | '1h' | '24h' | '7d';
export const WINDOW_MS: Record<Exclude<TimeWindow, 'all'>, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 };
export const WINDOW_LABEL: Record<TimeWindow, string> = { all: 'Any time', '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days' };

export interface AuditFilter {
  readonly actor: string;
  /** '' or 'all' = every module. */
  readonly module: string;
  readonly window: TimeWindow;
}

export const NO_FILTER: AuditFilter = { actor: '', module: 'all', window: 'all' };

/** `now` is passed in (ms since epoch) so the result is the same in a test and on screen. */
export function filterAudit(rows: readonly AuditRow[], f: AuditFilter, now: number): AuditRow[] {
  const actor = f.actor.trim().toLowerCase();
  const since = f.window === 'all' ? null : now - WINDOW_MS[f.window];
  return rows.filter((r) => {
    if (actor && !r.actor.toLowerCase().includes(actor)) return false;
    if (f.module && f.module !== 'all' && r.module !== f.module) return false;
    if (since !== null) {
      const t = Date.parse(r.at);
      if (Number.isNaN(t) || t < since) return false;
    }
    return true;
  });
}

export const modulesOf = (rows: readonly AuditRow[]): string[] => [...new Set(rows.map((r) => r.module))].sort();
