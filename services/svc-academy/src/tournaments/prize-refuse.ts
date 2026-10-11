/**
 * Tournament Stage-3 — IFC prize pools refuse-closed (TRK-academy.tournaments).
 *
 * Class N honesty gate. Ledger fund/payout recipes are Class M and do not exist
 * on this path. Academy never invents prize balances, pool amounts, or IFC
 * credits. Every prize-shaped intent refuses closed until a Class M PR lands.
 *
 * D26-P1-C3: blank / unset prize pools cannot start — typed
 * `academy.prize_pool_unset`. A present amount still refuses invent IFC
 * (`academy.prize_refuse_closed`) until owner Class M recipes exist.
 */

import { TournamentError } from './ladder.js';

export const PRIZE_REFUSE_CODE = 'academy.prize_refuse_closed' as const;
/** Blank / missing owner pool amount — cannot start a prize season. */
export const PRIZE_POOL_UNSET_CODE = 'academy.prize_pool_unset' as const;

export type PrizeIntentKind = 'fund_pool' | 'payout' | 'escrow' | 'clawback' | 'invent_balance';

export type PrizeRefuseCode = typeof PRIZE_REFUSE_CODE | typeof PRIZE_POOL_UNSET_CODE;

export type PrizeRefuse = {
  readonly status: 'refuse';
  readonly code: typeof PRIZE_REFUSE_CODE;
  readonly kind: PrizeIntentKind;
  readonly message: string;
  /** Always false — academy holds no prize book. */
  readonly academyHoldsPrizeBalance: false;
  /** Always false — no ledger recipe on this Stage. */
  readonly ledgerRecipeReady: false;
};

export type PrizeDecision = PrizeRefuse;

/**
 * Start-gate decision (D26-P1-C3). Never invents IFC; never returns ok.
 * `unset` vs `class_m` are distinct so operators can grep the residual.
 */
export type PrizeStartDecision = {
  readonly status: 'refuse';
  readonly code: PrizeRefuseCode;
  readonly reason: 'unset' | 'class_m';
  readonly message: string;
  readonly academyHoldsPrizeBalance: false;
  readonly ledgerRecipeReady: false;
  /** Always false — start never invents an IFC credit. */
  readonly inventedIfc: false;
};

const MESSAGE = 'IFC prize pools are refuse-closed — no invent pools, no academy balances, Class M ledger recipes only';

const UNSET_MESSAGE = 'IFC prize pool is unset — blank pool cannot start; refuse-closed (no invent IFC amounts)';

/** Stable residual for unset start gate (ops / audit grep). */
export const PRIZE_POOL_UNSET_RESIDUAL =
  'TRK-academy.tournaments D26-P1-C3 — prize pool unset; blank cannot start; refuse-closed (no invent IFC)';

/** Stable residual when amount present but Class M recipes missing. */
export const PRIZE_POOL_CLASS_M_RESIDUAL =
  'TRK-academy.tournaments Class M — prize fund/payout recipes unset; refuse-closed (no invent IFC)';

/**
 * Named refuse — operators / audits can grep the code. No amount fields:
 * inventing a decimal here would be a dual-book seed.
 */
export class PrizePoolRefuseError extends Error {
  constructor(
    message: string,
    readonly code: PrizeRefuseCode,
    readonly residual: string,
    readonly reason: 'unset' | 'class_m',
  ) {
    super(message);
    this.name = 'PrizePoolRefuseError';
  }
}

/**
 * Decide any prize-shaped intent. Always refuse — never invent a pool or payout.
 */
export function decidePrizeIntent(kind: PrizeIntentKind): PrizeDecision {
  return {
    status: 'refuse',
    code: PRIZE_REFUSE_CODE,
    kind,
    message: MESSAGE,
    academyHoldsPrizeBalance: false,
    ledgerRecipeReady: false,
  };
}

/** Fund a prize pool — refuse-closed. */
export function refuseFundPrizePool(): PrizeDecision {
  return decidePrizeIntent('fund_pool');
}

/** Pay winners from a pool — refuse-closed. */
export function refusePrizePayout(): PrizeDecision {
  return decidePrizeIntent('payout');
}

/** Escrow IFC for a season — refuse-closed. */
export function refusePrizeEscrow(): PrizeDecision {
  return decidePrizeIntent('escrow');
}

/** Clawback after re-rank — refuse-closed (no prior pay to invent). */
export function refusePrizeClawback(): PrizeDecision {
  return decidePrizeIntent('clawback');
}

/** Invent an IFC / prize balance row in academy — refuse-closed. */
export function refuseInventPrizeBalance(): PrizeDecision {
  return decidePrizeIntent('invent_balance');
}

function isBlankAmount(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return true;
}

/**
 * True when owner prize-pool config is blank / missing.
 * Fail-closed on unknown shapes — never treat garbage as a configured pool.
 */
export function isPrizePoolUnset(pool: unknown): boolean {
  if (pool == null) return true;
  if (typeof pool === 'string') return pool.trim() === '';
  if (typeof pool === 'number' || typeof pool === 'boolean' || typeof pool === 'bigint') {
    // Non-string scalars are not owner decimal-string law — treat as unset.
    return true;
  }
  if (typeof pool === 'object') {
    const o = pool as Record<string, unknown>;
    const keys = ['amount', 'ifcAmount', 'prizePool', 'prizeAmount'] as const;
    const present = keys.filter((k) => k in o);
    if (present.length === 0) return true;
    return present.every((k) => isBlankAmount(o[k]));
  }
  return true;
}

/**
 * D26-P1-C3 start gate: blank pool → `academy.prize_pool_unset`;
 * amount present without Class M recipes → `academy.prize_refuse_closed`
 * (still no invent IFC). Never returns ok.
 */
export function decidePrizePoolStart(pool: unknown): PrizeStartDecision {
  if (isPrizePoolUnset(pool)) {
    return {
      status: 'refuse',
      code: PRIZE_POOL_UNSET_CODE,
      reason: 'unset',
      message: UNSET_MESSAGE,
      academyHoldsPrizeBalance: false,
      ledgerRecipeReady: false,
      inventedIfc: false,
    };
  }
  return {
    status: 'refuse',
    code: PRIZE_REFUSE_CODE,
    reason: 'class_m',
    message: MESSAGE,
    academyHoldsPrizeBalance: false,
    ledgerRecipeReady: false,
    inventedIfc: false,
  };
}

/**
 * Blank prize pool cannot start — typed unset refuse.
 * Throws always for prize-bearing start (unset or Class M).
 */
export function assertMayStartPrizeSeason(pool: unknown): never {
  const d = decidePrizePoolStart(pool);
  throw new PrizePoolRefuseError(
    d.message,
    d.code,
    d.reason === 'unset' ? PRIZE_POOL_UNSET_RESIDUAL : PRIZE_POOL_CLASS_M_RESIDUAL,
    d.reason,
  );
}

/** Throw-shaped unset refuse (explicit blank). */
export function refuseUnsetPrizePoolStart(): never {
  assertMayStartPrizeSeason(null);
}

/** Result-shaped start refuse (callers that catch rather than throw). */
export function tryRefusePrizePoolStart(pool: unknown): PrizeStartDecision {
  return decidePrizePoolStart(pool);
}

/** True when residual names unset + no invent. */
export function prizePoolUnsetResidualIsHonest(residual: string): boolean {
  return residual.includes('unset') && residual.includes('refuse-closed') && residual.includes('no invent IFC');
}

/**
 * Prize-shaped keys on a freeze / end payload. `amount` and `ifcAmount` match
 * the amount keys `isPrizePoolUnset` already treats as a pool. Decimal strings
 * stay on the caller; this list never parses or stores them.
 */
const PRIZE_ATTACHMENT_KEYS = [
  'prize',
  'prizePool',
  'prizeAmount',
  'ifcPrize',
  'payout',
  'escrowAmount',
  'poolBalance',
  'amount',
  'ifcAmount',
] as const;

function rejectPrizeAttachmentKeys(record: Record<string, unknown>): void {
  for (const key of PRIZE_ATTACHMENT_KEYS) {
    if (key in record && record[key] != null) {
      throw new TournamentError(MESSAGE, 'academy.season_invalid');
    }
  }
}

/**
 * Hard assert for lifecycle edges (freeze / end). Throws if a caller tries to
 * attach prize amounts — never silently drop money fields.
 * Start-with-blank is `assertMayStartPrizeSeason` / `decidePrizePoolStart`
 * (typed `academy.prize_pool_unset`) — do not collapse those into season_invalid.
 * Nested `standings` rows are the same gate: a prize on a rank row is an attachment.
 */
export function assertNoPrizeAttachment(payload: unknown): void {
  if (payload == null || typeof payload !== 'object') return;
  const o = payload as Record<string, unknown>;
  rejectPrizeAttachmentKeys(o);
  if (!Array.isArray(o.standings)) return;
  for (const row of o.standings) {
    if (row == null || typeof row !== 'object') continue;
    rejectPrizeAttachmentKeys(row as Record<string, unknown>);
  }
}

/** True when a decision is the closed refuse (always, for this Stage). */
export function isPrizeRefuseClosed(decision: PrizeDecision): boolean {
  return decision.status === 'refuse' && decision.code === PRIZE_REFUSE_CODE && decision.ledgerRecipeReady === false;
}

/** True when start decision is typed unset refuse. */
export function isPrizePoolUnsetRefuse(decision: PrizeStartDecision): boolean {
  return decision.status === 'refuse' && decision.code === PRIZE_POOL_UNSET_CODE && decision.reason === 'unset';
}

/** Operator-facing one-liner (plane dark + unset start sealed). */
export function prizeRefuseStatusLine(): string {
  return `prizes=refuse_closed code=${PRIZE_REFUSE_CODE} unset=${PRIZE_POOL_UNSET_CODE} ledger=0 inventIfc=0`;
}

/** Export line for ops boards: reason,code (no invent amounts). */
export function prizePoolStartRefuseExportLine(decision: PrizeStartDecision): string {
  return `${decision.reason},${decision.code}`;
}

export function prizePoolStartRefuseExportHeader(): string {
  return 'reason,code';
}
