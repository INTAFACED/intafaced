/**
 * The account rooms' shared parts on the Volt kit: a failed read or write, and data on its way. They say exactly what
 * the old kit's `Failure` and `Loading` (shared/ui.tsx) say, with the same roles and test id, drawn only from the kit.
 */
import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import { isServiceNotConnected, type ApiResult } from '../../shared/api';
import { canTryAgain, embeddedKey, RAW_CODE } from '../../shared/failure-words';
import { uiCopy, uiMessage } from '../../shared/ui-copy';
import { refusalCopy } from '../../data/refusals';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/** A call that did not succeed, in the person's words, with a way to try again when a second attempt can help. */
export function Failure({ result, retry }: { result: Refusal; retry?: () => void }) {
  const { Copy, languageFor, requestedLocale } = uiCopy.useCopy();
  const again =
    retry && canTryAgain(result) ? (
      <Button tone="secondary" onClick={retry}>
        <Copy k="retry" />
      </Button>
    ) : null;
  if (isServiceNotConnected(result.code)) {
    // The gateway's own text is never shown for this answer: say plainly that the service is not connected here.
    return (
      <div data-testid="failure" className="lt-refusal" role="status">
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
    // Customers never read a raw code: the same plain sentences the other rooms use for typed refusals.
    const words = refusalCopy(result.code ?? rawCode);
    // A write that may have gone through is never called refused or unchanged; the code only gives the support reference.
    const uncertain = result.reason === 'uncertain';
    return (
      <div data-testid="failure" className="lt-refusal" role={uncertain ? 'alert' : 'status'}>
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
    <div data-testid="failure" className="lt-refusal" role={result.reason === 'uncertain' ? 'alert' : 'status'}>
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

/** Nothing to show, said as such: its heading, its words and one next step, as the old kit's EmptyState says them. */
export function Empty({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="lt-empty">
      <h3 className="lt-empty-title">{title}</h3>
      {children ? <p className="lt-empty-body">{children}</p> : null}
      {action}
    </div>
  );
}

/** Data on its way: the kit's still shape, and the words a screen reader hears. */
export function Loading({ label }: { label?: ReactNode }) {
  const { Copy } = uiCopy.useCopy();
  return (
    <div role="status">
      <Skeleton shape="rows" count={2} />
      <span className="lt-hint">{label ?? <Copy k="loading" />}…</span>
    </div>
  );
}
