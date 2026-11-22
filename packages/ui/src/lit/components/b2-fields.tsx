/**
 * Owner: lane B2 (templates). The form controls a room draws inside the kit's `lt-field` (styles in
 * `../templates/templates.css`): a choice list, a long answer and a tick, each with its words. A room never draws a raw
 * `<select>`, `<textarea>` or `<input>` itself (garden/no-raw-control); these hold the native control so the browser's
 * own keyboard, form and screen-reader behaviour stay.
 */
import * as React from 'react';

export interface ChoiceOption {
  value: string;
  label: string;
}

export type SelectFieldProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> & {
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** A bare string is its own label. */
  options: readonly (string | ChoiceOption)[];
  hint?: React.ReactNode;
};

/** One choice from a list, with its label above it. */
export function SelectField({ label, value, onChange, options, hint, ...rest }: SelectFieldProps) {
  return (
    <label className="lt-field">
      <span>{label}</span>
      <select {...rest} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => {
          const option = typeof o === 'string' ? { value: o, label: o } : o;
          return (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          );
        })}
      </select>
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export type TextAreaFieldProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & {
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  hint?: React.ReactNode;
};

/** A long answer, with its label above it. */
export function TextAreaField({ label, value, onChange, hint, rows = 5, ...rest }: TextAreaFieldProps) {
  return (
    <label className="lt-field">
      <span>{label}</span>
      <textarea {...rest} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export type TextFieldProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  hint?: React.ReactNode;
};

/** A short answer, with its label above it; the label may hold more than words (a counter, a link). */
export function TextField({ label, value, onChange, hint, ...rest }: TextFieldProps) {
  return (
    <label className="lt-field">
      <span>{label}</span>
      <input {...rest} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export type CheckFieldProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type'> & {
  label: React.ReactNode;
  onChange: (checked: boolean) => void;
};

/** A tick and its words on one row. */
export function CheckField({ label, onChange, ...rest }: CheckFieldProps) {
  return (
    <label className="lt-field">
      <input {...rest} type="checkbox" onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
