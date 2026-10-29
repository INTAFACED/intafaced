/** Browser hop for the two-founder desks. It talks only to the same-origin BFF; no credential is held here. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { DeskRequest } from './approval-packet';
import { readStepReply, type StepName, type StepReply } from './approval-types';
import { explainRefusal } from './refusal-copy';

export type ApprovalEndpoint =
  | '/api/kill-switch'
  | '/api/accounts/restore'
  | '/api/accounts/deposit-unfreeze'
  | '/api/accounts/closure'
  | '/api/accounts/archive'
  | '/api/accounts/documents'
  | '/api/accounts/selfies'
  | '/api/accounts/tier'
  | '/api/accounts/limits'
  | '/api/accounts/holds'
  | '/api/ledger-freeze'
  | '/api/ledger-reconciliation/run'
  | '/api/ledger-metadata/delete'
  | '/api/academy-ops'
  | '/api/more-ops'
  | '/api/protocol-ops'
  | '/api/bank-ops'
  | '/api/identity-ops/keys'
  | '/api/more-ops/waves'
  | '/api/console-mode';

export interface StepPayload {
  readonly step: StepName;
  readonly request?: DeskRequest;
  readonly confirm?: string;
  readonly approvalId?: string;
  readonly operationId?: string;
}

const NOT_SENT = (body: string): StepReply => ({
  ok: false,
  step: null,
  refusal: { title: 'Nothing was sent', body, next: 'Sign in again if needed, then repeat the step.', code: null, changed: 'no' },
});

export async function postStep(endpoint: ApprovalEndpoint, payload: StepPayload, signal?: AbortSignal): Promise<StepReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return NOT_SENT(error instanceof Error ? error.message : 'Your founder session could not be confirmed.');
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    const body: unknown = await res.json().catch(() => null);
    // Maintenance mode holds the write at the gate (`{ code: 'ops.console_read_only' }`, 423): a definite "not sent".
    if (res.status === 423 && body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string')
      return { ok: false, step: null, refusal: explainRefusal((body as { code: string }).code, 423, false) };
    // A session refusal from the gate is `{ code }` with no step shape: it is a definite "not sent".
    if (res.status === 401 || res.status === 403) {
      if (body && typeof body === 'object' && 'refusal' in body) return readStepReply(body);
      return NOT_SENT('The console did not accept your founder session. Sign out and in again.');
    }
    return readStepReply(body);
  } catch {
    // Sent, no answer: unknown, and the desk says so.
    return {
      ok: false,
      step: payload.step,
      refusal: {
        title: 'The outcome is not known',
        body: 'The connection ended before the console answered, so it is not known whether this went through.',
        next: 'Read the current state before doing anything again.',
        code: null,
        changed: 'unknown',
      },
    };
  }
}
