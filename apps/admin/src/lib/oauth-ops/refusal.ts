import type { FounderCallFailure } from '@/lib/desk/founder-call';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';

/**
 * Plain-English answers for what svc-identity says back to an operator reading or deciding on an OAuth app.
 *
 * svc-identity sends the typed code as the whole message (`oauth.operator_denied`). A refusal this file does not know
 * falls through to the general answers in `explainRefusal`, never to a raw code.
 */

export const OAUTH_OPS_FORBIDDEN = 'Your console session cannot decide on OAuth apps';

interface Entry {
  readonly title: string;
  readonly body: string;
  readonly next: string;
}

const BY_OAUTH_CODE: Readonly<Record<string, Entry>> = {
  'oauth.operator_denied': {
    title: 'svc-identity did not accept your session for this',
    body: 'Reading the queue needs the compliance permission (admin:compliance). Approving needs it too, on a session signed in with a second factor, and the person who registered an app cannot approve their own app.',
    next: 'Nothing was changed. If you registered this app, another founder decides it.',
  },
  'oauth.key_principal_refused': {
    title: 'An API key cannot do this',
    body: 'App decisions are made by a signed-in person, never by a key.',
    next: 'Nothing was changed. Use your founder sign-in.',
  },
  'oauth.app_not_found': {
    title: 'No such app',
    body: 'svc-identity does not have that app.',
    next: 'Reload the queue. Nothing was changed.',
  },
};

const OAUTH_CODE = /^oauth\.[a-z_]+$/;

export function oauthCodeOf(message: string, code: string | null): string | null {
  const text = message.trim();
  if (OAUTH_CODE.test(text)) return text;
  return code && OAUTH_CODE.test(code) ? code : null;
}

/** Every non-ok answer to a queue read or a decision, as one view the page and the BFF share. Never a success, never a raw code. */
export function explainOAuthFailure(result: FounderCallFailure<unknown>): RefusalView {
  switch (result.kind) {
    case 'forbidden': {
      if (result.refusal.status === 401) return explainRefusal('admin.session_required', 401, false);
      const named = oauthCodeOf(result.refusal.message, result.refusal.code);
      const known = named ? BY_OAUTH_CODE[named] : undefined;
      if (known) return { ...known, code: named, changed: 'no' };
      return {
        title: OAUTH_OPS_FORBIDDEN,
        body: 'svc-identity refused the session. Founder sign-in carries the compliance permission only when identity is set to grant it, and the decision needs a second factor.',
        next: 'Nothing was changed.',
        code: result.refusal.code ?? 'scope.denied',
        changed: 'no',
      };
    }
    case 'refused': {
      const named = oauthCodeOf(result.refusal.message, result.refusal.code);
      const known = named ? BY_OAUTH_CODE[named] : undefined;
      if (known) return { ...known, code: named, changed: 'no' };
      return explainRefusal(named ?? result.refusal.code, result.refusal.status, false);
    }
    case 'not_built':
      return {
        title: 'svc-identity has not switched this on',
        body: 'The service answered that it has no OAuth app queue on this deployment.',
        next: 'Nothing was changed. Ask engineering.',
        code: 'not_built',
        changed: 'no',
      };
    case 'unavailable':
      return explainRefusal(null, 503, result.uncertain);
    case 'invalid':
      return {
        title: 'The outcome is not known',
        body: 'svc-identity answered in a shape this console does not understand, so it cannot say whether this went through.',
        next: 'Read the queue again before deciding twice.',
        code: null,
        changed: 'unknown',
      };
  }
}
