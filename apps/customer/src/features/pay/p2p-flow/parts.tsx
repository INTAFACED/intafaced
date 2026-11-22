import { useAmountOverflow } from '../../../shared/amount-overflow';
import { useId, type ReactNode } from 'react';
import { Button, EmptyState, RefusalBox } from '@intafaced/ui/lit';
import { KeyValue, Sheet, Skeleton, StatusChip, Tabs } from '@intafaced/ui/lit/templates';
import type { MoneyStatus } from '@intafaced/ui/lit';
import type { ApiResult } from '../../../shared/api';
import type { Resource } from '../../../shared/resource';
import { displayAmount } from '../../../shared/money';
import { uiCopy, uiMessage } from '../../../shared/ui-copy';
import { payAuthoredMessage, payCopy } from '../copy';
import { payTimeText } from '../components';
import { useReviewedAction } from '../reviewed-action';

/**
 * The person-to-person flow rooms' kit views of the Pay parts (`../components.tsx`): the same words, states, ids and
 * handlers, drawn only from `@intafaced/ui/lit`. The data and the reviewed-action state are the originals' own
 * (`../reviewed-action.ts`, `payTimeText`); only the markup is the kit's.
 */

/**
 * The head every person-to-person flow room starts its step with: the "Personal Pay" line and the five P2P rooms, the
 * open one marked (`current` is its href; none on Create and Edit offer, as before).
 */
export function P2PHead({ current }: { current: '/uc/ad' | '/p2p/access' | '' }) {
  return (
    <>
      <p className="lt-hint">{payCopy.t('personalPay')}</p>
      <div
        onFocus={(event) => {
          if (event.target instanceof HTMLAnchorElement) event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }}
      >
        <Tabs
          label={payCopy.t('p2pRooms')}
          current={current}
          items={[
            { label: payCopy.t('offers'), href: '/p2p' },
            { label: payCopy.t('yourOrders'), href: '/uc/order' },
            { label: payCopy.t('yourOffers'), href: '/uc/ad' },
            { label: payCopy.t('paymentMethods'), href: '/p2p/methods' },
            { label: payCopy.t('tradingAccess'), href: '/p2p/access' },
          ]}
        />
      </div>
    </>
  );
}

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

function FailureView({ result, retry }: { result: Failed; retry?: () => void }) {
  const { t, languageFor, requestedLocale } = uiCopy.useCopy();
  const signIn = result.reason === 'unauthorized';
  return (
    <div role={result.reason === 'uncertain' ? 'alert' : 'status'}>
      <div lang={result.messageCopy ? languageFor(result.messageCopy.key) : undefined}>
        <RefusalBox
          refusal={{
            variant: 'refused',
            title: t(result.reason),
            body: result.messageCopy ? uiMessage(result.messageCopy, requestedLocale) : result.message,
            ...(signIn
              ? { action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(location.pathname + location.search)}` } }
              : {}),
          }}
        />
      </div>
      {!signIn && retry && result.reason !== 'uncertain' ? <Button onClick={retry}>{t('retry')}</Button> : null}
    </div>
  );
}

/** `PayFailure`: a refused or failed call, in the service's authored words when it has them. */
export function Failure({ result, retry }: { result: Failed; retry?: () => void }) {
  const { requestedLocale } = payCopy.useCopy();
  const authored = payAuthoredMessage(result);
  return (
    <div lang={authored === undefined ? 'und' : requestedLocale}>
      <FailureView result={authored === undefined ? result : { ...result, message: authored }} retry={retry} />
    </div>
  );
}

/** `PayTime`: a UTC time in the app's day-month form. */
export function Time({ value }: { value: string }) {
  const { requestedLocale } = payCopy.useCopy();
  const text = payTimeText(value, requestedLocale);
  if (text === null) return <span lang="zxx">{value}</span>;
  return (
    <time dateTime={value} title={value} lang={requestedLocale}>
      {text}
    </time>
  );
}

/** `PayState`: loading, failed, empty, then the data. */
export function State<T>({
  resource,
  retry,
  empty,
  shape = 'rows',
  children,
}: {
  resource: Resource<T>;
  retry: () => void;
  empty?: string;
  shape?: 'rows' | 'form' | 'text';
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'loading')
    return (
      <div data-kind="loading" role="status" aria-busy="true" aria-label={uiCopy.t('loading')}>
        <Skeleton shape={shape} />
      </div>
    );
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={retry} />;
  if (Array.isArray(resource.data) && !resource.data.length && empty)
    return <EmptyState title={empty} body={payCopy.t('refreshWhenActivityIsAvailableForThis')} />;
  return <>{children(resource.data)}</>;
}

/** `PayNotice`: a named notice in the room. */
export function Notice({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </section>
  );
}

/** `PaySection`: a titled part of the room, with one action beside its title. */
export function Section({
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
    <section data-testid="pay-section">
      <header className="lt-toolbar">
        <div>
          <h2 lang={titleLanguage}>{title}</h2>
          {description && <p className="lt-hint">{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** `PayDetails`: label and value rows. */
export function Details({ values, label }: { values: [string, ReactNode, string?][]; label?: string }) {
  return <KeyValue label={label} rows={values.map(([rowLabel, value]) => ({ label: rowLabel, value }))} />;
}

/** `PayAmount`: an exact decimal with its unit; copying the shown figure copies the exact one. */
export function Amount({ value, unit, label }: { value: string; unit: string; label: string }) {
  const { viewport, digits, overflows } = useAmountOverflow(value);
  const hintId = useId();
  const { requestedLocale } = payCopy.useCopy();
  const displayed = displayAmount(value);
  return (
    <span>
      <span
        className="lt-scroll-row"
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
          className="lt-mono"
          ref={digits}
          lang="zxx"
          dir="ltr"
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
          {displayed}
        </span>
      </span>{' '}
      <span lang="zxx">{unit}</span>
      {overflows && (
        <span className="lt-hint" id={hintId} lang={requestedLocale}>
          {payCopy.t('scrollFullAmount')}
        </span>
      )}
    </span>
  );
}

const statusOf = (value: string): MoneyStatus =>
  ['failed', 'rejected', 'cancelled'].includes(value)
    ? 'failed'
    : ['captured', 'settled', 'active', 'approved'].includes(value)
      ? 'done'
      : ['pending', 'open'].includes(value)
        ? 'pending'
        : 'unknown';

/** `Status`: a service's own status word, with its shape mark. */
export function Status({ value }: { value: string }) {
  return (
    <span lang="zxx">
      <StatusChip status={statusOf(value)} label={value.replaceAll('_', ' ')} />
    </span>
  );
}

/** `MutationResult`: what the service said to an action. */
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
    <p role="status">{payCopy.t(refreshed ? 'theServiceConfirmedTheAction' : 'theServiceConfirmedTheActionRefreshThe', { title })}</p>
  ) : (
    <Failure result={result} />
  );
}

/** `PayPagination`: how many records the read returned, and the one way to read more. */
export function Pagination({
  count,
  limit,
  max = 200,
  setLimit,
  fetched = count,
}: {
  count: number;
  limit: number;
  max?: number;
  setLimit: (limit: number) => void;
  fetched?: number;
}) {
  const full = fetched === limit;
  return (
    <div>
      <p className="lt-hint">
        {payCopy.t('recordsWindow', { count, limit })}
        {full ? payCopy.t('moreRecordsMayExist') : ''}
      </p>
      {full && limit < max && <Button onClick={() => setLimit(max)}>{payCopy.t('showRecords', { max })}</Button>}
      {full && limit === max && <p className="lt-hint">{payCopy.t('thisServiceHasNoContinuationCursorThis')}</p>}
    </div>
  );
}

/**
 * `ReviewedAction`: the press opens a review sheet; its button performs once. The state is `useReviewedAction`, the
 * same one the old view runs. None of these rooms' actions moves money, so none asks "Confirm it's you".
 */
export function ReviewedAction<T>({
  title,
  description,
  review,
  perform,
  onConfirmed,
  disabled = false,
  disabledReason,
  variant = 'secondary',
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
  variant?: 'primary' | 'secondary';
  ready?: boolean;
  notReadyReason?: string;
}) {
  const { opened, busy, result, uncertain, open, close, confirm } = useReviewedAction({ perform, onConfirmed, disabled, ready });
  return (
    <div title={disabled ? disabledReason : undefined}>
      <Button tone={variant} disabled={disabled || busy || uncertain} onClick={open}>
        {title}
      </Button>
      <MutationResult result={result} title={title} refreshed={Boolean(onConfirmed)} />
      {opened && (
        <Sheet open title={payCopy.t('review', { title })} dismissible={!busy} onClose={close}>
          <div data-testid="form-stack">
            <p className="lt-hint">{description}</p>
            {review}
            <MutationResult result={result} title={title} refreshed={Boolean(onConfirmed)} />
            {!ready && notReadyReason ? <p className="lt-hint">{notReadyReason}</p> : null}
            <Button tone={variant} disabled={!ready || busy || uncertain} onClick={() => void confirm()}>
              {busy ? payCopy.t('waitingForConfirmation') : title}
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
