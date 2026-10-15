import type { MerchantControlChangeResult, PayoutApproval } from '@intafaced/contracts';
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { RefusalView } from './registry-client';
import type { ControlChange } from './control-model';

/** Browser hop to `/api/merchants/controls`. The CSRF nonce is fetched per call; no token is ever stored. */

export type ControlReply =
  | { readonly ok: true; readonly result?: MerchantControlChangeResult; readonly approval?: PayoutApproval }
  | { readonly ok: false; readonly refusal: RefusalView };

const UNREACHABLE: RefusalView = {
  title: 'Could not reach the console',
  body: 'The request did not get through, so nothing was changed.',
  next: 'Check your connection and try again. Submitting again is safe: the same request reference is used.',
  code: null,
  requestId: null,
};

export type ControlRequest =
  | { action: 'submit'; requestId: string; merchantId: string; change: ControlChange; reason: string; expectedVersion: string }
  | {
      action: 'confirm' | 'decline';
      /** The request the second founder was shown, whole: the console hashes it and the service refuses a confirm for anything else. */
      requestId: string;
      merchantId: string;
      expectedVersion: string;
      change: ControlChange;
      reason: string;
    }
  | { action: 'decide'; approvalId: string; decision: 'approve' | 'reject'; expectedPayloadHash: string; reason: string };

export async function postControl(request: ControlRequest, signal?: AbortSignal): Promise<ControlReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return {
      ok: false,
      refusal: {
        title: 'You are signed out',
        body: error instanceof Error ? error.message : 'Your founder session is unavailable.',
        next: 'Sign in again, then repeat this step. Nothing was changed.',
        code: 'mfa.required',
        requestId: null,
      },
    };
  }
  try {
    const res = await fetch('/api/merchants/controls', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    const body = (await res.json().catch(() => null)) as (Partial<ControlReply> & { code?: string }) | null;
    if (body && body.ok === true) return body as ControlReply;
    if (body && body.ok === false && body.refusal) return body as ControlReply;
    if (body && typeof body.code === 'string') {
      return {
        ok: false,
        refusal: {
          title: res.status === 401 ? 'You are signed out' : 'Not allowed',
          body: 'The console did not accept your founder session for this action.',
          next: 'Sign out and in again. Nothing was changed.',
          code: body.code,
          requestId: null,
        },
      };
    }
    return { ok: false, refusal: UNREACHABLE };
  } catch {
    return { ok: false, refusal: UNREACHABLE };
  }
}

/** A fresh request reference for one change. Resubmitting with the same one is safe: the service returns the same outcome. */
export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}
