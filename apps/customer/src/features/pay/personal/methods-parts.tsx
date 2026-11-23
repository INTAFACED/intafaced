import { useRef, useState, type ReactNode } from 'react';
import { Button, EmptyState } from '@intafaced/ui/lit';
import { RefusalBox, Sheet, Skeleton } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import type { Resource } from '../../../shared/resource';
import { uiCopy, uiMessage } from '../../../shared/ui-copy';
import { payAuthoredMessage, payCopy } from '../copy';

/**
 * The Payment methods room's parts, drawn from the kit: a section, a read's loading, refusal and empty states, a notice,
 * the record window, a status word and a change the person reviews before it is sent. They say what the old shared Pay
 * parts said, word for word.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** A read or a change that was refused, in the service's words, with sign in or try again where either helps. */
export function MethodsFailure({ result, retry }: { result: Failed; retry?: () => void }) {
  const { t, languageFor, requestedLocale } = uiCopy.useCopy();
  const pay = payCopy.useCopy();
  const authored = payAuthoredMessage(result);
  const body = authored ?? (result.messageCopy ? uiMessage(result.messageCopy, requestedLocale) : result.message);
  const lang = authored !== undefined ? pay.requestedLocale : result.messageCopy ? languageFor(result.messageCopy.key) : 'und';
  const signIn = result.reason === 'unauthorized';
  return (
    <div role={result.reason === 'uncertain' ? 'alert' : 'status'} lang={lang}>
      <RefusalBox
        refusal={{
          variant: result.reason === 'uncertain' ? 'unreachable' : 'refused',
          title: t(result.reason),
          body,
          action: signIn
            ? { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(location.pathname + location.search)}` }
            : undefined,
        }}
      />
      {!signIn && retry && result.reason !== 'uncertain' ? (
        <div className="lt-actions">
          <Button tone="secondary" onClick={retry}>
            {t('retry')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** One read: its skeleton while it loads, its refusal, its empty line, or its rows. */
export function MethodsLoad<T>({
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
  if (resource.status === 'loading')
    return (
      <div role="status" aria-label={uiCopy.t('loading')}>
        <Skeleton shape="rows" />
      </div>
    );
  if (resource.status === 'failed') return <MethodsFailure result={resource.failure} retry={retry} />;
  if (Array.isArray(resource.data) && !resource.data.length && empty)
    return <EmptyState title={empty} body={payCopy.t('refreshWhenActivityIsAvailableForThis')} />;
  return <>{children(resource.data)}</>;
}

/** A section of the room: its heading, which the index links to, a line under it, and its rows. */
export function MethodsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} data-testid="pay-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{title}</h2>
      {description ? <p className="lt-hint">{description}</p> : null}
      {children}
    </section>
  );
}

/** Something the person should know before they change anything, named by its title. */
export function MethodsNotice({ title, children }: { title: string; children: string }) {
  return (
    <section aria-label={title}>
      <RefusalBox refusal={{ variant: 'refused', title, body: children }} />
    </section>
  );
}

/** How many records the read returned; a full read says more may exist and offers to read up to `max`. */
export function MethodsPages({
  count,
  limit,
  max = 200,
  setLimit,
}: {
  count: number;
  limit: number;
  max?: number;
  setLimit: (limit: number) => void;
}) {
  const full = count === limit;
  return (
    <div className="lt-toolbar">
      <p className="lt-hint">
        {payCopy.t('recordsWindow', { count: String(count), limit: String(limit) })}
        {full ? payCopy.t('moreRecordsMayExist') : ''}
      </p>
      {full && limit < max ? (
        <Button tone="secondary" onClick={() => setLimit(max)}>
          {payCopy.t('showRecords', { max: String(max) })}
        </Button>
      ) : null}
      {full && limit === max ? <p className="lt-hint">{payCopy.t('thisServiceHasNoContinuationCursorThis')}</p> : null}
    </div>
  );
}

/** A record's state as the service names it ("enabled", "active"), its underscores as spaces. */
export function MethodStatus({ value }: { value: string }) {
  // The same four kinds as the rest of Pay: refused, done, waiting, and every other state (enabled, disabled) unmarked.
  const status = ['failed', 'rejected', 'cancelled'].includes(value)
    ? 'failed'
    : ['captured', 'settled', 'active', 'approved'].includes(value)
      ? 'done'
      : ['pending', 'open'].includes(value)
        ? 'pending'
        : undefined;
  return (
    <span className="lt-chip" data-status={status} lang="zxx">
      <span className="lt-chip-mark" aria-hidden="true" />
      {value.replaceAll('_', ' ')}
    </span>
  );
}

/** What the service said about a change: confirmed (the room shows the new state itself), or its refusal. */
function ChangeResult({ result, title }: { result: ApiResult<unknown> | null; title: string }) {
  if (!result) return null;
  return result.ok ? (
    <p className="lt-hint" role="status">
      {payCopy.t('theServiceConfirmedTheAction', { title })}
    </p>
  ) : (
    <MethodsFailure result={result} />
  );
}

/**
 * A change the person opens, reads and then confirms: the button opens a sheet with the review; the sheet's own button,
 * named the same, sends it. An answer for a review that was closed or replaced is dropped (`current` says whether the
 * review that asked is still the open one).
 */
export function ReviewedChange<T>({
  title,
  description,
  review,
  perform,
  onConfirmed,
  ready = true,
  notReadyReason,
}: {
  title: string;
  description: string;
  review: ReactNode;
  perform: (current: () => boolean) => Promise<ApiResult<T>>;
  onConfirmed?: (data: T) => void;
  ready?: boolean;
  notReadyReason?: string;
}) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiResult<T> | null>(null);
  const inFlight = useRef(false);
  const reviewId = useRef(0);
  const uncertain = Boolean(result && !result.ok && result.reason === 'uncertain');
  const close = () => {
    if (inFlight.current) return;
    reviewId.current += 1;
    setOpened(false);
  };
  async function confirm() {
    if (inFlight.current || !opened || !ready) return;
    const asked = reviewId.current;
    const current = () => reviewId.current === asked;
    inFlight.current = true;
    setBusy(true);
    try {
      const outcome = await perform(current);
      if (!current()) return;
      setResult(outcome);
      // Done, or an answer that is unknown: close the review so the outcome under the button is not covered.
      if (outcome.ok || outcome.reason === 'uncertain') {
        reviewId.current += 1;
        setOpened(false);
        if (outcome.ok) onConfirmed?.(outcome.data);
      }
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  return (
    <div>
      <Button
        tone="secondary"
        disabled={busy || uncertain}
        onClick={() => {
          if (inFlight.current) return;
          reviewId.current += 1;
          setResult(null);
          setOpened(true);
        }}
      >
        {title}
      </Button>
      <ChangeResult result={result} title={title} />
      {opened ? (
        <Sheet open title={payCopy.t('review', { title })} onClose={close}>
          <div data-testid="form-stack">
            <p className="lt-hint">{description}</p>
            {review}
            <ChangeResult result={result} title={title} />
            {!ready && notReadyReason ? <p className="lt-hint">{notReadyReason}</p> : null}
            <div className="lt-actions">
              <Button tone="primary" disabled={!ready || busy || uncertain} onClick={() => void confirm()}>
                {busy ? payCopy.t('waitingForConfirmation') : title}
              </Button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
