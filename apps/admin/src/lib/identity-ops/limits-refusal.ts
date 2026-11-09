import type { FounderCallFailure } from '@/lib/desk/founder-call';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';

/** Plain answers for what svc-identity says back to a limit decision. Unknown codes fall to the general answers. */
const BY_CODE: Readonly<Record<string, Omit<RefusalView, 'code' | 'changed'>>> = {
  'identity.rate_limits_unset': {
    title: 'Rate limits are not set',
    body: 'The owner has set no rate-limit tiers, so there is no limit to raise.',
    next: 'Nothing was changed.',
  },
  'identity.rate_grant_ceiling_unset': {
    title: 'No grant can be made yet',
    body: 'The most one key may be granted is not set, so every grant is refused.',
    next: 'Nothing was changed. Refusing a request still works.',
  },
  'identity.rate_grant_above_ceiling': {
    title: 'Above the most a key may be granted',
    body: 'That grant is more than the owner allows for one key.',
    next: 'Nothing was changed. Grant less.',
  },
  'identity.limit_grant_invalid': {
    title: 'That grant does not fit the request',
    body: 'A grant is more than the key has now and no more than was asked for.',
    next: 'Nothing was changed. Change the amount.',
  },
  'identity.limit_request_decided': {
    title: 'Already decided',
    body: 'Someone decided this request first.',
    next: 'Nothing was changed. Refresh the desk.',
  },
  'identity.limit_request_not_found': {
    title: 'No such request',
    body: 'svc-identity does not have that request.',
    next: 'Nothing was changed. Refresh the desk.',
  },
  'identity.limit_review_own': {
    title: 'Not on your own key',
    body: 'A reviewer cannot decide a request on their own key.',
    next: 'Nothing was changed. Another reviewer decides it.',
  },
  'identity.key_not_live': {
    title: 'The key is not live',
    body: 'The key was revoked or passed its end date, so no grant can be made on it.',
    next: 'Nothing was changed. Refuse the request instead.',
  },
  'auth.mfa_required': {
    title: 'A second factor is needed',
    body: 'Deciding a limit needs a session signed in with a second factor.',
    next: 'Nothing was changed. Sign in again with your authenticator.',
  },
};

const CODE_IN_MESSAGE = /\[([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\]\s*$/;

export function explainLimitFailure(result: FounderCallFailure<unknown>): RefusalView {
  if (result.kind === 'forbidden' || result.kind === 'refused') {
    if (result.kind === 'forbidden' && result.refusal.status === 401) return explainRefusal('admin.session_required', 401, false);
    const code = result.refusal.code ?? CODE_IN_MESSAGE.exec(result.refusal.message)?.[1] ?? null;
    const known = code ? BY_CODE[code] : undefined;
    if (known) return { ...known, code, changed: 'no' };
    return explainRefusal(code, result.refusal.status, false);
  }
  if (result.kind === 'unavailable') return explainRefusal(null, 503, result.uncertain);
  if (result.kind === 'not_built') {
    return {
      title: 'svc-identity has not switched this on',
      body: 'There is no limit desk on this deployment.',
      next: 'Nothing was changed.',
      code: 'not_built',
      changed: 'no',
    };
  }
  return {
    title: 'The outcome is not known',
    body: 'svc-identity answered in a shape this console does not understand.',
    next: 'Refresh the desk before deciding again.',
    code: null,
    changed: 'unknown',
  };
}
