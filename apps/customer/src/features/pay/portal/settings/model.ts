import type { Member, MemberRole, MerchantRecord, TeamRole } from '../schemas';
import { type StepState, type Steps, nameProblem, text } from '../model';

/**
 * Progress comes from the service, never from the browser: a merchant record means step 1 is done, a KYB
 * status past `none` means step 2 has been submitted. A payout destination cannot be read back (the service
 * publishes no read), so step 3 is only "done" for what this visit just saved.
 */
export function onboardingSteps(merchant: MerchantRecord | null, kybStatus: string | null, destinationSaved: boolean): Steps {
  const business: StepState = merchant ? 'done' : 'current';
  const kyb = kybStatus ?? merchant?.kybStatus ?? 'none';
  const verification: StepState = !merchant ? 'todo' : kyb === 'approved' ? 'done' : kyb === 'pending' ? 'waiting' : 'current';
  const payout: StepState = !merchant ? 'todo' : destinationSaved ? 'done' : verification === 'current' ? 'todo' : 'current';
  const current = !merchant ? 0 : verification === 'current' || verification === 'waiting' ? 1 : 2;
  return {
    business,
    verification,
    payout,
    current: current as 0 | 1 | 2,
    sandboxReady: Boolean(merchant) && destinationSaved,
    liveWaiting: Boolean(merchant) && kyb !== 'approved',
  };
}

export type BusinessForm = {
  legalName: string;
  /** Optional trading name. Left blank, the service shows the legal name. */
  displayName: string;
  country: string;
  businessType: string;
  website: string;
  contactEmail: string;
  expectedVolume: string;
};

export const emptyBusiness: BusinessForm = {
  legalName: '',
  displayName: '',
  country: '',
  businessType: '',
  website: '',
  contactEmail: '',
  expectedVolume: '',
};

export type BusinessErrors = Partial<Record<keyof BusinessForm, 'required' | 'country' | 'website' | 'email' | 'volume' | 'name'>>;

export function validateBusiness(form: BusinessForm): BusinessErrors {
  const errors: BusinessErrors = {};
  if (form.legalName.trim().length < 2) errors.legalName = 'required';
  else if (nameProblem(form.legalName)) errors.legalName = 'name';
  if (nameProblem(form.displayName)) errors.displayName = 'name';
  if (!/^[A-Za-z]{2}$/.test(form.country.trim())) errors.country = 'country';
  if (form.businessType.trim().length < 2) errors.businessType = 'required';
  if (form.website.trim()) {
    try {
      const url = new URL(form.website.trim());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') errors.website = 'website';
    } catch {
      errors.website = 'website';
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contactEmail.trim())) errors.contactEmail = 'email';
  // Declared volume is free text for a person to read ("about 40 payments a month"); a number is not required.
  if (form.expectedVolume.length > 200) errors.expectedVolume = 'volume';
  return errors;
}

export function businessDetails(form: BusinessForm): Record<string, string> {
  return {
    legalName: form.legalName.trim(),
    country: form.country.trim().toUpperCase(),
    businessType: form.businessType.trim(),
    ...(form.website.trim() ? { website: form.website.trim() } : {}),
    contactEmail: form.contactEmail.trim(),
    ...(form.expectedVolume.trim() ? { declaredExpectedVolume: form.expectedVolume.trim() } : {}),
  };
}

/** The two names the service stores on the merchant. The display name is sent only when the person typed one. */
export function merchantNames(form: BusinessForm): { legalName: string; displayName?: string } {
  return {
    legalName: form.legalName.trim(),
    ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
  };
}

/** Shape checks the service repeats: a crypto destination is an EVM address; a bank one is an IBAN or IFSC. */
export function destinationShapeOk(kind: 'crypto' | 'bank', ref: string): boolean {
  const value = ref.trim();
  if (kind === 'crypto') return /^0x[0-9a-fA-F]{40}$/.test(value);
  const compact = value.replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(compact)) return true;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact) || compact.length < 15 || compact.length > 34) return false;
  let remainder = 0;
  for (const ch of compact.slice(4) + compact.slice(0, 4)) {
    const digits = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

export const railKind = (railId: string): 'crypto' | 'bank' => (railId.startsWith('crypto') ? 'crypto' : 'bank');

// ---- team ----------------------------------------------------------------------------------------------

export const memberActions = (me: MemberRole | null, member: Member) => {
  const manage = me === 'owner' || me === 'admin';
  const self = member.role === 'owner';
  const adminTarget = member.role === 'admin' && me !== 'owner';
  const canChange = manage && !self && member.status === 'active' && !adminTarget;
  return { canChange, canRemove: canChange, reason: !manage ? 'role' : self ? 'owner' : adminTarget ? 'admin' : null } as const;
};

/** Roles this person may hand out: only the owner may grant admin. */
export const grantableRoles = (me: MemberRole | null): readonly TeamRole[] =>
  me === 'owner' ? ['admin', 'finance', 'developer', 'viewer'] : me === 'admin' ? ['finance', 'developer', 'viewer'] : [];

/** Digits only, at most 18 places, no sign: what the service accepts as a threshold. */
export const isDecimalThreshold = (value: string) => /^\d+(\.\d{1,18})?$/.test(value.trim());
