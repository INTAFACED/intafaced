/** Browser hop for a one-operator desk action. Same-origin BFF only; no credential is held here. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import { readStepReply, type StepReply } from '@/lib/desk/approval-types';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { EscalateRequest } from './direct-model';

export async function postDirect(endpoint: '/api/p2p-ops', request: EscalateRequest, signal?: AbortSignal): Promise<StepReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return {
      ok: false,
      step: null,
      refusal: {
        title: 'Nothing was sent',
        body: error instanceof Error ? error.message : 'Your founder session could not be confirmed.',
        next: 'Sign in again if needed, then repeat the step.',
        code: null,
        changed: 'no',
      },
    };
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    const body: unknown = await res.json().catch(() => null);
    // Maintenance mode holds the write at the gate (`{ code: 'ops.console_read_only' }`, 423): a definite "not sent".
    if (res.status === 423 && body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string')
      return { ok: false, step: null, refusal: explainRefusal((body as { code: string }).code, 423, false) };
    // A session refusal from the gate has no step shape: it is a definite "not sent".
    if ((res.status === 401 || res.status === 403) && !(body && typeof body === 'object' && 'refusal' in body)) {
      return {
        ok: false,
        step: null,
        refusal: {
          title: 'Nothing was sent',
          body: 'The console did not accept your founder session. Sign out and in again.',
          next: 'Sign in again, then repeat the step.',
          code: null,
          changed: 'no',
        },
      };
    }
    return readStepReply(body);
  } catch {
    // Sent, no answer: unknown. The same key is kept by the form, so sending it again cannot escalate twice.
    return {
      ok: false,
      step: 'execute',
      refusal: {
        title: 'The outcome is not known',
        body: 'The connection ended before the console answered, so it is not known whether the dispute was escalated.',
        next: 'Read the dispute list again. Sending the same request again is safe: it cannot escalate twice.',
        code: null,
        changed: 'unknown',
      },
    };
  }
}
