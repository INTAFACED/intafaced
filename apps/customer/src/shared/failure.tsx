import { Button } from '@intafaced/ui/lit';
import { isServiceNotConnected, isVerifyFirst, type ApiResult } from './api';
import { VerifyFirstNote } from './verify-first';
import { uiCopy, uiMessage } from './ui-copy';
import { refusalCopy } from '../data/refusals';
import { canTryAgain, embeddedKey, RAW_CODE } from './failure-words';
export { canTryAgain };

/**
 * The app's one error box, drawn from the Volt kit: a refused or failed read in words, the reference small, and Try
 * again only where a second attempt can help (`canTryAgain`, in `./failure-words`). `shared/ui.tsx`'s `Failure` is this box with the old
 * `failure` class kept for the rooms not in Volt yet.
 */

export interface FailureProps {
  result: Extract<ApiResult<unknown>, { ok: false }>;
  retry?: () => void;
  /** Only `shared/ui.tsx` passes one: the old `failure` class, for the rooms and tests not in Volt yet. */
  className?: string;
}

export function Failure({ result, retry, className }: FailureProps) {
  const { Copy, languageFor, requestedLocale } = uiCopy.useCopy();
  const box = className ? `lt-refusal ${className}` : 'lt-refusal';
  if (isServiceNotConnected(result.code)) {
    // The gateway's own text is never shown for this answer: say plainly that the service is not connected here.
    return (
      <div data-testid="failure" className={box} role="status">
        <h3 className="lt-refusal-title">
          <Copy k="not_mounted" />
        </h3>
        <p className="lt-refusal-body">
          <Copy k="serviceNotConnected" />
        </p>
      </div>
    );
  }
  // A person not yet verified reads one plain ask to verify, never the gate's own sentence or its code.
  if (isVerifyFirst(result)) return <VerifyFirstNote code={result.code} />;
  const rawCode = RAW_CODE.test(result.message.trim()) ? result.message.trim() : result.code ? embeddedKey(result.message) : undefined;
  if (rawCode && !result.messageCopy) {
    // Customers never read a raw code: use the same plain sentences the other rooms use for typed refusals.
    const words = refusalCopy(result.code ?? rawCode);
    // A write that may have gone through is never called refused or unchanged; the code only gives the support reference.
    const uncertain = result.reason === 'uncertain';
    return (
      <div data-testid="failure" className={box} role={uncertain ? 'alert' : 'status'}>
        <h3 className="lt-refusal-title">{uncertain ? <Copy k="uncertain" /> : words.title}</h3>
        <p className="lt-refusal-body">{uncertain ? <Copy k="gatewayUncertain" /> : words.body}</p>
        {!uncertain && words.action && (
          <a className="lt-link" href={words.action.href}>
            {words.action.label}
          </a>
        )}
        {words.reference && <small className="lt-ref">{words.reference}</small>}
        {retry && canTryAgain(result) && (
          <Button tone="secondary" onClick={retry}>
            <Copy k="retry" />
          </Button>
        )}
      </div>
    );
  }
  return (
    <div data-testid="failure" className={box} role={result.reason === 'uncertain' ? 'alert' : 'status'}>
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
        retry &&
        canTryAgain(result) && (
          <Button tone="secondary" onClick={retry}>
            <Copy k="retry" />
          </Button>
        )
      )}
    </div>
  );
}
