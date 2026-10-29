import { founderMutationHeaders } from '@/lib/founder-browser';
import type { BusinessCategory, CategoryPolicyPreview, CategoryPolicyPreviewInput } from '@intafaced/contracts/business-category';
import type { ApprovalView, RefusalView } from './registry-client';

/** Browser hop to `/api/merchants/categories`. The CSRF nonce is fetched per call; no token is ever stored. */

export type CategoryReply =
  | {
      readonly ok: true;
      readonly preview?: CategoryPolicyPreview;
      readonly approval?: ApprovalView;
      readonly saved?: BusinessCategory;
      readonly matchesReviewedChange?: boolean;
    }
  | { readonly ok: false; readonly refusal: RefusalView };

export type CategoryRequest =
  | { action: 'preview' | 'propose'; change: CategoryPolicyPreviewInput }
  | { action: 'approve'; change: CategoryPolicyPreviewInput; approvalId: string }
  | { action: 'save'; change: CategoryPolicyPreviewInput; approvalId: string; operationId: string }
  | { action: 'reject'; approvalId: string };

const UNREACHABLE: RefusalView = {
  title: 'Could not reach the console',
  body: 'The request did not get through, so nothing was changed.',
  next: 'Check your connection and try again.',
  code: null,
  requestId: null,
};

export async function postCategory(request: CategoryRequest): Promise<CategoryReply> {
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
    const res = await fetch('/api/merchants/categories', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const body = (await res.json().catch(() => null)) as (Partial<CategoryReply> & { code?: string }) | null;
    if (body && (body.ok === true || (body.ok === false && body.refusal))) return body as CategoryReply;
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

/** What the first founder copies to the second: the change and the approval reference, nothing else. */
export function categoryHandoff(change: CategoryPolicyPreviewInput, approvalId: string): string {
  return JSON.stringify({ kind: 'business_category', approvalId, change }, null, 2);
}

export const CLASS_WORDS: Record<string, string> = {
  permissionless: 'Permissionless',
  restricted: 'Restricted',
  prohibited: 'Prohibited',
};

/** What each class does, in the words the console and the business both read. */
export const CLASS_RULE: Record<string, string> = {
  permissionless: 'Crypto-native payments only. No extra documents.',
  restricted: 'No card rails (crypto-native and bank transfer only), extra documents and reserve terms.',
  prohibited: 'Not taken: every payment and checkout session is refused.',
};
