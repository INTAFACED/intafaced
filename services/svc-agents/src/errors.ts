import type { CopyKey } from './copy.js';

/**
 * Errors carry two things: a machine code the platform branches on, and a copy
 * key the surface renders.
 *
 * The `message` is for operators — it goes to logs and spans. It is never what
 * a user reads, which is why `userMessageKey` is mandatory rather than
 * optional: an error without one has no defined user-facing form, and a code
 * path that has to invent one at the surface is exactly how a vendor's error
 * text ends up on a screen (Doctrine §0.7).
 */
export type AgentErrorCode =
  | 'agents.route_not_found'
  | 'agents.capability_unavailable'
  | 'agents.provider_unavailable'
  | 'agents.provider_failed'
  | 'agents.session_not_found'
  | 'agents.session_closed'
  | 'agents.agent_not_found'
  | 'agents.window_sealed'
  | 'agents.window_not_found'
  | 'agents.invalid_usage'
  | 'agents.request_id_replay'
  | 'agents.refused'
  | 'agents.log_mine_limit_unset'
  | 'agents.session_log_limit_unset'
  | 'agents.kb_search_limit_unset'
  | 'agents.tickers_limit_unset'
  | 'agents.navigator_markets_limit_unset'
  | 'agents.ops_sessions_limit_unset'
  | 'agents.session_mine_limit_unset'
  | 'agents.cursor_invalid'
  | 'agents.fee_asset_unset'
  | 'agents.spend_limit_unset'
  | 'agents.spend_limit_invalid'
  | 'agents.spend_limit'
  | 'agents.spend_idempotency_conflict'
  | 'agents.spend_reservation_conflict'
  | 'agents.spend_reservation_not_found'
  | 'agents.spend_reservation_closed'
  | 'agents.spend_hold_max_age_unset'
  | 'agents.funds_insufficient'
  /** A run of the person's own agent would pass one of the caps they set for it (per call, session or month). */
  | 'agents.spend.cap_exceeded'
  /** The person's own agent has no caps stored: nothing of it runs until they are set. */
  | 'agents.spend.cap_unset';

export class AgentError extends Error {
  constructor(
    message: string,
    readonly code: AgentErrorCode,
    readonly userMessageKey: CopyKey,
    readonly userMessageParams: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

/**
 * Thrown by an adapter when the upstream engine did not answer.
 *
 * Distinct from `AgentError` because the caller must be able to tell "the
 * engine failed" from "the platform refused": the first is retryable and bills
 * nothing, the second is a decision and is recorded as one.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    /** True when a retry could plausibly succeed (timeout, 429, 5xx). */
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** L3 — full agent error code catalog. */
export const AGENT_ERROR_CODES: readonly AgentErrorCode[] = [
  'agents.route_not_found',
  'agents.capability_unavailable',
  'agents.provider_unavailable',
  'agents.provider_failed',
  'agents.session_not_found',
  'agents.session_closed',
  'agents.agent_not_found',
  'agents.window_sealed',
  'agents.window_not_found',
  'agents.invalid_usage',
  'agents.request_id_replay',
  'agents.refused',
  'agents.log_mine_limit_unset',
  'agents.session_log_limit_unset',
  'agents.kb_search_limit_unset',
  'agents.tickers_limit_unset',
  'agents.navigator_markets_limit_unset',
] as const;

/** Owner-published page size. Blank / non-finite / <1 refuses. Never invent 100. */
export function assertUserLogPageLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new AgentError(
      'User log page limit is unset — pass limit (never invent 100)',
      'agents.log_mine_limit_unset',
      'agents.refused.log_mine_limit_unset',
    );
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new AgentError(
      'User log page limit is unset — pass limit (never invent 100)',
      'agents.log_mine_limit_unset',
      'agents.refused.log_mine_limit_unset',
    );
  }
  return Math.min(500, n);
}

/**
 * Session action log page size (sequence ASC). Distinct from user-wide log.mine
 * (occurred_at DESC). Blank / non-finite / <1 refuses. Never invent 100.
 */
export function assertSessionLogPageLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new AgentError(
      'Session log page limit is unset — pass limit (never invent 100)',
      'agents.session_log_limit_unset',
      'agents.refused.log_mine_limit_unset',
    );
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new AgentError(
      'Session log page limit is unset — pass limit (never invent 100)',
      'agents.session_log_limit_unset',
      'agents.refused.log_mine_limit_unset',
    );
  }
  return Math.min(500, n);
}

/** Operator session list page size. Blank / non-finite / <1 refuses. Never invent 100. */
export function assertOpsSessionsLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new AgentError(
      'ops sessions page limit is unset — pass limit (never invent 100)',
      'agents.ops_sessions_limit_unset',
      'agents.refused.log_mine_limit_unset',
    );
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new AgentError(
      'ops sessions page limit is unset — pass limit (never invent 100)',
      'agents.ops_sessions_limit_unset',
      'agents.refused.log_mine_limit_unset',
    );
  }
  return Math.min(500, n);
}

/** Caller session list page size. Blank / non-finite / <1 refuses. Never invent 100. */
export function assertSessionMineLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new AgentError(
      'session.mine page limit is unset — pass limit (never invent 100)',
      'agents.session_mine_limit_unset',
      'agents.refused.log_mine_limit_unset',
    );
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new AgentError(
      'session.mine page limit is unset — pass limit (never invent 100)',
      'agents.session_mine_limit_unset',
      'agents.refused.log_mine_limit_unset',
    );
  }
  return Math.min(500, n);
}

/**
 * KB search page size (cap 500, same window as log.mine). Blank / non-finite /
 * <1 refuses. Never invent 100.
 */
export function assertKbSearchPageLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new AgentError(
      'KB search page limit is unset — pass limit (never invent 100)',
      'agents.kb_search_limit_unset',
      'agents.refused.kb_search_limit_unset',
    );
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new AgentError(
      'KB search page limit is unset — pass limit (never invent 100)',
      'agents.kb_search_limit_unset',
      'agents.refused.kb_search_limit_unset',
    );
  }
  return Math.min(500, n);
}

/**
 * Trade tickers page size (cap 500). Blank / non-finite / <1 refuses. Never
 * invent 500 as a silent default — owner may pass 500 explicitly.
 */
export function assertTickersPageLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new AgentError(
      'Tickers page limit is unset — pass limit (never invent 500)',
      'agents.tickers_limit_unset',
      'agents.scanner.tickers_limit_unset',
    );
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new AgentError(
      'Tickers page limit is unset — pass limit (never invent 500)',
      'agents.tickers_limit_unset',
      'agents.scanner.tickers_limit_unset',
    );
  }
  return Math.min(500, n);
}

/**
 * Trade markets list page size (cap 500). Blank / non-finite / <1 refuses.
 * Never invent 50 as a silent default — owner may pass 50 explicitly.
 */
export function assertNavigatorMarketsPageLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new AgentError(
      'Navigator markets page limit is unset — pass limit (never invent 50)',
      'agents.navigator_markets_limit_unset',
      'agents.navigator.markets_limit_unset',
    );
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new AgentError(
      'Navigator markets page limit is unset — pass limit (never invent 50)',
      'agents.navigator_markets_limit_unset',
      'agents.navigator.markets_limit_unset',
    );
  }
  return Math.min(500, n);
}

/** L3 — catalog size. */
export function agentErrorCodeCount(): number {
  return AGENT_ERROR_CODES.length;
}

/** L3 — true when code is published. */
export function isAgentErrorCode(value: string): value is AgentErrorCode {
  return (AGENT_ERROR_CODES as readonly string[]).includes(value);
}

/** L3 — provider-class codes (engine path). */
export function agentProviderErrorCodes(): readonly AgentErrorCode[] {
  return AGENT_ERROR_CODES.filter((c) => c.includes('provider') || c.includes('capability') || c.includes('route'));
}

/** L3 — board card. */
export function agentErrorCatalogBoardCard(): {
  readonly total: number;
  readonly providerClass: number;
  readonly sessionClass: number;
} {
  return {
    total: agentErrorCodeCount(),
    providerClass: agentProviderErrorCodes().length,
    sessionClass: AGENT_ERROR_CODES.filter((c) => c.includes('session') || c.includes('window')).length,
  };
}

/** L3 — status line. */
export function agentErrorCatalogStatusLine(): string {
  const c = agentErrorCatalogBoardCard();
  return `total=${c.total} providerClass=${c.providerClass} sessionClass=${c.sessionClass}`;
}

/** L3 — parse status. Invalid → null. */
export function parseAgentErrorCatalogStatusLine(
  line: string,
): { readonly total: number; readonly providerClass: number; readonly sessionClass: number } | null {
  const m = line.trim().match(/^total=(\d+) providerClass=(\d+) sessionClass=(\d+)$/);
  if (!m) return null;
  return { total: Number(m[1]), providerClass: Number(m[2]), sessionClass: Number(m[3]) };
}

/** L3 — true when status matches. */
export function agentErrorCatalogStatusLineMatches(): boolean {
  const p = parseAgentErrorCatalogStatusLine(agentErrorCatalogStatusLine());
  if (!p) return false;
  const c = agentErrorCatalogBoardCard();
  return p.total === c.total && p.providerClass === c.providerClass && p.sessionClass === c.sessionClass;
}

/** L3 — export header. */
export function agentErrorCatalogExportHeader(): string {
  return 'code';
}

/** L3 — export lines. */
export function agentErrorCatalogExportLines(): readonly string[] {
  return AGENT_ERROR_CODES.slice();
}

/** L3 — full export. */
export function agentErrorCatalogExportText(): string {
  return [agentErrorCatalogExportHeader(), ...agentErrorCatalogExportLines()].join('\n');
}

/** L3 — true when total is within [min,max]. Invalid → false. */
export function agentErrorCodeCountInRange(min: number, max: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return false;
  const n = agentErrorCodeCount();
  return n >= min && n <= max;
}

/** L3 — provider error board (retryable honesty). */
export function providerErrorBoardCard(err: ProviderError): {
  readonly providerId: string;
  readonly retryable: boolean;
  readonly hasStatus: boolean;
  readonly status: number | null;
} {
  return {
    providerId: err.providerId,
    retryable: err.retryable,
    hasStatus: err.status !== undefined,
    status: err.status ?? null,
  };
}

/** L3 — provider error status line. */
export function providerErrorStatusLine(err: ProviderError): string {
  const c = providerErrorBoardCard(err);
  return `provider=${c.providerId} retryable=${c.retryable ? '1' : '0'} status=${c.status ?? '-'}`;
}
