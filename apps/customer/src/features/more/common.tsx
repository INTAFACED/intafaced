import { copy, t as copyText, Text } from './copy';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiResult } from '../../shared/api';
import type { Resource } from '../../shared/resource';
import { Button, Dialog, EmptyState, Failure, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import type { UiLocale } from '../../shared/i18n';

export function Read<T>({
  resource,
  retry,
  empty,
  children,
}: {
  resource: Resource<T>;
  retry: () => void;
  empty?: string;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed')
    return (
      <div lang="und" style={{ display: 'contents' }}>
        <Failure result={resource.failure} retry={retry} />
      </div>
    );
  if (empty && (resource.data === null || (Array.isArray(resource.data) && resource.data.length === 0)))
    return <EmptyState title={empty} />;
  return <>{children(resource.data)}</>;
}
export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (string | { value: string; label: string })[];
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={typeof o === 'string' ? o : o.value} value={typeof o === 'string' ? o : o.value}>
            {typeof o === 'string' ? o : o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
export function TextArea({
  label,
  value,
  onChange,
  maxLength = 10000,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} maxLength={maxLength} rows={5} />
    </label>
  );
}
export function Limit({ count, limit, cap, onChange }: { count: number; limit: number; cap: number; onChange: (limit: number) => void }) {
  return (
    <div className="more-continuation">
      <small>
        <Text k="common.showing" />
        {count}
        <Text k="common.requested.limit" />
        {limit}
        <Text k="common.this.service.publishes.no.continuation.cursor" />
      </small>
      {count >= limit && limit < cap ? (
        <Button variant="secondary" onClick={() => onChange(Math.min(cap, limit + 50))}>
          <Text k="common.load.a.larger.window" />
        </Button>
      ) : count >= cap ? (
        <small>
          <Text k="common.the.published.limit.is" />
          {cap}
          <Text k="common.older.rows.cannot.be.requested.here" />
        </small>
      ) : null}
    </div>
  );
}
export function Details({ items }: { items: readonly [string, ReactNode][] }) {
  return (
    <dl className="more-details">
      {items.map(([label, value], index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd style={{ minWidth: 0 }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
type Pending = { id: string; title: string; reference?: string };
// Presentation may follow View while the staged operation and journal stay fixed.
type Presented<T> = T | (() => T);
function present<T>(value: Presented<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}
type LocalFailureKey =
  | 'common.the.account.or.pending.request.changed.review'
  | 'common.recovery.storage.is.unavailable.no.action.was'
  | 'common.the.connection.ended.before.the.service.confirmed'
  | 'common.this.account.has.an.action.running.in'
  | 'common.this.browser.has.no.cross.tab.mutation'
  | 'common.the.original.outcome.lookup.could.not.be';
type FailurePresentation = (locale: UiLocale) => { message: string; language: UiLocale };
const failurePresentations = new WeakMap<object, FailurePresentation>();
/** Academy's compatible action hook shares authored failure presentation only. */
export function actionFailurePresentation(result: ApiResult<unknown>, locale: UiLocale) {
  return failurePresentations.get(result)?.(locale);
}
/** Register explicit authored copy at its origin. Opaque service prose stays outside this seam. */
export function presentActionFailure<T extends Extract<ApiResult<unknown>, { ok: false }>>(
  result: T,
  presentation: FailurePresentation,
): T {
  failurePresentations.set(result, presentation);
  return result;
}
function localRefusal(reason: Extract<ApiResult<unknown>, { ok: false }>['reason'], key: LocalFailureKey) {
  return presentActionFailure({ ok: false as const, reason, message: copyText(key) }, (locale) => {
    const current = copy.forLocale(locale);
    return { message: current.t(key), language: current.languageFor(key) };
  });
}
function pendingAt(key: string): Pending | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Pending;
    if (typeof parsed.id === 'string' && typeof parsed.title === 'string') return parsed;
  } catch {}
  return { id: 'legacy', title: copyText('common.earlier.request.with.unreadable.recovery.metadata') };
}

export function useAction(room: string, recovery?: { recover: (reference: string) => Promise<ApiResult<unknown>>; done?: () => void }) {
  const { userId } = useSession();
  const { language } = usePreferences();
  const actor = useRef(userId);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  actor.current = userId;
  const key = `intafaced:more:pending:${userId ?? 'anonymous'}:${room}`,
    running = useRef(new Set<string>());
  const [state, setState] = useState<{ key: string; busy: boolean; result: ApiResult<unknown> | null; success: Presented<string> }>({
    key,
    busy: false,
    result: null,
    success: '',
  });
  const [review, setReview] = useState<{
    key: string;
    title: Presented<string>;
    journalTitle: string;
    content: Presented<ReactNode>;
    confirm: Presented<string>;
    reference?: string;
    run: (canDispatch: () => boolean) => Promise<ApiResult<unknown>>;
    done?: () => void;
    success: Presented<string>;
  } | null>(null);
  const current = state.key === key ? state : { key, busy: false, result: null, success: '' },
    pending = pendingAt(key);
  useEffect(() => {
    setReview(null);
    const listener = (event: StorageEvent) => {
      if (event.key === key) {
        setReview(null);
        setState({ key, busy: false, result: null, success: '' });
      }
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }, [key]);
  function stage(input: Omit<NonNullable<typeof review>, 'key' | 'journalTitle'>) {
    if (!userId || current.busy || pendingAt(key) || running.current.has(key)) return;
    setReview({ ...input, key, journalTitle: present(input.title) });
  }
  function clear(marker: Pending) {
    if (pendingAt(key)?.id === marker.id) localStorage.removeItem(key);
  }
  async function send() {
    const request = review;
    if (!request || request.key !== key || !userId || current.busy || pendingAt(key) || running.current.has(key)) return;
    const identity = userId;
    running.current.add(key);
    setReview(null);
    setState({ key, busy: true, result: null, success: '' });
    const operation = async (): Promise<ApiResult<unknown>> => {
      if (!mounted.current || actor.current !== identity || pendingAt(key))
        return localRefusal('aborted', 'common.the.account.or.pending.request.changed.review');
      const marker = {
        id: crypto.randomUUID(),
        title: request.journalTitle,
        ...(request.reference ? { reference: request.reference } : {}),
      };
      try {
        localStorage.setItem(key, JSON.stringify(marker));
      } catch {
        return localRefusal('error', 'common.recovery.storage.is.unavailable.no.action.was');
      }
      let result: ApiResult<unknown>;
      try {
        result = await request.run(() => mounted.current && actor.current === identity && pendingAt(key)?.id === marker.id);
      } catch {
        result = localRefusal('uncertain', 'common.the.connection.ended.before.the.service.confirmed');
      }
      if (result.ok || result.reason !== 'uncertain') clear(marker);
      return result;
    };
    let result: ApiResult<unknown>;
    if (navigator.locks)
      result = await navigator.locks.request(`more-action:${key}`, { ifAvailable: true }, (lock) =>
        lock ? operation() : Promise.resolve(localRefusal('error', 'common.this.account.has.an.action.running.in')),
      );
    else result = localRefusal('not_supported', 'common.this.browser.has.no.cross.tab.mutation');
    running.current.delete(key);
    if (!mounted.current || actor.current !== identity) return;
    setState({ key, busy: false, result, success: result.ok ? request.success : '' });
    if (result.ok) request.done?.();
  }
  async function recover() {
    const marker = pendingAt(key);
    if (!marker?.reference || !recovery || !userId || running.current.has(key)) return;
    const identity = userId;
    running.current.add(key);
    setState({ key, busy: true, result: null, success: '' });
    let result: ApiResult<unknown>;
    try {
      result = await recovery.recover(marker.reference);
    } catch {
      result = localRefusal('unreachable', 'common.the.original.outcome.lookup.could.not.be');
    }
    running.current.delete(key);
    if (!mounted.current || actor.current !== identity) return;
    if (result.ok) {
      clear(marker);
      recovery.done?.();
    }
    setState({ key, busy: false, result, success: result.ok ? () => copyText('common.original.outcome.verified') : '' });
  }
  const failurePresentation = current.result ? failurePresentations.get(current.result)?.(language) : undefined;
  const feedback = (
    <>
      {current.busy ? (
        <Loading label={copyText('common.waiting.for.the.service')} />
      ) : current.result && !current.result.ok ? (
        <div lang={failurePresentation?.language ?? 'und'} style={{ display: 'contents' }}>
          <Failure
            result={
              failurePresentation ? { ...current.result, message: failurePresentation.message, messageCopy: undefined } : current.result
            }
          />
        </div>
      ) : current.success ? (
        <p className="more-success" role="status" lang={typeof current.success === 'function' ? language : 'und'}>
          {present(current.success)}
        </p>
      ) : null}
      {pending && !current.busy ? (
        <div className="failure" role="alert">
          {!current.result && (
            <h3>
              <Text k="common.outcome.not.confirmed" />
            </h3>
          )}
          <p>
            <Text k="common.earlier.request" />
            <span lang="und">{pending.title}</span>. {pending.reference && <code lang="zxx">{pending.reference}</code>}
            <Text k="common.read.its.original.records.before.continuing" />
          </p>
          {pending.reference && recovery ? (
            <Button variant="secondary" onClick={() => void recover()}>
              <Text k="common.check.original.outcome" />
            </Button>
          ) : (
            <p>
              <Text k="common.this.action.has.no.universal.recovery.lookup" />
            </p>
          )}
        </div>
      ) : null}
    </>
  );
  const dialog =
    review && review.key === key ? (
      <Dialog
        title={<span lang={typeof review.title === 'function' ? language : 'und'}>{present(review.title)}</span>}
        onClose={() => setReview(null)}
      >
        <div lang={typeof review.content === 'function' ? language : 'und'} style={{ display: 'contents' }}>
          {present(review.content)}
        </div>
        <p className="muted">
          <Text k="common.acting.as.account" />
          <code lang="zxx">{userId}</code>
          <Text k="common.the.service.enforces.your.scope.and.jurisdiction" />
        </p>
        <div className="actions">
          <Button variant="secondary" onClick={() => setReview(null)}>
            <Text k="common.back" />
          </Button>
          <Button lang={typeof review.confirm === 'function' ? language : 'und'} onClick={() => void send()}>
            {present(review.confirm)}
          </Button>
        </div>
      </Dialog>
    ) : null;
  return {
    stage,
    feedback,
    dialog,
    isCurrent: () => mounted.current && actor.current === userId,
    result: current.result,
    disabled: current.busy || Boolean(pending) || !userId,
  };
}
