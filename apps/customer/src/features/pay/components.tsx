import { uiCopy, uiMessage } from '../../shared/ui-copy';
import { payCopy, PayCopy, payAuthoredMessage } from './copy';
import { isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiResult } from '../../shared/api';
import type { Resource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { Button, ReviewDialog as Dialog, StateBlock, Amount, StatusTag } from '@intafaced/ui';
import { EmptyState } from './ui-kit';
import type { MoneyKind } from './portal/access/money-step';
import { payStepUp } from './portal/access/step-up-store';
import { StepUpNote } from './portal/access/step-up';
import { stepUpRequired, stepUpWords } from './portal/access/step-up-words';

function Failure({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
  const { t, languageFor, requestedLocale } = uiCopy.useCopy();
  return (
    <div role={result.reason === 'uncertain' ? 'alert' : 'status'}>
      <StateBlock
        kind="refused"
        title={t(result.reason)}
        body={
          <span lang={result.messageCopy ? languageFor(result.messageCopy.key) : undefined}>
            {result.messageCopy ? uiMessage(result.messageCopy, requestedLocale) : result.message}
          </span>
        }
        action={
          result.reason === 'unauthorized'
            ? { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(location.pathname + location.search)}` }
            : retry && result.reason !== 'uncertain'
              ? { label: t('retry'), onClick: retry }
              : undefined
        }
      />
    </div>
  );
}

export function PayFailure({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
  const { requestedLocale } = payCopy.useCopy();
  const authored = payAuthoredMessage(result);
  return (
    <div lang={authored === undefined ? 'und' : requestedLocale}>
      <Failure result={authored === undefined ? result : { ...result, message: authored }} retry={retry} />
    </div>
  );
}

/**
 * "17 Oct, 21:43 UTC" ("17 Oct 2025, 21:43 UTC" in another year): the same day-month and 24-hour clock as the rest of the app,
 * always in UTC and always naming it, since Pay services record UTC. English uses day-month order, never "10/17/2026, 9:43 PM".
 */
export function payTimeText(value: string, locale: string, now: number = Date.now()): string | null {
  const at = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(at)) return null;
  const tag = locale.toLowerCase() === 'en' || locale.toLowerCase() === 'en-us' ? 'en-GB' : locale;
  const year = (ms: number) => new Date(ms).getUTCFullYear();
  const text = new Intl.DateTimeFormat(tag, {
    day: 'numeric',
    month: 'short',
    ...(year(at) === year(now) ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  }).format(at);
  return `${text} UTC`;
}

export function PayTime({ value }: { value: string }) {
  const { requestedLocale } = payCopy.useCopy();
  const text = payTimeText(value, requestedLocale);
  if (text === null) return <span lang="zxx">{value}</span>;
  return (
    <time dateTime={value} title={value} lang={requestedLocale}>
      {text}
    </time>
  );
}

export function PayState<T>({
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
  if (resource.status === 'loading') return <StateBlock kind="loading" label={uiCopy.t('loading')} />;
  if (resource.status === 'failed') return <PayFailure result={resource.failure} retry={retry} />;
  if (Array.isArray(resource.data) && !resource.data.length && empty)
    return (
      <EmptyState title={empty}>
        <PayCopy k="refreshWhenActivityIsAvailableForThis" />
      </EmptyState>
    );
  return <>{children(resource.data)}</>;
}
export function PayNotice({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="pay-notice" aria-label={title}>
      <span className="pay-status-dot" aria-hidden="true" />
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
        {action}
      </div>
    </section>
  );
}
export function PaySection({
  title,
  titleLanguage,
  description,
  action,
  children,
}: {
  title: string;
  titleLanguage?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-testid="pay-section" className="pay-section">
      <header>
        <div>
          <h2 lang={titleLanguage}>{title}</h2>
          {description && <p className="muted">{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
export function PayPagination({
  count,
  limit,
  max = 200,
  setLimit,
  fetched = count,
}: {
  /** Rows shown on screen. */
  count: number;
  limit: number;
  max?: number;
  setLimit: (limit: number) => void;
  /** Rows the read returned, when the screen shows fewer (a client-side filter such as "your offers"). A full read means more may exist. */
  fetched?: number;
}) {
  const full = fetched === limit;
  return (
    <div className="pay-pagination">
      <p className="muted">
        <PayCopy k="recordsWindow" params={{ count, limit }} />
        {full ? payCopy.t('moreRecordsMayExist') : ''}
      </p>
      {full && limit < max && (
        <Button variant="secondary" onClick={() => setLimit(max)}>
          <PayCopy k="showRecords" params={{ max }} />
        </Button>
      )}
      {full && limit === max && (
        <p className="muted">
          <PayCopy k="thisServiceHasNoContinuationCursorThis" />
        </p>
      )}
    </div>
  );
}
export function PayDetails({ values }: { values: [string, ReactNode, string?][] }) {
  return (
    <dl data-testid="pay-details" className="pay-details">
      {values.map(([label, value, labelLanguage]) => (
        <div key={label} className={isValidElement(value) && value.type === PayAmount ? 'pay-details-amount' : undefined}>
          <dt lang={labelLanguage}>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function PayAmount({ value, unit, label }: { value: string; unit: string; label: string }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const digits = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  const hintId = useId();
  const { requestedLocale } = payCopy.useCopy();
  const displayed = displayAmount(value);
  useEffect(() => {
    const region = viewport.current;
    const token = digits.current;
    if (!region || !token) return;
    const measure = () => setOverflows(region.scrollWidth > region.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    observer.observe(token);
    region.scrollLeft = 0;
    measure();
    return () => observer.disconnect();
  }, [value]);
  return (
    <span className="pay-exact-amount">
      <span className="pay-amount-value">
        <span
          data-testid="pay-amount-scroll"
          className="pay-amount-scroll"
          ref={viewport}
          tabIndex={overflows ? 0 : undefined}
          role={overflows ? 'region' : undefined}
          aria-label={overflows ? `${label} · ${unit}` : undefined}
          aria-describedby={overflows ? hintId : undefined}
          lang={requestedLocale}
          onKeyDown={(event) => {
            if (!overflows || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const region = event.currentTarget;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              region.scrollLeft += event.key === 'ArrowLeft' ? -40 : 40;
            } else if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault();
              region.scrollLeft = event.key === 'Home' ? 0 : region.scrollWidth;
            }
          }}
        >
          <span
            data-testid="pay-amount-digits"
            className="pay-amount-digits numeric"
            ref={digits}
            lang="zxx"
            data-exact-amount={value}
            onCopy={(event) => {
              const selection = window.getSelection();
              if (!selection || selection.rangeCount !== 1 || selection.toString() !== displayed) return;
              const range = selection.getRangeAt(0);
              if (!event.currentTarget.contains(range.startContainer) || !event.currentTarget.contains(range.endContainer)) return;
              event.clipboardData.setData('text/plain', value);
              event.preventDefault();
            }}
          >
            <Amount value={displayed} sensitive={false} />
          </span>
        </span>{' '}
        <span data-testid="pay-amount-unit" className="pay-amount-unit" lang="zxx">
          {unit}
        </span>
      </span>
      {overflows && (
        <span className="pay-amount-hint" id={hintId} lang={requestedLocale}>
          <PayCopy k="scrollFullAmount" />
        </span>
      )}
    </span>
  );
}
export function Status({ value }: { value: string }) {
  return (
    <StatusTag
      status={
        ['failed', 'rejected', 'cancelled'].includes(value)
          ? 'failed'
          : ['captured', 'settled', 'active', 'approved'].includes(value)
            ? 'filled'
            : ['pending', 'open'].includes(value)
              ? 'pending'
              : 'working'
      }
      label={value.replaceAll('_', ' ')}
      lang="zxx"
    />
  );
}
/** `refreshed`: the page already shows the new state itself, so it does not tell the person to refresh. */
export function MutationResult({
  result,
  title,
  refreshed = false,
}: {
  result: ApiResult<unknown> | null;
  title: string;
  refreshed?: boolean;
}) {
  if (!result) return null;
  return result.ok ? (
    <p className="pay-confirmed" role="status">
      <PayCopy k={refreshed ? 'theServiceConfirmedTheAction' : 'theServiceConfirmedTheActionRefreshThe'} params={{ title }} />
    </p>
  ) : (
    <PayFailure result={result} />
  );
}
export function ReviewedAction<T>({
  title,
  description,
  review,
  perform,
  onConfirmed,
  disabled = false,
  disabledReason,
  variant = 'secondary',
  stepUp,
  ready = true,
  notReadyReason,
}: {
  title: string;
  description: string;
  review?: ReactNode;
  perform: (currentReview: () => boolean) => Promise<ApiResult<T>>;
  onConfirmed?: (data: T) => void;
  disabled?: boolean;
  disabledReason?: string;
  variant?: 'primary' | 'secondary' | 'sell';
  /**
   * Money leaving the account. Opening the action first asks "Confirm it's you" (a passkey or an authenticator code);
   * the review opens once that is done. If the confirmation runs out before the send, the person confirms again and the
   * same `perform` runs once more, so the same request id goes out. See `portal/access/step-up-store.ts`.
   */
  stepUp?: MoneyKind;
  /** The review's own confirm stays off until the person has done what the review asks (a checklist, for example). */
  ready?: boolean;
  notReadyReason?: string;
}) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiResult<T> | null>(null);
  const inFlight = useRef(false);
  const asking = useRef(false);
  const lifetime = useRef({ mounted: true, opened, disabled, ready, review: 0 });
  const reviewId = lifetime.current.review;
  useLayoutEffect(() => {
    lifetime.current.opened = opened;
    lifetime.current.disabled = disabled;
    lifetime.current.ready = ready;
  });
  useLayoutEffect(() => {
    lifetime.current.mounted = true;
    return () => {
      lifetime.current.mounted = false;
    };
  }, []);
  const currentReview = () => lifetime.current.mounted && lifetime.current.opened && lifetime.current.review === reviewId;
  async function confirm() {
    if (inFlight.current || !currentReview() || lifetime.current.disabled || !lifetime.current.ready) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const outcome = stepUp ? await payStepUp.run(stepUp, () => perform(currentReview), stepUpWords) : await perform(currentReview);
      if (!currentReview()) return;
      setResult(outcome);
      if (outcome.ok) {
        lifetime.current.opened = false;
        lifetime.current.review += 1;
        onConfirmed?.(outcome.data);
        setOpened(false);
      } else if (outcome.reason === 'uncertain') {
        // The answer is unknown: close the review so the recovery message and its check button are not covered.
        lifetime.current.opened = false;
        lifetime.current.review += 1;
        setOpened(false);
      }
    } finally {
      if (lifetime.current.mounted) setBusy(false);
      inFlight.current = false;
    }
  }
  return (
    <div className="pay-action" title={disabled ? disabledReason : undefined}>
      <Button
        variant={variant}
        disabled={disabled || busy || Boolean(result && !result.ok && result.reason === 'uncertain')}
        onClick={() => {
          if (!lifetime.current.mounted || lifetime.current.disabled || inFlight.current || asking.current) return;
          if (!stepUp) {
            lifetime.current.review += 1;
            setResult(null);
            setOpened(true);
            return;
          }
          // Money out: confirm it's them first, then show the review.
          asking.current = true;
          void payStepUp.ensure(stepUp).then((confirmed) => {
            asking.current = false;
            if (!lifetime.current.mounted || lifetime.current.disabled) return;
            if (!confirmed) {
              // Declining is the person's own choice and needs no message; a page with no one to ask says what is needed.
              setResult(payStepUp.canAsk ? null : stepUpRequired());
              return;
            }
            lifetime.current.review += 1;
            setResult(null);
            setOpened(true);
          });
        }}
      >
        {title}
      </Button>
      <MutationResult result={result} title={title} refreshed={Boolean(onConfirmed)} />
      {opened && (
        <Dialog
          closeLabel={uiCopy.t('closeDialog')}
          title={payCopy.t('review', { title: title })}
          onClose={() => {
            if (!inFlight.current) {
              lifetime.current.opened = false;
              lifetime.current.review += 1;
              setOpened(false);
            }
          }}
        >
          <div data-testid="form-stack" className="form-stack">
            <p className="muted">{description}</p>
            {review}
            {stepUp && <StepUpNote kind={stepUp} />}
            <MutationResult result={result} title={title} refreshed={Boolean(onConfirmed)} />
            {!ready && notReadyReason ? <p className="muted">{notReadyReason}</p> : null}
            <Button
              variant={variant}
              disabled={!ready || busy || Boolean(result && !result.ok && result.reason === 'uncertain')}
              onClick={() => void confirm()}
            >
              {busy ? payCopy.t('waitingForConfirmation') : title}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
