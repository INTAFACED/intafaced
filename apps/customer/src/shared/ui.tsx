import { useEffect, useId, useRef, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react';
import { BrandIris, Panel } from '@intafaced/ui';
import { isServiceNotConnected, type ApiResult } from './api';
import { uiCopy, uiMessage } from './ui-copy';
import { refusalCopy } from '../data/refusals';
import { classifyRefusal, type RefusalKind } from '../data/refusal-codes';
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
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode; error?: ReactNode }) {
  const generatedId = useId();
  const id = input.id ?? `${input.name ?? 'field'}-${generatedId}`;
  const describedBy = [input['aria-describedby'], hint || error ? `${id}-help` : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <label className="field" htmlFor={id}>
      <span id={`${id}-label`}>{label}</span>
      <input
        {...input}
        id={id}
        aria-labelledby={input['aria-label'] ? undefined : `${id}-label`}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
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
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-testid="page" className="page">
      <header data-testid="page-heading" className="page-heading">
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
export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
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
/** Refusals that come from something not being switched on, allowed or listed. A second attempt cannot change them. */
const SETTLED_KINDS: ReadonlySet<RefusalKind> = new Set([
  'screening',
  'region',
  'verify',
  'convertSpreadUnset',
  'slippageCapUnset',
  'protectionUnset',
  'priceBandUnset',
  'openOrdersCapUnset',
  'noBook',
  'marketNotOpen',
  'marketHalted',
  'stepUp',
  'mfaRequired',
  'noPermission',
  'orderTypeUnsupported',
  'marketLimitOnly',
  'optionUnsupported',
  'accountOnHold',
  'notFound',
  'notSetUp',
  'feeScheduleUnset',
  'algoSchedulerOff',
]);
/** Try again belongs to network trouble and to refusals that can clear by themselves, never to a missing setting or permission. */
export function canTryAgain(result: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  if (result.reason === 'uncertain' || result.reason === 'unauthorized') return false;
  // The gateway says the service is not running in this environment: a second attempt cannot change that.
  if (isServiceNotConnected(result.code)) return false;
  if (result.reason === 'unreachable' || result.reason === 'invalid_response' || result.reason === 'aborted') return true;
  // A source that is unavailable, stale or unknown can recover by itself, whatever else its code says.
  if (result.code && /_(unavailable|stale|unknown)$/.test(result.code)) return true;
  if (result.reason === 'forbidden' || result.reason === 'not_mounted' || result.reason === 'not_supported') return false;
  return !SETTLED_KINDS.has(classifyRefusal(result.code));
}
/** A service sometimes answers with its own refusal code as the message ("token.params_invalid"). */
const RAW_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i;
/** A setting or code name inside a sentence, such as "Missing token_params.fee_discount_schedule". Only underscored names count, so "v1.2" and "e.g." stay. */
const EMBEDDED_KEY = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*\b/gi;
function embeddedKey(message: string): string | undefined {
  return message.match(EMBEDDED_KEY)?.find((key) => key.includes('_'));
}
export function Failure({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
  const { Copy, languageFor, requestedLocale } = uiCopy.useCopy();
  if (isServiceNotConnected(result.code)) {
    // The gateway's own text is never shown for this answer: say plainly that the service is not connected here.
    return (
      <div data-testid="failure" className="failure" role="status">
        <h3>
          <Copy k="not_mounted" />
        </h3>
        <p>
          <Copy k="serviceNotConnected" />
        </p>
      </div>
    );
  }
  const rawCode = RAW_CODE.test(result.message.trim()) ? result.message.trim() : result.code ? embeddedKey(result.message) : undefined;
  if (rawCode && !result.messageCopy) {
    // Customers never read a raw code: use the same plain sentences the other rooms use for typed refusals.
    const words = refusalCopy(result.code ?? rawCode);
    // A write that may have gone through is never called refused or unchanged; the code only gives the support reference.
    const uncertain = result.reason === 'uncertain';
    return (
      <div data-testid="failure" className="failure" role={uncertain ? 'alert' : 'status'}>
        <h3>{uncertain ? <Copy k="uncertain" /> : words.title}</h3>
        <p>{uncertain ? <Copy k="gatewayUncertain" /> : words.body}</p>
        {!uncertain && words.action && (
          <a className="text-link" href={words.action.href}>
            {words.action.label}
          </a>
        )}
        {words.reference && <small className="muted">{words.reference}</small>}
        {retry && canTryAgain(result) && (
          <Button variant="secondary" onClick={retry}>
            <Copy k="retry" />
          </Button>
        )}
      </div>
    );
  }
  return (
    <div data-testid="failure" className="failure" role={result.reason === 'uncertain' ? 'alert' : 'status'}>
      <h3>
        <Copy k={result.reason} />
      </h3>
      <p lang={result.messageCopy ? languageFor(result.messageCopy.key) : undefined}>
        {result.messageCopy ? uiMessage(result.messageCopy, requestedLocale) : result.message}
      </p>
      {result.reason === 'unauthorized' ? (
        <a className="text-link" href={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`}>
          <Copy k="signIn" />
        </a>
      ) : (
        retry &&
        canTryAgain(result) && (
          <Button variant="secondary" onClick={retry}>
            <Copy k="retry" />
          </Button>
        )
      )}
    </div>
  );
}
/** Data on its way. `room`: a room's code is still arriving, so the brand's iris turns instead of the dot. */
export function Loading({ label, room }: { label?: ReactNode; room?: boolean }) {
  const { Copy } = uiCopy.useCopy();
  return (
    <div className={room ? 'loading loading--room' : 'loading'} role="status">
      {room ? <BrandIris size={24} mode="loop" /> : <span className="loading-dot" />}
      {label ?? <Copy k="loading" />}…
    </div>
  );
}
export function Tabs({
  items,
  value,
  onChange,
  label,
  labels,
}: {
  items: readonly string[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  labels?: Readonly<Record<string, ReactNode>>;
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
          {labels?.[item] ?? item}
        </button>
      ))}
    </div>
  );
}
export function Dialog({ title, children, onClose }: { title: ReactNode; children: ReactNode; onClose: () => void }) {
  const { t, languageFor } = uiCopy.useCopy();
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
        <Button variant="ghost" aria-label={t('closeDialog')} lang={languageFor('closeDialog')} onClick={onClose}>
          ×
        </Button>
      </header>
      {children}
    </dialog>
  );
}
export function DataTable({ headers, children, label }: { headers: readonly ReactNode[]; children: ReactNode; label: string }) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={label}>
      <table>
        <thead>
          <tr>
            {headers.map((head, index) => (
              <th key={index} scope="col">
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
export function Stat({ label, value, note }: { label: ReactNode; value: ReactNode; note?: ReactNode }) {
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
