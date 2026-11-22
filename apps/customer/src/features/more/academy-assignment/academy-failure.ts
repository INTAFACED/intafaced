import type { Refusal } from '@intafaced/ui/lit/templates';
import { isServiceNotConnected, type ApiResult } from '../../../shared/api';
import type { uiCopy } from '../../../shared/ui-copy';
import { uiMessage } from '../../../shared/ui-copy';
import { refusalCopy } from '../../../data/refusals';
import { canTryAgain, rawCodeOf } from '../../../shared/failure-rules';
import { academyRefusalText } from '../academy-flows';
import type { academyLmsCopy } from '../academy-lms-copy';

type Failure = Extract<ApiResult<unknown>, { ok: false }>;
type UiCopy = ReturnType<(typeof uiCopy)['useCopy']>;

/**
 * A failed Academy request, as the kit draws it. Academy's own typed refusals are its plain words (`words`); anything
 * else (a dropped connection, a sign-in problem, a service not connected here) is a kit refusal with the same words the
 * app's shared failure panel uses, the one next step, and whether Try again belongs to it. Pure: copy comes in.
 */
export type AcademyFailureView = { kind: 'words'; words: string } | { kind: 'refusal'; refusal: Refusal; retry: boolean };

/** Whether Try again belongs to a failure: the app's one rule (shared/failure-rules.ts). */
export const mayTryAgain = canTryAgain;

export function academyFailureView(failure: Failure, t: (typeof academyLmsCopy)['t'], ui: UiCopy, here = ''): AcademyFailureView {
  const words = academyRefusalText(failure, t);
  if (words !== null) return { kind: 'words', words };
  if (isServiceNotConnected(failure.code))
    return {
      kind: 'refusal',
      retry: false,
      refusal: { variant: 'refused', title: ui.t('not_mounted'), body: ui.t('serviceNotConnected') },
    };
  const rawCode = rawCodeOf(failure);
  if (rawCode && !failure.messageCopy) {
    if (failure.reason === 'uncertain')
      return {
        kind: 'refusal',
        retry: false,
        refusal: { variant: 'unreachable', title: ui.t('uncertain'), body: ui.t('gatewayUncertain') },
      };
    const said = refusalCopy(failure.code ?? rawCode);
    return {
      kind: 'refusal',
      retry: mayTryAgain(failure),
      refusal: { variant: 'refused', title: said.title, body: said.body, reference: said.reference, action: said.action },
    };
  }
  const signIn = failure.reason === 'unauthorized';
  return {
    kind: 'refusal',
    retry: !signIn && mayTryAgain(failure),
    refusal: {
      variant: failure.reason === 'uncertain' ? 'unreachable' : 'refused',
      title: ui.t(failure.reason),
      body: failure.messageCopy ? uiMessage(failure.messageCopy, ui.requestedLocale) : failure.message,
      action: signIn ? { label: ui.t('signIn'), href: `/login?redirect=${encodeURIComponent(here)}` } : undefined,
    },
  };
}
