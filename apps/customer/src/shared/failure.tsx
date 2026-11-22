import { Button } from '@intafaced/ui/lit';
import { isServiceNotConnected, type ApiResult } from './api';
import { uiCopy, uiMessage } from './ui-copy';
import { refusalCopy } from '../data/refusals';
import { classifyRefusal, type RefusalKind } from '../data/refusal-codes';

/**
 * The app's one error box, drawn from the Volt kit: a refused or failed read in words, the reference small, and Try
 * again only where a second attempt can help (`canTryAgain`). `shared/ui.tsx`'s `Failure` is this box with the old
 * `failure` class kept for the rooms not in Volt yet.
 */

/** Refusals that come from something not being switched on, allowed or listed. A second attempt cannot change them. */
const SETTLED_KINDS: ReadonlySet<RefusalKind> = new Set([
  'spaceLocked',
  'screening',
  'region',
  'verify',
  'convertSpreadUnset',
  'slippageCapUnset',
  'protectionUnset',
  'priceBandUnset',
  'openOrdersCapUnset',
  'noBook',
  'marketNotOpen',
  'marketHalted',
  'stepUp',
  'mfaRequired',
  'noPermission',
  'orderTypeUnsupported',
  'marketLimitOnly',
  'marketCancelOnly',
  'marketPostOnly',
  'optionUnsupported',
  'accountOnHold',
  'tradingOnHold',
  'frozenByYou',
  'notFound',
  'notSetUp',
  'feeScheduleUnset',
  'algoSchedulerOff',
]);
/** Try again belongs to network trouble and to refusals that can clear by themselves, never to a missing setting or permission. */
export function canTryAgain(result: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  if (result.reason === 'uncertain' || result.reason === 'unauthorized') return false;
  // The gateway says the service is not running in this environment: a second attempt cannot change that.
  if (isServiceNotConnected(result.code)) return false;
  if (result.reason === 'unreachable' || result.reason === 'invalid_response' || result.reason === 'aborted') return true;
  // A source that is unavailable, stale or unknown can recover by itself, whatever else its code says.
  if (result.code && /_(unavailable|stale|unknown)$/.test(result.code)) return true;
  if (result.reason === 'forbidden' || result.reason === 'not_mounted' || result.reason === 'not_supported') return false;
  return !SETTLED_KINDS.has(classifyRefusal(result.code));
}
/** A service sometimes answers with its own refusal code as the message ("token.params_invalid"). */
const RAW_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i;
/** A setting or code name inside a sentence, such as "Missing token_params.fee_discount_schedule". Only underscored names count, so "v1.2" and "e.g." stay. */
const EMBEDDED_KEY = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*\b/gi;
function embeddedKey(message: string): string | undefined {
  return message.match(EMBEDDED_KEY)?.find((key) => key.includes('_'));
}

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
