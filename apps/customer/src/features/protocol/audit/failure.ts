import type { Refusal } from '@intafaced/ui/lit/templates';
import { isServiceNotConnected, type ApiResult } from '../../../shared/api';
import { uiCopy, uiMessage } from '../../../shared/ui-copy';
import { refusalCopy } from '../../../data/refusals';
import type { UiLocale } from '../../../shared/i18n';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

export { canTryAgain as canRetry } from '../../../shared/try-again';

/** A service sometimes answers with its own refusal code as the message ("token.params_invalid"). */
const RAW_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i;
const EMBEDDED_KEY = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*\b/gi;
/**
 * A failed read in the kit's refusal shape, in the same words the shared Failure uses: "not connected" for the gateway's
 * unwired answer, the typed refusal's plain sentences for a coded answer, and the reason's own words otherwise.
 */
export function failureRefusal(result: Failed, locale: UiLocale): Refusal {
  const { t } = uiCopy.forLocale(locale);
  if (isServiceNotConnected(result.code)) return { variant: 'parked', title: t('not_mounted'), body: t('serviceNotConnected') };
  const message = result.message.trim();
  const rawCode = RAW_CODE.test(message)
    ? message
    : result.code
      ? message.match(EMBEDDED_KEY)?.find((key) => key.includes('_'))
      : undefined;
  if (rawCode && !result.messageCopy) {
    if (result.reason === 'uncertain') return { variant: 'unreachable', title: t('uncertain'), body: t('gatewayUncertain') };
    const words = refusalCopy(result.code ?? rawCode);
    return { variant: 'refused', title: words.title, body: words.body ?? '', reference: words.reference, action: words.action };
  }
  return {
    variant: result.reason === 'unreachable' ? 'unreachable' : 'refused',
    title: t(result.reason),
    body: result.messageCopy ? uiMessage(result.messageCopy, locale) : result.message,
  };
}
