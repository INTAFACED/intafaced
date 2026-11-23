/**
 * The parts the More and Algo dev rooms on the kit share (intafaced issue 9568): a read's waiting, failed and empty answers, a
 * section with its heading, and a table that scrolls in its own named region. Drawn only from the kit's `lt-` classes and
 * parts; the words of a failure are the shared `Failure`'s (`shared/failure-words.ts`).
 */
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import type { ApiResult } from '../../shared/api';
import { useFailureWords } from '../../shared/failure-words';
import type { Resource } from '../../shared/resource';
import { uiCopy } from '../../shared/ui-copy';
import { t as copyText } from './copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** A failed read or write: what happened in plain words, the support reference, and Try again when it can help. */
export function FailureNote({ result, retry }: { result: Failed; retry?: () => void }) {
  const words = useFailureWords()(result);
  return (
    <div data-testid="failure" className="lt-refusal" role={words.role}>
      <h3 className="lt-refusal-title">{words.title}</h3>
      <p className="lt-refusal-body" lang={words.bodyLang}>
        {words.body}
      </p>
      {words.action ? (
        <a className="lt-link" href={words.action.href}>
          {words.action.label}
        </a>
      ) : null}
      {words.reference ? <p className="lt-ref">{words.reference}</p> : null}
      {retry && words.retry ? (
        <Button tone="secondary" onClick={retry}>
          {words.retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

/** Data on its way; `label` says what, when it is more than loading. */
export function Waiting({ label }: { label?: ReactNode }) {
  const { t } = uiCopy.useCopy();
  return <p role="status">{label ?? t('loading')}…</p>;
}

/** Nothing to show yet, said as such, with its heading. */
export function EmptyNote({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="lt-empty">
      <h3 className="lt-empty-title">{title}</h3>
      {children ? <p className="lt-empty-body">{children}</p> : null}
      {action}
    </div>
  );
}

/** One read's answer: waiting, its failure, empty, or the data. */
export function KitRead<T>({
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
  if (resource.status === 'loading') return <Waiting />;
  if (resource.status === 'failed')
    return (
      <div lang="und">
        <FailureNote result={resource.failure} retry={retry} />
      </div>
    );
  if (empty && (resource.data === null || (Array.isArray(resource.data) && resource.data.length === 0))) return <EmptyNote title={empty} />;
  return <>{children(resource.data)}</>;
}

/** A section of a room under its own heading. */
export function Section({ title, children, ...rest }: Omit<ComponentPropsWithoutRef<'section'>, 'title'> & { title?: ReactNode }) {
  return (
    <section {...rest}>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  );
}

/** A table in a region of its own, named, that scrolls by keyboard when it is wider than the room. */
export function ScrollTable({ label, headers, children }: { label: string; headers: readonly ReactNode[]; children: ReactNode }) {
  return (
    <div role="region" aria-label={label} tabIndex={0}>
      <table className="lt-table">
        <thead>
          <tr>
            {headers.map((head, index) => (
              <th key={index} scope="col">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** How many rows a read returned of the window asked for, and a larger window while the service's cap allows one. */
export function KitLimit({
  count,
  limit,
  cap,
  onChange,
}: {
  count: number;
  limit: number;
  cap: number;
  onChange: (limit: number) => void;
}) {
  return (
    <div className="lt-stack">
      <small className="lt-hint">
        {copyText('common.showing')}
        {count}
        {copyText('common.requested.limit')}
        {limit}
        {copyText('common.this.service.publishes.no.continuation.cursor')}
      </small>
      {count >= limit && limit < cap ? (
        <Button tone="secondary" onClick={() => onChange(Math.min(cap, limit + 50))}>
          {copyText('common.load.a.larger.window')}
        </Button>
      ) : count >= cap ? (
        <small className="lt-hint">
          {copyText('common.the.published.limit.is')}
          {cap}
          {copyText('common.older.rows.cannot.be.requested.here')}
        </small>
      ) : null}
    </div>
  );
}
