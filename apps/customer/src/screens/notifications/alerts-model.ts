/**
 * Price alerts, as pure rules: what a typed price may be, how a refusal is worded, how a lost answer is settled.
 * No React, no network. Prices are decimal strings and are only ever compared as text.
 */
import type { ApiResult } from '../../shared/api';
import { canonicalPrice, isIntent, type AlertEvaluation, type AlertIntent, type PriceAlert } from './notify-api';

export const PRICE_MAX = 64;

/** A positive decimal as the service accepts it: digits, one optional fraction, at least one non-zero digit. No signs, exponents or separators. */
export function validPrice(raw: string): boolean {
  const text = raw.trim();
  return text.length > 0 && text.length <= PRICE_MAX && /^\d+(\.\d+)?$/.test(text) && /[1-9]/.test(text);
}

export type PriceProblem = 'empty' | 'invalid';
export const priceProblem = (raw: string): PriceProblem | null => (raw.trim() === '' ? 'empty' : validPrice(raw) ? null : 'invalid');

/** The optional expiry as a date-time field gives it (local time, no zone). Blank is fine; a value that is not a real moment is not. */
export function expiryProblem(raw: string): 'invalid' | null {
  return raw.trim() === '' || Number.isFinite(new Date(raw).getTime()) ? null : 'invalid';
}
/** The exact instant the person's local date-time means, as the service wants it. `undefined` when none was given. */
export const expiryIso = (raw: string): string | undefined =>
  raw.trim() === '' || expiryProblem(raw) ? undefined : new Date(raw).toISOString();

/** Why no alert can trigger right now, as a copy key. `null` when one can. */
export type EvaluationNote = 'evalReady' | 'evalDark' | 'evalNoDelivery';
export function evaluationNote(evaluation: AlertEvaluation): EvaluationNote {
  if (evaluation.canFire) return 'evalReady';
  return evaluation.code === 'channel.not_configured' || evaluation.code === 'channel.disabled' ? 'evalNoDelivery' : 'evalDark';
}

/** An active alert already waiting on the same market, side and price. Shown as a heads-up on review, never a block. */
export const findDuplicate = (rows: readonly PriceAlert[], intent: AlertIntent): PriceAlert | null =>
  rows.find((row) => row.status === 'active' && isIntent(row, intent)) ?? null;

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────────────────────

export type Refusal =
  | 'signedOut'
  | 'notAllowed'
  | 'notOn'
  | 'priceMissing'
  | 'badRequest'
  | 'textRejected'
  | 'expiryRejected'
  | 'optionNotOn'
  | 'tooMany'
  | 'accountChanged'
  | 'unpublished'
  | 'other';

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * What a failed create or cancel means. `unknown` is a request that may have been carried out (the connection dropped, the
 * service errored, or its answer was not the one asked for): it is never shown as failed or as done. Everything else is a
 * refusal the service gave before doing anything, so nothing changed.
 */
export type Settled = { kind: 'unknown' } | { kind: 'refused'; refusal: Refusal };

export function settleFailure(failure: Failure): Settled {
  if (failure.reason === 'uncertain') return { kind: 'unknown' };
  if (failure.reason === 'unauthorized') return { kind: 'refused', refusal: 'signedOut' };
  if (failure.reason === 'forbidden') return { kind: 'refused', refusal: 'notAllowed' };
  if (failure.reason === 'not_mounted' || failure.reason === 'not_supported') return { kind: 'refused', refusal: 'notOn' };
  if (failure.reason === 'aborted') return { kind: 'refused', refusal: 'accountChanged' };
  const said = `${failure.code ?? ''} ${failure.message}`;
  if (failure.status === 429) return { kind: 'refused', refusal: 'tooMany' };
  if (/alert\.price_unavailable/.test(said)) return { kind: 'refused', refusal: 'notOn' };
  if (/notify\.price_unset/.test(said)) return { kind: 'refused', refusal: 'priceMissing' };
  if (/notify\.alert_(text_limit|expiry_max)_unset/.test(said)) return { kind: 'refused', refusal: 'optionNotOn' };
  if (/alert\.(text_too_long|message_placeholder_unknown)/.test(said)) return { kind: 'refused', refusal: 'textRejected' };
  if (/alert\.expiry_(in_past|too_far)/.test(said)) return { kind: 'refused', refusal: 'expiryRejected' };
  if (/alert\.(kind_unpublished|portfolio_view_unpublished)/.test(said)) return { kind: 'refused', refusal: 'unpublished' };
  if (failure.status === 400 || /BAD_REQUEST/.test(said)) return { kind: 'refused', refusal: 'badRequest' };
  if (failure.reason === 'unreachable' || failure.reason === 'invalid_response') return { kind: 'unknown' };
  return { kind: 'refused', refusal: 'other' };
}

// ── A lost answer to "save this alert" ──────────────────────────────────────────────────────────────────────────

/**
 * After a create whose answer was lost, the list is read again. A new active alert that matches what was asked (one that
 * was not in the list before the attempt) shows it was saved. If none appears the page still does not claim it was not
 * saved: the person decides whether to save again.
 */
export function settleUnknownCreate(before: ReadonlySet<string>, intent: AlertIntent, rows: readonly PriceAlert[]): PriceAlert | null {
  return rows.find((row) => !before.has(row.id) && row.status === 'active' && isIntent(row, intent)) ?? null;
}

// ── Cancel answers ──────────────────────────────────────────────────────────────────────────────────────────────

export type CancelWords = 'cancelled' | 'alreadyFired' | 'alreadyCancelled' | 'notFound';
export function cancelWords(data: { cancelled: boolean; alert: Pick<PriceAlert, 'status'> | null }): CancelWords {
  if (data.cancelled) return 'cancelled';
  if (data.alert === null) return 'notFound';
  return data.alert.status === 'fired' ? 'alreadyFired' : 'alreadyCancelled';
}

/** The price as typed, without changing a digit; only the spelling of leading and trailing zeros is ignored when comparing. */
export const samePrice = (a: string, b: string): boolean => canonicalPrice(a) === canonicalPrice(b);

// ── One change at a time ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lets one change through at a time. A second click that lands before the screen has redrawn is turned away here, not by a
 * disabled button, so a double click can never send two saves.
 */
export function createGate() {
  let open = false;
  return {
    enter(): boolean {
      if (open) return false;
      open = true;
      return true;
    },
    leave(): void {
      open = false;
    },
    get busy(): boolean {
      return open;
    },
  };
}
