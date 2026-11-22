import { isServiceNotConnected, type ApiResult } from './api';
import { canTryAgain, rawRefusalCode } from './try-again';
import { uiCopy, uiMessage } from './ui-copy';
import { refusalCopy } from '../data/refusals';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

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

export function useFailureWords(result: Failed, canRetry: boolean): FailureWords {
  const { t, languageFor, requestedLocale } = uiCopy.useCopy();
  if (isServiceNotConnected(result.code)) return { alert: false, title: t('not_mounted'), body: t('serviceNotConnected') };
  const retry = canRetry && canTryAgain(result) ? t('retry') : undefined;
  const rawCode = rawRefusalCode(result);
  if (rawCode && !result.messageCopy) {
    const words = refusalCopy(result.code ?? rawCode);
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
