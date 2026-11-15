import { z } from 'zod';
import { parseProofLimits, type ProofLimits } from '../personal-pay/payee-controls.js';

/**
 * The owner's values for a bank account's onboarding, information requests and reopening (BK-acct-05, BK-acct-06,
 * J-bank-17). None has a default: each blank one is null here and refuses with its own typed code where it is needed.
 */
export interface BankAccountTerms {
  /** `BANK_ONBOARDING_REQUIREMENTS_JSON`: the owner's own requirements, shown beside the partner's. */
  readonly ownerRequirements: readonly string[] | null;
  /** `BANK_INFO_REQUEST_UPLOAD_JSON`: the size cap and types for an answer's file. */
  readonly upload: ProofLimits | null;
  /** `BANK_REOPEN_WINDOW_DAYS`: how many days after closing an account may be reopened. */
  readonly reopenWindowDays: number | null;
}

const requirementsShape = z.array(z.string().trim().min(1).max(300)).min(1).max(30);

function parseJson(raw: string | undefined): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function parseBankAccountTerms(raw: {
  onboardingRequirements?: string | undefined;
  infoRequestUpload?: string | undefined;
  reopenWindowDays?: string | undefined;
}): BankAccountTerms {
  const requirements = requirementsShape.safeParse(parseJson(raw.onboardingRequirements));
  const days = raw.reopenWindowDays?.trim() ?? '';
  const window = /^\d{1,4}$/.test(days) ? Number(days) : null;
  return Object.freeze({
    ownerRequirements: requirements.success ? Object.freeze(requirements.data) : null,
    upload: parseProofLimits(raw.infoRequestUpload),
    reopenWindowDays: window !== null && window >= 1 && window <= 3650 ? window : null,
  });
}
