import { payCopy, PayCopy, payAuthoredMessage } from './copy';
import { useRef, useState, type ReactNode } from 'react';
import type { ApiResult } from '../../shared/api';
import type { Resource } from '../../shared/resource';
import { Button, Dialog, EmptyState, Failure, Loading } from '../../shared/ui';

export function PayFailure({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
  const { requestedLocale } = payCopy.useCopy();
  const authored = payAuthoredMessage(result);
  return (
    <div lang={authored === undefined ? 'und' : requestedLocale}>
      <Failure result={authored === undefined ? result : { ...result, message: authored }} retry={retry} />
    </div>
  );
}

export function PayTime({ value }: { value: string }) {
  const { requestedLocale } = payCopy.useCopy();
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(date.getTime())) return <span lang="zxx">{value}</span>;
  return (
    <time dateTime={value} title={value} lang={requestedLocale}>
      {date.toLocaleString(requestedLocale, { timeZone: 'UTC', timeZoneName: 'short' })}
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
  if (resource.status === 'loading') return <Loading />;
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
    <section className="pay-section">
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
}: {
  count: number;
  limit: number;
  max?: number;
  setLimit: (limit: number) => void;
}) {
  return (
    <div className="pay-pagination">
      <p className="muted">
        <PayCopy k="recordsWindow" params={{ count, limit }} />
        {count === limit ? payCopy.t('moreRecordsMayExist') : ''}
      </p>
      {count === limit && limit < max && (
        <Button variant="secondary" onClick={() => setLimit(max)}>
          <PayCopy k="showRecords" params={{ max }} />
        </Button>
      )}
      {count === limit && limit === max && (
        <p className="muted">
          <PayCopy k="thisServiceHasNoContinuationCursorThis" />
        </p>
      )}
    </div>
  );
}
export function PayDetails({ values }: { values: [string, ReactNode, string?][] }) {
  return (
    <dl className="pay-details">
      {values.map(([label, value, labelLanguage]) => (
        <div key={label}>
          <dt lang={labelLanguage}>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function Status({ value }: { value: string }) {
  return (
    <span className="pay-status" lang="zxx">
      {value.replaceAll('_', ' ')}
    </span>
  );
}
export function MutationResult({ result }: { result: ApiResult<unknown> | null }) {
  if (!result) return null;
  return result.ok ? (
    <p className="pay-confirmed" role="status">
      <PayCopy k="theServiceConfirmedTheActionRefreshThe" />
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
  variant = 'secondary',
}: {
  title: string;
  description: string;
  review?: ReactNode;
  perform: () => Promise<ApiResult<T>>;
  onConfirmed?: (data: T) => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiResult<T> | null>(null);
  const inFlight = useRef(false);
  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const outcome = await perform();
      setResult(outcome);
      if (outcome.ok) {
        onConfirmed?.(outcome.data);
        setOpened(false);
      }
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  return (
    <div className="pay-action">
      <Button
        variant={variant}
        disabled={disabled || busy || Boolean(result && !result.ok && result.reason === 'uncertain')}
        onClick={() => {
          setResult(null);
          setOpened(true);
        }}
      >
        {title}
      </Button>
      <MutationResult result={result} />
      {opened && (
        <Dialog
          title={payCopy.t('review', { title: title })}
          onClose={() => {
            if (!busy) setOpened(false);
          }}
        >
          <div className="form-stack">
            <p className="muted">{description}</p>
            {review}
            <MutationResult result={result} />
            <Button
              variant={variant}
              disabled={busy || Boolean(result && !result.ok && result.reason === 'uncertain')}
              onClick={() => void confirm()}
            >
              {busy ? payCopy.t('waitingForConfirmation') : payCopy.t('confirm', { value1: title.toLowerCase() })}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
