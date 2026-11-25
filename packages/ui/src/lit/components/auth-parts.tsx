/**
 * Parts for the beta's sign-up, sign-in and verification pages (the picked "mix": a stage beside the form).
 *
 * - `ChoiceTile`: one answer of a short choice drawn as a tile (title and a quiet line), still the browser's own radio
 *   button inside a fieldset, so it is sent with the form and named by its words.
 * - `RadioTrack`: two or three answers on one sunken pill track, each the browser's own radio button. Unlike
 *   `Segmented` (pressed buttons) its answer is sent with the form, and it may start unanswered.
 * - `WalletCard`: the hero object, a tilted matte card with the brand mark, a label and a short value, with the
 *   screen's one spark as a soft light behind it. It shows only what it is given.
 */
import * as React from 'react';
import { clsx } from 'clsx';

type RadioInput = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'children' | 'title'>;

export function ChoiceTile({
  title,
  detail,
  onSelect,
  className,
  ...rest
}: RadioInput & { title: React.ReactNode; detail?: React.ReactNode; onSelect?: () => void }) {
  return (
    <label className={clsx('lt-choice-tile', className)}>
      <input {...rest} type="radio" onChange={(e) => e.target.checked && onSelect?.()} />
      <span className="lt-choice-tile__title">{title}</span>
      {detail ? <small className="lt-choice-tile__detail">{detail}</small> : null}
    </label>
  );
}

export type RadioTrackOption = { value: string; label: React.ReactNode };

export function RadioTrack({
  name,
  options,
  value,
  defaultValue,
  onChange,
  disabled,
  className,
}: {
  name: string;
  options: readonly RadioTrackOption[];
  /** Controlled answer; leave both `value` and `defaultValue` out to start unanswered. */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={clsx('lt-radio-track', className)}>
      {options.map((o) => (
        <label key={o.value} className="lt-radio-track__option">
          <input
            type="radio"
            name={name}
            value={o.value}
            disabled={disabled}
            {...(value === undefined
              ? defaultValue === undefined
                ? {}
                : { defaultChecked: defaultValue === o.value }
              : { checked: value === o.value })}
            onChange={(e) => e.target.checked && onChange?.(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

export function WalletCard({
  mark,
  label,
  value,
  className,
  ...rest
}: Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> & { mark: React.ReactNode; label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div {...rest} className={clsx('lt-wallet-card', className)}>
      <div className="lt-wallet-card__card">
        <span className="lt-wallet-card__top">
          <span className="lt-wallet-card__mark">{mark}</span>
          <span className="lt-wallet-card__spark" aria-hidden="true" />
        </span>
        <span className="lt-wallet-card__label">{label}</span>
        <span className="lt-wallet-card__value">{value}</span>
      </div>
    </div>
  );
}
