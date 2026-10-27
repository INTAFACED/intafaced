'use client';

import * as React from 'react';
import { Field } from '@base-ui/react/field';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn, focusRing } from './cn.js';
import { parsePasted, parseTyped, stepDecimal, toDisplay, type DecimalSeparator } from './amount-input-logic.js';

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

const smallButton =
  'inline-flex h-6 shrink-0 select-none items-center justify-center rounded-pill bg-raised px-2.5 text-xs font-medium text-fg-2 transition-colors duration-(--if-t-fast) ease-if hover:text-fg disabled:opacity-40';

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
      className={cn('flex min-w-0 flex-col gap-1', className)}
    >
      <div
        className={cn(
          'flex items-center gap-2',
          hero
            ? 'min-h-14 justify-center'
            : 'h-10 rounded-sm bg-field px-3 transition-colors duration-(--if-t-fast) ease-if hover:bg-raised',
          'has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus',
          error && 'outline-1 -outline-offset-1 outline-down-text',
          disabled && 'opacity-40',
        )}
      >
        {label ? <Field.Label className={cn('shrink-0 text-sm text-fg-2', hero && 'sr-only')}>{label}</Field.Label> : null}
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
          className={cn(
            'if-num min-w-0 bg-transparent tabular-nums text-fg outline-none placeholder:text-fg-3',
            hero ? 'max-w-full text-center text-hero' : 'flex-1 text-right text-md',
          )}
        />
        {unit ? <span className={cn('shrink-0 text-fg-2', hero ? 'text-md' : 'text-base font-medium')}>{unit}</span> : null}
        {showSteppers ? (
          <span className="flex shrink-0 flex-col">
            <button
              type="button"
              tabIndex={-1}
              aria-label={stepLabels.up}
              disabled={disabled}
              onClick={() => step(1)}
              className={cn('flex h-4 w-5 items-center justify-center rounded-xs text-fg-2 hover:text-fg', focusRing)}
            >
              <ChevronUp size={12} strokeWidth={2} aria-hidden="true" />
            </button>
            <button
              type="button"
              tabIndex={-1}
              aria-label={stepLabels.down}
              disabled={disabled}
              onClick={() => step(-1)}
              className={cn('flex h-4 w-5 items-center justify-center rounded-xs text-fg-2 hover:text-fg', focusRing)}
            >
              <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          </span>
        ) : null}
        {onBbo ? (
          <button type="button" onClick={onBbo} disabled={disabled} className={cn(smallButton, focusRing)}>
            {bboLabel}
          </button>
        ) : null}
        {onMax ? (
          <button type="button" onClick={onMax} disabled={disabled} className={cn(smallButton, focusRing)}>
            {maxLabel}
          </button>
        ) : null}
      </div>
      {description ? <Field.Description className="text-xs text-fg-2">{description}</Field.Description> : null}
      <Field.Error match={Boolean(error)} className="text-xs text-down-text">
        {error}
      </Field.Error>
    </Field.Root>
  );
}
