import { Button } from '@intafaced/ui/lit';
import { isServiceNotConnected, type ApiResult } from '../../../shared/api';
import { uiCopy, uiMessage } from '../../../shared/ui-copy';
import { canTryAgain, failureRawCode } from '../../../shared/failure-words';
import { refusalCopy } from '../../../data/refusals';

/**
 * A failed call in a kit room: the same words, link and Try again as the app's old Failure (`shared/ui.tsx`), drawn from
 * the kit's refusal parts. `data-testid="failure"` stays the rooms' and journeys' handle for it.
 */
export function ApiFailure({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
  const { Copy, languageFor, requestedLocale } = uiCopy.useCopy();
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
  const rawCode = failureRawCode(result);
  const again = retry && canTryAgain(result) && (
    <Button tone="secondary" onClick={retry}>
      <Copy k="retry" />
    </Button>
  );
  if (rawCode && !result.messageCopy) {
    // Customers never read a raw code: use the same plain sentences the other rooms use for typed refusals.
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
