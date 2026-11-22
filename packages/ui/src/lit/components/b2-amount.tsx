/**
 * Volt's amount field for order tickets and converters: the older kit's AmountInput (the same props and the same
 * decimal-string behaviour, `amount-input-logic`), drawn with `lt-amount` in components.css. Never a number.
 */
import * as React from 'react';
import { Field } from '@base-ui/react/field';
import { clsx } from 'clsx';
import { parsePasted, parseTyped, stepDecimal, toDisplay, type DecimalSeparator } from '../../components/amount-input-logic.js';

export interface AmountInputProps {
  /** Canonical decimal string with "." and no group separators ("1234.5"); "" when empty. Never a number. */
  value: string;
  onValueChange: (value: string) => void;
  /** Max decimals of the asset or market. Typing more is refused; pasting more is cut off (down). */
  precision: number;
  /** Step size (the market's tick size) for the arrow keys and the steppers. Without it there are no steppers. */
  tick?: string;
  /** Lower and upper bound used by the steppers only (typing is never clamped). Default min "0". */
  min?: string;
  max?: string;
  /** `desk` = 40 px field for order forms. `hero` = 48 px centred text for the Simple buy card. */
  size?: 'desk' | 'hero';
  /** Visible label. Without it, pass `aria-label`. */
  label?: string;
  'aria-label'?: string;
  /** Unit suffix: "USDT", "BTC". */
  unit?: string;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  /** Error text, announced through aria-describedby. Setting it also marks the field invalid. */
  error?: string;
  description?: string;
  /** "Max" and "BBO" buttons appear when their handlers are given. */
  onMax?: () => void;
  onBbo?: () => void;
  maxLabel?: string;
  bboLabel?: string;
  /** Show the up/down steppers. Default: yes for `desk` when `tick` is given. */
  steppers?: boolean;
  stepLabels?: { up: string; down: string };
  /** The person's decimal mark while typing. Default ".". The value prop stays canonical. */
  decimalSeparator?: DecimalSeparator;
  id?: string;
  name?: string;
  autoFocus?: boolean;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  className?: string;
}

/**
 * Amount field for order forms, converters and buy cards (COMPONENT-PLAN 3.5).
 * A text input with inputMode="decimal" inside a Base UI Field; the value is
 * held as a decimal STRING and every operation (typing, paste, stepping) is
 * string or bigint work, never a float. Not Base UI NumberField: that holds a
 * JavaScript number.
 *
 * Behaviour: a second decimal mark is refused; decimals beyond `precision` are
 * refused; paste accepts group separators and currency text and normalises
 * (see parsePasted); ArrowUp/ArrowDown step by `tick` (Shift or PageUp/PageDown:
 * 10 ticks); an unfinished trailing "." is dropped on blur.
 */
export function AmountInput({
  value,
  onValueChange,
  precision,
  tick,
  min = '0',
  max,
  size = 'desk',
  label,
  unit,
  placeholder = '0',
  disabled,
  readOnly,
  error,
  description,
  onMax,
  onBbo,
  maxLabel = 'Max',
  bboLabel = 'BBO',
  steppers,
  stepLabels = { up: 'Increase', down: 'Decrease' },
  decimalSeparator = '.',
  id,
  name,
  autoFocus,
  onBlur,
  className,
  ...aria
}: AmountInputProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const pendingCaret = React.useRef<number | null>(null);
  const display = toDisplay(value, decimalSeparator);
  const hero = size === 'hero';
  const showSteppers = (steppers ?? (!hero && tick !== undefined)) && tick !== undefined && !readOnly;

  // Put the caret back where the person was typing after a refused or cleaned keystroke.
  React.useLayoutEffect(() => {
    if (pendingCaret.current !== null && inputRef.current) {
      const pos = Math.max(0, Math.min(pendingCaret.current, inputRef.current.value.length));
      inputRef.current.setSelectionRange(pos, pos);
      pendingCaret.current = null;
    }
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.currentTarget.value;
    const caret = e.currentTarget.selectionStart ?? raw.length;
    const next = parseTyped(raw, { precision, decimalSeparator });
    if (next === null) {
      // Refused keystroke: React restores the old text; keep the caret one step back.
      pendingCaret.current = Math.max(0, caret - 1);
      return;
    }
    const shown = toDisplay(next, decimalSeparator);
    pendingCaret.current = Math.max(0, caret - (raw.length - shown.length));
    if (next !== value) onValueChange(next);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (readOnly) return;
    e.preventDefault();
    const parsed = parsePasted(e.clipboardData.getData('text'), { precision, decimalSeparator });
    if (parsed !== null && parsed !== value) {
      pendingCaret.current = toDisplay(parsed, decimalSeparator).length;
      onValueChange(parsed);
    }
  };

  const step = (direction: 1 | -1, multiplier = 1) => {
    if (tick === undefined || disabled || readOnly) return;
    const next = stepDecimal(value, tick, direction, { precision, min, max, multiplier });
    if (next !== value) onValueChange(next);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (tick === undefined) return;
    const multiplier = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      step(1, multiplier);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      step(-1, multiplier);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      step(1, 10);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      step(-1, 10);
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (value.endsWith('.')) onValueChange(value.slice(0, -1));
    onBlur?.(e);
  };

  const widthCh = hero ? `${Math.max(display.length, placeholder.length, 1)}ch` : undefined;

  return (
    <Field.Root
      invalid={Boolean(error)}
      disabled={disabled}
      data-slot="amount-input"
      data-size={size}
      className={clsx('lt-amount', className)}
    >
      <div className="lt-amount-box" data-invalid={error ? '' : undefined}>
        {label ? (
          <Field.Label className="lt-amount-label" data-hidden={hero || undefined}>
            {label}
          </Field.Label>
        ) : null}
        <Field.Control
          ref={inputRef}
          id={id}
          name={name}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          enterKeyHint="done"
          aria-label={aria['aria-label']}
          placeholder={placeholder}
          readOnly={readOnly}
          value={display}
          onChange={handleChange}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          style={hero ? { width: widthCh } : undefined}
          className="lt-amount-input"
        />
        {unit ? <span className="lt-amount-unit">{unit}</span> : null}
        {showSteppers ? (
          <span className="lt-amount-steps">
            <button type="button" tabIndex={-1} aria-label={stepLabels.up} disabled={disabled} onClick={() => step(1)}>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
            <button type="button" tabIndex={-1} aria-label={stepLabels.down} disabled={disabled} onClick={() => step(-1)}>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        ) : null}
        {onBbo ? (
          <button type="button" onClick={onBbo} disabled={disabled} className="lt-amount-key">
            {bboLabel}
          </button>
        ) : null}
        {onMax ? (
          <button type="button" onClick={onMax} disabled={disabled} className="lt-amount-key">
            {maxLabel}
          </button>
        ) : null}
      </div>
      {description ? <Field.Description className="lt-note">{description}</Field.Description> : null}
      <Field.Error match={Boolean(error)} className="lt-note lt-note-bad">
        {error}
      </Field.Error>
    </Field.Root>
  );
}
