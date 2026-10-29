/**
 * Small pieces the five tabs share: a gate for polled reads, a labelled pick list, the confirm dialog that repeats the
 * numbers, and a one-sentence reason placed next to a disabled control (never a tooltip alone).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { fractionDigits } from '../../../data/decimal';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import { Refusal } from '../rooms/RoomNotices';
import { roomWords } from '../rooms/refusals';
import { readIds, type RoomKind } from '../rooms/store';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  EmptyState,
  KeyValue,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  type Loadable,
} from '../rooms/ui';
import { execCopy } from './copy';

export const signInHref = (): string => `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;

/** Decimal places the kit's Input should allow for a step such as a lot or a tick. */
export const placesFor = (step: string | null | undefined): number => fractionDigits(step) ?? 8;

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
      <div role="status" aria-busy="true" className="flex flex-col gap-2">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} height={32} />
        ))}
      </div>
    );
  if (load.status === 'refused') {
    if (load.code === 'auth.required')
      return (
        <EmptyState
          variant="refused"
          size="inline"
          title={t('Sign in title')}
          reason={t('Sign in reason')}
          action={{ label: t('Sign in'), href: signInHref(), variant: 'primary' }}
        />
      );
    return <Refusal words={roomWords({ code: load.code })} size="inline" />;
  }
  if (load.status === 'error')
    return <Refusal words={{ title: t('Could not load title'), body: t('Could not load body') }} onRetry={load.retry} size="inline" />;
  return <>{children(load.data, load.asOf)}</>;
}

/** The sentence that says why a control is off, right beside it. */
export function Why({ children, code }: { children: ReactNode; code?: string }) {
  return (
    <p role="note" data-code={code} className="m-0 text-sm text-warn">
      {children}
    </p>
  );
}

export function Pick<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string }>;
  onChange: (value: V) => void;
  disabled?: boolean;
}) {
  const items = Object.fromEntries(options.map((o) => [o.value, o.label]));
  return (
    <Select items={items} value={value} disabled={disabled} onValueChange={(next) => next && onChange(next as V)}>
      <SelectTrigger size={32} aria-label={label} className="w-full">
        <SelectValue>{items[value] ?? value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  rows: readonly ConfirmRow[];
  confirmLabel: string;
  busy?: boolean;
  tone?: 'primary' | 'secondary';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = execCopy.useCopy();
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <KeyValue density="dense" items={rows.map((r) => ({ label: r.label, value: r.value, hint: r.hint, mono: r.mono }))} />
        <AlertDialogFooter>
          <Button variant="secondary" size={40} disabled={busy} onClick={onCancel}>
            {t('Go back')}
          </Button>
          <Button variant={tone} size={40} loading={busy} autoFocus onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
