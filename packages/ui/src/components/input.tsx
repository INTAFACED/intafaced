'use client';

/**
 * Input: a single-line text field for forms. Two kinds. `text` is a normal
 * string input. `decimal` is for money and quantities: the value is a decimal
 * STRING ("0.1", never a number), typing a character that would make it
 * invalid is refused, paste is cleaned and cut down to `precision`, and the
 * arrow keys step by `tick` in exact bigint arithmetic. See input-logic.ts.
 * Inside a Field it takes the label, hint, error, density, required and
 * disabled from it (Base UI wires the label and aria-describedby).
 */
import * as React from 'react';
import { CircleAlert } from 'lucide-react';
import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from './cn.js';
import { controlHeight, controlPadX, controlText, DEFAULT_DENSITY, type Density } from './density.js';
import { useFieldContext } from './field.js';
import type { DecimalSeparator } from './amount-input-logic.js';
import { blurDecimalValue, displayDecimal, nextDecimalValue, pastedDecimalValue, stepValueForKey } from './input-logic.js';

type NativeInputProps = Omit<
  React.ComponentProps<'input'>,
  'value' | 'defaultValue' | 'onChange' | 'type' | 'inputMode' | 'size' | 'prefix' | 'children' | 'color'
>;

interface InputCommonProps extends NativeInputProps {
  density?: Density;
  /** Icon or short text before the value. */
  leading?: React.ReactNode;
  /** Unit text ("USDT") or an icon after the value. */
  trailing?: React.ReactNode;
  /** Sets aria-busy and shows a static spinner. The field stays editable. */
  loading?: boolean;
  /** Draws the error border and sets aria-invalid. A Field with `error` does this for you. */
  invalid?: boolean;
  /** Where the text sits. Default `start`; the decimal kind defaults to `end`. */
  align?: 'start' | 'end';
  /** Class for the outer box (the visible field). */
  className?: string;
  /** Class for the inner <input>. */
  inputClassName?: string;
}

export interface TextInputProps extends InputCommonProps {
  kind?: 'text';
  /** Controlled value. Leave out for an uncontrolled input (use `defaultValue`). */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export interface DecimalInputProps extends InputCommonProps {
  kind: 'decimal';
  /** Canonical decimal string with "." and no group separators ("1234.5"); "" when empty. Never a number. */
  value: string;
  onValueChange: (value: string) => void;
  /** Max decimals. Typing more is refused; pasting more is cut off (down). */
  precision: number;
  /** The person's decimal mark while typing. Default ".". The value prop stays canonical. */
  decimalSeparator?: DecimalSeparator;
  /** Step size for ArrowUp/ArrowDown (Shift or PageUp/PageDown: 10 steps). Without it the arrow keys do nothing. */
  tick?: string;
  /** Lower and upper bound for stepping only (typing is never clamped). Default min "0". */
  min?: string;
  max?: string;
}

export type InputProps = TextInputProps | DecimalInputProps;

/** Small ring spinner, static under reduced motion. */
function Spinner() {
  return (
    <span
      data-slot="input-spinner"
      aria-hidden="true"
      className="size-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent text-fg-2 opacity-70 motion-safe:animate-spin"
    />
  );
}

/**
 * `kind="text"` (default) or `kind="decimal"` (money-safe, see the file comment).
 * The visible box is `data-slot="input"` and carries `data-density`, `data-kind`,
 * `data-invalid`, `data-disabled`, `data-readonly` and `data-loading`.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
  const field = useFieldContext();
  const {
    density: densityProp,
    leading,
    trailing,
    loading = false,
    invalid: invalidProp,
    align,
    className,
    inputClassName,
    disabled: disabledProp,
    readOnly,
    required: requiredProp,
    onBlur,
    onKeyDown,
    onPaste,
    'aria-describedby': describedByProp,
  } = props;
  const isDecimal = props.kind === 'decimal';

  const density = densityProp ?? field?.density ?? DEFAULT_DENSITY;
  const invalid = invalidProp ?? field?.invalid ?? false;
  const disabled = disabledProp ?? field?.disabled ?? false;
  const required = requiredProp ?? field?.required ?? false;
  const describedBy = [describedByProp, field?.describedBy].filter(Boolean).join(' ') || undefined;
  const alignEnd = (align ?? (isDecimal ? 'end' : 'start')) === 'end';

  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const pendingCaret = React.useRef<number | null>(null);
  React.useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

  // Put the caret back where the person was typing after a refused or cleaned keystroke.
  React.useLayoutEffect(() => {
    if (pendingCaret.current !== null && inputRef.current) {
      const pos = Math.max(0, Math.min(pendingCaret.current, inputRef.current.value.length));
      inputRef.current.setSelectionRange(pos, pos);
      pendingCaret.current = null;
    }
  });

  // Props that differ by kind. Pulled out so the DOM props below stay free of our own names.
  let kindProps: React.ComponentProps<'input'> & { onValueChange?: undefined };
  if (props.kind === 'decimal') {
    const {
      value,
      onValueChange,
      precision,
      decimalSeparator = '.',
      tick,
      min,
      max,
      kind: _k,
      density: _d,
      leading: _l,
      trailing: _t,
      loading: _lo,
      invalid: _i,
      align: _a,
      className: _c,
      inputClassName: _ic,
      disabled: _di,
      readOnly: _ro,
      required: _re,
      onBlur: _ob,
      onKeyDown: _ok,
      onPaste: _op,
      'aria-describedby': _ad,
      ...domRest
    } = props;
    const opts = { precision, decimalSeparator };

    kindProps = {
      ...domRest,
      type: 'text',
      inputMode: 'decimal',
      autoComplete: 'off',
      autoCorrect: 'off',
      spellCheck: false,
      value: displayDecimal(value, decimalSeparator),
      onChange: (e) => {
        const raw = e.currentTarget.value;
        const caret = e.currentTarget.selectionStart ?? raw.length;
        const next = nextDecimalValue(value, raw, opts);
        const shown = displayDecimal(next, decimalSeparator);
        // A refused or cleaned keystroke makes the text shorter than typed: keep the caret where it was.
        pendingCaret.current = Math.max(0, caret - (raw.length - shown.length));
        if (next !== value) onValueChange(next);
      },
      onPaste: (e) => {
        onPaste?.(e);
        if (e.defaultPrevented || readOnly || disabled) return;
        e.preventDefault();
        const next = pastedDecimalValue(value, e.clipboardData.getData('text'), opts);
        pendingCaret.current = displayDecimal(next, decimalSeparator).length;
        if (next !== value) onValueChange(next);
      },
      onKeyDown: (e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || tick === undefined || disabled || readOnly) return;
        const next = stepValueForKey(value, tick, e.key, e.shiftKey, { precision, min, max });
        if (next === null) return;
        e.preventDefault();
        if (next !== value) onValueChange(next);
      },
      onBlur: (e) => {
        const cleaned = blurDecimalValue(value);
        if (cleaned !== value) onValueChange(cleaned);
        onBlur?.(e);
      },
    };
  } else {
    const {
      value,
      defaultValue,
      onValueChange,
      kind: _k,
      density: _d,
      leading: _l,
      trailing: _t,
      loading: _lo,
      invalid: _i,
      align: _a,
      className: _c,
      inputClassName: _ic,
      disabled: _di,
      readOnly: _ro,
      required: _re,
      onBlur: _ob,
      onKeyDown: _ok,
      onPaste: _op,
      'aria-describedby': _ad,
      ...domRest
    } = props;
    kindProps = {
      ...domRest,
      type: 'text',
      ...(value !== undefined ? { value } : { defaultValue }),
      onChange: (e) => onValueChange?.(e.currentTarget.value),
      onPaste,
      onKeyDown,
      onBlur,
    };
  }

  return (
    <div
      data-slot="input"
      data-kind={isDecimal ? 'decimal' : 'text'}
      data-density={density}
      data-invalid={invalid ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      data-readonly={readOnly ? '' : undefined}
      data-loading={loading ? '' : undefined}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-sm border bg-field text-fg',
        'transition-colors duration-(--if-t-fast) ease-if',
        controlHeight[density],
        controlText[density],
        controlPadX[density],
        invalid ? 'border-error' : 'border-transparent',
        !disabled && !readOnly && 'hover:bg-raised',
        readOnly && !disabled && 'bg-panel',
        'has-[input:focus-visible]:outline-solid has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus',
        disabled && 'cursor-not-allowed opacity-40',
        className,
      )}
    >
      {leading ? (
        <span data-slot="input-leading" className="flex shrink-0 items-center text-fg-2 [&_svg]:shrink-0">
          {leading}
        </span>
      ) : null}
      <InputPrimitive
        {...kindProps}
        ref={inputRef}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        aria-busy={loading ? true : undefined}
        data-slot="input-control"
        className={cn(
          'min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-3 disabled:cursor-not-allowed',
          alignEnd ? 'text-end' : 'text-start',
          isDecimal && 'tabular-nums',
          inputClassName,
        )}
      />
      {loading ? <Spinner /> : null}
      {/* Colour is never the only cue: an invalid box always carries an icon (the Field adds the words). */}
      {invalid ? (
        <CircleAlert data-slot="input-invalid-icon" size={16} strokeWidth={2} aria-hidden="true" className="shrink-0 text-error-text" />
      ) : null}
      {trailing ? (
        <span data-slot="input-trailing" className="flex shrink-0 items-center font-medium text-fg-2 [&_svg]:shrink-0">
          {trailing}
        </span>
      ) : null}
    </div>
  );
});
