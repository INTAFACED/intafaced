import { Button } from '@intafaced/ui/lit';
import { isServiceNotConnected } from '../../../shared/api';
import { uiCopy, uiMessage } from '../../../shared/ui-copy';
import { refusalCopy } from '../../../data/refusals';
import { canTryAgain, rawCodeOf } from '../../../shared/failure-rules';
import type { Failed } from './refusal-words';

/**
 * A failed read or write in the app's own words, drawn from the kit: the same words, roles, links and Try again as the
 * app's `Failure` (`shared/ui.tsx`) gives the same failure.
 */
export function FailureNote({ result, retry }: { result: Failed; retry?: () => void }) {
  const { Copy, languageFor, requestedLocale } = uiCopy.useCopy();
  if (isServiceNotConnected(result.code)) {
    // The gateway's own text is never shown for this answer: say plainly that the service is not connected here.
    return (
      <div data-testid="failure" role="status">
        <h3>
          <Copy k="not_mounted" />
        </h3>
        <p>
          <Copy k="serviceNotConnected" />
        </p>
      </div>
    );
  }
  const rawCode = rawCodeOf(result);
  if (rawCode && !result.messageCopy) {
    // Customers never read a raw code: use the same plain sentences the other rooms use for typed refusals.
    const words = refusalCopy(result.code ?? rawCode);
    // A write that may have gone through is never called refused or unchanged; the code only gives the support reference.
    const uncertain = result.reason === 'uncertain';
    return (
      <div data-testid="failure" role={uncertain ? 'alert' : 'status'}>
        <h3>{uncertain ? <Copy k="uncertain" /> : words.title}</h3>
        <p>{uncertain ? <Copy k="gatewayUncertain" /> : words.body}</p>
        {!uncertain && words.action && (
          <a className="lt-link" href={words.action.href}>
            {words.action.label}
          </a>
        )}
        {words.reference && <small className="lt-hint">{words.reference}</small>}
        {retry && canTryAgain(result) && (
          <Button tone="secondary" onClick={retry}>
            <Copy k="retry" />
          </Button>
        )}
      </div>
    );
  }
  return (
    <div data-testid="failure" role={result.reason === 'uncertain' ? 'alert' : 'status'}>
      <h3>
        <Copy k={result.reason} />
      </h3>
      <p lang={result.messageCopy ? languageFor(result.messageCopy.key) : undefined}>
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

/** A failed read, as the agent pages' `Read` shows one: the failure with Try again, in no language of its own. */
export function ReadFailure({ result, retry }: { result: Failed; retry: () => void }) {
  return (
    <div lang="und">
      <FailureNote result={result} retry={retry} />
    </div>
  );
}
