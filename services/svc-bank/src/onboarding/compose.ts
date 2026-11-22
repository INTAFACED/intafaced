import { parseBankAccountTerms, type BankAccountTerms } from './bank-account-terms.js';

/** Opening, information requests and reopening a bank account. An area of svc-bank (`area-chain.ts`). */
export interface OnboardingServices {
  /** The owner's values for onboarding, information requests and reopening a bank account (J-bank-17); null is unpublished. */
  readonly bankAccountTerms: BankAccountTerms;
}

export interface OnboardingServiceOptions {
  /** `BANK_ONBOARDING_REQUIREMENTS_JSON`, `BANK_INFO_REQUEST_UPLOAD_JSON`, `BANK_REOPEN_WINDOW_DAYS` (J-bank-17). No defaults. */
  onboardingRequirements?: string | undefined;
  infoRequestUpload?: string | undefined;
  reopenWindowDays?: string | undefined;
}

export function composeOnboardingArea(_root: unknown, _made: object, options: OnboardingServiceOptions): OnboardingServices {
  return { bankAccountTerms: parseBankAccountTerms(options) };
}
