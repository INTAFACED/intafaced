/**
 * Two parts the flow rooms need that the sheet lacked: a decimal field (money and quantities as decimal strings,
 * never a number) and a freshness chip (Live, Stale or Unknown, with its as-of time). Both read only lit roles
 * through `components.css`; every word arrives as a prop. Names and meanings are in `../contracts.ts`.
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { asOfIso, formatAsOf, freshnessOf, type AsOf, type Freshness as FreshnessWord } from '../../components/freshness.js';
import { useFreshnessClock } from '../../components/use-freshness-clock.js';
import { blurDecimalValue, displayDecimal, nextDecimalValue, pastedDecimalValue } from '../../components/input-logic.js';

export type DecimalFieldProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'defaultValue' | 'onChange' | 'type' | 'inputMode'
> & {
  label: string;
  hint?: string;
  error?: string;
  /** Canonical decimal string with "." and no group separators ("1234.5"); "" when empty. Never a number. */
  value: string;
  onValueChange: (value: string) => void;
  /** Max decimals. Typing more is refused; pasting more is cut off (down). 0 takes whole numbers only. */
  precision: number;
};

/**
 * A labelled decimal input: a keystroke that would make the value invalid is refused, a paste is cleaned and cut down
 * to `precision`, and an unfinished trailing "." is dropped on blur (the same rules as the old kit's decimal Input).
 */
export function DecimalField({
  label,
  hint,
  error,
  id,
  className,
  value,
  onValueChange,
  precision,
  onPaste,
  onBlur,
  ...rest
}: DecimalFieldProps) {
  const auto = React.useId();
  const inputId = id ?? auto;
  const describedBy =
    [rest['aria-describedby'], hint ? `${inputId}-hint` : null, error ? `${inputId}-error` : null].filter(Boolean).join(' ') || undefined;
  const opts = { precision };
  return (
    <div className={clsx('lit-field-control', className)}>
      <label htmlFor={inputId}>{label}</label>
      <input
        {...rest}
        id={inputId}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        data-kind="decimal"
        value={displayDecimal(value)}
        aria-invalid={error ? true : rest['aria-invalid']}
        aria-describedby={describedBy}
        onChange={(e) => {
          const next = nextDecimalValue(value, e.currentTarget.value, opts);
          if (next !== value) onValueChange(next);
        }}
        onPaste={(e) => {
          onPaste?.(e);
          if (e.defaultPrevented || rest.readOnly || rest.disabled) return;
          e.preventDefault();
          const next = pastedDecimalValue(value, e.clipboardData.getData('text'), opts);
          if (next !== value) onValueChange(next);
        }}
        onBlur={(e) => {
          const cleaned = blurDecimalValue(value);
          if (cleaned !== value) onValueChange(cleaned);
          onBlur?.(e);
        }}
      />
      {hint && (
        <span id={`${inputId}-hint`} data-part="hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${inputId}-error`} data-part="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export type FreshnessProps = {
  /** When the data was read (ISO text or epoch ms). Missing or unusable reads Unknown. */
  asOf: AsOf;
  /** Older than this many ms reads Stale; the chip keeps its own clock and turns Stale by itself. */
  staleAfterMs: number | null;
  /** The words for each state, from the room's copy. */
  words: Readonly<Record<'live' | 'stale' | 'unknown', string>> & { asOf: string };
  /** Why, for assistive tech and the tooltip ("The last refresh failed; showing the previous read"). */
  reason?: string;
  /** Fix the clock (screenshots and tests). */
  now?: number;
  timeZone?: string;
  locale?: string;
};

/** Data freshness: a shape and a word (never colour alone), with "as of 14:03:07" when the time is known. A polite status. */
export function Freshness({ asOf, staleAfterMs, words, reason, now, timeZone, locale }: FreshnessProps) {
  const clock = useFreshnessClock({ asOf, now, staleAfterMs });
  const state: FreshnessWord = freshnessOf({ asOf, now: clock, staleAfterMs });
  const shown: Exclude<FreshnessWord, 'refused'> = state === 'refused' ? 'unknown' : state;
  const iso = asOfIso(asOf);
  const at = iso ? formatAsOf(asOf, { timeZone, locale, now: clock }) : null;
  return (
    <span className="lit-fresh" role="status" data-fresh={shown} title={reason}>
      <span className="lit-fresh-mark" aria-hidden="true" />
      <span>{words[shown]}</span>
      {iso && at ? (
        <span>
          {' · '}
          {words.asOf} <time dateTime={iso}>{at}</time>
        </span>
      ) : null}
      {reason ? <span className="lit-sr">{reason}</span> : null}
    </span>
  );
}

export type ChoiceGroupProps<T extends string> = {
  /** The question, as the group's legend (text, or the room's copy element). */
  legend: React.ReactNode;
  /** The radio group's form name. */
  name: string;
  options: readonly { value: T; label: React.ReactNode; hint?: React.ReactNode }[];
  /** The chosen value; `null` while nothing is chosen yet (a question with no default answer). */
  value: T | null;
  onChange: (value: T) => void;
  /** Words about the whole question, after its choices. */
  hint?: React.ReactNode;
  disabled?: boolean;
};

/** One choice of several, each with its own words: native radios in a fieldset, so each is a radio named by its label. */
export function ChoiceGroup<T extends string>({ legend, name, options, value, onChange, hint, disabled }: ChoiceGroupProps<T>) {
  const hintId = React.useId();
  return (
    <fieldset className="lit-choices" disabled={disabled} aria-describedby={hint ? hintId : undefined}>
      <legend>{legend}</legend>
      {options.map((o) => (
        <label key={o.value} data-part="choice">
          <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
          <span data-part="label">{o.label}</span>
          {o.hint ? <span data-part="hint">{o.hint}</span> : null}
        </label>
      ))}
      {hint ? (
        <span id={hintId} data-part="hint">
          {hint}
        </span>
      ) : null}
    </fieldset>
  );
}
