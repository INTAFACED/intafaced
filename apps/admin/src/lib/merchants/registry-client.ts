import { founderMutationHeaders } from '@/lib/founder-browser';
import type { PlainRefusal, RegistryKind, RegistryPreview } from './registry-model';

/** Browser hop to `/api/merchants/registries`. The CSRF nonce is fetched per call; no token is ever stored. */

export type RefusalView = PlainRefusal & { readonly code: string | null; readonly requestId: string | null };

export interface ApprovalView {
  readonly approvalId: string;
  readonly operationId?: string;
  readonly status: string;
  readonly expiresAt?: string;
  readonly payloadHash?: string;
}

export type RegistryReply =
  | {
      readonly ok: true;
      readonly preview?: RegistryPreview;
      readonly approval?: ApprovalView;
      readonly saved?: Record<string, unknown>;
      readonly listHref?: string;
      readonly matchesReviewedChange?: boolean;
      readonly reviewedPayloadHash?: string;
    }
  | { readonly ok: false; readonly refusal: RefusalView };

const UNREACHABLE: RefusalView = {
  title: 'Could not reach the console',
  body: 'The request did not get through, so nothing was changed.',
  next: 'Check your connection and try again.',
  code: null,
  requestId: null,
};

export type RegistryRequest =
  | { action: 'preview' | 'propose' | 'save'; registry: RegistryKind; change: Record<string, unknown> }
  | { action: 'approve'; registry: RegistryKind; change: Record<string, unknown>; approvalId: string }
  | { action: 'reject'; approvalId: string };

export async function postRegistry(request: RegistryRequest, signal?: AbortSignal): Promise<RegistryReply> {
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
    const res = await fetch('/api/merchants/registries', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    const body = (await res.json().catch(() => null)) as (Partial<RegistryReply> & { code?: string }) | null;
    if (body && body.ok === true) return body as RegistryReply;
    if (body && body.ok === false && body.refusal) return body as RegistryReply;
    if (body && typeof body.code === 'string') {
      // A gate refusal from the console itself (`admin.session_*`, `admin.founder_required`, ...).
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
