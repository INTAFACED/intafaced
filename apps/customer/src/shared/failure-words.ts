/**
 * How a failed read or write is worded, the one version every room shares: whether Try again can help, the raw refusal
 * code a message carries, and the words the old kit's `Failure` (`./ui`) says, for a room drawn on the Volt kit to draw
 * with the kit's own parts. `Failure`, `./read-state` and `features/more/volt-parts` read it.
 */
import { isServiceNotConnected, isVerifyFirst, type ApiResult } from './api';
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
  'minNotionalUnset',
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
export const RAW_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i;
/** A setting or code name inside a sentence, such as "Missing token_params.fee_discount_schedule". Only underscored names count, so "v1.2" and "e.g." stay. */
const EMBEDDED_KEY = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*\b/gi;
export function embeddedKey(message: string): string | undefined {
  return message.match(EMBEDDED_KEY)?.find((key) => key.includes('_'));
}
/** The refusal code a failure's message is, or names inside a sentence; undefined when it is plain words. */
export function failureRawCode(result: Extract<ApiResult<unknown>, { ok: false }>): string | undefined {
  return RAW_CODE.test(result.message.trim()) ? result.message.trim() : result.code ? embeddedKey(result.message) : undefined;
}

/**
 * The words of a failed read or change, as `Failure` in `./ui` says them, for a room in Volt to draw with the kit's
 * parts: the same title, body, link, reference and try-again rule, chosen the same way. `alert`
 * is true where `Failure` answers with role="alert" (a write that may have gone through).
 */
export interface FailureWords {
  alert: boolean;
  title: string;
  body: string;
  /** The body's language, when it is a translated service message. */
  bodyLang?: string;
  action?: { label: string; href: string };
  reference?: string;
  /** The try-again button's word, when trying again can help and the caller can retry. */
  retry?: string;
}

/** The same words in the shape a note that holds its own retry reads: its role, whether a retry can help, and the button's word. */
export interface FailureNoteWords {
  title: string;
  /** The language the title's words are in, when the app's own copy gave them. */
  titleLang?: string;
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

type Copy = ReturnType<typeof uiCopy.useCopy>;

function wordsOf({ t, languageFor, requestedLocale }: Copy, result: Failed, canRetry: boolean): FailureWords {
  if (isServiceNotConnected(result.code)) return { alert: false, title: t('not_mounted'), body: t('serviceNotConnected') };
  // Never the gate's tier, module or region code: one sentence and the way to Verification.
  if (isVerifyFirst(result))
    return { alert: false, title: t('verifyFirstTitle'), body: t('verifyFirst'), action: { label: t('verifyNow'), href: '/verification' } };
  const retry = canRetry && canTryAgain(result) ? t('retry') : undefined;
  const rawCode = failureRawCode(result);
  if (rawCode && !result.messageCopy) {
    // Customers never read a raw code: the same plain sentences the other rooms use for typed refusals.
    const words = refusalCopy(result.code ?? rawCode);
    // A write that may have gone through is never called refused or unchanged; the code only gives the support reference.
    const uncertain = result.reason === 'uncertain';
    return {
      alert: uncertain,
      title: uncertain ? t('uncertain') : words.title,
      body: uncertain ? t('gatewayUncertain') : words.body,
      ...(!uncertain && words.action ? { action: words.action } : {}),
      ...(words.reference ? { reference: words.reference } : {}),
      ...(retry ? { retry } : {}),
    };
  }
  const unauthorized = result.reason === 'unauthorized';
  return {
    alert: result.reason === 'uncertain',
    title: t(result.reason),
    body: result.messageCopy ? uiMessage(result.messageCopy, requestedLocale) : result.message,
    ...(result.messageCopy ? { bodyLang: languageFor(result.messageCopy.key) } : {}),
    ...(unauthorized
      ? { action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(location.pathname + location.search)}` } }
      : retry
        ? { retry }
        : {}),
  };
}

/** The app's own copy key the title came from, when it did; a refusal's own title has none. */
function titleKey(result: Failed): Parameters<Copy['languageFor']>[0] | undefined {
  if (isServiceNotConnected(result.code)) return 'not_mounted';
  if (isVerifyFirst(result)) return 'verifyFirstTitle';
  if (failureRawCode(result) && !result.messageCopy) return result.reason === 'uncertain' ? 'uncertain' : undefined;
  return result.reason;
}

function noteWordsOf(copy: Copy, result: Failed): FailureNoteWords {
  const { alert, retry, ...words } = wordsOf(copy, result, true);
  const key = titleKey(result);
  return {
    ...words,
    ...(key ? { titleLang: copy.languageFor(key) } : {}),
    role: alert ? 'alert' : 'status',
    retry: retry !== undefined,
    retryLabel: copy.t('retry'),
  };
}

/**
 * The words for a failure, as `Failure` in `./ui` shows them: never a raw code, never "refused" for an uncertain write.
 * Called with a failure and whether the caller can retry, it answers that failure's words; called with nothing, it answers
 * a function that words any failure, for a note that holds its own retry.
 */
export function useFailureWords(): (result: Failed) => FailureNoteWords;
export function useFailureWords(result: Failed, canRetry: boolean): FailureWords;
export function useFailureWords(result?: Failed, canRetry = false): FailureWords | ((result: Failed) => FailureNoteWords) {
  const copy = uiCopy.useCopy();
  if (result === undefined) return (failed) => noteWordsOf(copy, failed);
  return wordsOf(copy, result, canRetry);
}
