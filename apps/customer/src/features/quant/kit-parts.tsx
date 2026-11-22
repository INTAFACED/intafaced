import type { ReactNode } from 'react';
import { Button, EmptyState } from '@intafaced/ui/lit';
import { isServiceNotConnected, type ApiResult } from '../../shared/api';
import { canTryAgain, embeddedKey, RAW_CODE } from '../../shared/failure-words';
import type { Resource } from '../../shared/resource';
import { uiCopy, uiMessage } from '../../shared/ui-copy';
import { refusalCopy } from '../../data/refusals';

/**
 * The Algo dev rooms' reading parts, drawn from the Volt kit only: a read's loading line, its failure in words, and a
 * table. Each says and does what the app's shared `Read`, `Failure`, `Loading` and `DataTable` do (same words, roles,
 * test ids and Try again rule); only the look is the kit's.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

export function KitLoading({ label }: { label?: ReactNode }) {
  const { Copy } = uiCopy.useCopy();
  return (
    <p className="lt-hint" role="status">
      {label ?? <Copy k="loading" />}…
    </p>
  );
}

/** A failed call in words: the same choices as the shared Failure, drawn as the kit's refusal. */
export function KitFailure({ result, retry }: { result: Failed; retry?: () => void }) {
  const { Copy, languageFor, requestedLocale } = uiCopy.useCopy();
  const again =
    retry && canTryAgain(result) ? (
      <Button onClick={retry}>
        <Copy k="retry" />
      </Button>
    ) : null;
  if (isServiceNotConnected(result.code)) {
    // The gateway's own text is never shown for this answer: say plainly that the service is not connected here.
    return (
      <div data-testid="failure" className="lt-refusal" data-refusal="unreachable" role="status">
        <h3 className="lt-refusal-title">
          <Copy k="not_mounted" />
        </h3>
        <p className="lt-refusal-body">
          <Copy k="serviceNotConnected" />
        </p>
      </div>
    );
  }
  const rawCode = RAW_CODE.test(result.message.trim()) ? result.message.trim() : result.code ? embeddedKey(result.message) : undefined;
  if (rawCode && !result.messageCopy) {
    // Customers never read a raw code: use the same plain sentences the other rooms use for typed refusals.
    const words = refusalCopy(result.code ?? rawCode);
    // A write that may have gone through is never called refused or unchanged; the code only gives the support reference.
    const uncertain = result.reason === 'uncertain';
    return (
      <div data-testid="failure" className="lt-refusal" data-refusal="refused" role={uncertain ? 'alert' : 'status'}>
        <h3 className="lt-refusal-title">{uncertain ? <Copy k="uncertain" /> : words.title}</h3>
        <p className="lt-refusal-body">{uncertain ? <Copy k="gatewayUncertain" /> : words.body}</p>
        {!uncertain && words.action && (
          <a className="lt-link" href={words.action.href}>
            {words.action.label}
          </a>
        )}
        {words.reference && <small className="lt-ref">{words.reference}</small>}
        {again}
      </div>
    );
  }
  return (
    <div data-testid="failure" className="lt-refusal" data-refusal="refused" role={result.reason === 'uncertain' ? 'alert' : 'status'}>
      <h3 className="lt-refusal-title">
        <Copy k={result.reason} />
      </h3>
      <p className="lt-refusal-body" lang={result.messageCopy ? languageFor(result.messageCopy.key) : undefined}>
        {result.messageCopy ? uiMessage(result.messageCopy, requestedLocale) : result.message}
      </p>
      {result.reason === 'unauthorized' ? (
        <a className="lt-link" href={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`}>
          <Copy k="signIn" />
        </a>
      ) : (
        again
      )}
    </div>
  );
}

/** One read: its loading line, its failure with Try again, an optional empty line, then the data. */
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
  if (resource.status === 'loading') return <KitLoading />;
  if (resource.status === 'failed')
    return (
      <div lang="und">
        <KitFailure result={resource.failure} retry={retry} />
      </div>
    );
  if (empty && (resource.data === null || (Array.isArray(resource.data) && resource.data.length === 0)))
    return <EmptyState title={empty} />;
  return <>{children(resource.data)}</>;
}

/** A labelled table the keyboard can reach; rows are the caller's own `<tr>`s. */
export function KitTable({ headers, children, label }: { headers: readonly ReactNode[]; children: ReactNode; label: string }) {
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
