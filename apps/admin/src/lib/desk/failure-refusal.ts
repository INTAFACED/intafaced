import type { CallModule, FounderCallFailure } from './founder-call';
import type { ExecuteReply } from '../approval-types';
import { codeInText, explainRefusal, isKnownCode } from '../refusal-copy';

/**
 * A failed founder call as a desk refusal, in the words every desk shows: a missing operator permission is named with
 * what grants it, a service's own refusal keeps its words, and a dropped connection is "outcome unknown".
 */

const NEEDS: Readonly<Record<string, string>> = {
  market: 'the market operator permission (market:ops) and a verified second factor',
  academy: 'the Academy operator permission (admin:write) and a verified second factor',
  bank: 'the bank treasury permission (admin:treasury) and a verified second factor',
  p2p: 'moderator access (admin:compliance, or being on the moderator list) and the P2P read permission',
  ops: 'the operator write permission (admin:write) and a verified second factor',
};

/** The permission, as the founder reads it in the refusal's headline. */
const PERMISSION_NAME: Readonly<Record<string, string>> = {
  market: 'market operator',
  academy: 'Academy operator',
  bank: 'bank treasury',
  p2p: 'P2P moderator',
  ops: 'operations',
};

/** A failed call as a desk refusal. A typed approval code is a definite "nothing changed"; a dropped connection is unknown. */
export function failureRefusal(service: string, module: CallModule, failure: FounderCallFailure<unknown>): ExecuteReply {
  switch (failure.kind) {
    case 'forbidden': {
      const base = explainRefusal(failure.refusal.code ?? codeInText(failure.refusal.message), failure.refusal.status, false);
      return {
        ok: false,
        refusal: isKnownCode(base.code)
          ? base
          : {
              ...base,
              title: `Your console session does not have ${PERMISSION_NAME[module] ?? 'operator'} permission`,
              body: `${service} did not accept your founder session for this. It needs ${NEEDS[module] ?? 'an operator permission'}, and founder sign-in does not carry it. Nothing was changed.`,
              next: 'See the back-end needs note for the permission to grant.',
            },
      };
    }
    case 'refused': {
      const code = codeInText(failure.refusal.message) ?? failure.refusal.code;
      const view = explainRefusal(code, failure.refusal.status, false);
      return {
        ok: false,
        refusal: isKnownCode(code) || failure.refusal.message === '' ? view : { ...view, body: failure.refusal.message },
      };
    }
    case 'unavailable':
      return { ok: false, refusal: explainRefusal(null, 503, failure.uncertain) };
    case 'not_built':
      return {
        ok: false,
        refusal: {
          title: `${service} does not have this switched on`,
          body: 'The procedure is not mounted on this deployment. Nothing was changed.',
          next: 'Tell engineering.',
          code: null,
          changed: 'no',
        },
      };
    case 'invalid':
      return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
  }
}
