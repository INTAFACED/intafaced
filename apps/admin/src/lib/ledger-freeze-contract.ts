/** The singleton posting record is a standing read, never an operation receipt. */
export interface FreezeState {
  readonly frozen: boolean;
  readonly reason: string | null;
  readonly actor: string | null;
  /** Last record change, not read time, operation version or original outcome. */
  readonly changedAt: string;
}
export type FreezeReadKind = 'reachable' | 'loading' | 'unconfigured' | 'absent' | 'refused' | 'unreachable' | 'invalid_response';
export interface FreezeResult {
  readonly ok: boolean;
  readonly status: number;
  readonly kind: FreezeReadKind;
  readonly state: FreezeState | null;
  readonly detail: string | null;
  readonly code?: string;
  readonly upstreamStatus?: number;
}
export interface FreezeIntent {
  readonly frozen: boolean;
  readonly reason?: string;
}
export interface FreezeCommandResult {
  readonly ok: false;
  readonly status: number;
  readonly state: null;
  readonly detail: string;
  readonly code: string;
  readonly uncertain: boolean;
  /** Original input only. No original actor/operation binding is published. */
  readonly intent: FreezeIntent;
  readonly returnedState?: FreezeState;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
/** Validate local calendar/time before Date.parse can normalize an impossible day. */
function instant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const p = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!p) return false;
  const year = Number(p[1]),
    month = Number(p[2]),
    day = Number(p[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (days[month - 1] ?? 0) &&
    Number(p[4]) <= 23 &&
    Number(p[5]) <= 59 &&
    Number(p[6]) <= 59 &&
    (p[7] === undefined || (Number(p[7]) <= 23 && Number(p[8]) <= 59)) &&
    Number.isFinite(Date.parse(value))
  );
}
export function decodeFreezeState(value: unknown): FreezeState | null {
  if (
    !record(value) ||
    typeof value.frozen !== 'boolean' ||
    !(value.reason === null || typeof value.reason === 'string') ||
    !(value.actor === null || typeof value.actor === 'string') ||
    !instant(value.changedAt)
  )
    return null;
  // actor/reason are opaque published fields, not a human authority or financial schema.
  return { frozen: value.frozen, reason: value.reason, actor: value.actor, changedAt: value.changedAt };
}
function detail(body: unknown, fallback: string): string {
  if (!record(body)) return fallback;
  for (const key of ['detail', 'error', 'message']) if (typeof body[key] === 'string') return body[key];
  return fallback;
}
function code(body: unknown, fallback: string): string {
  return record(body) && typeof body.code === 'string' ? body.code : fallback;
}
export function freezeUnavailable(
  kind: Exclude<FreezeReadKind, 'reachable'>,
  message: string,
  errorCode: string,
  status = 503,
): FreezeResult {
  return { ok: false, status, kind, state: null, detail: message, code: errorCode };
}
export function decodeFreezeRead(body: unknown, status: number, envelope: boolean): FreezeResult {
  if (status < 200 || status >= 300) {
    const errorCode = code(body, 'admin.ledger_read_refused');
    const kind =
      errorCode === 'admin.ledger_invalid_response'
        ? 'invalid_response'
        : errorCode === 'admin.ledger_unconfigured' || errorCode === 'admin.bff_gate_unconfigured'
          ? 'unconfigured'
          : status === 404
            ? 'absent'
            : status === 401 || status === 403
              ? 'refused'
              : 'unreachable';
    return freezeUnavailable(kind, detail(body, `Ledger read unavailable (HTTP ${status}).`), errorCode, status);
  }
  const state = decodeFreezeState(envelope && record(body) ? body.state : body);
  if (
    !state ||
    (envelope && (!record(body) || body.ok !== true || body.kind !== 'reachable' || body.status !== status || body.detail !== null))
  ) {
    return {
      ...freezeUnavailable(
        'invalid_response',
        'The ledger did not return a complete posting record.',
        'admin.ledger_invalid_response',
        502,
      ),
      upstreamStatus: status,
    };
  }
  return { ok: true, status, kind: 'reachable', state, detail: null };
}
export function freezeUnresolved(
  intent: FreezeIntent,
  message: string,
  status = 502,
  errorCode = 'admin.ledger_outcome_unresolved',
): FreezeCommandResult {
  return { ok: false, status, state: null, detail: message, code: errorCode, uncertain: true, intent };
}
/** Exact pre-effect boundaries in the mounted BFF/Edge/Ledger path. No status-wide inference. */
const PRE_EFFECT_STATUS: Readonly<Record<string, number>> = {
  'admin.ledger_unconfigured': 503,
  'admin.bff_gate_unconfigured': 503,
  'admin.bff_gate': 401,
  'admin.bff_gate_origin': 403,
  'admin.ledger_invalid_request': 400,
  'edge.ledger_unreachable': 503,
  'action_approval.missing': 400,
  'action_approval.identity_unwired': 400,
};
export function decodeFreezeCommand(body: unknown, status: number, intent: FreezeIntent, envelope: boolean): FreezeCommandResult {
  const errorCode = code(body, 'admin.ledger_outcome_unresolved');
  if (
    (status < 200 || status >= 300) &&
    PRE_EFFECT_STATUS[errorCode] === status &&
    record(body) &&
    (body.ok === undefined || body.ok === false) &&
    body.uncertain !== true &&
    (body.state === undefined || body.state === null) &&
    body.returnedState === undefined
  ) {
    return {
      ok: false,
      status,
      state: null,
      detail: detail(body, 'The ledger command was refused before dispatch.'),
      code: errorCode,
      uncertain: false,
      intent,
    };
  }
  // Approval consumption, storage writes or event publication may precede a 4xx/5xx.
  // Even a valid standing record lacks an original operation and human binding.
  const result = freezeUnresolved(
    intent,
    detail(body, 'The original ledger command outcome is unresolved. A standing record is not a receipt.'),
    status,
    errorCode,
  );
  const returnedState = status >= 200 && status < 300 ? decodeFreezeState(envelope && record(body) ? body.returnedState : body) : null;
  return returnedState ? { ...result, returnedState } : result;
}
