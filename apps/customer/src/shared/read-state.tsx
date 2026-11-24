import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { isServiceNotConnected, isVerifyFirst, type ApiResult } from './api';
import { VerifyFirstNote } from './verify-first';
import { refusalCopy } from '../data/refusals';
import type { Resource } from './resource';
import { uiCopy, uiMessage } from './ui-copy';
import { canTryAgain, failureRawCode } from './failure-words';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * A read on its way, a read that failed and the two together, drawn from the Volt kit. The words, the roles and when Try
 * again shows are the old kit's `Loading` and `Failure` (shared/ui.tsx), from the same copy and `failure-words.ts`.
 */
export function ReadLoading({ label }: { label?: ReactNode }) {
  const { Copy } = uiCopy.useCopy();
  return (
    <p className="lt-hint" role="status">
      {label ?? <Copy k="loading" />}…
    </p>
  );
}

export function ReadFailure({ result, retry }: { result: Failed; retry?: () => void }) {
  const { Copy, languageFor, requestedLocale } = uiCopy.useCopy();
  const variant = result.reason === 'unreachable' ? 'unreachable' : 'refused';
  const again =
    retry && canTryAgain(result) ? (
      <Button tone="secondary" onClick={retry}>
        <Copy k="retry" />
      </Button>
    ) : null;
  if (isServiceNotConnected(result.code)) {
    // The gateway's own text is never shown for this answer: say plainly that the service is not connected here.
    return (
      <div data-testid="failure" className="lt-refusal" data-refusal="parked" role="status">
        <p className="lt-refusal-title">
          <Copy k="not_mounted" />
        </p>
        <p className="lt-refusal-body">
          <Copy k="serviceNotConnected" />
        </p>
      </div>
    );
  }
  if (isVerifyFirst(result)) return <VerifyFirstNote code={result.code} />;
  const uncertain = result.reason === 'uncertain';
  const rawCode = failureRawCode(result);
  if (rawCode && !result.messageCopy) {
    // Customers never read a raw code: the same plain sentences the other rooms use for typed refusals.
    const words = refusalCopy(result.code ?? rawCode);
    return (
      <div data-testid="failure" className="lt-refusal" data-refusal={variant} role={uncertain ? 'alert' : 'status'}>
        <p className="lt-refusal-title">{uncertain ? <Copy k="uncertain" /> : words.title}</p>
        <p className="lt-refusal-body">{uncertain ? <Copy k="gatewayUncertain" /> : words.body}</p>
        {!uncertain && words.action && (
          <a className="lt-link" href={words.action.href}>
            {words.action.label}
          </a>
        )}
        {words.reference && <p className="lt-ref">{words.reference}</p>}
        {again}
      </div>
    );
  }
  return (
    <div data-testid="failure" className="lt-refusal" data-refusal={variant} role={uncertain ? 'alert' : 'status'}>
      <p className="lt-refusal-title">
        <Copy k={result.reason} />
      </p>
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

/** A read's three states: on its way, failed with its words and Try again, or its data. */
export function ReadView<T>({
  resource,
  reload,
  children,
}: {
  resource: Resource<T>;
  reload: () => void;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'loading') return <ReadLoading />;
  if (resource.status === 'failed') return <ReadFailure result={resource.failure} retry={reload} />;
  return <>{children(resource.data)}</>;
}
