/**
 * Small pieces the five tabs share: a gate for polled reads, a labelled pick list, the confirm dialog that repeats the
 * numbers, and a one-sentence reason placed next to a disabled control (never a tooltip alone). Drawn only from the Volt
 * kit (`@intafaced/ui/lit`), so the rooms that use them stay on it.
 */
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { DecimalInput, FreshnessChip, KeyValue, RefusalBox, Select, Sheet, Skeleton } from '@intafaced/ui/lit/templates';
import { fractionDigits } from '../../../data/decimal';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import { STALE_AFTER_MS } from '../rooms/read';
import { roomWords, type Words } from '../rooms/refusals';
import { readIds, type RoomKind } from '../rooms/store';
import { BLOCK_WORDS, type RoomWriter } from '../rooms/write';
import { UNKNOWN, type Loadable } from '../rooms/ui';
import { execCopy } from './copy';

export const signInHref = (): string => `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

/** Decimal places a decimal box should allow for a step such as a lot or a tick. */
export const placesFor = (step: string | null | undefined): number => fractionDigits(step) ?? 8;

/** A value the service has not given: a dash to the eye, "unknown" to assistive tech. */
export function Unknown() {
  const { t } = execCopy.useCopy();
  return (
    <>
      <span aria-hidden="true">{UNKNOWN}</span>
      <span className="lt-sr">{t('unknown')}</span>
    </>
  );
}

/** A refusal in plain words, with its code small and an optional retry. */
export function Refusal({ words, onRetry }: { words: Words; onRetry?: () => void }) {
  const { t } = execCopy.useCopy();
  return (
    <div className="lt-refusal" data-refusal="refused" role="status">
      <p className="lt-refusal-title">{words.title}</p>
      <p className="lt-refusal-body">{words.body}</p>
      {words.code ? <p className="lt-ref">{words.code}</p> : null}
      {onRetry ? <Button onClick={onRetry}>{t('Try again')}</Button> : null}
    </div>
  );
}

/** The sign-in refusal: what signing in unlocks, and the one way there. */
function SignInRefusal() {
  const { t } = execCopy.useCopy();
  return (
    <RefusalBox
      refusal={{
        variant: 'refused',
        title: t('Sign in title'),
        body: t('Sign in reason'),
        action: { label: t('Sign in'), href: signInHref() },
      }}
    />
  );
}

/** An empty list, said in words. */
export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="lt-empty">
      <p className="lt-empty-title">{title}</p>
      {body ? <p className="lt-empty-body">{body}</p> : null}
    </div>
  );
}

/** Loading, signed out, refused and error in one place; `children` only ever sees an answer the service gave. */
export function Gate<T>({
  load,
  rows = 3,
  children,
}: {
  load: Loadable<T>;
  rows?: number;
  children: (data: T, asOf: number) => ReactNode;
}) {
  const { t } = execCopy.useCopy();
  if (load.status === 'loading' || load.status === 'empty')
    return (
      <div role="status" aria-busy="true">
        <Skeleton shape="rows" count={rows} />
      </div>
    );
  if (load.status === 'refused') {
    if (load.code === 'auth.required') return <SignInRefusal />;
    return <Refusal words={roomWords({ code: load.code })} />;
  }
  if (load.status === 'error')
    return <Refusal words={{ title: t('Could not load title'), body: t('Could not load body') }} onRetry={load.retry} />;
  return <>{children(load.data, load.asOf)}</>;
}

/** The sentence that says why a control is off, right beside it. */
export function Why({ children, code }: { children: ReactNode; code?: string }) {
  return (
    <p role="note" data-code={code} className="lt-hint">
      {children}
    </p>
  );
}

/** Freshness of a polled region. `asOf` null means no good answer (unknown), `refused` means the service said no. */
export function Freshness({ asOf, refused = false }: { asOf: number | null; refused?: boolean }) {
  return <FreshnessChip asOf={asOf} refused={refused} staleAfterMs={STALE_AFTER_MS} showAsOf={asOf !== null} />;
}

/** A labelled box: the label names the control, the hint and the error sit under it and describe it. */
function FieldBox({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="lt-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint ? <small id={`${id}-hint`}>{hint}</small> : null}
      {error ? (
        <small id={`${id}-error`} role="alert">
          {error}
        </small>
      ) : null}
    </div>
  );
}

/** A labelled decimal box (money and quantities: a decimal string, never a number). */
export function DecimalField({
  label,
  hint,
  error,
  value,
  onValueChange,
  precision,
}: {
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onValueChange: (value: string) => void;
  precision: number;
}) {
  return (
    <FieldBox label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <DecimalInput
          id={id}
          aria-label={label}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          value={value}
          onValueChange={onValueChange}
          precision={precision}
        />
      )}
    </FieldBox>
  );
}

/** A labelled text box; `readOnly` shows a fixed value (a request id, the time in force). */
export function TextField({
  label,
  hint,
  error,
  value,
  onValueChange,
  readOnly,
  onKeyDown,
}: {
  label: string;
  hint?: string;
  error?: string;
  value: string;
  onValueChange?: (value: string) => void;
  readOnly?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <Field
      type="text"
      label={label}
      aria-label={label}
      hint={hint}
      error={error}
      value={value}
      readOnly={readOnly}
      onChange={(e) => onValueChange?.(e.currentTarget.value)}
      onKeyDown={onKeyDown}
    />
  );
}

/**
 * A labelled pick list. The box shows the label once (a filter row's `bare` list shows none); the combobox carries it
 * too, so it is found by its name.
 */
export function Pick<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  hint,
  error,
  bare = false,
}: {
  label: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string }>;
  onChange: (value: V) => void;
  disabled?: boolean;
  hint?: string;
  error?: string;
  bare?: boolean;
}) {
  return (
    <div className="lt-field">
      {bare ? null : <span aria-hidden="true">{label}</span>}
      <Select label={label} value={value} options={options} disabled={disabled} onChange={(next) => onChange(next as V)} />
      {hint ? <small>{hint}</small> : null}
      {error ? <small role="alert">{error}</small> : null}
    </div>
  );
}

export interface ConfirmRow {
  label: string;
  value: string | null;
  hint?: string;
  mono?: boolean;
}

/** Enter confirms (the confirm button holds focus), Esc dismisses, and every number being agreed to is on the dialog. */
export function ConfirmDialog({
  open,
  title,
  description,
  rows,
  confirmLabel,
  busy = false,
  tone = 'primary',
  confirmDisabled = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  rows: readonly ConfirmRow[];
  /** Extra content under the rows, such as a list the rows cannot hold. */
  children?: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  tone?: 'primary' | 'secondary';
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = execCopy.useCopy();
  return (
    <Sheet open={open} role="alertdialog" title={title} onClose={() => !busy && onCancel()}>
      <p className="lt-description">{description}</p>
      <KeyValue rows={rows.map((r) => ({ label: r.label, value: r.value ?? <Unknown />, note: r.hint, ltr: r.mono }))} />
      {children}
      <div className="lt-actions">
        <Button tone="secondary" disabled={busy} onClick={onCancel}>
          {t('Go back')}
        </Button>
        <Button tone={tone} disabled={busy || confirmDisabled} aria-busy={busy || undefined} data-autofocus="" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Sheet>
  );
}

/**
 * What happened to the last write, and the note of any request still unconfirmed. `onCheck` re-reads the original from
 * the service; the room decides what "the original" is. Nothing here sends anything. (The words and behaviour of
 * `rooms/RoomNotices` WriteNotice, drawn from the kit.)
 */
export function WriteNotice({
  writer,
  onCheck,
  done,
}: {
  writer: RoomWriter;
  /** Re-read the unresolved original and call `writer.resolve(id)` once the service proves its state. */
  onCheck?: (id: string) => void;
  /** Plain-words line shown after a successful write. */
  done?: ReactNode;
}) {
  const { t } = execCopy.useCopy();
  const { outcome, note } = writer;
  const pendingId = note.state === 'pending' ? note.pending.id : outcome.kind === 'uncertain' ? outcome.id : null;
  return (
    <div className="lt-body" aria-live="polite">
      {outcome.kind === 'done' && done ? <p>{done}</p> : null}
      {outcome.kind === 'refused' ? <Refusal words={outcome.words} /> : null}
      {outcome.kind === 'blocked' ? (
        <p role="alert" className="lt-hint">
          {BLOCK_WORDS[outcome.reason]}
        </p>
      ) : null}
      {outcome.kind === 'uncertain' ? (
        <p role="alert" className="lt-hint">
          {outcome.words.title}. {outcome.words.body}
        </p>
      ) : null}
      {note.state === 'unreadable' ? (
        <p role="alert" className="lt-hint">
          {BLOCK_WORDS.unreadable}
        </p>
      ) : null}
      {pendingId ? (
        <div className="lt-toolbar">
          <span className="lt-hint">
            {t('Unconfirmed request')} <span className="lt-mono">{pendingId}</span>. {t('Unconfirmed request locked')}
          </span>
          {onCheck ? <Button onClick={() => onCheck(pendingId)}>{t('Check status')}</Button> : null}
        </div>
      ) : null}
    </div>
  );
}

/** "14 Oct, 19:29" in the person's zone for an ISO time or epoch ms; unknown stays null (drawn as a dash). */
export function useWhen(): (value: string | number | null | undefined) => string | null {
  const { timeZone } = usePreferences();
  return (value) => {
    if (value === null || value === undefined) return null;
    const ms = typeof value === 'number' ? value : Date.parse(value);
    return Number.isNaN(ms) ? null : dayTime(ms, timeZone);
  };
}

/** Ids this device remembers for a room, kept in step with other tabs and with `rememberId`. */
export function useStoredIds(kind: RoomKind, userId: string | null): string[] {
  const [ids, setIds] = useState(() => readIds(kind, userId));
  useEffect(() => {
    const sync = () => setIds(readIds(kind, userId));
    sync();
    window.addEventListener('trade-room-ids-change', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('trade-room-ids-change', sync);
      window.removeEventListener('storage', sync);
    };
  }, [kind, userId]);
  return ids;
}
