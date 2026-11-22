import { isServiceNotConnected, type ApiResult } from './api';
import { uiCopy, uiMessage } from './ui-copy';
import { refusalCopy } from '../data/refusals';
import { classifyRefusal, type RefusalKind } from '../data/refusal-codes';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

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
function canTryAgain(result: Failed): boolean {
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

/** What a failed read or write says, in the words the shared `Failure` uses, for a room drawn on the kit. */
export interface FailureWords {
  title: string;
  body: string;
  /** The language the body's words are in, when the answer's own message copy chose them. */
  bodyLang?: string;
  /** One next step: the refusal's own link, or signing in. */
  action?: { label: string; href: string };
  /** The support reference, shown small. */
  reference?: string;
  /** `alert` for an outcome that may have gone through; `status` otherwise. */
  role: 'alert' | 'status';
  /** Whether a second attempt can change the answer. */
  retry: boolean;
  /** The words of the retry button. */
  retryLabel: string;
}

/** The words for a failure, as `Failure` in `./ui` shows them: never a raw code, never "refused" for an uncertain write. */
export function useFailureWords(): (result: Failed) => FailureWords {
  const { t, languageFor, requestedLocale } = uiCopy.useCopy();
  return (result) => {
    const retryLabel = t('retry');
    if (isServiceNotConnected(result.code))
      return { title: t('not_mounted'), body: t('serviceNotConnected'), role: 'status', retry: false, retryLabel };
    const rawCode = RAW_CODE.test(result.message.trim()) ? result.message.trim() : result.code ? embeddedKey(result.message) : undefined;
    if (rawCode && !result.messageCopy) {
      const words = refusalCopy(result.code ?? rawCode);
      const uncertain = result.reason === 'uncertain';
      return {
        title: uncertain ? t('uncertain') : words.title,
        body: uncertain ? t('gatewayUncertain') : (words.body ?? ''),
        action: !uncertain && words.action ? words.action : undefined,
        reference: words.reference,
        role: uncertain ? 'alert' : 'status',
        retry: canTryAgain(result),
        retryLabel,
      };
    }
    const unauthorized = result.reason === 'unauthorized';
    return {
      title: t(result.reason),
      body: result.messageCopy ? uiMessage(result.messageCopy, requestedLocale) : result.message,
      bodyLang: result.messageCopy ? languageFor(result.messageCopy.key) : undefined,
      action: unauthorized
        ? { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(location.pathname + location.search)}` }
        : undefined,
      role: result.reason === 'uncertain' ? 'alert' : 'status',
      retry: !unauthorized && canTryAgain(result),
      retryLabel,
    };
  };
}
