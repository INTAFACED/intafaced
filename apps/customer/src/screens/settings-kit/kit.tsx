import { useId, type ComponentProps, type ReactNode } from 'react';
import './settings-kit.css';

/** The cards, rows, fields and notes the settings-style screens share. Markup only; the look is in settings-kit.css. */

export function Card({
  title,
  lead,
  action,
  children,
  label,
  className,
}: {
  title?: ReactNode;
  lead?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  /** Accessible name when there is no visible title. */
  label?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <section
      className={className ? `sk-card ${className}` : 'sk-card'}
      aria-labelledby={title ? id : undefined}
      aria-label={title ? undefined : label}
    >
      {title || action ? (
        <div className="sk-card__head">
          <div className="sk-card__titles">
            {title ? (
              <h2 className="sk-h2" id={id}>
                {title}
              </h2>
            ) : null}
            {lead ? <p className="sk-lead">{lead}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Rows({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className="sk-rows" aria-label={label}>
      {children}
    </ul>
  );
}

export function Row({
  icon,
  title,
  chip,
  line,
  action,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  chip?: ReactNode;
  line?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li>
      <div className="sk-row" data-plain={icon ? undefined : ''} data-compact={!line && !children ? '' : undefined}>
        {icon ? (
          <span className="sk-row__icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <div className="sk-row__text">
          <span className="sk-row__title">
            {title}
            {chip}
          </span>
          {line ? <span className="sk-row__line">{line}</span> : null}
          {children}
        </div>
        {action ? <div className="sk-row__action">{action}</div> : null}
      </div>
    </li>
  );
}

export function Chip({ children, tone }: { children: ReactNode; tone?: 'good' | 'warn' }) {
  return (
    <span className="sk-chip" data-tone={tone}>
      {children}
    </span>
  );
}

export function Note({ children, tone, role }: { children: ReactNode; tone?: 'warn' | 'error' | 'good'; role?: 'status' | 'alert' }) {
  return (
    <div className="sk-note" data-tone={tone} role={role}>
      {children}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  mono,
  multiline,
  ...input
}: {
  label: string;
  hint?: string;
  error?: string | null;
  mono?: boolean;
  multiline?: boolean;
} & Omit<ComponentProps<'input'>, 'className'>) {
  const id = useId();
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  const common = {
    id,
    className: 'sk-input',
    'data-mono': mono ? '' : undefined,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': described,
  } as const;
  return (
    <div className="sk-field">
      <label className="sk-field__label" htmlFor={id}>
        {label}
      </label>
      {multiline ? <textarea {...common} {...(input as unknown as ComponentProps<'textarea'>)} /> : <input {...common} {...input} />}
      {hint ? (
        <span className="sk-field__hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="sk-field__error" id={`${id}-error`} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
