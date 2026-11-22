import type { Refusal } from '@intafaced/ui/lit';
import { isServiceNotConnected, type ApiResult } from './api';
import { uiCopy, uiMessage } from './ui-copy';
import { refusalCopy } from '../data/refusals';
import { canTryAgain, rawCodeOf } from './failure-rules';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** What a failed call says, as the kit's refusal draws it: the same words, in the same cases, as shared/ui's `Failure`. */
export interface FailureView {
  refusal: Refusal;
  /** `alert` for a write that may have gone through; `status` otherwise. */
  role: 'status' | 'alert';
  /** The body's language when it is a service's own authored words. */
  bodyLang?: string;
  /** Try again may be offered: network trouble or a refusal that can clear by itself. */
  retryable: boolean;
  retryLabel: string;
}

/**
 * The words for one failed call, for a room drawn from the kit (`<RefusalBox refusal={v.refusal} role={v.role}
 * data-testid="failure">`). shared/ui's `Failure` draws the old look from the same cases; a room in Volt uses this.
 */
export function useFailureView(result: Failed): FailureView {
  const { t, languageFor, requestedLocale } = uiCopy.useCopy();
  const retryLabel = t('retry');
  if (isServiceNotConnected(result.code))
    return {
      refusal: { variant: 'refused', title: t('not_mounted'), body: t('serviceNotConnected') },
      role: 'status',
      retryable: false,
      retryLabel,
    };
  const rawCode = rawCodeOf(result);
  const uncertain = result.reason === 'uncertain';
  if (rawCode && !result.messageCopy) {
    // Customers never read a raw code; a write that may have gone through is never called refused.
    const words = refusalCopy(result.code ?? rawCode);
    return {
      refusal: uncertain
        ? {
            variant: 'unreachable',
            title: t('uncertain'),
            body: t('gatewayUncertain'),
            ...(words.reference ? { reference: words.reference } : {}),
          }
        : {
            variant: 'refused',
            title: words.title,
            body: words.body,
            ...(words.action ? { action: words.action } : {}),
            ...(words.reference ? { reference: words.reference } : {}),
          },
      role: uncertain ? 'alert' : 'status',
      retryable: canTryAgain(result),
      retryLabel,
    };
  }
  const unauthorized = result.reason === 'unauthorized';
  return {
    refusal: {
      variant: uncertain || result.reason === 'unreachable' ? 'unreachable' : 'refused',
      title: t(result.reason),
      body: result.messageCopy ? uiMessage(result.messageCopy, requestedLocale) : result.message,
      ...(unauthorized
        ? { action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(location.pathname + location.search)}` } }
        : {}),
    },
    role: uncertain ? 'alert' : 'status',
    ...(result.messageCopy ? { bodyLang: languageFor(result.messageCopy.key) } : {}),
    retryable: !unauthorized && canTryAgain(result),
    retryLabel,
  };
}
