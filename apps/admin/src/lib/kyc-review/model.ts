/**
 * The verification review queue in the console (I-kyc-compliance-02, J-identity-20 #1 #2): what the browser and the
 * console's own route say to each other, and identity's refusals in plain words. Identity holds every fact: the page size,
 * the claim, the notes. This file holds none of them.
 */

export type KycReviewStep =
  | { readonly op: 'assign'; readonly caseId: string; readonly action: 'claim' | 'release' }
  | { readonly op: 'note'; readonly caseId: string; readonly body: string }
  | { readonly op: 'appeal'; readonly caseId: string; readonly decision: 'upheld' | 'overturned' };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A step the route accepts, or null. Nothing else reaches identity. */
export function readKycReviewStep(raw: unknown): KycReviewStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.caseId !== 'string' || !UUID.test(r.caseId)) return null;
  if (r.op === 'assign' && (r.action === 'claim' || r.action === 'release')) return { op: 'assign', caseId: r.caseId, action: r.action };
  if (r.op === 'appeal' && (r.decision === 'upheld' || r.decision === 'overturned'))
    return { op: 'appeal', caseId: r.caseId, decision: r.decision };
  if (r.op === 'note' && typeof r.body === 'string' && r.body.trim().length >= 1 && r.body.trim().length <= 2000)
    return { op: 'note', caseId: r.caseId, body: r.body.trim() };
  return null;
}

export interface KycReviewRefusal {
  readonly code: string | null;
  readonly title: string;
  readonly body: string;
}

const BY_CODE: Readonly<Record<string, Omit<KycReviewRefusal, 'code'>>> = {
  'kyc.case_assigned': {
    title: 'Another reviewer has this case',
    body: 'Someone claimed it first. Nothing was changed; pick another case from the queue.',
  },
  'kyc.case_not_assigned': { title: 'You do not hold this case', body: 'Only the reviewer who claimed a case can release it.' },
  'kyc.case_state': { title: 'This case is already decided', body: 'Only an open case can be claimed or released.' },
  'kyc.case_unknown': { title: 'No such case', body: 'Identity has no verification case with this id.' },
  'kyc.queue_page_size_unset': {
    title: 'The queue page size is not set',
    body: 'The owner has not published how many cases a page shows (IDENTITY_KYC_QUEUE_PAGE_SIZE), so identity refuses to invent one.',
  },
  'kyc.queue_cursor_invalid': { title: 'That page marker is not valid', body: 'Go back to the first page and page forward again.' },
  'auth.kyc_self_review': { title: 'This is your own verification', body: 'Nobody reviews their own case. Another reviewer takes it.' },
  'kyc.case_final': { title: 'This rejection is final', body: 'Its appeal is decided, so it takes no more appeals or decisions.' },
  'kyc.appeal_none': { title: 'No appeal is waiting', body: 'This case has no appeal waiting for a decision.' },
  'kyc.same_reviewer': {
    title: 'You rejected this case',
    body: 'A different reviewer decides its appeal, so the first decision is checked by a second person.',
  },
  'mfa.required': {
    title: 'A second factor is needed',
    body: 'Identity needs a session signed in with your second factor for the review queue.',
  },
};

/** Identity's refusal in words, with its code beside it. A code not listed here still shows, never a raw stack. */
export function explainKycReview(code: string | null, status: number): KycReviewRefusal {
  const known = code ? BY_CODE[code] : undefined;
  if (known) return { code, ...known };
  if (status === 401 || status === 403)
    return {
      code,
      title: 'Your session cannot work the verification queue',
      body: 'The queue needs the compliance permission (admin:compliance) and a second factor on your session.',
    };
  return { code, title: 'Identity did not answer', body: 'Nothing was changed. Try again in a moment.' };
}
