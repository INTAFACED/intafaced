/**
 * Pure logic for the decimal kind of Input: what a keystroke, a paste, a blur
 * or an arrow key does to the value. The value is ALWAYS a canonical decimal
 * string ("1234.5"); there is no float anywhere. This is a thin layer over
 * amount-input-logic.ts so Input and AmountInput agree on every rule.
 *
 * Rules (the same as AmountInput): a second decimal mark or more decimals than
 * `precision` is refused (value unchanged); letters are dropped; a minus sign is
 * dropped, because parseTyped has no negative amounts; paste is cleaned by
 * parsePasted and cut DOWN to `precision`.
 */
import { parsePasted, parseTyped, stepDecimal, toDisplay, type DecimalSeparator } from './amount-input-logic.js';

export interface DecimalOptions {
  /** Max decimals. Typing more is refused; pasting more is cut off (down). */
  precision: number;
  /** The person's decimal mark while typing. Default ".". The value stays canonical. */
  decimalSeparator?: DecimalSeparator;
}

/** What the box shows for a canonical value ("12.5" -> "12,5" with ","). */
export function displayDecimal(value: string, decimalSeparator: DecimalSeparator = '.'): string {
  return toDisplay(value, decimalSeparator);
}

/**
 * Called with the text in the box after a keystroke. Returns the new canonical
 * value, or `prevValue` when the keystroke is refused.
 */
export function nextDecimalValue(prevValue: string, raw: string, opts: DecimalOptions): string {
  const next = parseTyped(raw, opts);
  return next === null ? prevValue : next;
}

/** Called with pasted text. Returns the cleaned value, or `prevValue` when it cannot be read as an amount. */
export function pastedDecimalValue(prevValue: string, text: string, opts: DecimalOptions): string {
  const next = parsePasted(text, opts);
  return next === null ? prevValue : next;
}

/** On blur an unfinished trailing "." is dropped ("12." -> "12"). Everything else is kept as typed. */
export function blurDecimalValue(value: string): string {
  return value.endsWith('.') ? value.slice(0, -1) : value;
}

export interface KeyStep {
  direction: 1 | -1;
  /** How many ticks to move: 1 for the arrow keys, 10 with Shift or PageUp/PageDown. */
  ticks: number;
}

/** Maps a keyboard key to a step, or null when the key does not step. */
export function keyToStep(key: string, shift = false): KeyStep | null {
  switch (key) {
    case 'ArrowUp':
      return { direction: 1, ticks: shift ? 10 : 1 };
    case 'ArrowDown':
      return { direction: -1, ticks: shift ? 10 : 1 };
    case 'PageUp':
      return { direction: 1, ticks: 10 };
    case 'PageDown':
      return { direction: -1, ticks: 10 };
    default:
      return null;
  }
}

export interface StepKeyOptions {
  precision: number;
  /** Lower bound for stepping. Default "0". */
  min?: string;
  max?: string;
}

/** The value after pressing `key`, or null when the key does not step. Bigint arithmetic via stepDecimal. */
export function stepValueForKey(value: string, tick: string, key: string, shift: boolean, opts: StepKeyOptions): string | null {
  const step = keyToStep(key, shift);
  if (step === null) return null;
  return stepDecimal(value, tick, step.direction, { ...opts, multiplier: step.ticks });
}
