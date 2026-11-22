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
  /** The option's own language, when its words are not in the page's (a language list names each in itself). */
  lang?: string;
}

/** The control's id, and the hint's when there is one: the hint describes the control and never joins its name. */
function useIds(id: string | undefined, hint: React.ReactNode, describedBy: string | undefined) {
  const auto = React.useId();
  const controlId = id ?? auto;
  const hintId = hint ? `${controlId}-hint` : undefined;
  return { controlId, hintId, describedBy: [describedBy, hintId].filter(Boolean).join(' ') || undefined };
}

function Hint({ id, hint }: { id?: string; hint: React.ReactNode }) {
  return hint ? <small id={id}>{hint}</small> : null;
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
export function SelectField({ label, value, onChange, options, hint, id, ...rest }: SelectFieldProps) {
  const ids = useIds(id, hint, rest['aria-describedby']);
  return (
    <div className="lt-field">
      <label htmlFor={ids.controlId}>{label}</label>
      <select {...rest} id={ids.controlId} aria-describedby={ids.describedBy} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => {
          const option = typeof o === 'string' ? { value: o, label: o } : o;
          return (
            <option key={option.value} value={option.value} lang={option.lang}>
              {option.label}
            </option>
          );
        })}
      </select>
      <Hint id={ids.hintId} hint={hint} />
    </div>
  );
}

export type TextAreaFieldProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & {
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  hint?: React.ReactNode;
  /** Why what was typed is refused: shown in the hint's place, announced, and it marks the box invalid. */
  error?: React.ReactNode;
};

/** A long answer, with its label above it. */
export function TextAreaField({ label, value, onChange, hint, error, id, rows = 5, ...rest }: TextAreaFieldProps) {
  const ids = useIds(id, error || hint, rest['aria-describedby']);
  return (
    <div className="lt-field">
      <label htmlFor={ids.controlId}>{label}</label>
      <textarea
        {...rest}
        id={ids.controlId}
        aria-describedby={ids.describedBy}
        aria-invalid={error ? true : rest['aria-invalid']}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? (
        <small id={ids.hintId} role="alert">
          {error}
        </small>
      ) : (
        <Hint id={ids.hintId} hint={hint} />
      )}
    </div>
  );
}

export type TextFieldProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  hint?: React.ReactNode;
};

/** A short answer, with its label above it; the label may hold more than words (a counter, a link). */
export function TextField({ label, value, onChange, hint, id, ...rest }: TextFieldProps) {
  const ids = useIds(id, hint, rest['aria-describedby']);
  return (
    <div className="lt-field">
      <label htmlFor={ids.controlId}>{label}</label>
      <input {...rest} id={ids.controlId} aria-describedby={ids.describedBy} value={value} onChange={(e) => onChange(e.target.value)} />
      <Hint id={ids.hintId} hint={hint} />
    </div>
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

export type FileFieldProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type' | 'value'> & {
  label: React.ReactNode;
  onChange: (file: File | null) => void;
  hint?: React.ReactNode;
  /** The picker itself, so the room can clear it after a send. */
  ref?: React.Ref<HTMLInputElement>;
};

/** One file picked from the device, with its label above it and its hint under it. */
export function FileField({ label, onChange, hint, id, ref, ...rest }: FileFieldProps) {
  const ids = useIds(id, hint, rest['aria-describedby']);
  return (
    <div className="lt-field">
      <label htmlFor={ids.controlId}>{label}</label>
      <input
        {...rest}
        ref={ref}
        id={ids.controlId}
        type="file"
        aria-describedby={ids.describedBy}
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
      <Hint id={ids.hintId} hint={hint} />
    </div>
  );
}
