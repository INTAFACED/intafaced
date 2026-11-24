import type { ReactNode } from 'react';
import { Button, EmptyState } from '@intafaced/ui/lit';
import { isVerifyFirst, type ApiResult } from '../api';
import { VerifyFirstNote } from '../verify-first';
import { useFailureWords } from '../failure-words';
import type { Resource } from '../resource';
import { uiCopy } from '../ui-copy';

/**
 * The record rooms' small read parts, drawn with the Volt kit, for any feature. Each keeps the words, roles and ids of the
 * part it stands in for (`shared/ui` Failure and Loading, `features/more` Read), which other rooms still use as they are.
 */

/** A failed read or change, in the words the app's Failure says. */
export function FailureBox({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
  const w = useFailureWords(result, Boolean(retry));
  if (isVerifyFirst(result)) return <VerifyFirstNote code={result.code} />;
  return (
    <div data-testid="failure" className="lt-refusal" role={w.alert ? 'alert' : 'status'}>
      <h3 className="lt-refusal-title">{w.title}</h3>
      <p className="lt-refusal-body" lang={w.bodyLang}>
        {w.body}
      </p>
      {w.action && (
        <a className="lt-link" href={w.action.href}>
          {w.action.label}
        </a>
      )}
      {w.reference && <small className="lt-ref">{w.reference}</small>}
      {w.retry && retry && (
        <Button tone="secondary" onClick={retry}>
          {w.retry}
        </Button>
      )}
    </div>
  );
}

/** A table of records in a named region that scrolls on its own, as the app's DataTable lays one out: one header row, then the rows. */
export function RecordTable({ headers, children, label }: { headers: readonly ReactNode[]; children: ReactNode; label: string }) {
  return (
    <div tabIndex={0} role="region" aria-label={label}>
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

/** A read still on its way, in the words the app's Loading says. */
export function LoadingLine({ label }: { label?: ReactNode }) {
  const { Copy } = uiCopy.useCopy();
  return <p role="status">{label ?? <Copy k="loading" />}…</p>;
}

/**
 * A read's states, as `features/more` Read draws them: on its way, failed with its words and Try again, empty (when an
 * empty title is given and the answer is null or an empty list), or its data.
 */
export function ReadView<T>({
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
  if (resource.status === 'loading') return <LoadingLine />;
  if (resource.status === 'failed')
    return (
      <div lang="und">
        <FailureBox result={resource.failure} retry={retry} />
      </div>
    );
  if (empty && (resource.data === null || (Array.isArray(resource.data) && resource.data.length === 0)))
    return <EmptyState title={empty} />;
  return <>{children(resource.data)}</>;
}
