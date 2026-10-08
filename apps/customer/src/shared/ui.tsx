import { useEffect, useId, useRef, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react';
import { Panel } from '@intafaced/ui';
import type { ApiResult } from './api';
export { Panel };

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'chrome' }) {
  return <button type="button" className={`button button--${variant} ${className}`} {...props} />;
}
export function Field({
  label,
  hint,
  error,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const generatedId = useId();
  const id = input.id ?? `${input.name ?? label.toLowerCase().replace(/\W+/g, '-')}-${generatedId}`;
  return (
    <label className="field" htmlFor={id}>
      <span id={`${id}-label`}>{label}</span>
      <input
        {...input}
        id={id}
        aria-labelledby={input['aria-label'] ? undefined : `${id}-label`}
        aria-invalid={Boolean(error)}
        aria-describedby={hint || error ? `${id}-help` : undefined}
      />
      {(hint || error) && (
        <small id={`${id}-help`} className={error ? 'error-text' : ''}>
          {error ?? hint}
        </small>
      )}
    </label>
  );
}
export function Page({
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page">
      <header className="page-heading">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1>{title}</h1>
          {description && <p className="muted">{description}</p>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden="true">
        ↗
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function Failure({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
  const headings = {
    unauthorized: 'Sign in to continue',
    forbidden: 'Access is restricted',
    not_mounted: 'This service is not connected',
    not_supported: 'This action is unavailable',
    unreachable: 'Connection unavailable',
    invalid_response: 'Information could not be verified',
    aborted: 'Request stopped',
    error: 'The request was refused',
    uncertain: 'Outcome not confirmed',
  };
  return (
    <div className="failure" role={result.reason === 'uncertain' ? 'alert' : 'status'}>
      <h3>{headings[result.reason]}</h3>
      <p>{result.message}</p>
      {result.reason === 'unauthorized' ? (
        <a className="text-link" href={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`}>
          Sign in
        </a>
      ) : (
        retry &&
        result.reason !== 'uncertain' && (
          <Button variant="secondary" onClick={retry}>
            Try again
          </Button>
        )
      )}
    </div>
  );
}
export function Loading({ label = 'Loading information' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="loading-dot" />
      {label}…
    </div>
  );
}
export function Tabs({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly string[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className="tabs" role="group" aria-label={label}>
      {items.map((item) => (
        <button
          type="button"
          key={item}
          className={value === item ? 'selected' : ''}
          aria-pressed={value === item}
          onClick={() => onChange(item)}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      className="dialog"
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <Button variant="ghost" aria-label="Close dialog" onClick={onClose}>
          ×
        </Button>
      </header>
      {children}
    </dialog>
  );
}
export function DataTable({ headers, children, label }: { headers: readonly string[]; children: ReactNode; label: string }) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={label}>
      <table>
        <thead>
          <tr>
            {headers.map((head) => (
              <th key={head} scope="col">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong className="numeric">{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
export function Icon({
  name,
  size = 20,
}: {
  name: 'search' | 'person' | 'chevron' | 'money' | 'trade' | 'pay' | 'more' | 'bell' | 'settings';
  size?: number;
}) {
  const paths = {
    search: 'm21 21-5-5M19 10a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    person: 'M20 21v-2a7 7 0 0 0-14 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    chevron: 'm7 10 5 5 5-5',
    money: 'M3 7h18v13H3zM3 7V4h15M16 12h5v4h-5z',
    trade: 'M4 20V4M4 20h17M7 15l4-5 4 3 6-8',
    pay: 'M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4',
    more: 'M4 4h5v5H4zM15 4h5v5h-5zM4 15h5v5H4zM15 15h5v5h-5z',
    bell: 'M18 8a6 6 0 0 0-12 0v8l-2 2h16l-2-2zM10 21h4',
    settings: 'M12 2v4m0 12v4M2 12h4m12 0h4M5 5l3 3m8 8 3 3M5 19l3-3m8-8 3-3M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
