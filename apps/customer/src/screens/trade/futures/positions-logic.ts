/**
 * Pure logic for the Positions blotter and its dialogs (TRFUT-SPEC §2.4, §2.5): row view-model, which actions are
 * allowed and why not, the nonce rule for a re-sent request, and the Close-all result reducer. No React, no clock.
 * Money stays a string; the only maths is the exact-decimal helpers already in `model.ts` and `data/decimal.ts`.
 */
import type { Position } from '@intafaced/exchange-contract/schemas';
import { compare, dec, signOf, str, ZERO } from '../../../data/decimal';
import { fmtAmount, MINUS, PLUS } from '../../../data/format';
import { healthOf, isLive, liquidationDistancePct, stateOf, type Health, type PositionState } from './model';
import type { BlockReason } from '../buy/write-lock';
import type { WriteOutcome } from './write';

export type ActionKey = 'add' | 'reduce' | 'leverage' | 'protect' | 'stop' | 'close';
export type GateReason = 'planeOff' | 'noId' | 'notLive' | 'writerLocked' | 'liquidating' | 'stale';

export interface RowModel {
  id: string;
  symbol: string;
  side: Position['side'];
  state: PositionState;
  closingReason: string | null;
  contracts: string;
  entry: string;
  mark: string | null;
  pnl: string | null;
  /** Percent points as published by the service ("-0.59"); null when unknown. */
  pnlPct: string | null;
  margin: string | null;
  health: Health;
  liquidationPrice: string | null;
  distancePct: string | null;
  leverage: string | null;
}

/** Everything the table draws for one position, with unknowns kept as null (never 0). */
export function rowOf(position: Position): RowModel {
  return {
    id: position.id ?? `${position.symbol}:${position.timestamp}:${position.side}`,
    symbol: position.symbol,
    side: position.side,
    state: stateOf(position),
    closingReason: position.closingReason ?? null,
    contracts: position.contracts,
    entry: position.entryPrice,
    mark: position.markPrice,
    pnl: position.unrealizedPnl,
    pnlPct: position.percentage,
    margin: position.collateral,
    health: healthOf(position),
    liquidationPrice: position.liquidationPrice,
    distancePct: liquidationDistancePct(position),
    leverage: position.leverage,
  };
}

/** "+1.20" / "−0.40" / "0": a signed asset amount for PnL, null stays null. */
export function signedAmount(value: string | null, places: number): string | null {
  const sign = signOf(value);
  if (sign === null) return null;
  const text = fmtAmount(value, { places });
  return sign === 1 && !text.startsWith(PLUS) && !text.startsWith(MINUS) ? `${PLUS}${text}` : text;
}

/** The settle currency a position's margin is held in: "BTC/USDT:USDT" and "BTC/USDT" both give "USDT". */
export function settleOf(symbol: string): string | null {
  const [pair, settle] = symbol.split(':');
  const quote = pair?.split('/')[1];
  return settle || quote || null;
}

/** Free balance of the position's settle currency; null when it is not known (never 0). */
export function freeFor(symbol: string, balances: Readonly<Record<string, { free: string }>> | null): string | null {
  const settle = settleOf(symbol);
  return settle && balances ? (balances[settle]?.free ?? null) : null;
}

/** CSS width ("37%") of the margin-ratio bar: the whole percent, capped at 100 (100 = liquidatable). Unknown draws no bar. */
export function barWidth(health: Health): string | null {
  const pct = dec(health.marginRatioPct);
  if (pct === null) return null;
  const whole = pct / 10n ** 18n;
  return `${whole >= 100n ? 100n : whole < 0n ? 0n : whole}%`;
}

export interface GateInput {
  position: Position;
  planeOff: boolean;
  /** A write is in flight or an unresolved request exists on this device. */
  writerLocked: boolean;
  /** The service has refused something with "a liquidation step is live" for this position. */
  liquidating: boolean;
  /** The positions read is older than the freshness limit. */
  stale: boolean;
}

/** For each action: null when allowed, else the single reason it is off. Order of reasons is the order of truth. */
export function gateActions(input: GateInput): Record<ActionKey, GateReason | null> {
  const { position, planeOff, writerLocked, liquidating, stale } = input;
  const closing = stateOf(position) === 'closing';
  const base: GateReason | null = planeOff
    ? 'planeOff'
    : position.id === null
      ? 'noId'
      : !isLive(position)
        ? 'notLive'
        : writerLocked
          ? 'writerLocked'
          : null;
  // A live liquidation step blocks everything except adding margin; a stale mark blocks what is priced off the mark.
  const needsMark: GateReason | null = base ?? (liquidating ? 'liquidating' : !closing && stale ? 'stale' : null);
  return {
    add: base,
    reduce: needsMark,
    leverage: needsMark,
    // A take-profit or stop-loss is checked against the mark, so it needs a fresh one too.
    protect: needsMark,
    // A stop is judged on a live price too; one armed on an old read could fire at once.
    stop: needsMark,
    // Retry close on a closing position is the same key; staleness does not make it unsafe.
    close: base ?? (liquidating ? 'liquidating' : stale && !closing ? 'stale' : null),
  };
}

/** Keep the nonce while the intent is unchanged (a re-send uses the same id); a changed intent gets a fresh one. */
export function pickNonce(prev: { key: string; nonce: string } | null, key: string, fresh: () => string): { key: string; nonce: string } {
  return prev && prev.key === key ? prev : { key, nonce: fresh() };
}

/** A close is a reduce-only order for this size: above zero and at most what the position holds. `null` means fine. */
export type CloseSizeProblem = 'empty' | 'notPositive' | 'overPosition';

export function closeSizeProblem(value: string, contracts: string): CloseSizeProblem | null {
  if (value.trim() === '') return 'empty';
  const v = dec(value);
  if (v === null || v <= 0n) return 'notPositive';
  const held = dec(contracts);
  if (held !== null && v > held) return 'overPosition';
  return null;
}

/** `pct` percent of the position's size, exact, cut (never rounded up) at 18 places. */
export function closeShare(contracts: string, pct: number): string | null {
  const held = dec(contracts);
  if (held === null || held <= 0n || !Number.isInteger(pct) || pct <= 0 || pct > 100) return null;
  return str((held * BigInt(pct)) / 100n);
}

/** Amount checks for a margin or leverage field. `null` means fine. Money maths is exact decimals. */
export type AmountProblem = 'empty' | 'notPositive' | 'overFree' | 'overCap';

export function amountProblem(value: string, opts: { free?: string | null; cap?: string | null }): AmountProblem | null {
  const v = dec(value);
  if (v === null) return 'empty';
  if (compare(v, ZERO) <= 0) return 'notPositive';
  const free = dec(opts.free);
  if (free !== null && compare(v, free) > 0) return 'overFree';
  const cap = dec(opts.cap);
  if (cap !== null && compare(v, cap) > 0) return 'overCap';
  return null;
}

// ── Close all ────────────────────────────────────────────────────────────────

export type CloseResult =
  | { kind: 'waiting' }
  | { kind: 'sending' }
  | { kind: 'done' }
  | { kind: 'refused'; title: string; body: string; code: string | null }
  /** The answer is unknown. The saved request is checked, never rebuilt. */
  | { kind: 'uncertain' }
  | { kind: 'blocked'; reason: BlockReason }
  /** Not sent because an earlier close was unresolved. */
  | { kind: 'skipped' };

export interface CloseAllState {
  order: string[];
  results: Record<string, CloseResult>;
}

export type CloseAllEvent =
  | { type: 'sending'; id: string }
  | { type: 'result'; id: string; result: CloseResult }
  /** The run stopped at an unresolved close: every id still waiting is marked skipped. */
  | { type: 'stop' };

export function startCloseAll(ids: readonly string[]): CloseAllState {
  return { order: [...ids], results: Object.fromEntries(ids.map((id) => [id, { kind: 'waiting' } as CloseResult])) };
}

export function closeAllReduce(state: CloseAllState, event: CloseAllEvent): CloseAllState {
  switch (event.type) {
    case 'sending':
      return { ...state, results: { ...state.results, [event.id]: { kind: 'sending' } } };
    case 'result':
      return { ...state, results: { ...state.results, [event.id]: event.result } };
    case 'stop': {
      const results = { ...state.results };
      for (const id of state.order) if (results[id]?.kind === 'waiting') results[id] = { kind: 'skipped' };
      return { ...state, results };
    }
  }
}

/** Map a writer outcome to a list row. */
export function resultOf(outcome: WriteOutcome): CloseResult {
  switch (outcome.kind) {
    case 'done':
      return { kind: 'done' };
    case 'refused':
      return { kind: 'refused', title: outcome.refusal.title, body: outcome.refusal.body, code: outcome.refusal.code };
    case 'uncertain':
      return { kind: 'uncertain' };
    case 'blocked':
      return { kind: 'blocked', reason: outcome.reason };
  }
}

/** Any close whose answer is not known: Close all stays off until it is looked up. */
export function hasUnresolved(state: CloseAllState): boolean {
  return state.order.some((id) => state.results[id]?.kind === 'uncertain' || state.results[id]?.kind === 'sending');
}

/** Ids still to send, in order: never sent, or held back by a stop or a block. */
export function remainingIds(state: CloseAllState): string[] {
  return state.order.filter((id) => {
    const kind = state.results[id]?.kind;
    return kind === 'waiting' || kind === 'skipped' || kind === 'blocked';
  });
}

/** True when this outcome ends the run: only an unknown answer or a blocked send does. A refusal does not. */
export function stopsRun(result: CloseResult): boolean {
  return result.kind === 'uncertain' || result.kind === 'blocked';
}

export function tally(state: CloseAllState): { done: number; refused: number; unknown: number; total: number } {
  let done = 0;
  let refused = 0;
  let unknown = 0;
  for (const id of state.order) {
    const kind = state.results[id]?.kind;
    if (kind === 'done') done += 1;
    else if (kind === 'refused') refused += 1;
    else if (kind === 'uncertain') unknown += 1;
  }
  return { done, refused, unknown, total: state.order.length };
}
