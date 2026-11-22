import type { Refusal } from '@intafaced/ui/lit/templates';
import { isServiceNotConnected, type ApiResult } from '../../shared/api';
import { currentPreferences } from '../../shared/preferences';
import { uiCopy, uiMessage } from '../../shared/ui-copy';
import { refusalCopy } from '../../data/refusals';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** A service's own refusal code sent as the message ("token.params_invalid"). */
const RAW_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i;
/** Network trouble clears by itself, so it offers Try again; a refusal or a missing setting does not. */
const PASSING = new Set<Failed['reason']>(['unreachable', 'invalid_response', 'aborted']);

/**
 * A failed call as the kit's refusal, in the words the app's old `Failure` box used: the service not connected here, a
 * raw code in plain words with the code as the reference, else the reason's title and the service's sentence. `here` is
 * where Try again and Sign in return to.
 */
export function failureRefusal(result: Failed, here: string, locale = currentPreferences().language): Refusal {
  const { t } = uiCopy.forLocale(locale);
  if (isServiceNotConnected(result.code)) return { variant: 'unreachable', title: t('not_mounted'), body: t('serviceNotConnected') };
  const uncertain = result.reason === 'uncertain';
  const retry = PASSING.has(result.reason) ? { label: t('retry'), href: here } : undefined;
  const raw = RAW_CODE.test(result.message.trim()) ? result.message.trim() : undefined;
  if (raw && !result.messageCopy) {
    const words = refusalCopy(result.code ?? raw);
    return {
      variant: uncertain || retry ? 'unreachable' : 'refused',
      title: uncertain ? t('uncertain') : words.title,
      body: uncertain ? t('gatewayUncertain') : words.body,
      reference: words.reference,
      action: uncertain ? undefined : (words.action ?? retry),
    };
  }
  return {
    variant: uncertain || retry ? 'unreachable' : 'refused',
    title: t(result.reason),
    body: result.messageCopy ? uiMessage(result.messageCopy, locale) : result.message,
    action: result.reason === 'unauthorized' ? { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(here)}` } : retry,
  };
}
