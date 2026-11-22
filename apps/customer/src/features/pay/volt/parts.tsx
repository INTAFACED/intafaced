/**
 * Personal Pay's shared parts for a room on its Volt template, drawn only from the kit (`@intafaced/ui/lit`, its
 * templates and their `lt-` classes). Each keeps the words, roles, names and test ids of the part it stands in for in
 * `../components.tsx` and `../ui-kit.tsx`, so a room moves onto the kit without a test or a journey noticing; what a
 * reviewed action does is `../reviewed-action.ts`, shared with the old look, so both behave exactly alike.
 */
import { useId, useRef, type ReactNode } from 'react';
import { useOverflows } from '../../../shared/use-overflows';
import { Button } from '@intafaced/ui/lit';
import { Dialog, Skeleton, StatusChip } from '@intafaced/ui/lit/templates';
import { uiCopy, uiMessage } from '../../../shared/ui-copy';
import type { ApiResult } from '../../../shared/api';
import type { Resource } from '../../../shared/resource';
import { displayAmount } from '../../../shared/money';
import { payCopy, PayCopy, payAuthoredMessage } from '../copy';
import type { MoneyKind } from '../portal/access/money-step';
import { StepUpNote } from '../portal/access/step-up';
import { useReviewedAction } from '../reviewed-action';

export { PayTime, payTimeText } from '../pay-time';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** A refusal in plain words, with signing in or trying again where either can help (`PayFailure` in `../components`). */
export function PayFailure({ result, retry }: { result: Failed; retry?: () => void }) {
  const { requestedLocale } = payCopy.useCopy();
  const { t, languageFor, requestedLocale: uiLocale } = uiCopy.useCopy();
  const authored = payAuthoredMessage(result);
  const shown = authored === undefined ? result : { ...result, message: authored };
  return (
    <div lang={authored === undefined ? 'und' : requestedLocale}>
      <div
        className="lt-refusal"
        data-refusal={shown.reason === 'uncertain' ? 'unreachable' : 'refused'}
        role={shown.reason === 'uncertain' ? 'alert' : 'status'}
      >
        <h3 className="lt-refusal-title">{t(shown.reason)}</h3>
        <p className="lt-refusal-body">
          <span lang={shown.messageCopy ? languageFor(shown.messageCopy.key) : undefined}>
            {shown.messageCopy ? uiMessage(shown.messageCopy, uiLocale) : shown.message}
          </span>
        </p>
        {shown.reason === 'unauthorized' ? (
          <a className="lt-link" href={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`}>
            {t('signIn')}
          </a>
        ) : retry && shown.reason !== 'uncertain' ? (
          <Button tone="secondary" onClick={retry}>
            {t('retry')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Nothing here yet, said honestly, with a caller-owned action (`EmptyState` in `../ui-kit`). */
export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div data-slot="empty-state" className="lt-empty">
      <h3 className="lt-empty-title">{title}</h3>
      {children ? <p className="lt-empty-body">{children}</p> : null}
      {action ? <div className="lt-actions">{action}</div> : null}
    </div>
  );
}

/** The shape of what is coming, announced once to assistive tech. */
export function PayLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label={uiCopy.t('loading')}>
      <Skeleton shape="rows" count={rows} />
    </div>
  );
}

/** Loading, refused and empty for one read (`PayState` in `../components`). */
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
  if (resource.status === 'loading') return <PayLoading />;
  if (resource.status === 'failed') return <PayFailure result={resource.failure} retry={retry} />;
  if (Array.isArray(resource.data) && !resource.data.length && empty)
    return (
      <EmptyState title={empty}>
        <PayCopy k="refreshWhenActivityIsAvailableForThis" />
      </EmptyState>
    );
  return <>{children(resource.data)}</>;
}

/** Something the person should know before going on, named by its title. */
export function PayNotice({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="lt-held" aria-label={title}>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </section>
  );
}

/** One part of a room: its heading, a line on what it is for, its one action and its rows. */
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
    <section data-testid="pay-section">
      <h2 lang={titleLanguage}>{title}</h2>
      {description && <p className="lt-hint">{description}</p>}
      {action ? <div className="lt-actions">{action}</div> : null}
      {children}
    </section>
  );
}

/** How many rows are shown, and the one way to ask for more. */
export function PayPagination({
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
    <div className="lt-actions">
      <p className="lt-hint">
        <PayCopy k="recordsWindow" params={{ count, limit }} />
        {full ? payCopy.t('moreRecordsMayExist') : ''}
      </p>
      {full && limit < max && (
        <Button tone="secondary" onClick={() => setLimit(max)}>
          <PayCopy k="showRecords" params={{ max }} />
        </Button>
      )}
      {full && limit === max && (
        <p className="lt-hint">
          <PayCopy k="thisServiceHasNoContinuationCursorThis" />
        </p>
      )}
    </div>
  );
}

/** Label and value rows; a label in its own language when it has one. */
export function PayDetails({ values }: { values: [string, ReactNode, string?][] }) {
  return (
    <dl className="lt-kv" data-testid="pay-details">
      {values.map(([label, value, labelLanguage]) => (
        <div key={label}>
          <dt lang={labelLanguage}>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * An exact amount and its unit. A figure wider than its place scrolls in its own named region, by arrow keys too, and
 * copying the whole shown figure copies the exact decimal (`PayAmount` in `../components`).
 */
export function PayAmount({ value, unit, label }: { value: string; unit: string; label: string }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const digits = useRef<HTMLSpanElement>(null);
  const overflows = useOverflows(viewport, digits, value);
  const hintId = useId();
  const { requestedLocale } = payCopy.useCopy();
  const displayed = displayAmount(value);
  return (
    <span>
      <span>
        <span
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
      </span>
      {overflows && (
        <span className="lt-hint" id={hintId} lang={requestedLocale}>
          <PayCopy k="scrollFullAmount" />
        </span>
      )}
    </span>
  );
}

const STATUS_LOOK = (value: string) =>
  ['failed', 'rejected', 'cancelled'].includes(value)
    ? 'failed'
    : ['captured', 'settled', 'active', 'approved'].includes(value)
      ? 'done'
      : ['pending', 'open'].includes(value)
        ? 'pending'
        : 'unknown';

/** A service status in its own words, with the kit's shape mark (`Status` in `../components`). */
export function Status({ value }: { value: string }) {
  return (
    <span lang="zxx">
      <StatusChip status={STATUS_LOOK(value)} label={value.replaceAll('_', ' ')} />
    </span>
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
    <p className="lt-hint" role="status">
      <PayCopy k={refreshed ? 'theServiceConfirmedTheAction' : 'theServiceConfirmedTheActionRefreshThe'} params={{ title }} />
    </p>
  ) : (
    <PayFailure result={result} />
  );
}

const TONE = { primary: 'primary', secondary: 'secondary', sell: 'primary' } as const;

/**
 * A step reviewed before it is sent (`ReviewedAction` in `../components`): the button opens the review in the kit's
 * dialog, which sends once and closes on a yes or an unknown answer. Money out asks "Confirm it's you" first.
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
  stepUp?: MoneyKind;
  ready?: boolean;
  notReadyReason?: string;
}) {
  const { opened, busy, result, unknown, open, close, confirm } = useReviewedAction({ perform, onConfirmed, disabled, stepUp, ready });
  return (
    <div className="lt-actions" title={disabled ? disabledReason : undefined}>
      <Button tone={TONE[variant]} disabled={disabled || busy || unknown} onClick={open}>
        {title}
      </Button>
      <MutationResult result={result} title={title} refreshed={Boolean(onConfirmed)} />
      {opened && (
        <Dialog closeLabel={uiCopy.t('closeDialog')} title={payCopy.t('review', { title: title })} onClose={close}>
          <div data-testid="form-stack" className="lt-stack">
            <p className="lt-hint">{description}</p>
            {review}
            {stepUp && <StepUpNote kind={stepUp} />}
            <MutationResult result={result} title={title} refreshed={Boolean(onConfirmed)} />
            {!ready && notReadyReason ? <p className="lt-hint">{notReadyReason}</p> : null}
            <Button tone={TONE[variant]} disabled={!ready || busy || unknown} onClick={() => void confirm()}>
              {busy ? payCopy.t('waitingForConfirmation') : title}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** A labelled native input, its hint or error tied to it: the kit's own Field (`Field` in `../ui-kit`). */
export { Field } from '@intafaced/ui/lit';
