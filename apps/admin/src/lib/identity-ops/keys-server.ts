import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { partFrom, type Part } from '@/lib/desk/part';
import { codeInText, explainRefusal, isKnownCode } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';
import { readKeyState, type KeyState } from './keys-model';

export interface KeysView {
  readonly asOf: string;
  readonly state: Part<KeyState>;
}

export async function loadKeys(ctx: FounderCallContext): Promise<KeysView> {
  const result = await founderCall(ctx, 'identity', 'authKeys.state', 'GET', undefined, readKeyState);
  return {
    asOf: new Date().toISOString(),
    state: partFrom(result, (d) => d, {
      service: 'svc-identity',
      forbiddenMessage:
        'svc-identity did not accept your founder session for this read. It needs a live founder signed in with a second factor.',
    }),
  };
}

const WRONG_STATE: ExecuteReply = { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };

/** Run an approved key change as the signed-in founder. The state the service returns must show the change, or it is not reported done. */
export function identityKeysExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'identity.auth_key.rotate' && request.kind !== 'identity.auth_key.remove_old') {
      return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    }
    const rotate = request.kind === 'identity.auth_key.rotate';
    const result = await founderCall(
      ctx,
      'identity',
      rotate ? 'authKeys.rotate' : 'authKeys.removeOld',
      'POST',
      rotate ? { keyId: request.keyId, ...ids } : ids,
      readKeyState,
    );
    if (result.kind === 'refused') {
      // Identity sends the typed code as the whole message (`auth_key.invalid_id`), not in brackets.
      const fromMessage = /^auth_key\.[a-z_]+$/.test(result.refusal.message) ? result.refusal.message : null;
      const code = result.refusal.code ?? fromMessage ?? codeInText(result.refusal.message);
      return { ok: false, refusal: explainRefusal(isKnownCode(code) ? code : null, result.refusal.status, false) };
    }
    if (result.kind !== 'ok') return failureRefusal('svc-identity', 'identity', result);
    const state = result.data;
    if (rotate ? state.activeKeyId !== request.keyId : state.previousKeyIds.length !== 0) return WRONG_STATE;
    return {
      ok: true,
      detail: rotate
        ? `svc-identity answered and its signing key is now ${state.activeKeyId}; the previous key is ${state.previousKeyIds.join(', ') || 'none'}.`
        : `svc-identity answered and no previous key remains; ${state.activeKeyId} is the only key that verifies.`,
    };
  };
}
