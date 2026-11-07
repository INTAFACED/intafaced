/**
 * A business application on the identity desk (I-kyc-compliance-25, J-identity-20 #9). Compliance reads the business's
 * verification status from svc-pay (`kyb.current`) and sees it in the same words the business reads on its own
 * verification step (the customer app's `kyb*Note` lines; `business.test.ts` keeps the two equal).
 */
export const KYB_APPLICANT_STATUSES = ['none', 'pending', 'approved', 'rejected'] as const;
export type KybApplicantStatus = (typeof KYB_APPLICANT_STATUSES)[number];

/** What the business reads for each status, word for word. */
export const BUSINESS_SEES: Readonly<Record<KybApplicantStatus, string>> = {
  none: 'You have not sent anything for verification yet.',
  pending: 'Sent. INTAFACED is reviewing it. You will be told here when there is a decision.',
  approved: 'Approved. Live payments can be switched on by INTAFACED.',
  rejected: 'Not approved. You can send a new reference.',
};

export interface KybCurrent {
  readonly kybStatus: KybApplicantStatus;
  readonly kybRef: string | null;
  readonly mode: string;
}

/** svc-pay's answer, exactly: a known status, a reference or null, and a mode. Anything else is unreadable. */
export function readKybCurrent(raw: unknown): KybCurrent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!(KYB_APPLICANT_STATUSES as readonly unknown[]).includes(r.kybStatus)) return null;
  if (r.kybRef !== null && typeof r.kybRef !== 'string') return null;
  if (typeof r.mode !== 'string') return null;
  return { kybStatus: r.kybStatus as KybApplicantStatus, kybRef: r.kybRef as string | null, mode: r.mode };
}
