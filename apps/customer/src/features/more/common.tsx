import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiResult } from '../../shared/api';
import type { Resource } from '../../shared/resource';
import { Button, Dialog, EmptyState, Failure, Loading } from '../../shared/ui';
import { useSession } from '../session/session';

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
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={retry} />;
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
        Showing {count} · requested limit {limit}. This service publishes no continuation cursor.
      </small>
      {count >= limit && limit < cap ? (
        <Button variant="secondary" onClick={() => onChange(Math.min(cap, limit + 50))}>
          Load a larger window
        </Button>
      ) : count >= cap ? (
        <small>The published limit is {cap}; older rows cannot be requested here.</small>
      ) : null}
    </div>
  );
}
export function Details({ items }: { items: readonly [string, ReactNode][] }) {
  return (
    <dl className="more-details">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
type Pending = { id: string; title: string; reference?: string };
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
  return { id: 'legacy', title: 'earlier request with unreadable recovery metadata' };
}

export function useAction(room: string, recovery?: { recover: (reference: string) => Promise<ApiResult<unknown>>; done?: () => void }) {
  const { userId } = useSession();
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
  const [state, setState] = useState<{ key: string; busy: boolean; result: ApiResult<unknown> | null; success: string }>({
    key,
    busy: false,
    result: null,
    success: '',
  });
  const [review, setReview] = useState<{
    key: string;
    title: string;
    content: ReactNode;
    confirm: string;
    reference?: string;
    run: (canDispatch: () => boolean) => Promise<ApiResult<unknown>>;
    done?: () => void;
    success: string;
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
  function stage(input: Omit<NonNullable<typeof review>, 'key'>) {
    if (!userId || current.busy || pendingAt(key) || running.current.has(key)) return;
    setReview({ ...input, key });
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
        return { ok: false, reason: 'aborted', message: 'The account or pending request changed. Review again.' };
      const marker = { id: crypto.randomUUID(), title: request.title, ...(request.reference ? { reference: request.reference } : {}) };
      try {
        localStorage.setItem(key, JSON.stringify(marker));
      } catch {
        return { ok: false, reason: 'error', message: 'Recovery storage is unavailable. No action was sent.' };
      }
      let result: ApiResult<unknown>;
      try {
        result = await request.run(() => mounted.current && actor.current === identity && pendingAt(key)?.id === marker.id);
      } catch {
        result = {
          ok: false,
          reason: 'uncertain',
          message:
            'The connection ended before the service confirmed this action. Check its original record before sending another request.',
        };
      }
      if (result.ok || result.reason !== 'uncertain') clear(marker);
      return result;
    };
    let result: ApiResult<unknown>;
    if (navigator.locks)
      result = await navigator.locks.request(`more-action:${key}`, { ifAvailable: true }, (lock) =>
        lock
          ? operation()
          : Promise.resolve({
              ok: false as const,
              reason: 'error' as const,
              message: 'This account has an action running in another tab. No second action was sent.',
            }),
      );
    else result = { ok: false, reason: 'not_supported', message: 'This browser has no cross-tab mutation lock. No action was sent.' };
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
      result = { ok: false, reason: 'unreachable', message: 'The original outcome lookup could not be reached.' };
    }
    running.current.delete(key);
    if (!mounted.current || actor.current !== identity) return;
    if (result.ok) {
      clear(marker);
      recovery.done?.();
    }
    setState({ key, busy: false, result, success: result.ok ? 'Original outcome verified' : '' });
  }
  const feedback = (
    <>
      {current.busy ? (
        <Loading label="Waiting for the service" />
      ) : current.result && !current.result.ok ? (
        <Failure result={current.result} />
      ) : current.success ? (
        <p className="more-success" role="status">
          {current.success}
        </p>
      ) : null}
      {pending && !current.busy ? (
        <div className="failure" role="alert">
          {!current.result && <h3>Outcome not confirmed</h3>}
          <p>
            Earlier request: {pending.title}. {pending.reference && <code>{pending.reference}</code>} Read its original records before
            continuing.
          </p>
          {pending.reference && recovery ? (
            <Button variant="secondary" onClick={() => void recover()}>
              Check original outcome
            </Button>
          ) : (
            <p>This action has no universal recovery lookup. Keep its records and contact Support before sending another request.</p>
          )}
        </div>
      ) : null}
    </>
  );
  const dialog =
    review && review.key === key ? (
      <Dialog title={review.title} onClose={() => setReview(null)}>
        {review.content}
        <p className="muted">
          Acting as account <code>{userId}</code>. The service enforces your scope and jurisdiction.
        </p>
        <div className="actions">
          <Button variant="secondary" onClick={() => setReview(null)}>
            Back
          </Button>
          <Button onClick={() => void send()}>{review.confirm}</Button>
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
