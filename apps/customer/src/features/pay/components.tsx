import { uiCopy, uiMessage } from '../../shared/ui-copy';
import { payCopy, PayCopy, payAuthoredMessage } from './copy';
import { isValidElement, useId, useRef, type ReactNode } from 'react';
import { useOverflows } from '../../shared/use-overflows';
import type { ApiResult } from '../../shared/api';
import type { Resource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { Button, ReviewDialog as Dialog, StateBlock, Amount, StatusTag } from '@intafaced/ui';
import { EmptyState } from './ui-kit';
import type { MoneyKind } from './portal/access/money-step';
import { StepUpNote } from './portal/access/step-up';
import { useReviewedAction } from './reviewed-action';

export { useReviewedAction } from './reviewed-action';
export { PayTime, payTimeText } from './pay-time';

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
          {description && <p className="lt-muted">{description}</p>}
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
      <p className="lt-muted">
        <PayCopy k="recordsWindow" params={{ count, limit }} />
        {full ? payCopy.t('moreRecordsMayExist') : ''}
      </p>
      {full && limit < max && (
        <Button variant="secondary" onClick={() => setLimit(max)}>
          <PayCopy k="showRecords" params={{ max }} />
        </Button>
      )}
      {full && limit === max && (
        <p className="lt-muted">
          <PayCopy k="thisServiceHasNoContinuationCursorThis" />
        </p>
      )}
    </div>
  );
}
export function PayDetails({ values }: { values: [string, ReactNode, string?][] }) {
  return (
    <dl className="pay-details" data-testid="pay-details">
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
  const overflows = useOverflows(viewport, digits, value);
  const hintId = useId();
  const { requestedLocale } = payCopy.useCopy();
  const displayed = displayAmount(value);
  return (
    <span className="pay-exact-amount">
      <span className="pay-amount-value">
        <span
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
        <span className="pay-amount-unit" lang="zxx">
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
function MutationResult({ result, title, refreshed = false }: { result: ApiResult<unknown> | null; title: string; refreshed?: boolean }) {
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
  const { opened, busy, result, unknown, open, close, confirm } = useReviewedAction({ perform, onConfirmed, disabled, stepUp, ready });
  return (
    <div className="pay-action" title={disabled ? disabledReason : undefined}>
      <Button variant={variant} disabled={disabled || busy || unknown} onClick={open}>
        {title}
      </Button>
      <MutationResult result={result} title={title} refreshed={Boolean(onConfirmed)} />
      {opened && (
        <Dialog closeLabel={uiCopy.t('closeDialog')} title={payCopy.t('review', { title: title })} onClose={close}>
          <div data-testid="form-stack" className="lt-stack">
            <p className="lt-muted">{description}</p>
            {review}
            {stepUp && <StepUpNote kind={stepUp} />}
            <MutationResult result={result} title={title} refreshed={Boolean(onConfirmed)} />
            {!ready && notReadyReason ? <p className="lt-muted">{notReadyReason}</p> : null}
            <Button variant={variant} disabled={!ready || busy || unknown} onClick={() => void confirm()}>
              {busy ? payCopy.t('waitingForConfirmation') : title}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
