import { isModuleId, type ModuleId } from '@intafaced/config';

export type ControlPlaneStatus = 'reachable' | 'unconfigured' | 'unreachable' | 'refused' | 'invalid_response' | 'loading';
export interface AuditEntry {
  readonly at: string;
  readonly module: ModuleId;
  readonly actor: string;
  readonly confirmOperatorId?: string | null;
  readonly reason: string;
  readonly previous: boolean;
  readonly next: boolean;
  readonly changed: boolean;
}
export interface KillSwitchSnapshot {
  readonly disabledModules: readonly ModuleId[];
  readonly reasons: Readonly<Record<string, string>>;
  readonly audit: readonly AuditEntry[];
}
export interface ControlPlaneState {
  readonly status: ControlPlaneStatus;
  /** Unavailable states carry a compatibility placeholder, never an observed zero. */
  readonly snapshot: KillSwitchSnapshot;
  readonly detail: string | null;
  readonly code?: string;
  readonly httpStatus?: number;
}
export interface ToggleInput {
  readonly module: ModuleId;
  readonly disabled: boolean;
  readonly reason: string;
}
export interface ToggleResult {
  readonly ok: boolean;
  readonly status: number;
  readonly snapshot: KillSwitchSnapshot;
  readonly detail: string | null;
  readonly code?: string;
  readonly uncertain?: boolean;
  /** Original caller intent only, not authoritative operation or human identity. */
  readonly intent?: ToggleInput;
}
export const EMPTY_SNAPSHOT: KillSwitchSnapshot = { disabledModules: [], reasons: {}, audit: [] };
export const MODULE_WRITE_UNAVAILABLE =
  'Module writes require a real operator session and an identity-issued approval with original operation context. Those prerequisites are unavailable in this desk. Read access does not grant write access.';
export function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function instant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return false;
  // Date.parse normalizes some impossible dates (February 30 becomes March 2).
  // Check local calendar/time fields before accepting its timezone conversion.
  const year = Number(parts[1]),
    month = Number(parts[2]),
    day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (days[month - 1] ?? 0) &&
    Number(parts[4]) <= 23 &&
    Number(parts[5]) <= 59 &&
    Number(parts[6]) <= 59 &&
    (parts[7] === undefined || (Number(parts[7]) <= 23 && Number(parts[8]) <= 59)) &&
    Number.isFinite(Date.parse(value))
  );
}
export function decodeSnapshot(value: unknown): KillSwitchSnapshot | null {
  if (!record(value) || !Array.isArray(value.disabledModules) || !record(value.reasons) || !Array.isArray(value.audit)) return null;
  if (
    !value.disabledModules.every((m): m is ModuleId => typeof m === 'string' && isModuleId(m)) ||
    new Set(value.disabledModules).size !== value.disabledModules.length
  )
    return null;
  if (!Object.entries(value.reasons).every(([m, reason]) => isModuleId(m) && typeof reason === 'string')) return null;
  if (
    !value.audit.every(
      (entry) =>
        record(entry) &&
        instant(entry.at) &&
        typeof entry.module === 'string' &&
        isModuleId(entry.module) &&
        typeof entry.actor === 'string' &&
        entry.actor.trim().length > 0 &&
        typeof entry.reason === 'string' &&
        (entry.confirmOperatorId === undefined ||
          entry.confirmOperatorId === null ||
          (typeof entry.confirmOperatorId === 'string' && entry.confirmOperatorId.trim().length > 0)) &&
        typeof entry.previous === 'boolean' &&
        typeof entry.next === 'boolean' &&
        typeof entry.changed === 'boolean' &&
        entry.changed === (entry.previous !== entry.next),
    )
  )
    return null;
  return { disabledModules: value.disabledModules, reasons: value.reasons as Record<string, string>, audit: value.audit as AuditEntry[] };
}
export function unavailable(
  status: Exclude<ControlPlaneStatus, 'reachable'>,
  detail: string,
  code: string,
  httpStatus?: number,
): ControlPlaneState {
  return { status, snapshot: EMPTY_SNAPSHOT, detail, code, ...(httpStatus === undefined ? {} : { httpStatus }) };
}
export function refusalDetail(body: unknown, fallback: string): string {
  if (!record(body)) return fallback;
  return typeof body.detail === 'string' ? body.detail : typeof body.error === 'string' ? body.error : fallback;
}
export function refusalCode(body: unknown, fallback: string): string {
  return record(body) && typeof body.code === 'string' ? body.code : fallback;
}
export function decodeRead(body: unknown, httpStatus: number, envelope: boolean): ControlPlaneState {
  if (httpStatus < 200 || httpStatus >= 300) {
    const code = refusalCode(body, 'admin.kill_read_refused');
    const configured =
      code === 'admin.bff_gate_unconfigured' || code === 'admin.kill_unconfigured' || (record(body) && body.status === 'unconfigured');
    const invalid = code === 'admin.kill_invalid_response';
    return unavailable(
      configured ? 'unconfigured' : invalid ? 'invalid_response' : httpStatus === 401 || httpStatus === 403 ? 'refused' : 'unreachable',
      refusalDetail(body, `Module read refused (HTTP ${httpStatus}).`),
      code,
      httpStatus,
    );
  }
  const snapshot = decodeSnapshot(envelope && record(body) ? body.snapshot : body);
  if (
    !snapshot ||
    (envelope && (!record(body) || body.status !== 'reachable' || (body.detail !== null && typeof body.detail !== 'string')))
  )
    return unavailable(
      'invalid_response',
      'Current module state was not returned in a usable shape.',
      'admin.kill_invalid_response',
      httpStatus,
    );
  return {
    status: 'reachable',
    snapshot,
    detail: envelope && record(body) && typeof body.detail === 'string' ? body.detail : null,
    httpStatus,
  };
}
export function unresolved(intent: ToggleInput, detail: string, status = 502, code = 'admin.kill_outcome_unresolved'): ToggleResult {
  return { ok: false, status, snapshot: EMPTY_SNAPSHOT, detail, code, uncertain: true, intent };
}
export function decodeToggle(body: unknown, status: number, intent: ToggleInput, envelope: boolean): ToggleResult {
  if (status === 503 && record(body) && (body.code === 'admin.kill_unconfigured' || body.code === 'admin.bff_gate_unconfigured'))
    return {
      ok: false,
      status,
      snapshot: EMPTY_SNAPSHOT,
      detail: refusalDetail(body, 'Module command was not dispatched because the console is unconfigured.'),
      code: body.code,
      uncertain: false,
      intent,
    };
  if (status >= 500)
    return unresolved(
      intent,
      refusalDetail(body, `Command outcome unresolved (HTTP ${status}).`),
      status,
      refusalCode(body, 'admin.kill_outcome_unresolved'),
    );
  if (status < 200 || status >= 300)
    return {
      ok: false,
      status,
      snapshot: EMPTY_SNAPSHOT,
      detail: refusalDetail(body, `Module command refused (HTTP ${status}).`),
      code: refusalCode(body, 'admin.kill_command_refused'),
      uncertain: false,
      intent,
    };
  const snapshot = decodeSnapshot(envelope && record(body) ? body.snapshot : body);
  if (
    !snapshot ||
    (envelope &&
      (!record(body) ||
        body.ok !== true ||
        typeof body.status !== 'number' ||
        !Number.isInteger(body.status) ||
        body.status < 200 ||
        body.status >= 300 ||
        (body.detail !== null && typeof body.detail !== 'string') ||
        (body.uncertain !== undefined && body.uncertain !== false) ||
        (body.code !== undefined && typeof body.code !== 'string'))) ||
    snapshot.disabledModules.includes(intent.module) !== intent.disabled
  )
    return unresolved(
      intent,
      'The returned response does not establish the original module command outcome.',
      502,
      'admin.kill_invalid_command_response',
    );
  // Validated transport data is a returned snapshot, not an original-operation receipt.
  return {
    ok: true,
    status,
    snapshot,
    detail: 'Returned snapshot; original operation lookup and current human identity are unavailable.',
    uncertain: false,
    intent,
  };
}
