import type { Refusal } from '@intafaced/ui/lit/templates';
import { isServiceNotConnected, type ApiResult } from '../../../shared/api';
import { uiCopy, uiMessage } from '../../../shared/ui-copy';
import { refusalCopy } from '../../../data/refusals';
import { canTryAgain, rawCodeOf } from '../../../shared/failure-rules';
import type { UiLocale } from '../../../shared/i18n';

/**
 * A failed read in the Volt kit's words: the same title, body, sign-in link and support reference the app's old failure
 * panel (`Failure` in shared/ui.tsx) gives, as a kit `Refusal` the flow template draws. `retryable` is that panel's rule for
 * offering "Try again"; both read shared/failure-rules.ts, as that panel does.
 */
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** That panel's rule for offering "Try again". */
export const retryable = canTryAgain;

/** `returnTo` is the address the sign-in link brings the person back to. */
export function readRefusal(result: Failed, locale: UiLocale, returnTo: string): Refusal {
  const words = uiCopy.forLocale(locale);
  if (isServiceNotConnected(result.code))
    return { variant: 'unreachable', title: words.t('not_mounted'), body: words.t('serviceNotConnected') };
  const rawCode = rawCodeOf(result);
  if (rawCode && !result.messageCopy) {
    const typed = refusalCopy(result.code ?? rawCode);
    if (result.reason === 'uncertain') return { variant: 'unreachable', title: words.t('uncertain'), body: words.t('gatewayUncertain') };
    return {
      variant: 'refused',
      title: typed.title,
      body: typed.body,
      ...(typed.reference ? { reference: typed.reference } : {}),
      ...(typed.action ? { action: typed.action } : {}),
    };
  }
  return {
    variant: result.reason === 'unreachable' || result.reason === 'uncertain' ? 'unreachable' : 'refused',
    title: words.t(result.reason),
    body: result.messageCopy ? uiMessage(result.messageCopy, locale) : result.message,
    ...(result.reason === 'unauthorized'
      ? { action: { label: words.t('signIn'), href: `/login?redirect=${encodeURIComponent(returnTo)}` } }
      : {}),
  };
}
