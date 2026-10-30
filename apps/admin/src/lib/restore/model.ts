/**
 * Pure model of the restore room (OPS-ledger-desk-05). Client components reach this file, and the contracts entry point pulls in
 * Node-only code, so only plain types are declared here and the closed lists are repeated; model.test.ts pins them to the
 * contracts lists.
 */

export const RESTORE_STEPS = ['restore_clean', 'validate', 'preview', 'finalize'] as const;
export type RestoreStep = (typeof RESTORE_STEPS)[number];
export const RESTORE_SERVICES = ['ledger', 'identity', 'bank', 'pay'] as const;
export type RestoreServiceName = (typeof RESTORE_SERVICES)[number];

export const STEP_LABEL: Readonly<Record<RestoreStep, string>> = {
  restore_clean: 'Restore into a clean area',
  validate: 'Validate',
  preview: 'Preview',
  finalize: 'Finalize',
};

export const SERVICE_LABEL: Readonly<Record<string, string>> = {
  ledger: 'svc-ledger',
  identity: 'svc-identity',
  bank: 'svc-bank',
  pay: 'svc-pay',
};

export const DISAGREE_WORDS: Readonly<Record<string, string>> = {
  stamp_missing: 'No stamp has been recorded for this service.',
  read_missing: 'The service could not be read, so its position is unknown.',
  position_differs: 'The service reports a different position than its stamp.',
  written_after_cutoff: 'The service wrote something after the cut-off.',
  cutoff_invalid: 'The cut-off is not a valid time.',
};

/** What each typed refusal means to an operator. No raw code is shown without a sentence. */
export const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'ops.restore_archive_unconfigured': 'No joint-restore archive is configured, so nothing can be started or recorded.',
  'ops.restore_archive_unprobed':
    'An archive is configured but it could not be read, or did not answer with a backup list, so no backup is listed.',
  'ops.restore_storage_unconfigured':
    'svc-ops has no durable storage for restore runs on this deployment, so nothing can be read or saved.',
  'ops.restore_target_unset': 'The owner has not set a restore storage target. Starting and finalizing stay off until they do.',
  'ops.restore_watermarks_disagree':
    'The stamps and the live services do not agree, so nothing was restored. The table below names each service and why.',
  'ops.restore_step_out_of_order': 'That step is not the next one. Steps run in order: clean area, validate, preview, finalize.',
  'ops.restore_run_not_found': 'No restore run has this number.',
  'ops.restore_watermark_unavailable': 'A service did not give its position, so it counts as disagreeing.',
  'ops.restore_watermark_required': 'A stamp needs a service, a kind and the watermark that was read.',
  'ops.idempotency_conflict': 'This run or step was already recorded with different details. Reload to see what was stored.',
  'ops.approval_missing': 'Finalize needs an approval id and an operation id from the second founder.',
  'ops.approval_wrong': 'That approval is not for this restore run, or was proposed by someone else.',
  'ops.approval_not_founders': 'Finalize needs two distinct live founders. One person cannot approve their own restore.',
  'ops.approval_unwired': 'svc-ops cannot reach the approval service on this deployment, so finalize cannot be approved.',
};

export function refusalWords(code: string | null): string | null {
  return code !== null && Object.hasOwn(REFUSAL_WORDS, code) ? REFUSAL_WORDS[code]! : null;
}

/** The keys are business keys, so a repeated press or a retry after a lost reply returns the stored row. */
export const startKey = (restoreNo: string) => `restore:start:${restoreNo}`;
export const stepKey = (restoreNo: string, step: Exclude<RestoreStep, 'finalize'>) => `restore:step:${restoreNo}:${step}`;
export const finalizeKey = (restoreNo: string) => `restore:finalize:${restoreNo}`;

export const RESTORE_NO = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface RestoreRun {
  readonly restoreNo: string;
  readonly cutOff: string;
  readonly startedBy: string;
  readonly startedAt: string;
}
export interface RestoreStepRow {
  readonly restoreNo: string;
  readonly step: RestoreStep;
  readonly actor: string;
  readonly approverId: string | null;
  readonly at: string;
}
export interface ServiceVerdict {
  readonly service: string;
  readonly ok: boolean;
  readonly reason: string | null;
  readonly stamp: string | null;
  readonly position: string | null;
}
export interface LiveRead {
  readonly service: string;
  readonly ok: boolean;
  readonly code: string | null;
  readonly message: string | null;
}
export interface RunDetail {
  readonly run: RestoreRun;
  readonly steps: readonly RestoreStepRow[];
  readonly restored: boolean;
  readonly next: RestoreStep | null;
  readonly finalizeOffered: boolean;
  readonly live: {
    readonly joint: { readonly agree: boolean; readonly cutOff: string; readonly services: readonly ServiceVerdict[] };
    readonly reads: readonly LiveRead[];
  };
}
export interface StampRow {
  readonly service: string;
  readonly kind: string;
  readonly watermark: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly approverId: string;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null);
const str = (v: unknown): v is string => typeof v === 'string';

function parseRun(v: unknown): RestoreRun | null {
  const o = obj(v);
  return o && str(o.restoreNo) && str(o.cutOff) && str(o.startedBy) && str(o.startedAt)
    ? { restoreNo: o.restoreNo, cutOff: o.cutOff, startedBy: o.startedBy, startedAt: o.startedAt }
    : null;
}

export function parseRuns(raw: unknown): { asOf: string; runs: RestoreRun[] } | null {
  const o = obj(raw);
  if (!o || !str(o.asOf) || !Array.isArray(o.runs)) return null;
  const runs = o.runs.map(parseRun);
  return runs.every((r) => r !== null) ? { asOf: o.asOf, runs: runs as RestoreRun[] } : null;
}

export function parseBackups(raw: unknown): { asOf: string; reason: string; backups: unknown[] } | null {
  const o = obj(raw);
  return o && str(o.asOf) && str(o.reason) && Array.isArray(o.backups) ? { asOf: o.asOf, reason: o.reason, backups: o.backups } : null;
}

export function parseStamps(raw: unknown): { stamped: boolean; rows: StampRow[] } | null {
  const o = obj(raw);
  const w = o ? obj(o.watermarks) : null;
  if (!o) return null;
  if (o.watermarks === null) return { stamped: false, rows: [] };
  if (!w || !Array.isArray(w.rows)) return null;
  const rows: StampRow[] = [];
  for (const r of w.rows) {
    const x = obj(r);
    if (!x || !str(x.service) || !str(x.kind) || !str(x.watermark) || !str(x.recordedAt) || !str(x.recordedBy) || !str(x.approverId))
      return null;
    rows.push({
      service: x.service,
      kind: x.kind,
      watermark: x.watermark,
      recordedAt: x.recordedAt,
      recordedBy: x.recordedBy,
      approverId: x.approverId,
    });
  }
  return { stamped: rows.length > 0, rows };
}

export function parseRunDetail(raw: unknown): RunDetail | null {
  const o = obj(raw);
  const run = o ? parseRun(o.run) : null;
  const live = o ? obj(o.live) : null;
  const joint = live ? obj(live.joint) : null;
  if (!o || !run || !live || !joint || !Array.isArray(o.steps) || !Array.isArray(joint.services) || !Array.isArray(live.reads)) return null;
  if (typeof o.restored !== 'boolean' || typeof o.finalizeOffered !== 'boolean' || typeof joint.agree !== 'boolean' || !str(joint.cutOff))
    return null;
  const steps: RestoreStepRow[] = [];
  for (const s of o.steps) {
    const x = obj(s);
    if (!x || !str(x.restoreNo) || !str(x.actor) || !str(x.at) || !RESTORE_STEPS.includes(x.step as RestoreStep)) return null;
    steps.push({
      restoreNo: x.restoreNo,
      step: x.step as RestoreStep,
      actor: x.actor,
      approverId: str(x.approverId) ? x.approverId : null,
      at: x.at,
    });
  }
  const services: ServiceVerdict[] = [];
  for (const s of joint.services) {
    const x = obj(s);
    if (!x || !str(x.service) || typeof x.ok !== 'boolean') return null;
    services.push({
      service: x.service,
      ok: x.ok,
      reason: str(x.reason) ? x.reason : null,
      stamp: str(x.stamp) ? x.stamp : null,
      position: str(x.position) ? x.position : null,
    });
  }
  const reads: LiveRead[] = [];
  for (const s of live.reads) {
    const x = obj(s);
    if (!x || !str(x.service) || typeof x.ok !== 'boolean') return null;
    reads.push({ service: x.service, ok: x.ok, code: str(x.code) ? x.code : null, message: str(x.message) ? x.message : null });
  }
  const next = str(o.next) && RESTORE_STEPS.includes(o.next as RestoreStep) ? (o.next as RestoreStep) : null;
  return {
    run,
    steps,
    restored: o.restored,
    next,
    finalizeOffered: o.finalizeOffered,
    live: { joint: { agree: joint.agree, cutOff: joint.cutOff, services }, reads },
  };
}

/** The room's query: `?run=<restoreNo>` opens one run. */
export function parseRestoreQuery(q: Readonly<Record<string, string | string[] | undefined>>): { runNo: string | null } {
  const v = Array.isArray(q.run) ? q.run[0] : q.run;
  return { runNo: typeof v === 'string' && RESTORE_NO.test(v.trim()) ? v.trim() : null };
}

export const runHref = (restoreNo: string) => `/restore?run=${encodeURIComponent(restoreNo)}`;
