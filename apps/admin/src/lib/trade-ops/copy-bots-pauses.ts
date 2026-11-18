/**
 * The copy and bots kill switch's data, as svc-trade sends it (`copy.ops.pauses.*`,
 * services/svc-trade/src/copy/platform-pauses.ts). Plain data and parsers, safe in server and browser code: a body of
 * any other shape is refused, never guessed at.
 */

export type PauseScopeKind = 'lead' | 'bot_type' | 'symbol';
export type PauseOp = 'pause' | 'resume';

/** The bot types a founder may pause, as svc-trade names them (`PAUSABLE_BOT_TYPES`), with the words the desk shows. */
export const BOT_TYPES = [
  { value: 'grid', label: 'Grid' },
  { value: 'twap', label: 'TWAP' },
  { value: 'vwap', label: 'VWAP' },
  { value: 'pov', label: 'POV' },
  { value: 'chase', label: 'Chase' },
] as const;

export const SCOPE_KIND_TEXT: Record<PauseScopeKind, string> = { lead: 'Lead', bot_type: 'Bot type', symbol: 'Symbol' };
export const OP_TEXT: Record<PauseOp, string> = { pause: 'Pause', resume: 'Resume' };

export interface PauseScope {
  readonly kind: PauseScopeKind;
  readonly value: string;
}

export interface PauseRequest {
  readonly id: string;
  readonly op: PauseOp;
  readonly scope: PauseScope;
  readonly status: 'awaiting_second' | 'applied';
  readonly approvalId: string;
  readonly proposedBy: string;
  readonly approverId: string | null;
  readonly confirmedBy: string | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
}

export interface ActivePause {
  readonly id: string;
  readonly scope: PauseScope;
  readonly pausedBy: string;
  readonly pauseApprover: string;
  readonly pausedAt: string;
}

export interface PauseDeskRead {
  readonly paused: readonly ActivePause[];
  readonly waiting: readonly PauseRequest[];
}

const KINDS: readonly string[] = ['lead', 'bot_type', 'symbol'];
const rec = (raw: unknown): Record<string, unknown> | null => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function parseScope(raw: unknown): PauseScope | null {
  const r = rec(raw);
  return r && str(r.kind) && KINDS.includes(r.kind) && str(r.value) ? { kind: r.kind as PauseScopeKind, value: r.value } : null;
}

export function parsePauseRequest(raw: unknown): PauseRequest | null {
  const r = rec(raw);
  if (!r) return null;
  const scope = parseScope(r.scope);
  if (
    !scope ||
    !str(r.id) ||
    (r.op !== 'pause' && r.op !== 'resume') ||
    (r.status !== 'awaiting_second' && r.status !== 'applied') ||
    !str(r.approvalId) ||
    !str(r.proposedBy) ||
    !strOrNull(r.approverId) ||
    !strOrNull(r.confirmedBy) ||
    !str(r.requestedAt) ||
    !strOrNull(r.decidedAt)
  )
    return null;
  return {
    id: r.id,
    op: r.op,
    scope,
    status: r.status,
    approvalId: r.approvalId,
    proposedBy: r.proposedBy,
    approverId: r.approverId,
    confirmedBy: r.confirmedBy,
    requestedAt: r.requestedAt,
    decidedAt: r.decidedAt,
  };
}

function parseActivePause(raw: unknown): ActivePause | null {
  const r = rec(raw);
  if (!r) return null;
  const scope = parseScope(r.scope);
  if (!scope || !str(r.id) || !str(r.pausedBy) || !str(r.pauseApprover) || !str(r.pausedAt)) return null;
  return { id: r.id, scope, pausedBy: r.pausedBy, pauseApprover: r.pauseApprover, pausedAt: r.pausedAt };
}

export function parsePauseDesk(raw: unknown): PauseDeskRead | null {
  const r = rec(raw);
  if (!r || !Array.isArray(r.paused) || !Array.isArray(r.waiting)) return null;
  const paused = r.paused.map(parseActivePause);
  const waiting = r.waiting.map(parsePauseRequest);
  if (paused.some((p) => p === null) || waiting.some((w) => w === null)) return null;
  return { paused: paused as ActivePause[], waiting: waiting as PauseRequest[] };
}

/** A scope as a founder typed it, checked the way svc-trade checks it (`canonicalScope`), or the words that say why not. */
export function checkScope(kind: unknown, value: unknown): { ok: true; scope: PauseScope } | { ok: false; message: string } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (kind === 'lead') {
    return /^[A-Za-z0-9_-]{1,80}$/.test(raw)
      ? { ok: true, scope: { kind, value: raw } }
      : { ok: false, message: 'Type the lead’s listing reference.' };
  }
  if (kind === 'bot_type') {
    const v = raw.toLowerCase();
    return BOT_TYPES.some((b) => b.value === v) ? { ok: true, scope: { kind, value: v } } : { ok: false, message: 'Choose a bot type.' };
  }
  if (kind === 'symbol') {
    const v = raw.toUpperCase();
    return /^[A-Z0-9]{1,20}\/[A-Z0-9]{1,20}$/.test(v)
      ? { ok: true, scope: { kind, value: v } }
      : { ok: false, message: 'Type a symbol such as ETH/USDT.' };
  }
  return { ok: false, message: 'Choose a lead, a bot type or a symbol.' };
}

/** The scope in words: "Lead 3fa2…", "Bot type Grid", "Symbol ETH/USDT". */
export function scopeText(scope: PauseScope): string {
  const value = scope.kind === 'bot_type' ? (BOT_TYPES.find((b) => b.value === scope.value)?.label ?? scope.value) : scope.value;
  return `${SCOPE_KIND_TEXT[scope.kind]} ${value}`;
}
