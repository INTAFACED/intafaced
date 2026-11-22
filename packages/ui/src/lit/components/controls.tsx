/**
 * Volt form and overlay parts a desk needs: a labelled field around one control, a text or money-safe decimal input,
 * a checkbox, a modal dialog, a menu and a headline figure with its freshness. Behaviour is the old kit's (Base UI for focus, labels and
 * Escape; `../../components/input-logic.ts` for the decimal rules); the look is only `--lit-*` roles, in
 * `../templates/templates.css` (`lt-input`, `lt-dialog`, `lt-menu`).
 */
import * as React from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { Field as FieldPrimitive } from '@base-ui/react/field';
import { Input as InputPrimitive } from '@base-ui/react/input';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { blurDecimalValue, displayDecimal, nextDecimalValue, pastedDecimalValue, stepValueForKey } from '../../components/input-logic.js';
import { asOfIso, formatAsOf, freshnessOf, type AsOf, type Freshness } from '../../components/freshness.js';
import { useFreshnessClock } from '../../components/use-freshness-clock.js';
import { Button } from './index.js';

interface FormFieldContext {
  invalid: boolean;
  disabled: boolean;
  describedBy: string | undefined;
}

const FormFieldContext = React.createContext<FormFieldContext | null>(null);

export interface FormFieldProps {
  label?: React.ReactNode;
  /** Help under the control. */
  hint?: React.ReactNode;
  /** Error words: mark the control invalid and are announced. */
  error?: string;
  disabled?: boolean;
  /** At the end of the label row ("Max"). */
  labelAction?: React.ReactNode;
  /** One control, usually an `Input`, and anything that belongs under it. */
  children?: React.ReactNode;
}

/** Label, control, hint and error as one unit: the label names the control and the hint and error describe it. */
export function FormField({ label, hint, error, disabled = false, labelAction, children }: FormFieldProps) {
  const uid = React.useId();
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  const hasHint = hint !== undefined && hint !== null && hint !== false && hint !== '';
  const hasError = Boolean(error);
  const describedBy = [hasHint ? hintId : null, hasError ? errorId : null].filter(Boolean).join(' ') || undefined;
  const ctx = React.useMemo(() => ({ invalid: hasError, disabled, describedBy }), [hasError, disabled, describedBy]);
  const hasLabel = label !== undefined && label !== null && label !== false && label !== '';
  return (
    <FormFieldContext.Provider value={ctx}>
      <FieldPrimitive.Root invalid={hasError} disabled={disabled} className="lt-field" data-slot="field">
        {hasLabel || labelAction ? (
          <div className="lt-field-label">
            {hasLabel ? <FieldPrimitive.Label>{label}</FieldPrimitive.Label> : null}
            {labelAction ? <span>{labelAction}</span> : null}
          </div>
        ) : null}
        {children}
        {hasHint ? (
          <FieldPrimitive.Description id={hintId} className="lt-hint">
            {hint}
          </FieldPrimitive.Description>
        ) : null}
        <FieldPrimitive.Error match={hasError} id={errorId} role="alert" className="lt-field-error">
          {hasError ? error : null}
        </FieldPrimitive.Error>
      </FieldPrimitive.Root>
    </FormFieldContext.Provider>
  );
}

type NativeInputProps = Omit<
  React.ComponentProps<'input'>,
  'value' | 'defaultValue' | 'onChange' | 'type' | 'inputMode' | 'size' | 'prefix' | 'children' | 'color' | 'className' | 'style'
>;

interface InputCommon extends NativeInputProps {
  /** Unit words ("USDT", "x") after the value. */
  trailing?: React.ReactNode;
  invalid?: boolean;
  /** Where the text sits; the decimal kind defaults to the end. */
  align?: 'start' | 'end';
}

export interface TextInputProps extends InputCommon {
  kind?: 'text';
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export interface DecimalInputProps extends InputCommon {
  /** Money and quantities: a decimal STRING, never a number. */
  kind: 'decimal';
  value: string;
  onValueChange: (value: string) => void;
  /** Most decimals: typing more is refused, pasting more is cut down. */
  precision: number;
  /** Arrow-key step; without it the arrows do nothing. */
  tick?: string;
  min?: string;
  max?: string;
}

export type InputProps = TextInputProps | DecimalInputProps;

/**
 * A single-line input. `kind="decimal"` keeps the old kit's money rules: a character that would make the value invalid
 * is refused, a paste is cleaned and cut to `precision`, the arrows step by `tick` in exact arithmetic.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
  const field = React.useContext(FormFieldContext);
  const { trailing, invalid: invalidProp, align, disabled: disabledProp, readOnly, onBlur, onKeyDown, onPaste } = props;
  const isDecimal = props.kind === 'decimal';
  const invalid = invalidProp ?? field?.invalid ?? false;
  const disabled = disabledProp ?? field?.disabled ?? false;
  const describedBy = [props['aria-describedby'], field?.describedBy].filter(Boolean).join(' ') || undefined;
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const pendingCaret = React.useRef<number | null>(null);
  React.useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);
  React.useLayoutEffect(() => {
    if (pendingCaret.current !== null && inputRef.current) {
      const pos = Math.max(0, Math.min(pendingCaret.current, inputRef.current.value.length));
      inputRef.current.setSelectionRange(pos, pos);
      pendingCaret.current = null;
    }
  });

  let control: React.ComponentProps<'input'>;
  if (props.kind === 'decimal') {
    const {
      value,
      onValueChange,
      precision,
      tick,
      min,
      max,
      kind: _k,
      trailing: _t,
      invalid: _i,
      align: _a,
      disabled: _d,
      readOnly: _r,
      onBlur: _b,
      onKeyDown: _kd,
      onPaste: _p,
      'aria-describedby': _ad,
      ...rest
    } = props;
    const opts = { precision, decimalSeparator: '.' as const };
    control = {
      ...rest,
      type: 'text',
      inputMode: 'decimal',
      autoComplete: 'off',
      autoCorrect: 'off',
      spellCheck: false,
      value: displayDecimal(value, '.'),
      onChange: (e) => {
        const raw = e.currentTarget.value;
        const caret = e.currentTarget.selectionStart ?? raw.length;
        const next = nextDecimalValue(value, raw, opts);
        pendingCaret.current = Math.max(0, caret - (raw.length - displayDecimal(next, '.').length));
        if (next !== value) onValueChange(next);
      },
      onPaste: (e) => {
        onPaste?.(e);
        if (e.defaultPrevented || readOnly || disabled) return;
        e.preventDefault();
        const next = pastedDecimalValue(value, e.clipboardData.getData('text'), opts);
        pendingCaret.current = displayDecimal(next, '.').length;
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
      trailing: _t,
      invalid: _i,
      align: _a,
      disabled: _d,
      readOnly: _r,
      'aria-describedby': _ad,
      ...rest
    } = props;
    control = {
      ...rest,
      type: 'text',
      ...(value !== undefined ? { value } : { defaultValue }),
      onChange: (e) => onValueChange?.(e.currentTarget.value),
    };
  }
  return (
    <div
      className="lt-input"
      data-slot="input"
      data-kind={isDecimal ? 'decimal' : 'text'}
      data-align={(align ?? (isDecimal ? 'end' : 'start')) === 'end' ? 'end' : undefined}
      data-invalid={invalid || undefined}
      data-disabled={disabled || undefined}
    >
      <InputPrimitive
        {...control}
        ref={inputRef}
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
      />
      {trailing ? <span data-part="trailing">{trailing}</span> : null}
    </div>
  );
});

export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked' | 'className' | 'style'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

/** A checkbox. Put it first inside an `lt-field` label with its words, so the whole row is the hit area. */
export function Checkbox({ checked, onCheckedChange, ...rest }: CheckboxProps) {
  return <input {...rest} type="checkbox" checked={checked} onChange={(e) => onCheckedChange(e.currentTarget.checked)} />;
}

export interface DialogProps {
  title: string;
  description?: React.ReactNode;
  /** The close control's spoken name. */
  closeLabel: string;
  onClose: () => void;
  children: React.ReactNode;
  /** The dialog's buttons, at its end. */
  footer?: React.ReactNode;
}

/**
 * A modal dialog over a scrim, open while mounted: focus stays inside, Escape and the close control call `onClose`. A
 * tall one scrolls inside itself so its title and close stay reachable.
 */
export function Dialog({ title, description, closeLabel, onClose, children, footer }: DialogProps) {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="lt-scrim" />
        <DialogPrimitive.Popup className="lt-dialog" data-slot="dialog-content">
          <div className="lt-dialog-head">
            <DialogPrimitive.Title className="lt-sheet-title">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close render={<Button tone="quiet" aria-label={closeLabel} />}>
              <span aria-hidden="true">×</span>
            </DialogPrimitive.Close>
          </div>
          {description ? <DialogPrimitive.Description className="lt-hint">{description}</DialogPrimitive.Description> : null}
          <div className="lt-dialog-body">{children}</div>
          {footer ? <div className="lt-dialog-foot">{footer}</div> : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface MenuItemSpec {
  key: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

/** A button that opens a list of actions (role menu). */
export function Menu({
  label,
  triggerLabel,
  items,
  align = 'end',
}: {
  label: React.ReactNode;
  /** The trigger's spoken name, when it differs from its words. */
  triggerLabel?: string;
  items: readonly MenuItemSpec[];
  align?: 'start' | 'center' | 'end';
}) {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger render={<Button tone="secondary" aria-label={triggerLabel} />}>{label}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner side="bottom" sideOffset={8} align={align} className="lt-menu-layer">
          <MenuPrimitive.Popup className="lt-menu">
            {items.map((item) => (
              <MenuPrimitive.Item key={item.key} className="lt-menu-item" disabled={item.disabled} onClick={item.onSelect}>
                {item.label}
              </MenuPrimitive.Item>
            ))}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

const FRESHNESS: Record<Freshness, { status: 'done' | 'pending' | 'unknown' | 'failed'; word: string }> = {
  live: { status: 'done', word: 'Live' },
  stale: { status: 'pending', word: 'Stale' },
  unknown: { status: 'unknown', word: 'Unknown' },
  refused: { status: 'failed', word: 'Refused' },
};

export interface StatProps {
  label: string;
  /** Pre-formatted text. null = unknown: the dash, spoken "unknown", never 0. */
  value: string | null;
  hint?: string;
  /** With it (or when refused), a freshness chip with the as-of time sits under the value. */
  asOf?: AsOf;
  /** Epoch ms; without it the figure re-checks its own age. */
  now?: number;
  staleAfterMs?: number | null;
  refused?: boolean;
}

/** One headline figure with its label, its hint and how fresh it is (Live, Stale, Unknown, Refused) in words. */
export function Stat({ label, value, hint, asOf, now, staleAfterMs, refused }: StatProps) {
  const id = React.useId();
  const hasFreshness = asOf != null || refused === true;
  const clock = useFreshnessClock({ asOf, now, staleAfterMs, refused, enabled: hasFreshness });
  const freshness = hasFreshness ? freshnessOf({ asOf, now: clock, staleAfterMs, refused }) : undefined;
  const iso = hasFreshness ? asOfIso(asOf) : null;
  const shown = iso ? formatAsOf(asOf, { now: clock }) : null;
  return (
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={hint ? `${id}-hint` : undefined}
      className="lt-stat"
      data-freshness={freshness}
    >
      <span id={`${id}-label`} className="lt-hint">
        {label}
      </span>
      <span className="lt-figure">
        {value === null ? (
          <>
            <span aria-hidden="true">—</span>
            <span className="lt-sr">unknown</span>
          </>
        ) : (
          value
        )}
      </span>
      {hint ? (
        <span id={`${id}-hint`} className="lt-hint">
          {hint}
        </span>
      ) : null}
      {freshness ? (
        <span role="status" className="lt-chip" data-status={FRESHNESS[freshness].status} data-freshness={freshness}>
          <span className="lt-chip-mark" aria-hidden="true" />
          <span data-part="word">{FRESHNESS[freshness].word}</span>
          {iso && shown ? (
            <span>
              {' · as of '}
              <time dateTime={iso}>{shown}</time>
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
