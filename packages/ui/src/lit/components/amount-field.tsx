/**
 * AmountField: the box someone types an amount of money into. A text input with `inputMode="decimal"` (never
 * `type="number"`, which holds a float), its unit beside the figure, what is available and a Max key under it, and a
 * refusal that marks it invalid and is announced. The value is a canonical decimal string ("1234.5", "" when empty):
 * typing, pasting and Max are string work, never a number. A second decimal mark and decimals past `precision` are
 * refused as they are typed; a pasted amount drops group separators and currency words and is cut (down) to `precision`;
 * an unfinished trailing mark is dropped on leaving. Words arrive as props.
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { parsePasted, parseTyped, toDisplay, type DecimalSeparator } from '../../components/amount-input-logic.js';

export type AmountFieldProps = {
  /** The field's name, shown above it (or only to a screen reader with `hideLabel`, as on a hero amount). */
  label: string;
  hideLabel?: boolean;
  /** Canonical decimal string with "." and no group separators; "" when empty. Never a number. */
  value: string;
  onChange: (value: string) => void;
  /** Most decimals the asset takes: typing more is refused, pasting more is cut down. */
  precision: number;
  /** The unit beside the figure: an asset code, or the asset's mark with its code. */
  unit?: React.ReactNode;
  /** `hero`: the one large amount a flow is about, centred. */
  size?: 'md' | 'hero';
  /** What can be spent, in words ("Available 9,218.50 USDT"), under the box. */
  available?: React.ReactNode;
  /** A key that fills in the whole available amount; the caller sets the value. */
  max?: { label: string; onSelect: () => void };
  hint?: React.ReactNode;
  /** Why the amount is refused: takes the hint's place, is announced, and marks the box invalid. */
  error?: React.ReactNode;
  /** The person's decimal mark while typing; the value stays canonical. Default ".". */
  decimalSeparator?: DecimalSeparator;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  id?: string;
  name?: string;
  autoFocus?: boolean;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  className?: string;
  'data-testid'?: string;
};

export function AmountField({
  label,
  hideLabel,
  value,
  onChange,
  precision,
  unit,
  size = 'md',
  available,
  max,
  hint,
  error,
  decimalSeparator = '.',
  placeholder = '0',
  disabled,
  readOnly,
  id,
  name,
  autoFocus,
  onBlur,
  className,
  'data-testid': testId,
}: AmountFieldProps) {
  const auto = React.useId();
  const inputId = id ?? auto;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const caret = React.useRef<number | null>(null);
  const display = toDisplay(value, decimalSeparator);
  const note = error || hint;
  const describedBy = [available ? `${inputId}-available` : null, note ? `${inputId}-note` : null].filter(Boolean).join(' ') || undefined;

  // Put the caret back where the person was typing after a refused or cleaned keystroke.
  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (caret.current === null || !input) return;
    const at = Math.max(0, Math.min(caret.current, input.value.length));
    input.setSelectionRange(at, at);
    caret.current = null;
  });

  return (
    <div
      className={clsx('lit-amount', className)}
      data-slot="amount-field"
      data-size={size}
      data-invalid={error ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      data-testid={testId}
    >
      <label htmlFor={inputId} className={hideLabel ? 'lit-sr' : undefined}>
        {label}
      </label>
      <div data-part="box">
        <input
          ref={inputRef}
          id={inputId}
          name={name}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          autoFocus={autoFocus}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          value={display}
          onChange={(e) => {
            const raw = e.currentTarget.value;
            const at = e.currentTarget.selectionStart ?? raw.length;
            const next = parseTyped(raw, { precision, decimalSeparator });
            if (next === null) {
              // A refused keystroke: React keeps the old text; the caret stays where it was.
              caret.current = Math.max(0, at - 1);
              return;
            }
            caret.current = Math.max(0, at - (raw.length - toDisplay(next, decimalSeparator).length));
            if (next !== value) onChange(next);
          }}
          onPaste={(e) => {
            if (readOnly) return;
            e.preventDefault();
            const pasted = parsePasted(e.clipboardData.getData('text'), { precision, decimalSeparator });
            if (pasted === null || pasted === value) return;
            caret.current = toDisplay(pasted, decimalSeparator).length;
            onChange(pasted);
          }}
          onBlur={(e) => {
            if (value.endsWith('.')) onChange(value.slice(0, -1));
            onBlur?.(e);
          }}
        />
        {unit ? <span data-part="unit">{unit}</span> : null}
      </div>
      {available || max ? (
        <div data-part="foot">
          {available ? (
            <span id={`${inputId}-available`} data-part="available">
              {available}
            </span>
          ) : null}
          {max ? (
            <button type="button" data-part="max" disabled={disabled || readOnly} onClick={max.onSelect}>
              {max.label}
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <small id={`${inputId}-note`} data-part="error" role="alert">
          {error}
        </small>
      ) : hint ? (
        <small id={`${inputId}-note`} data-part="hint">
          {hint}
        </small>
      ) : null}
    </div>
  );
}
